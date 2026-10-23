import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {base64} from '@scure/base';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {decodeEpochScan} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import type {RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {encodeEpochSnapshot} from '../src/rollup/epoch-snapshot.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import type {RollupRecord} from '../src/rollup/operator.ts';
import {rollupEpochPin} from '../src/rollup/service.ts';
import {writeSnapshot} from '../src/rollup/snapshot.ts';
import {epochHarness} from './fixtures/epoch.ts';
import {bakedPool,checkpoint,emulatorKey,hash,listen,proof,serverKey,sha,until} from './fixtures/epoch-service.ts';

const {deposit}=epochHarness(hash);
// Two blocks follow the 64-block checkpoint of epoch 1, and no global batch number equals its in-epoch one.
const EPOCH_LEN=68,BATCHES=134;
const blockRoot=(n:number)=>hash([77n,BigInt(n)]);
const slotOf=(n:number,s:number)=>({nullifiers:[String(hash([78n,BigInt(n),BigInt(s)]))],commitments:['0','0'] as [string,string],ctDigest:'0',groupId:'0',groupSize:0,publics:[] as string[]});
const stamp=(n:number)=>({txid:sha(`batch ${n}`),at:1_700_000_000_000+n*1000});
// Epoch 0 is spends; the recoveries after it are one slot wide, which keeps the replay of a second epoch cheap.
const epochRecord=(epochLen:number)=>(n:number):RollupEpochRecord=>({kind:n<epochLen?'spend':'recover',
 slots:n<epochLen?Array.from({length:BATCH_SLOTS},(_,s)=>({anchor:'0',...slotOf(n,s)})):[{anchor:'0',origin:-1,...slotOf(n,0)}],noteBlockRoot:String(blockRoot(n)),...stamp(n)});
const classicRecord=(n:number):RollupRecord=>({kind:'spend',slots:Array.from({length:BATCH_SLOTS},(_,s)=>({root:'0',...slotOf(n,s)})),noteBlockRoot:String(blockRoot(n)),...stamp(n)});
const fold=(level:bigint[]):bigint=>level.length===1?level[0]!:fold(Array.from({length:level.length/2},(_,i)=>hash([level[2*i]!,level[2*i+1]!])));
const roots=(first:number)=>Array.from({length:64},(_,k)=>blockRoot(first+k));
/** The checkpoint at 64 blocks from the block roots alone: only the node over all 64 is not zero. */
const filledAt64=(blockRoots:bigint[])=>Array.from({length:27},(_,u)=>String(u===6?fold(blockRoots):0n));
const checkpointPath=(path:string)=>`/api/rollup/checkpoints/${path}`;

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
 assert.throws(()=>service.scan(0,64),/live note tree/);
 assert.deepEqual(decodeEpochScan(base64.decode(service.scan(6,58).data),6,64).map(e=>e.root),roots(0).slice(6));
 assert.deepEqual(service.checkpointAt(0,64),{epoch:0,blocks:64,filled:filledAt64(roots(0))});
});
