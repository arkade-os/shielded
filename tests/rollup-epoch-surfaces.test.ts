import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {base64} from '@scure/base';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {decodeEpochScan,rotatesAt} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import {encodeEpochSnapshot,writeSnapshot} from '../src/rollup/epoch-snapshot.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import type {RollupRecord} from '../src/rollup/operator.ts';
import {rollupEpochPin} from '../src/rollup/service.ts';
import {epochHarness} from './fixtures/epoch.ts';
import {bakedPool,blockRoot,checkpoint,emulatorKey,EPOCH_POOL_KEYS,epochRecord,hash,keySet,listen,offline,POOL_KEYS,PROVING_KEYS,proof,ready,scratch,serverKey,sha,slotOf,stamp,STATUS_KEYS,until} from './fixtures/epoch-service.ts';

const {deposit}=epochHarness(hash);
// Two blocks follow the 64-block checkpoint of epoch 1, and no global batch number equals its in-epoch one.
const EPOCH_LEN=68,BATCHES=134;
const classicRecord=(n:number):RollupRecord=>({kind:'spend',slots:Array.from({length:BATCH_SLOTS},(_,s)=>({root:'0',...slotOf(n,s)})),noteBlockRoot:String(blockRoot(n)),...stamp(n)});
const fold=(level:bigint[]):bigint=>level.length===1?level[0]!:fold(Array.from({length:level.length/2},(_,i)=>hash([level[2*i]!,level[2*i+1]!])));
const roots=(first:number,count=64)=>Array.from({length:count},(_,k)=>blockRoot(first+k));
/** The checkpoint at 64 blocks from the block roots alone: only the node over all 64 is not zero. */
const filledAt64=(blockRoots:bigint[])=>Array.from({length:27},(_,u)=>String(u===6?fold(blockRoots):0n));
const checkpointPath=(path:string)=>`/api/rollup/checkpoints/${path}`;
type Pool=Record<string,any>;
const statusOf=async(request:Awaited<ReturnType<typeof listen>>)=>(await (await request('/api/rollup/status')).json()) as {proving:Record<string,unknown>;pool:Pool};
/** The note root after these block roots, from the frontier a wallet keeps rather than from the pool's own tree. */
const rootAfter=(blockRoots:bigint[])=>{const frontier=new NoteFrontier(hash);for(const root of blockRoots)frontier.appendRoot(root);return String(frontier.root());};
const landedRoot=(directory:string,n:number)=>BigInt((JSON.parse(readFileSync(join(directory,'operator','batches',`${n}.json`),'utf8')) as RollupEpochRecord).noteBlockRoot);
const accepted=(pool:Pool)=>Object.fromEntries(['batches','root','prevNoteRoot','epoch','batchesInEpoch','erCount','rsCount','nullifiers'].map(key=>[key,pool[key]]));
/** A spend opened from /status alone, as a wallet builds one: the only anchor inputs are accepted values. */
const walletSpend=(pool:Pool)=>{
 const view={epoch:pool.epoch,latestRoot:()=>BigInt(pool.root),nextAnchorRoot:()=>BigInt(rotatesAt(pool.batches,pool.epochLen)?pool.root:pool.prevNoteRoot)} as unknown as EpochState;
 const built=deposit(view,0n);
 return {id:randomBytes(16).toString('hex'),slot:built.slot,publics:built.publicSignals,proof} as never;
};

const openEpochPool=async()=>{const pool=await bakedPool({epochLen:EPOCH_LEN,batches:BATCHES,record:epochRecord(EPOCH_LEN)});return {...pool,request:await listen(pool.service)};};
let shared:ReturnType<typeof openEpochPool>|undefined;
const epochPool=()=>shared??=openEpochPool();

test('an epoch pool serves the current epoch\'s checkpoint, and a frontier built from it matches the pool',async()=>{
 const {request}=await epochPool();
 const answer=await request(checkpointPath('1/64')),body=await answer.json();
 assert.deepEqual([answer.status,answer.headers.get('cache-control')],[200,'no-store']);
 assert.deepEqual(body,{epoch:1,blocks:64,filled:filledAt64(roots(EPOCH_LEN))});
 const page=await (await request(`/api/rollup/scan?from=${EPOCH_LEN+64}`)).json(),rest=decodeEpochScan(base64.decode(page.data),page.from,EPOCH_LEN);
 assert.deepEqual(rest.map(e=>[e.batch,e.epoch,e.blockInEpoch]),[[EPOCH_LEN+64,1,64],[EPOCH_LEN+65,1,65]]);
 const frontier=NoteFrontier.at(hash,body);
 for(const entry of rest)frontier.appendRoot(entry.root);
 assert.equal(frontier.root(),BigInt((await (await request('/api/rollup/status')).json()).pool.root));
});

test('a closed epoch, a future epoch, a non-multiple of 64 and a block count past the epoch each 404',async()=>{
 const {request}=await epochPool();
 assert.equal((await request(checkpointPath('1/64'))).status,200,'the same pool serves its current epoch');
 const refused={'a closed epoch':['0/64','0/128'],'a future epoch':['2/64','9999999999/64'],'a non-multiple of 64':['1/0','1/1','1/63','1/65','1/66'],'a block count past the epoch':['1/128','1/192']};
 for(const [why,paths] of Object.entries(refused))for(const path of paths){
  const answer=await request(checkpointPath(path));
  assert.equal(answer.status,404,`${why}: ${path}`);
  assert.equal(typeof (await answer.json()).error,'string',path);
 }
});

test('a classic pool answers /checkpoints/:blocks exactly as today and 404s the two-segment form',async()=>{
 const {service}=await bakedPool({batches:64,record:classicRecord}),request=await listen(service);
 const answer=await request(checkpointPath('64')),body=await answer.json();
 assert.deepEqual([answer.status,Object.keys(body)],[200,['blocks','filled']]);
 assert.deepEqual(body,{blocks:64,filled:filledAt64(roots(0))});
 for(const path of ['0','63','128'])assert.equal((await request(checkpointPath(path))).status,404,path);
 for(const path of ['0/64','1/64','0/0'])assert.equal((await request(checkpointPath(path))).status,404,path);
 assert.equal(service.checkpointAt(0,64),undefined);
});

test('an epoch pool still 404s the one-segment form',async()=>{
 const {request,service}=await epochPool();
 for(const blocks of [64,128])assert.equal((await request(checkpointPath(String(blocks)))).status,404,String(blocks));
 assert.equal(service.checkpoint(64),undefined);
});

test('a batch that is applied but not yet accepted is not in the checkpoint',async()=>{
 const {net,directory,service}=await bakedPool({epochLen:64,batches:63,record:epochRecord(64)}),request=await listen(service);
 assert.equal((await request(checkpointPath('0/64'))).status,404,'63 of 64 blocks');
 const empty=EpochState.genesis(hash,64,false),mirror={epoch:0,nextAnchorRoot:()=>empty.prevNoteRoot,latestRoot:()=>BigInt(service.status().pool!.root)} as unknown as EpochState;
 const held=net.hold(),built=deposit(mirror,0n);
 try{
  await service.submit({id:randomBytes(16).toString('hex'),slot:built.slot,publics:built.publicSignals,proof} as never);
  await until('the batch reaches the transport',()=>held.reached,net);
  assert.deepEqual([service.status().pool!.batches,(await request(checkpointPath('0/64'))).status],[63,404]);
 }finally{held.release();}
 await until('the batch lands',()=>service.status().pool!.batches===64,net);
 const landed=JSON.parse(readFileSync(join(directory,'operator','batches','63.json'),'utf8')) as RollupEpochRecord,answer=await request(checkpointPath('0/64'));
 assert.deepEqual([answer.status,await answer.json()],[200,{epoch:0,blocks:64,filled:filledAt64([...roots(0).slice(0,63),BigInt(landed.noteBlockRoot)])}]);
});

test('an epoch pool reopened from a mid-epoch snapshot serves its scan and its checkpoint from the restored tree',async()=>{
 const record=epochRecord(64),replica=EpochState.genesis(hash,64,false);
 let mid!:EpochState;
 for(let n=0;n<64;n++){
  if(n===32)mid=replica.clone();
  const r=record(n);replica.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));
 }
 const {service}=await bakedPool({epochLen:64,batches:64,record,committed:replica.commitment(),prepare:async({directory,saved})=>{
  const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json'));
  writeSnapshot(join(directory,'operator','snapshot.bin'),encodeEpochSnapshot(mid,rollupEpochPin({leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey,emulatorKey})));
  const path=join(directory,'operator','batches','5.json'),file=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path,JSON.stringify({...file,noteBlockRoot:String(BigInt(file.noteBlockRoot)+1n)}));
 }});
 // A replay from genesis reads batch 5's file and fails to open, so the pool opening means batches 0-31 came from the snapshot.
 assert.throws(()=>service.scan(0,64),/Batch 5's recorded block root/);
 assert.equal(service.status().pool!.root,rootAfter(roots(0,64)),'the accepted root comes from the restored tree and the replay after it');
 assert.deepEqual(decodeEpochScan(base64.decode(service.scan(6,58).data),6,64).map(e=>e.root),roots(0).slice(6));
 assert.deepEqual(service.checkpointAt(0,64),{epoch:0,blocks:64,filled:filledAt64(roots(0))});
});

const openClassic=async()=>{const service=await ready(offline(),scratch('rollup-classic-status-'),keySet('classic'));return {service,request:await listen(service)};};
let classic:ReturnType<typeof openClassic>|undefined;
const classicPool=()=>classic??=openClassic();

test('an epoch /status carries epoch, epochLen, batchesInEpoch, erCount, rsCount and nullifiers',async()=>{
 const {request}=await epochPool(),{pool}=await statusOf(request),recoveries=BATCHES-EPOCH_LEN;
 // The sentinel leaf counts in both sets, and epoch 1 holds recoveries only.
 assert.deepEqual([pool.epoch,pool.epochLen,pool.batchesInEpoch,pool.erCount,pool.rsCount,pool.nullifiers],[1,EPOCH_LEN,recoveries,1,1+recoveries,1]);
 assert.deepEqual([pool.root,pool.prevNoteRoot],[rootAfter(roots(EPOCH_LEN,recoveries)),rootAfter(roots(0,EPOCH_LEN))]);
 assert.deepEqual(Object.keys(pool).sort(),[...POOL_KEYS,...EPOCH_POOL_KEYS].sort());
 assert.equal(typeof pool.heapBytes,'number');
});

test('a classic /status key set is unchanged',async()=>{
 const {request}=await classicPool(),status=await statusOf(request);
 assert.deepEqual([Object.keys(status).sort(),Object.keys(status.pool).sort(),Object.keys(status.proving).sort()],[STATUS_KEYS,POOL_KEYS,PROVING_KEYS]);
});

test('an epoch /status advertises batchRecover; a classic one does not',async()=>{
 const pair=(c:string)=>({wasm:sha(`${c}.wasm`),zkey:sha(`${c}.zkey`)}),{request}=await epochPool(),{proving}=await statusOf(request);
 assert.deepEqual(proving,{spend:pair('epoch-spend'),join:pair('epoch-join'),batch:pair('epoch-batch-spend'),batchJoin:pair('epoch-batch-join'),batchRecover:pair('epoch-batch-recover')});
 const key=await request('/api/rollup/proving/epoch-batch-recover.zkey');
 assert.deepEqual([key.status,sha(await key.text())],[200,pair('epoch-batch-recover').zkey],'the advertised hash is the served file\'s');
 assert.equal('batchRecover' in (await statusOf((await classicPool()).request)).proving,false);
});

test('status.root never moves ahead of status.batches',async()=>{
 const {net,directory,service}=await bakedPool({epochLen:64,batches:63,record:epochRecord(64)}),request=await listen(service);
 const before=(await statusOf(request)).pool,old=rootAfter(roots(0,63));
 assert.deepEqual([before.batches,before.root],[63,old]);
 const held=net.hold();
 try{
  await service.submit(walletSpend(before));
  await until('the batch reaches the transport',()=>held.reached,net);
  const during=(await statusOf(request)).pool;
  assert.deepEqual([during.batches,during.root],[63,old],'applied to the model, not yet accepted');
 }finally{held.release();}
 const seen:[number,string][]=[];
 await until('the batch lands',()=>{const {batches,root}=service.status().pool!;seen.push([batches,root]);return batches===64;},net);
 const landed=rootAfter([...roots(0,63),landedRoot(directory,63)]);
 assert.notEqual(landed,old);
 assert.deepEqual(seen.filter(([batches,root])=>!(batches===63&&root===old)&&!(batches===64&&root===landed)),[],'root and batches move together');
});

test('an epoch pool on the edge of its epoch advertises the rotation only once its batch is accepted',async t=>{
 const {net,directory,service}=await bakedPool({epochLen:64,batches:64,record:epochRecord(64)}),request=await listen(service);
 const last=rootAfter(roots(0,64)),before=(await statusOf(request)).pool;
 assert.deepEqual(accepted(before),{batches:64,root:last,prevNoteRoot:rootAfter([]),epoch:0,batchesInEpoch:64,erCount:0,rsCount:1,nullifiers:1+64*BATCH_SLOTS});
 await t.test('a rotating batch in flight serves no checkpoint, and prevNoteRoot moves exactly when it lands',async()=>{
  const held=net.hold();
  try{
   await service.submit(walletSpend(before));
   await until('the rotating batch reaches the transport',()=>held.reached,net);
   assert.deepEqual(accepted((await statusOf(request)).pool),accepted(before),'applied to the model, which has rotated, but not yet accepted');
   for(const path of ['0/64','1/64'])assert.equal((await request(checkpointPath(path))).status,404,`${path} while the rotating batch is held`);
  }finally{held.release();}
  await until('the rotating batch lands',()=>service.status().pool!.batches===65,net);
  assert.deepEqual(accepted((await statusOf(request)).pool),{batches:65,root:rootAfter([landedRoot(directory,64)]),prevNoteRoot:last,epoch:1,batchesInEpoch:1,erCount:1,rsCount:1,nullifiers:1+BATCH_SLOTS});
  for(const path of ['0/64','1/64'])assert.equal((await request(checkpointPath(path))).status,404,`${path} after it lands`);
 });
 await t.test('lastBatch.rotated is true exactly on the batch that rotated',async()=>{
  await until('the rotating batch is published',()=>service.status().pool!.lastBatch?.batch===64,net);
  assert.equal(service.status().pool!.lastBatch!.rotated,true);
  // The next spend is built from the accepted prevNoteRoot alone, so the pool admitting it is the wallet's check that the field is right.
  await service.submit(walletSpend((await statusOf(request)).pool));
  await until('the next batch is published',()=>service.status().pool!.lastBatch?.batch===65,net);
  assert.equal(service.status().pool!.lastBatch!.rotated,false);
 });
});
