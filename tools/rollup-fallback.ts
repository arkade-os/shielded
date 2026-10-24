// The liveness fallback (spec section 4): the pool's batch leaf checks proofs, not who submits, so anyone can move it.
//   mirror  <pool-url> <dir>            save the pool's parameters, proving keys, batch records and (epoch pool) checked nullifier archives while the operator is up
//   withdraw <dir> <sats> <tark1…>       prove and submit a batch paying out from the wallet in SHIELDED_PHRASE
//   recover <dir> <origin>              (epoch pool) prove and submit a width-1 batch recovering the wallet's largest BTC note of that epoch
//   publish <dir> <pool-url> <batch>     hand a batch this tool landed to the operator, so it can follow it
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ArkAddress,Extension,RestArkProvider,RestIndexerProvider,type Transaction} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {BATCH_SLOTS,EPOCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,randomField,RollupAccount,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {toCircuitInput} from '../packages/protocol/src/rollup/client.ts';
import {chainOnly,EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2,parseMasterSecret} from '../packages/protocol/src/wallet-keys.ts';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';
import {decodeStockIndexerTransaction} from '../src/stock/indexer.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type SnarkProof} from '../src/rollup/covenant.ts';
import {epochNfArchivePath} from '../src/rollup/epoch-archive-file.ts';
import type {RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {buildEpochFallbackBatch,openEpochReplica,type EpochFallbackSpend} from '../src/rollup/epoch-replica.ts';
import {indexerBatchWalker} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves,loadRollupLeaves} from '../src/rollup/leaves.ts';
import {createRollupProver} from '../src/rollup/prover.ts';
import {rollupKeyFilesOf,rollupSpecOf} from '../src/rollup/service.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';
import {cacheBatch,cacheEpochArchive,cachedBatchNumbers as batchesIn,catchUpCachedBatches,epochMirrorStart,mirrorStart,replayEpochMirror} from './rollup-cache.ts';

interface Pool {token:string;operator:string;script:string;network:StockNetworkInfo;epochLen?:number}
const [command,...args]=process.argv.slice(2);
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const fromLe=(bytes:Uint8Array)=>bytes.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);
const log=(...parts:unknown[])=>console.log(new Date().toISOString().slice(11,19),...parts);
const warn=(...parts:unknown[])=>console.error(new Date().toISOString().slice(11,19),...parts);

async function mirror(url:string,dir:string){
 // A replay or archive check can outlast the pool's keep-alive, leaving the pooled connection dead; a GET is safe to send once more.
 const get=async(path:string)=>{const r=await fetch(url+'/api/rollup'+path).catch(()=>fetch(url+'/api/rollup'+path));if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r;};
 const status=await (await get('/status')).json(),epochLen:number|undefined=status.pool.epochLen;
 mkdirSync(join(dir,'keys'),{recursive:true});mkdirSync(join(dir,'batches'),{recursive:true});
 writeFileSync(join(dir,'pool.json'),JSON.stringify({token:status.pool.token,operator:status.pool.operator,script:status.pool.script,network:status.network,...(epochLen===undefined?{}:{epochLen})} satisfies Pool));
 if(epochLen!==undefined)writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf('epoch',status.pool.token,status.pool.operator)));
 const manifest=await (await get('/proving/manifest.json')).json() as {circuits:Record<string,{files:Record<string,string>}>};
 writeFileSync(join(dir,'keys','manifest.json'),JSON.stringify(manifest));
 // The manifest comes from the pool, so its file names are untrusted: only the service's allowlisted key files are written.
 const known=new Set<string>(rollupKeyFilesOf(epochLen===undefined?'classic':'epoch').filter(name=>name!=='manifest.json'));
 for(const {files} of Object.values(manifest.circuits))for(const [name,digest] of Object.entries(files)){
  if(!known.has(name))throw new Error(`The key manifest names an unexpected file: ${JSON.stringify(name)}.`);
  const path=join(dir,'keys',name);if(existsSync(path)&&sha(readFileSync(path))===digest)continue;
  const bytes=new Uint8Array(await (await get('/proving/'+name)).arrayBuffer());
  if(sha(bytes)!==digest)throw new Error(`${name} does not match the key manifest.`);
  writeFileSync(path,bytes);log('key',name,bytes.length,'bytes');
 }
 for(let from=(epochLen===undefined?mirrorStart:epochMirrorStart)(dir);;){
  const page=await (await get(`/batches?from=${from}&limit=100`)).json() as {total:number;batches:PublishedBatch[]};
  page.batches.forEach((batch,i)=>cacheBatch(dir,from+i,batch));
  from+=page.batches.length;if(from>=page.total||!page.batches.length)break;
 }
 let refused=0;
 if(epochLen!==undefined){
  const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v))),{epochs}=await (await get('/archives')).json() as {epochs:unknown[]};
  const folder=join(dir,'nullifiers'),count=batchesIn(dir).length,closed=count?Math.floor((count-1)/epochLen):0;
  let state:ReturnType<typeof replayEpochMirror>|undefined;
  for(const epoch of epochs){
   if(typeof epoch!=='number'||!Number.isSafeInteger(epoch)||epoch<0)throw new Error(`The pool lists an archive for epoch ${JSON.stringify(epoch)}.`);
   if(epoch>=closed){warn('skipped archive',epoch,'- the mirrored records have not closed that epoch');continue;}
   if(existsSync(epochNfArchivePath(folder,epoch)))continue;
   const bytes=new Uint8Array(await (await get(`/archives/epoch-${epoch}.nf`)).arrayBuffer());
   state??=replayEpochMirror(dir,hash,epochLen);
   try{cacheEpochArchive(dir,state,epoch,bytes,hash);log('archive',epoch,bytes.length,'bytes');}
   catch(error){refused++;warn('refused archive',`${epoch}:`,(error as Error).message);}
  }
  for(let epoch=0;epoch<closed;epoch++)if(!existsSync(epochNfArchivePath(folder,epoch)))warn('no archive file for closed epoch',epoch);
 }
 log('mirrored',batchesIn(dir).length,'batches into',dir);
 if(refused)throw new Error(`${refused} archive file(s) did not check against the mirrored records and were not written; mirror again.`);
}

async function wallet(){
 const phrase=process.env.SHIELDED_PHRASE;
 if(!phrase)throw new Error('Set SHIELDED_PHRASE to the wallet\'s 24-word recovery phrase.');
 const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const keys=deriveRollupKeys2(parseMasterSecret(phrase),'mutinynet');
 return {hash,keys,self:rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret)};
}
/** The pool head the indexer shows, and the commitment its state packet carries. */
async function poolHead(pool:Pool){
 const indexer=new RestIndexerProvider(pool.network.indexerUrl??pool.network.arkUrl);
 const head=(await indexer.getVtxos({scripts:[pool.script],spendableOnly:true})).vtxos.find(v=>v.assets?.some(a=>a.assetId===pool.token));
 if(!head)throw new Error('The indexer shows no pool head.');
 // Renewal needs the operator, so without it the head, and every payout made from it, expire together.
 const expires=head.expiresAt instanceof Date?head.expiresAt.getTime():undefined;
 if(expires!==undefined&&expires-Date.now()<30*60_000)throw new Error(`The pool head expires at ${new Date(expires).toISOString()}; a payout now would be swept before it could be moved.`);
 const source=(await indexer.getVirtualTxs([head.txid])).txs.map(decodeStockIndexerTransaction).find(t=>t.id===head.txid)!;
 const packet=Extension.fromTx(source).getPacketByType(ROLLUP_STATE_PACKET)!.serialize();
 return {indexer,head,source,expires,committed:fromLe(packet.subarray(0,32))};
}
const proverOf=(dir:string,circuit:string)=>async(built:{witness:{input:Record<string,unknown>}})=>(await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),join(dir,'keys',`${circuit}.wasm`),join(dir,'keys',`${circuit}.zkey`))).proof as SnarkProof;
const checkpointOf=async(network:StockNetworkInfo)=>{const info=await new RestArkProvider(network.arkUrl).getInfo();return validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey);};
const submit=(network:StockNetworkInfo,built:{arkTx:Transaction;checkpoints:Transaction[]})=>createRollupTransport(network).submit({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(c=>base64.encode(c.toPSBT()))},1);

async function withdraw(dir:string,sats:bigint,to:string){
 const pool=json<Pool>(join(dir,'pool.json')),network=pool.network;
 if(pool.epochLen!==undefined)return epochWithdraw(dir,{...pool,epochLen:pool.epochLen},sats,to);
 const {hash,keys,self}=await wallet();
 const account=RollupAccount.owning(hash,keys),numbers=batchesIn(dir);
 for(const n of numbers)await account.apply(json<PublishedBatch>(join(dir,'batches',`${n}.json`)));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'keys/spend.vkey.json',batchKey:'keys/batch-spend.vkey.json',clientJoinKey:'keys/join.vkey.json',batchJoinKey:'keys/batch-join.vkey.json',slots:BATCH_SLOTS,token:pool.token,operator:pool.operator}));
 const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json')),tree=rollupPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
 if(hex.encode(tree.tree.pkScript)!==pool.script)throw new Error('The rebuilt pool script is not the pool\'s.');
 const {indexer,head,source,expires,committed}=await poolHead(pool);
 if(committed!==account.state.commitment()){
  // Records were withheld before the mirror ran: walk the head's ancestry from the last mirrored batch and apply each from chain.
  const last=numbers.length?json<PublishedBatch>(join(dir,'batches',`${numbers.length-1}.json`)).txid:undefined;
  if(!last)throw new Error('No mirrored batch to catch up from; mirror at least one batch while the operator is up.');
  log('caught up',await catchUpCachedBatches(dir,account,leaves,last,committed,indexerBatchWalker(indexer)),'withheld batches from the chain');
 }
 const note=account.notes().filter(n=>n.amount>=sats).sort((a,b)=>a.amount<b.amount?-1:1)[0];
 if(!note)throw new Error(`No single note of this wallet covers ${sats} sats; it holds ${account.balance()} in ${account.notes().length} notes.`);
 const batch=account.batchCount;
 log('replayed',batch,'batches; spending a',note.amount,'sat note');
 const prove=proverOf(dir,'spend');
 const mine=await account.spend({input:note,withdraw:sats,program:ArkAddress.decode(to).pkScript.subarray(2)},self),spends=[{built:mine,proof:await prove(mine)}];
 // Our own zero-value spends fill the slots, as the operator's padding does.
 for(let i=1;i<BATCH_SLOTS;i++){const pad=await buildRollupSpend(hash,{root:account.state.latestRoot(),ask:randomField(),nk:randomField(),self:rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey()),request:{}});spends.push({built:pad,proof:await prove(pad)});}
 log('proved',spends.length,'spends; proving the batch');
 const replica=account.state.clone(),result=replica.apply('spend',spends.map(s=>s.built.witness.slot));
 const batchProof=await createRollupProver({wasm:join(dir,'keys','batch-spend.wasm'),zkey:join(dir,'keys','batch-spend.zkey')}).prove(result.witness,result.publicSignals);
 const built=buildRollupBatchTx({head:{txid:head.txid,vout:head.vout,value:head.value,sourceTx:source.toBytes(true,true),tapTree:tree.tree.encode(),leaf:tree.tree.findLeaf(hex.encode(tree.batch))},deposits:[],
  legs:spends.map(({built:{witness:{publicSignals:p}}},i)=>({deposit:p[3]!,withdraw:p[4]!,asset:p[5]!==0n,...(i===0?{program:ArkAddress.decode(to).pkScript.subarray(2)}:{})})),
  token:pool.token,leaves,witness:rollupWitness(batchProof,spends.map(s=>({proof:s.proof,publics:s.built.witness.publicSignals}))),
  newPacket:Uint8Array.from([...le32(replica.commitment()),...le32(result.daRoot),...le32(result.blockRoot)]),checkpoint:await checkpointOf(network)});
 const receipt=await submit(network,built);
 const record:PublishedBatch={kind:'spend',slots:spends.map(({built:{witness:{slot,publicSignals},ciphertext}})=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publicSignals.map(String),ciphertext:hex.encode(ciphertext)})),txid:receipt.txid,at:Date.now()};
 log('landed batch',batch,'as',receipt.txid,'paying',sats,'sats to',to);
 cacheBatch(dir,batch,record);
 if(expires!==undefined)log('the payout expires with the head at',new Date(expires).toISOString(),'- move or settle it on Arkade before then');
}

type EpochPool=Pool&{epochLen:number};
/** The replica bound to the head the indexer shows, its chain walk saved to the mirror, and the wallet's account over it. */
async function epochOpen(dir:string,pool:EpochPool){
 const w=await wallet(),{network}=pool;
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json')),tree=rollupEpochPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
 if(hex.encode(tree.tree.pkScript)!==pool.script)throw new Error('The rebuilt pool script is not the pool\'s.');
 const head=await poolHead(pool),replica=await openEpochReplica({dir,hash:w.hash,epochLen:pool.epochLen,leaves}),mirrored=replica.records.length;
 if(!mirrored&&replica.state.commitment()!==head.committed)throw new Error('No mirrored batch to catch up from; mirror at least one batch while the operator is up.');
 const caught=await replica.catchUpFromChain(replica.records.at(-1)?.txid??'',head.committed,indexerBatchWalker(head.indexer));
 replica.records.slice(mirrored).forEach((record,i)=>cacheBatch(dir,mirrored+i,record as unknown as PublishedBatch));
 if(caught)log('caught up',caught,'withheld batches from the chain');
 const account=EpochAccount.owning(w.hash,w.keys,{epochLen:pool.epochLen,replica:true});
 for(const record of replica.records)await account.apply(record);
 return {...w,...head,pool,leaves,tree,replica,account};
}
async function epochLand(dir:string,o:Awaited<ReturnType<typeof epochOpen>>,kind:'spend'|'recover',spends:EpochFallbackSpend[],program?:Uint8Array){
 log('proved',spends.length,'spends; proving the batch');
 const built=await buildEpochFallbackBatch(o.replica,{kind,spends,...(program?{program}:{}),prover:createRollupProver({wasm:join(dir,'keys',`epoch-batch-${kind}.wasm`),zkey:join(dir,'keys',`epoch-batch-${kind}.zkey`)}),
  head:{txid:o.head.txid,vout:o.head.vout,value:o.head.value,sourceTx:o.source.toBytes(true,true)},pool:o.tree,leaves:o.leaves,token:o.pool.token,checkpoint:await checkpointOf(o.pool.network)});
 const receipt=await submit(o.pool.network,built),batch=o.replica.state.batchCount;
 cacheBatch(dir,batch,{...built.record,txid:receipt.txid,at:Date.now()} as unknown as PublishedBatch);
 log('landed batch',batch,'as',receipt.txid);
}
async function epochWithdraw(dir:string,pool:EpochPool,sats:bigint,to:string){
 const o=await epochOpen(dir,pool),{account,replica}=o,program=ArkAddress.decode(to).pkScript.subarray(2),prove=proverOf(dir,'epoch-spend');
 const note=account.notes().filter(n=>n.amount>=sats&&account.spendable(n)).sort((a,b)=>a.amount<b.amount?-1:1)[0];
 if(!note)throw new Error(`No single note of this wallet on the fast path covers ${sats} sats; it holds ${account.balance()} in ${account.notes().length} notes, and recover brings an older one back.`);
 log('replayed',replica.state.batchCount,'batches; spending a',note.amount,'sat note of epoch',note.epoch);
 const mine=await account.spend({input:note,withdraw:sats,program},o.self),spends:EpochFallbackSpend[]=[{built:mine,proof:await prove(mine)}];
 while(spends.length<EPOCH_SLOTS.spend){const pad=await replica.pad();spends.push({built:pad,proof:await prove(pad)});}
 await epochLand(dir,o,'spend',spends,program);
 log('paid',sats,'sats to',to);
 if(o.expires!==undefined)log('the payout expires with the head at',new Date(o.expires).toISOString(),'- move or settle it on Arkade before then');
}
async function recover(dir:string,origin:number){
 const pool=json<Pool>(join(dir,'pool.json'));
 if(pool.epochLen===undefined)throw new Error('This mirror is of a classic pool, which has no recover batch.');
 const o=await epochOpen(dir,{...pool,epochLen:pool.epochLen}),{account,replica}=o;
 replica.preload(origin);
 const stranded=account.notes().filter(n=>!account.spendable(n)),note=stranded.filter(n=>n.epoch===origin).sort((a,b)=>a.amount>b.amount?-1:1)[0];
 if(!note)throw new Error(`This wallet holds no BTC note of epoch ${origin} that needs a recovery${stranded.length?`; the epochs that hold one: ${[...new Set(stranded.map(n=>n.epoch))].join(', ')}`:''}.`);
 const mine=await account.recover(note,o.self);
 await epochLand(dir,o,'recover',[{built:mine,proof:await proverOf(dir,'epoch-spend')(mine)}]);
 log('recovered a',note.amount,'sat note of epoch',origin);
}

async function publish(dir:string,url:string,batch:number){
 const record=json<PublishedBatch>(join(dir,'batches',`${batch}.json`)),epoch=json<Pool>(join(dir,'pool.json')).epochLen!==undefined;
 // An epoch pool follows a chain-only batch from its transaction alone, and refuses the zero placeholders as slots.
 const bare=epoch&&chainOnly(record as unknown as RollupEpochRecord);
 const r=await fetch(url+'/api/rollup/external',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txid:record.txid,...(bare?{}:{slots:record.slots})})});
 log(r.status,await r.text());
}

if(command==='mirror')await mirror(args[0]!.replace(/\/+$/,''),args[1]!);
else if(command==='withdraw')await withdraw(args[0]!,BigInt(args[1]!),args[2]!);
else if(command==='recover')await recover(args[0]!,Number(args[1]));
else if(command==='publish')await publish(args[0]!,args[1]!.replace(/\/+$/,''),Number(args[2]));
else throw new Error('Usage: rollup-fallback.ts mirror <pool-url> <dir> | withdraw <dir> <sats> <tark1…> | recover <dir> <origin> (BTC notes) | publish <dir> <pool-url> <batch>');
await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();
