import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,readFileSync,statfsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {readEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';
import {bakedPool,epochRecord,hash,keySet,listen,offline,ready,scratch,until} from './fixtures/epoch-service.ts';

// Batches 64 and 128 rotate, so epochs 0 and 1 are closed and epoch 2 is open.
const EPOCH_LEN=64,BATCHES=130,record=epochRecord(EPOCH_LEN);
const openEpochPool=async()=>{const pool=await bakedPool({epochLen:EPOCH_LEN,batches:BATCHES,record});return {...pool,request:await listen(pool.service)};};
let shared:ReturnType<typeof openEpochPool>|undefined;
const epochPool=()=>shared??=openEpochPool();
const openClassic=async()=>{const directory=scratch('rollup-classic-archives-');return {directory,request:await listen(await ready(offline(),directory,keySet('classic')))};};
let classic:ReturnType<typeof openClassic>|undefined;
const classicPool=()=>classic??=openClassic();
const archivePath=(directory:string,name:string)=>join(directory,'operator','nullifiers',name);

test('an epoch pool lists its closed epochs and serves each archive byte-identically',async()=>{
 const {directory,request}=await epochPool(),listing=await request('/api/rollup/archives');
 assert.deepEqual([listing.status,listing.headers.get('cache-control'),await listing.json()],[200,'no-store',{epochs:[0,1]}]);
 const replica=EpochState.genesis(hash,EPOCH_LEN,false),copy=join(scratch('rollup-served-archive-'),'served.nf');
 for(let n=0;n<BATCHES;n++){const r=record(n);replica.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));}
 for(const epoch of [0,1]){
  const answer=await request(`/api/rollup/archives/epoch-${epoch}.nf`),bytes=Buffer.from(await answer.arrayBuffer());
  assert.deepEqual([answer.status,answer.headers.get('content-type'),answer.headers.get('cache-control')],[200,'application/octet-stream','public, max-age=31536000, immutable'],`epoch ${epoch}`);
  assert.deepEqual(bytes,readFileSync(archivePath(directory,`epoch-${epoch}.nf`)),`epoch ${epoch}`);
  const root=replica.archive.record(epoch)?.nfFinal??replica.archive.record(epoch-1)!.nfNextFinal;
  writeFileSync(copy,bytes);
  assert.equal(readEpochNfArchive(copy,hash,{epoch,root}).root(),root,`epoch ${epoch}`);
 }
});

test('a traversal, an unknown name and a classic pool each 404',async()=>{
 const {net,directory,request}=await epochPool(),beside=(name:string)=>archivePath(directory,name);
 // A basename or a path join of the name would serve each of these.
 copyFileSync(beside('epoch-1.nf'),beside('epoch-1.nf.bak'));copyFileSync(beside('epoch-1.nf'),beside('epoch-2.nf'));writeFileSync(beside('manifest.json'),'{}');
 await until('the operator writes its snapshot',()=>existsSync(join(directory,'operator','snapshot.bin')),net);
 for(const name of ['..%2Fsnapshot.bin','..%2F..%2Fsecrets.json','epoch-1.nf.bak','manifest.json','epoch-2.nf','epoch-01.nf','epoch-9.nf']){
  const answer=await request(`/api/rollup/archives/${name}`);
  assert.deepEqual([answer.status,answer.headers.get('cache-control')],[404,'no-store'],name);
  assert.equal(typeof (await answer.json()).error,'string',name);
 }
 const {directory:classicDirectory,request:classicRequest}=await classicPool();
 mkdirSync(join(classicDirectory,'operator','nullifiers'),{recursive:true});copyFileSync(beside('epoch-0.nf'),archivePath(classicDirectory,'epoch-0.nf'));
 for(const path of ['archives','archives/epoch-0.nf']){
  const answer=await classicRequest(`/api/rollup/${path}`);
  assert.deepEqual([answer.status,typeof (await answer.json()).error],[404,'string'],`classic ${path}`);
 }
});

test('/storage reports the free and total bytes of the volume, on a classic and an epoch pool alike',async()=>{
 for(const {directory,request} of [await classicPool(),await epochPool()]){
  const answer=await request('/api/rollup/storage'),body=await answer.json(),{blocks,bsize}=statfsSync(dirname(directory));
  assert.deepEqual([answer.status,answer.headers.get('cache-control'),Object.keys(body).sort()],[200,'no-store',['freeBytes','totalBytes']]);
  assert.ok([body.freeBytes,body.totalBytes].every(n=>Number.isSafeInteger(n)&&n>0)&&body.freeBytes<=body.totalBytes,JSON.stringify(body));
  assert.equal(body.totalBytes,blocks*bsize);
 }
});
