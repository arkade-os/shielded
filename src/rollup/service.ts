import {execFile,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {freemem,totalmem} from 'node:os';
import {join} from 'node:path';
import {ArkAddress,Extension,RestArkProvider,RestIndexerProvider,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {schnorr} from '@noble/curves/secp256k1.js';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS} from '../../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,randomField} from '../../packages/protocol/src/rollup/account.ts';
import {RollupState} from '../../packages/protocol/src/rollup/state.ts';
import {rollupRecipientOf} from '../../packages/protocol/src/rollup/wallet.ts';
import {openCustomerArkWallet} from '../stock/ark-wallet.ts';
import {validateStockCheckpoint} from '../stock/checkpoint.ts';
import {decodeStockIndexerTransaction} from '../stock/indexer.ts';
import {isStorageLocked} from '../storage.ts';
import {preflightStockMutinynet,type StockNetworkInfo} from '../stock/network.ts';
import type {StockWireRequest} from '../stock/transport.ts';
import type {RollupSpend} from './batcher.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET,type RollupCoin} from './covenant.ts';
import {loadRollupLeaves} from './leaves.ts';
import {openRollupOperator,type RollupArchive,type RollupOperator,type RollupRecord} from './operator.ts';
import {createRollupProver} from './prover.ts';
import {flushRollupIntent,leftoverRenewal,renewedRollupPool,renewRollupPool} from './renewal.ts';
import {listingsOf} from './listings.ts';
import {decodeSpend,encodeSpend,openSpendStore,type CoinRef} from './spend-store.ts';
import {createRollupTransport} from './transport.ts';

export const ROLLUP_KEY_FILES=['manifest.json','spend.wasm','spend.zkey','spend.vkey.json','batch-spend.wasm','batch-spend.zkey','batch-spend.vkey.json'] as const;
const HEAD_SATS=1000,MINIMUM_FUNDING_SATS=2000,SIGN_TIMEOUT_MS=30_000,PADDING_TARGET=BATCH_SLOTS+1;
const SETUP_MEMORY_BYTES=4*1024**3,SETUP_ATTEMPTS=3,SETUP_RETRY_MS=10*60_000;
// arkd sweeps a pool coin at its batch expiry, so the head moves to a fresh round well before. A batch inherits its
// earliest input expiry, so a deposit coin may shorten the head's life, but never below the renewal threshold's reach.
const RENEW_BEFORE_MS=48*3600_000,RENEW_CHECK_MS=10*60_000,DEPOSIT_FLOOR_MS=24*3600_000,LIST_CHECK_MS=60_000;

export type RollupPhase='starting'|'keys'|'funding'|'genesis'|'ready'|'blocked';
export interface RollupStatus {
 version:1;phase:RollupPhase;message:string;minimumFundingSats:number;fundingAddress?:string;fundingSats?:number;
 pool?:{token:string;address:string;script:string;batches:number;root:string;head:{txid:string;vout:number;value:number};pending:number;padding:number;reserves:Record<string,string>};
 network?:StockNetworkInfo;
 proving?:{spend:{wasm:string;zkey:string}};
}
export interface RollupSpendStatus {status:'pending'|'signing'|'included'|'dropped';batch?:number;txid?:string;reason?:string;arkTx?:string;checkpoint?:string;checkpoints?:string[];vin?:number}
interface Genesis {version:1;token:string;txid:string;archive:RollupArchive;serverKey:string;emulatorKey:string}
interface Session {arkTx:string;checkpoints:string[];vin:number;signed?:{arkTx:string;checkpoint:string}}

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const readJson=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;

type KeyManifest={circuits:Record<string,{files:Record<string,string>}>};
function verifyKeys(keys:string):KeyManifest {
 const manifest=readJson<KeyManifest>(join(keys,'manifest.json'));
 for(const {files} of Object.values(manifest.circuits))for(const [name,digest] of Object.entries(files))if(sha(readFileSync(join(keys,name)))!==digest)throw new Error(`Rollup key ${name} does not match its manifest.`);
 return manifest;
}

/**
 * `circuits` holds the image's compiled spend and batch circuits; the one-time key setup runs from them unless
 * `bundled` already holds keys. Afterwards the volume's keys define the pool, whatever later images hold.
 */
export async function openRollupService(o:{directory:string;circuits:string;setupTool:string;bundled?:string;vmBinary:string;rapidsnark?:string;endpoints:{arkUrl?:string;emulatorUrl?:string;indexerUrl?:string};renewBeforeMs?:number;log?:(message:string)=>void}){
 const log=o.log??((message:string)=>console.log('[rollup] '+message)),keys=join(o.directory,'keys');
 mkdirSync(o.directory,{recursive:true,mode:0o700});
 const secretsPath=join(o.directory,'secrets.json');
 if(!existsSync(secretsPath))writeFileSync(secretsPath,JSON.stringify({wallet:randomBytes(32).toString('hex'),operator:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});
 const secrets=readJson<{wallet:string;operator:string}>(secretsPath),identity=SingleKey.fromHex(secrets.wallet),operatorSecret=hex.decode(secrets.operator);
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
 let status:RollupStatus={version:1,phase:'starting',message:'Starting the rollup pool.',minimumFundingSats:MINIMUM_FUNDING_SATS};
 let manifest:KeyManifest|undefined,setup:ChildProcess|undefined,setupFailures=0,setupRetryAt=0;

 /** Ready keys, or undefined while the one-time setup runs in a child process. */
 function ensureKeys():KeyManifest|undefined {
  if(manifest)return manifest;
  if(!existsSync(join(keys,'manifest.json'))){
   if(existsSync(join(o.directory,'genesis.json')))throw new Error('The rollup keys are missing from a pool that already exists; restore the volume.');
   if(o.bundled&&existsSync(join(o.bundled,'manifest.json'))){mkdirSync(keys,{mode:0o700});for(const name of ROLLUP_KEY_FILES)copyFileSync(join(o.bundled,name),join(keys,name));}
   else{
    const memory=process.constrainedMemory()||totalmem(),gib=(bytes:number)=>(bytes/1024**3).toFixed(1)+' GiB';
    // The batch key setup holds gigabytes; refuse a small host and back off after failures.
    if(memory<SETUP_MEMORY_BYTES){status={...status,phase:'blocked',message:`Key setup needs ${gib(SETUP_MEMORY_BYTES)} of memory; this host has ${gib(memory)}.`};return undefined;}
    if(!setup&&setupFailures>=SETUP_ATTEMPTS){status={...status,phase:'blocked',message:`Key setup failed ${setupFailures} times; see the server log. Free memory: ${gib(freemem())}.`};return undefined;}
    if(!setup&&Date.now()>=setupRetryAt){
     const partial=keys+'.partial';rmSync(partial,{recursive:true,force:true});
     status={...status,phase:'keys',message:`Generating the development proving keys (one time). Memory: ${gib(memory)}.`};
     setup=execFile(process.execPath,[o.setupTool,'--development-only','--single-thread','--build',o.circuits,'--ptau',join(o.directory,'ptau','powersOfTau28_hez_final_20.ptau'),'--out',partial],{maxBuffer:16*1024*1024,windowsHide:true},error=>{
      setup=undefined;
      if(error){setupFailures++;setupRetryAt=Date.now()+SETUP_RETRY_MS;status={...status,message:`Key setup failed (${setupFailures}/${SETUP_ATTEMPTS}): `+error.message.slice(0,300)};log(status.message);return;}
      renameSync(partial,keys);rmSync(join(o.directory,'ptau'),{recursive:true,force:true});log('development proving keys ready');
     });
     setup.stdout?.on('data',(chunk:Buffer)=>{for(const line of String(chunk).split(/\r?\n/))if(line.startsWith('ROLLUP_SETUP_PROGRESS=')){try{status={...status,message:`Generating the development proving keys (one time): ${JSON.parse(line.slice(22)).stage}.`};}catch{}}});
    }
    return undefined;
   }
  }
  manifest=verifyKeys(keys);
  const files=manifest.circuits['spend']!.files;
  status={...status,proving:{spend:{wasm:files['spend.wasm']!,zkey:files['spend.zkey']!}}};
  return manifest;
 }
 let live:{operator:RollupOperator;network:StockNetworkInfo;genesis:Genesis;address:string;pool:ReturnType<typeof rollupPoolTree>;leaves:Awaited<ReturnType<typeof loadRollupLeaves>>;indexer:RestIndexerProvider}|undefined;
 let stopped=false,timers:ReturnType<typeof setTimeout>[]=[];
 const sessions=new Map<string,Session>(),tracked=new Map<string,RollupSpendStatus&{nullifier:string;at:number}>(),store=openSpendStore(join(o.directory,'spends'));
 /** Moves a tracked spend to a new status, on disk too, so a restart neither forgets nor re-runs it. */
 const settle=(id:string,patch:Partial<RollupSpendStatus>)=>{
  const t=tracked.get(id);if(!t)return;Object.assign(t,patch);
  store.save({id,status:t.status==='signing'?'pending':t.status,nullifier:t.nullifier,at:t.at,...(t.batch!==undefined?{batch:t.batch}:{}),...(t.txid?{txid:t.txid}:{}),...(t.reason?{reason:t.reason}:{})});
 };
 /** A deposit coin as the indexer knows it: value, script and asset holdings come from there, never from the client. */
 const resolveCoin=async(c:CoinRef):Promise<RollupCoin&{assetAmount?:bigint;assetId?:string}>=>{
  const raw=(await live!.indexer.getVirtualTxs([c.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===c.txid);
  const output=raw&&c.vout<raw.outputsLength?raw.getOutput(c.vout):undefined,tree=VtxoScript.decode(hex.decode(c.tapTree));
  if(!raw||!output?.script||hex.encode(output.script)!==hex.encode(tree.pkScript))throw new Error('The deposit coin is not indexed under that tree.');
  const assets=(await live!.indexer.getVtxos({outpoints:[{txid:c.txid,vout:c.vout}]})).vtxos.find(v=>v.txid===c.txid&&v.vout===c.vout)?.assets??[];
  if(assets.length>1)throw new Error('A deposit coin may hold at most one asset.');
  return {txid:c.txid,vout:c.vout,value:Number(output.amount),sourceTx:raw.toBytes(true,true),tapTree:tree.encode(),leaf:tree.findLeaf(c.leaf),...(assets[0]?{assetAmount:BigInt(assets[0].amount),assetId:assets[0].assetId}:{})};
 };
 /** Re-admits spends that were waiting when the service stopped, oldest first so groups keep the order their id commits to. */
 async function restore(operator:RollupOperator){
  for(const record of store.load()){
   if(Date.now()-record.at>3600_000){store.remove(record.id);continue;}
   tracked.set(record.id,{status:record.status,nullifier:record.nullifier,at:record.at,...(record.batch!==undefined?{batch:record.batch}:{}),...(record.txid?{txid:record.txid}:{}),...(record.reason?{reason:record.reason}:{})});
   if(record.status!=='pending'||!record.spend)continue;
   if(operator.state.nullifiers.has(BigInt(record.nullifier))){settle(record.id,{status:'included'});continue;}
   try{const coin=record.spend.coin?await resolveCoin(record.spend.coin):undefined;await operator.submit({...decodeSpend(record.spend),...(coin?{coin}:{})});}
   catch(error){settle(record.id,{status:'dropped',reason:'It could not be re-admitted after the pool restarted: '+(error as Error).message});}
  }
 }

 const spec=async(token:string)=>{
  writeFileSync(join(o.directory,'spec.json'),JSON.stringify({clientKey:'keys/spend.vkey.json',batchKey:'keys/batch-spend.vkey.json',slots:BATCH_SLOTS,kind:0,token,operator:hex.encode(schnorr.getPublicKey(operatorSecret))}));
  return loadRollupLeaves(o.vmBinary,join(o.directory,'spec.json'));
 };

 /** Issues the pool token and sends the head with the genesis state packet; a crash in between re-finds the head by its script. */
 async function genesis(network:StockNetworkInfo):Promise<Genesis|undefined> {
  const ark=await openCustomerArkWallet(identity,network),wallet=ark.wallet,balance=await wallet.getBalance();
  status={...status,phase:'funding',fundingAddress:ark.address,fundingSats:balance.available,message:`Fund the operator wallet with at least ${MINIMUM_FUNDING_SATS} sats to create the pool.`};
  const tokenPath=join(o.directory,'genesis-token.json');
  if(!existsSync(tokenPath)){
   if(balance.available<MINIMUM_FUNDING_SATS)return undefined;
   status={...status,phase:'genesis',message:'Issuing the pool token.'};
   writeFileSync(tokenPath,JSON.stringify({token:(await wallet.assetManager.issue({amount:1n})).assetId}),{flag:'wx'});
  }
  const {token}=readJson<{token:string}>(tokenPath),leaves=await spec(token);
  const serverKey=hex.decode(network.serverKey),pool=rollupPoolTree(serverKey,hex.decode(network.emulatorKey),leaves,network.exitDelay);
  const indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl),script=hex.encode(pool.tree.pkScript);
  let head=(await indexer.getVtxos({scripts:[script],spendableOnly:true})).vtxos.find(v=>v.assets?.some(a=>a.assetId===token));
  if(!head){
   status={...status,phase:'genesis',message:'Sending the pool head.'};
   const address=new ArkAddress(serverKey,pool.tree.pkScript.subarray(2),'tark').encode();
   const packet=Uint8Array.from([...le32(RollupState.genesis(hash).commitment()),...le32(0n)]);
   const txid=await wallet.send({recipients:[{address,amount:HEAD_SATS,assets:[{assetId:token,amount:1n}],tapTree:pool.tree.encode(),extensions:[{type:ROLLUP_STATE_PACKET,payload:packet}]}]});
   for(let i=0;i<30&&!head;i++){await sleep(1000);head=(await indexer.getVtxos({scripts:[script],spendableOnly:true})).vtxos.find(v=>v.txid===txid);}
   if(!head)throw new Error(`Genesis ${txid} is not indexed yet.`);
  }
  const raw=(await indexer.getVirtualTxs([head.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===head!.txid)!;
  if(!Extension.fromTx(raw).getPacketByType(ROLLUP_STATE_PACKET))throw new Error('The pool head carries no state packet.');
  const saved:Genesis={version:1,token,txid:head.txid,serverKey:network.serverKey,emulatorKey:network.emulatorKey,
   archive:{version:1,head:{txid:head.txid,vout:head.vout,value:head.value,sourceTxHex:hex.encode(raw.toBytes(true,true))},reserves:{},batches:0}};
  writeFileSync(join(o.directory,'genesis.json'),JSON.stringify(saved),{flag:'wx'});
  log(`genesis ${head.txid}:${head.vout} token ${token}`);
  return saved;
 }

 const signDeposits=async(request:StockWireRequest,deposits:RollupSpend[])=>{
  const first=Transaction.fromPSBT(base64.decode(request.arkTx)).inputsLength-deposits.length;
  deposits.forEach((d,i)=>sessions.set(d.id,{arkTx:request.arkTx,checkpoints:request.checkpoints,vin:first+i}));
  for(const deadline=Date.now()+SIGN_TIMEOUT_MS;Date.now()<deadline&&deposits.some(d=>!sessions.get(d.id)?.signed);)await sleep(250);
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),checkpoints=[...request.checkpoints];
  for(const d of deposits){
   const s=sessions.get(d.id);sessions.delete(d.id);
   if(!s?.signed)continue;
   ark.updateInput(s.vin,{tapScriptSig:Transaction.fromPSBT(base64.decode(s.signed.arkTx)).getInput(s.vin).tapScriptSig});
   checkpoints[s.vin]=s.signed.checkpoint;
  }
  return {arkTx:base64.encode(ark.toPSBT()),checkpoints};
 };

 async function open(network:StockNetworkInfo,saved:Genesis){
  const leaves=await spec(saved.token),pool=rollupPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
  const ark=await openCustomerArkWallet(identity,network),info=await new RestArkProvider(network.arkUrl).getInfo();
  const checkpoint=validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey),indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl);
  const prover=(name:string)=>createRollupProver({wasm:join(keys,`${name}.wasm`),zkey:join(keys,`${name}.zkey`)},o.rapidsnark);
  const operator=await openRollupOperator({directory:join(o.directory,'operator'),
   pin:{version:1,network:'mutinynet',descriptorProfileId:sha('rollup-v2-spend'),programsHash:sha(leaves.batch),artifactsHash:sha(readFileSync(join(keys,'manifest.json'))),checkpointHash:sha(checkpoint.script),genesisTxid:saved.txid,serverKey:network.serverKey,emulatorKey:network.emulatorKey},
   genesis:saved.archive,leaves,token:saved.token,serverKey:hex.decode(network.serverKey),emulatorKey:hex.decode(network.emulatorKey),exitDelay:network.exitDelay,checkpoint,
   clientKey:readJson(join(keys,'spend.vkey.json')),hash,prover:prover('batch-spend'),transport:createRollupTransport(network),signDeposits,depositFloorMs:DEPOSIT_FLOOR_MS,dustSats:network.dust,
   onDrop:(ids,reason)=>{for(const id of ids)if(tracked.get(id)?.status==='pending')settle(id,{status:'dropped',reason});}});
  const address=new ArkAddress(hex.decode(network.serverKey),pool.tree.pkScript.subarray(2),'tark').encode();
  live={operator,network,genesis:saved,address,pool,leaves,indexer};
  await restore(operator);
  status={...status,phase:'ready',message:'The rollup pool is open.',fundingAddress:ark.address};
  run(prover('spend'));
 }

 function run(spendProver:ReturnType<typeof createRollupProver>){
  const {operator}=live!;let paused=false,ticking:Promise<unknown>|undefined,lastError='',lock:Promise<unknown>=Promise.resolve();
  /** Renewal and listing move the head or reserves, so batches pause and they run one at a time. */
  const exclusive=(work:()=>Promise<void>)=>{const turn=lock.then(async()=>{paused=true;try{await ticking?.catch(()=>{});if(operator.status().pending)throw new Error('a submitted batch is unresolved; this waits.');await work();}finally{paused=false;}});lock=turn.catch(()=>{});return turn;};
  const note=(message:string)=>{if(message!==lastError)log(message);lastError=message;};
  const included=(batch:number,txid:string)=>{
   const record=readJson<RollupRecord>(join(o.directory,'operator','batches',`${batch}.json`)),spent=new Set(record.slots.flatMap(s=>s.nullifiers));
   for(const [id,t] of tracked)if(t.status==='pending'&&spent.has(t.nullifier))settle(id,{status:'included',batch,txid});
  };
  const sweep=()=>{
   const waiting=new Set(operator.pendingIds());
   for(const [id,t] of tracked){
    if(t.status==='pending'&&!waiting.has(id)&&!sessions.has(id))settle(id,operator.state.nullifiers.has(BigInt(t.nullifier))?{status:'included'}:{status:'dropped',reason:'The operator dropped this spend before it reached a batch; build it again.'});
    if(Date.now()-t.at>3600_000){tracked.delete(id);store.remove(id);}
   }
  };
  const tick=async()=>{
   if(stopped)return;
   if(!paused){
    try{ticking=operator.tick();const r=await ticking as Awaited<ReturnType<RollupOperator['tick']>>;if(r&&'txid' in r){log(`batch ${r.batch} ${r.txid}`);included(r.batch,r.txid);}else if(r)note(r.blocked);}
    catch(error){note((error as Error).message);}
    finally{ticking=undefined;}
    sweep();
   }
   timers.push(setTimeout(tick,1000));
  };
  const pad=async()=>{
   const recipient=rollupRecipientOf(hash,randomField(),x25519.utils.randomSecretKey());
   while(!stopped){
    if(operator.padding()>=PADDING_TARGET){await sleep(2000);continue;}
    try{
     const built=await buildRollupSpend(hash,{root:operator.state.latestRoot(),spendSecret:randomField(),self:recipient,request:{}});
     const proof=await spendProver.prove(built.witness.input,built.witness.publicSignals);
     operator.addPadding([{id:'pad-'+randomBytes(8).toString('hex'),slot:built.witness.slot,publics:built.witness.publicSignals as unknown as RollupSpend['publics'],proof,ciphertext:built.ciphertext,receivedAt:Infinity}]);
    }catch(error){note('padding: '+(error as Error).message);await sleep(10_000);}
   }
  };
  const renewalPath=join(o.directory,'renewal.json');
  const settleRenewal=async()=>{
   if(!existsSync(renewalPath))return;
   const pending=readJson<{intentId:string;head:{txid:string;vout:number}}>(renewalPath),{archive}=operator.status();
   const next=leftoverRenewal(pending,archive.head,(await live!.indexer.getVtxos({outpoints:[pending.head]})).vtxos[0]);
   if(next==='moved')throw new Error('The pool head was spent outside this operator, which cannot follow that yet.');
   if(next==='adopt'){await operator.relocate(await renewedRollupPool(live!.indexer,live!.pool.tree,live!.genesis.token,archive));log('adopted the head an interrupted renewal created');}
   if(next==='flush')log(`interrupted renewal intent ${pending.intentId}: ${await flushRollupIntent({arkUrl:live!.network.arkUrl,intentId:pending.intentId,topics:[archive.head,...Object.values(archive.reserves)].map(c=>`${c.txid}:${c.vout}`)})}`);
   rmSync(renewalPath,{force:true});
  };
  const renew=async()=>{
   if(stopped)return;
   try{
    if(existsSync(renewalPath))await exclusive(settleRenewal);
    const {head}=operator.status().archive,{vtxos}=await live!.indexer.getVtxos({outpoints:[{txid:head.txid,vout:head.vout}]}),expires=vtxos[0]?.expiresAt;
    if(expires instanceof Date&&expires.getTime()-Date.now()<(o.renewBeforeMs??RENEW_BEFORE_MS))await exclusive(async()=>{
     const from=operator.status().archive.head;
     try{
      const moved=await renewRollupPool({network:live!.network,identity,operatorSecret,pool:live!.pool.tree,renewLeaf:live!.pool.renew,leaves:live!.leaves,token:live!.genesis.token,archive:operator.status().archive,
       onIntent:intentId=>writeFileSync(renewalPath,JSON.stringify({intentId,head:{txid:from.txid,vout:from.vout}}))});
      await operator.relocate(moved);rmSync(renewalPath,{force:true});log(`renewed into round ${moved.commitment}, head ${moved.head.txid}`);
     }catch(error){await settleRenewal().catch(e=>note('renewal: '+(e as Error).message));throw error;}
    });
   }catch(error){note('renewal: '+(error as Error).message);}
   timers.push(setTimeout(renew,RENEW_CHECK_MS));
  };
  const list=async()=>{
   if(stopped)return;
   try{
    const {archive}=operator.status(),{vtxos}=await live!.indexer.getVtxos({scripts:[hex.encode(live!.pool.tree.pkScript)],spendableOnly:true});
    const found=listingsOf(vtxos,live!.genesis.token,new Set(Object.keys(archive.reserves)));
    if(found.length)await exclusive(async()=>{
     const reserves={...operator.status().archive.reserves};
     for(const f of found){
      const raw=(await live!.indexer.getVirtualTxs([f.coin.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===f.coin.txid);
      if(!raw)continue;
      reserves[f.assetId]={txid:f.coin.txid,vout:f.coin.vout,value:f.coin.value,sourceTxHex:hex.encode(raw.toBytes(true,true)),amount:String(f.amount)};
      log(`listed asset ${f.assetId} with ${f.amount} units at ${f.coin.txid}:${f.coin.vout}`);
     }
     await operator.relocate({head:operator.status().archive.head,reserves});
    });
   }catch(error){note('listing: '+(error as Error).message);}
   timers.push(setTimeout(list,LIST_CHECK_MS));
  };
  const start=()=>{void tick();void pad();void renew();void list();};
  // A batch started before the leftover intent clears would only be refused, and its deposits dropped.
  if(existsSync(renewalPath))void exclusive(settleRenewal).catch(error=>note('renewal: '+(error as Error).message)).finally(start);else start();
 }

 return {
  status:():RollupStatus=>{
   if(!live)return status;
   const {operator,genesis,address,network,pool}=live,{archive}=operator.status();
   return {...status,network,pool:{token:genesis.token,address,script:hex.encode(pool.tree.pkScript),batches:archive.batches,root:String(operator.state.latestRoot()),head:{txid:archive.head.txid,vout:archive.head.vout,value:archive.head.value},pending:operator.pending(),padding:operator.padding(),
    reserves:Object.fromEntries(Object.entries(archive.reserves).map(([assetId,reserve])=>[assetId,reserve.amount]))}};
  },
  /** Advances setup by one step; once ready, the batch, padding and renewal loops run on their own. */
  step:async()=>{
   if(live||stopped)return;
   try{
    if(!ensureKeys())return;
    const path=join(o.directory,'genesis.json'),known=existsSync(path)?readJson<Genesis>(path):undefined;
    const network=await preflightStockMutinynet({...o.endpoints,...(known?{expected:{serverKey:known.serverKey,emulatorKey:known.emulatorKey}}:{})});
    const saved=known??await genesis(network);
    if(saved)await open(network,saved);
   }catch(error){
    // A deploy starts the new instance before stopping the old one, which still holds the pool's journal.
    const locked=isStorageLocked(error);
    status=locked?{...status,message:'Waiting for the previous instance to release the pool.'}:{...status,phase:status.phase==='starting'?'blocked':status.phase,message:(error as Error).message};
    log(status.message);
   }
  },
  ready:()=>!!live,
  keyFile:(name:string)=>manifest&&(['spend.wasm','spend.zkey','spend.vkey.json'] as const).find(file=>file===name)?join(keys,name):undefined,
  batches:(from:number,limit:number)=>{
   const total=live?.operator.status().archive.batches??0,to=Math.min(total,from+limit),list:RollupRecord[]=[];
   for(let n=from;n<to;n++)list.push(readJson<RollupRecord>(join(o.directory,'operator','batches',`${n}.json`)));
   return {from,total,batches:list};
  },
  /** Fills a deposit coin from the indexer; the client names the outpoint and the tree that locks it. */
  depositCoin:resolveCoin,
  submit:async(spend:Omit<RollupSpend,'receivedAt'>,coin?:CoinRef)=>{
   if(!live)throw new Error('The rollup pool is not open yet.');
   if(tracked.has(spend.id))throw new Error('Duplicate rollup spend id.');
   await live.operator.submit(spend);
   const record={status:'pending' as const,nullifier:String(spend.slot.nullifiers[0]),at:Date.now()};
   tracked.set(spend.id,record);store.save({id:spend.id,...record,spend:encodeSpend(spend,coin)});
  },
  spend:(id:string):RollupSpendStatus|undefined=>{
   const s=sessions.get(id),t=tracked.get(id);
   if(s&&!s.signed)return {status:'signing',arkTx:s.arkTx,checkpoint:s.checkpoints[s.vin]!,checkpoints:s.checkpoints,vin:s.vin};
   if(!t)return undefined;
   const {nullifier:_n,at:_a,...rest}=t;return rest;
  },
  sign:(id:string,signed:{arkTx:string;checkpoint:string})=>{
   const s=sessions.get(id);
   if(!s||s.signed)throw new Error('This spend has no open signing round.');
   const same=(a:string,b:string)=>Transaction.fromPSBT(base64.decode(a)).id===Transaction.fromPSBT(base64.decode(b)).id;
   if(!same(signed.arkTx,s.arkTx)||!same(signed.checkpoint,s.checkpoints[s.vin]!))throw new Error('The signed transactions are not this batch.');
   s.signed=signed;
  },
  close:()=>{stopped=true;for(const t of timers)clearTimeout(t);setup?.kill();live?.operator.close();},
 };
}
export type RollupService=Awaited<ReturnType<typeof openRollupService>>;
