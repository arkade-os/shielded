// The liveness fallback (spec section 4): the pool's batch leaf checks proofs, not who submits, so anyone can move it.
//   mirror  <pool-url> <dir>            save the pool's parameters, proving keys and batch records while the operator is up
//   withdraw <dir> <sats> <tark1…>       prove and submit a batch paying out from the wallet in SHIELDED_PHRASE
//   publish <dir> <pool-url> <batch>     hand a batch this tool landed to the operator, so it can follow it
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ArkAddress,Extension,RestArkProvider,RestIndexerProvider} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,randomField,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {toCircuitInput} from '../packages/protocol/src/rollup/client.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2,parseMasterSecret} from '../packages/protocol/src/wallet-keys.ts';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';
import {decodeStockIndexerTransaction} from '../src/stock/indexer.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';
import {buildRollupBatchTx,rollupPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type SnarkProof} from '../src/rollup/covenant.ts';
import {DEFAULT_VM_BINARY,loadRollupLeaves} from '../src/rollup/leaves.ts';
import {createRollupProver} from '../src/rollup/prover.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';

interface Pool {token:string;operator:string;script:string;network:StockNetworkInfo}
const [command,...args]=process.argv.slice(2);
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const fromLe=(bytes:Uint8Array)=>bytes.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);
const log=(...parts:unknown[])=>console.log(new Date().toISOString().slice(11,19),...parts);
const batchesIn=(dir:string)=>readdirSync(join(dir,'batches')).map(name=>Number(name.replace('.json',''))).filter(Number.isInteger).sort((a,b)=>a-b);

async function mirror(url:string,dir:string){
 const get=async(path:string)=>{const r=await fetch(url+'/api/rollup'+path);if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r;};
 const status=await (await get('/status')).json();
 mkdirSync(join(dir,'keys'),{recursive:true});mkdirSync(join(dir,'batches'),{recursive:true});
 writeFileSync(join(dir,'pool.json'),JSON.stringify({token:status.pool.token,operator:status.pool.operator,script:status.pool.script,network:status.network} satisfies Pool));
 const manifest=await (await get('/proving/manifest.json')).json() as {circuits:Record<string,{files:Record<string,string>}>};
 writeFileSync(join(dir,'keys','manifest.json'),JSON.stringify(manifest));
 // The manifest comes from the pool, so its file names are untrusted: only the six key files are written.
 const known=new Set(['spend.wasm','spend.zkey','spend.vkey.json','batch-spend.wasm','batch-spend.zkey','batch-spend.vkey.json']);
 for(const {files} of Object.values(manifest.circuits))for(const [name,digest] of Object.entries(files)){
  if(!known.has(name))throw new Error(`The key manifest names an unexpected file: ${JSON.stringify(name)}.`);
  const path=join(dir,'keys',name);if(existsSync(path)&&sha(readFileSync(path))===digest)continue;
  const bytes=new Uint8Array(await (await get('/proving/'+name)).arrayBuffer());
  if(sha(bytes)!==digest)throw new Error(`${name} does not match the key manifest.`);
  writeFileSync(path,bytes);log('key',name,bytes.length,'bytes');
 }
 for(let from=batchesIn(dir).length;;){
  const page=await (await get(`/batches?from=${from}&limit=100`)).json() as {total:number;batches:PublishedBatch[]};
  page.batches.forEach((batch,i)=>writeFileSync(join(dir,'batches',`${from+i}.json`),JSON.stringify(batch)));
  from+=page.batches.length;if(from>=page.total||!page.batches.length)break;
 }
 log('mirrored',batchesIn(dir).length,'batches into',dir);
}

async function withdraw(dir:string,sats:bigint,to:string){
 const pool=json<Pool>(join(dir,'pool.json')),network=pool.network,phrase=process.env.SHIELDED_PHRASE;
 if(!phrase)throw new Error('Set SHIELDED_PHRASE to the wallet\'s 24-word recovery phrase.');
 const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const keys=deriveRollupKeys2(parseMasterSecret(phrase),'mutinynet'),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 const account=RollupAccount.owning(hash,keys),numbers=batchesIn(dir);
 if(numbers.some((n,i)=>n!==i))throw new Error('The mirrored batch records have a gap.');
 for(const n of numbers)await account.apply(json<PublishedBatch>(join(dir,'batches',`${n}.json`)));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'keys/spend.vkey.json',batchKey:'keys/batch-spend.vkey.json',slots:BATCH_SLOTS,kind:0,token:pool.token,operator:pool.operator}));
 const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json')),tree=rollupPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
 if(hex.encode(tree.tree.pkScript)!==pool.script)throw new Error('The rebuilt pool script is not the pool\'s.');
 const indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl);
 const head=(await indexer.getVtxos({scripts:[pool.script],spendableOnly:true})).vtxos.find(v=>v.assets?.some(a=>a.assetId===pool.token));
 if(!head)throw new Error('The indexer shows no pool head.');
 // Renewal needs the operator, so without it the head, and every payout made from it, expire together.
 const expires=head.expiresAt instanceof Date?head.expiresAt.getTime():undefined;
 if(expires!==undefined&&expires-Date.now()<30*60_000)throw new Error(`The pool head expires at ${new Date(expires).toISOString()}; a payout now would be swept before it could be moved.`);
 const source=(await indexer.getVirtualTxs([head.txid])).txs.map(decodeStockIndexerTransaction).find(t=>t.id===head.txid)!;
 const packet=Extension.fromTx(source).getPacketByType(ROLLUP_STATE_PACKET)!.serialize();
 if(fromLe(packet.subarray(0,32))!==account.state.commitment())throw new Error('The mirrored records are behind the chain; mirror again or find the missing ones.');
 const note=account.notes().filter(n=>n.amount>=sats).sort((a,b)=>a.amount<b.amount?-1:1)[0];
 if(!note)throw new Error(`No single note of this wallet covers ${sats} sats; it holds ${account.balance()} in ${account.notes().length} notes.`);
 log('replayed',numbers.length,'batches; spending a',note.amount,'sat note');
 const prove=async(built:BuiltSpend)=>(await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),join(dir,'keys','spend.wasm'),join(dir,'keys','spend.zkey'))).proof as SnarkProof;
 const mine=await account.spend({input:note,withdraw:sats,program:ArkAddress.decode(to).pkScript.subarray(2)},self),spends=[{built:mine,proof:await prove(mine)}];
 // Our own zero-value spends fill the slots, as the operator's padding does.
 for(let i=1;i<BATCH_SLOTS;i++){const pad=await buildRollupSpend(hash,{root:account.state.latestRoot(),ask:randomField(),nk:randomField(),self:rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey()),request:{}});spends.push({built:pad,proof:await prove(pad)});}
 log('proved',spends.length,'spends; proving the batch');
 const replica=account.state.clone(),result=replica.apply('spend',spends.map(s=>s.built.witness.slot));
 const batchProof=await createRollupProver({wasm:join(dir,'keys','batch-spend.wasm'),zkey:join(dir,'keys','batch-spend.zkey')}).prove(result.witness,result.publicSignals);
 const info=await new RestArkProvider(network.arkUrl).getInfo();
 const built=buildRollupBatchTx({head:{txid:head.txid,vout:head.vout,value:head.value,sourceTx:source.toBytes(true,true),tapTree:tree.tree.encode(),leaf:tree.tree.findLeaf(hex.encode(tree.batch))},deposits:[],
  legs:spends.map(({built:{witness:{publicSignals:p}}},i)=>({deposit:p[1]!,withdraw:p[2]!,asset:p[3]!==0n,...(i===0?{program:ArkAddress.decode(to).pkScript.subarray(2)}:{})})),
  token:pool.token,leaves,witness:rollupWitness(batchProof,spends.map(s=>({proof:s.proof,publics:s.built.witness.publicSignals}))),
  newPacket:Uint8Array.from([...le32(replica.commitment()),...le32(result.daRoot)]),checkpoint:validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey)});
 const receipt=await createRollupTransport(network).submit({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(c=>base64.encode(c.toPSBT()))},1);
 const record:PublishedBatch={kind:'spend',slots:spends.map(({built:{witness:{slot,publicSignals},ciphertext}})=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publicSignals.map(String),ciphertext:hex.encode(ciphertext)})),txid:receipt.txid,at:Date.now()};
 writeFileSync(join(dir,'batches',`${numbers.length}.json`),JSON.stringify(record));
 log('landed batch',numbers.length,'as',receipt.txid,'paying',sats,'sats to',to);
 if(expires!==undefined)log('the payout expires with the head at',new Date(expires).toISOString(),'- move or settle it on Arkade before then');
}

async function publish(dir:string,url:string,batch:number){
 const record=json<PublishedBatch>(join(dir,'batches',`${batch}.json`));
 const r=await fetch(url+'/api/rollup/external',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txid:record.txid,slots:record.slots})});
 log(r.status,await r.text());
}

if(command==='mirror')await mirror(args[0]!.replace(/\/+$/,''),args[1]!);
else if(command==='withdraw')await withdraw(args[0]!,BigInt(args[1]!),args[2]!);
else if(command==='publish')await publish(args[0]!,args[1]!.replace(/\/+$/,''),Number(args[2]));
else throw new Error('Usage: rollup-fallback.ts mirror <pool-url> <dir> | withdraw <dir> <sats> <tark1…> | publish <dir> <pool-url> <batch>');
await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();
