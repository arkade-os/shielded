import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs,{existsSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {ArkAddress,EmulatorPacket,Extension,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {RawWitness} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {RollupAccount,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {statementOf} from '../packages/protocol/src/rollup/notes.ts';
import type {RollupNullifiers} from '../packages/protocol/src/rollup/nullifiers.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {ROLLUP_STATE_PACKET,rollupEpochPoolTree,rollupWitness,type RollupLeaves,type SnarkProof} from '../src/rollup/covenant.ts';
import {encodeEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';
import {chainOnlyBatch,readBatchTx} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupSpecOf} from '../src/rollup/service.ts';
import {recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import {cachedBatchNumbers,cacheBatch,cacheEpochArchive,catchUpCachedBatches,epochMirrorStart,mirrorStart,replayEpochMirror} from '../tools/rollup-cache.ts';
import {bakedPool,epochRecord,listen,scratch} from './fixtures/epoch-service.ts';

const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const leaves:RollupLeaves={batch:Uint8Array.of(0x51),batchJoin:Uint8Array.of(0x52),reserve:Uint8Array.of(0x53),renew:Uint8Array.of(0x54)};
const proof:SnarkProof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1']};
const le32=(value:bigint)=>Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
const account=()=>RollupAccount.owning(hash,{ask:1n,nk:2n,viewSecret:new Uint8Array(32).fill(3)});
const read=(dir:string,index:number)=>JSON.parse(readFileSync(join(dir,'batches',`${index}.json`),'utf8')) as PublishedBatch;
function directory(t:{after(fn:()=>void):void}){
 const dir=mkdtempSync(join(tmpdir(),'rollup-fallback-cache-'));mkdirSync(join(dir,'batches'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;
}
function chain(){
 const state=RollupState.genesis(hash),records:PublishedBatch[]=[],txs:Transaction[]=[],commitments:bigint[]=[];
 for(let n=0;n<5;n++){
  const slots=Array.from({length:BATCH_SLOTS},(_,i)=>({root:state.latestRoot(),nullifiers:[BigInt(n*BATCH_SLOTS+i+1)],commitments:[BigInt(n*64+i*2+1),BigInt(n*64+i*2+2)] as [bigint,bigint],ctDigest:0n,groupId:0n,groupSize:0}));
  const publics=slots.map(slot=>[statementOf(hash,{domain:ROLLUP_DOMAIN,...slot}),slot.nullifiers[0]!,0n,0n,0n,0n,0n]),result=state.apply('spend',slots);
  const ext=Extension.create([EmulatorPacket.create([{vin:0,script:leaves.batch,witness:RawWitness.encode(rollupWitness(proof,publics.map(publics=>({proof,publics}))))}]),new UnknownPacket(ROLLUP_STATE_PACKET,Uint8Array.from([...le32(state.commitment()),...le32(result.daRoot),...le32(result.blockRoot)]))]);
  const tx=new Transaction({allowUnknownOutputs:true});tx.addInput({txid:txs.at(-1)?.id??'ab'.repeat(32),index:0});tx.addOutput({script:Uint8Array.of(0x51,0x20,...new Uint8Array(32).fill(7)),amount:1000n});tx.addOutput(ext.txOut());
  records.push({kind:'spend',txid:tx.id,at:n,slots:slots.map((slot,i)=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:slot.commitments.map(String) as [string,string],ctDigest:'0',groupId:'0',groupSize:0,publics:publics[i]!.map(String)}))});
  txs.push(tx);commitments.push(state.commitment());
 }
 return {records,txs,commitments};
}
const fixture=chain();
/** Five epoch records at epochLen 2: batches 2 and 4 rotate, closing epochs 0 and 1, whose frozen sets come back too. */
function epochChain(){
 const state=EpochState.genesis(hash,2,false),records:RollupEpochRecord[]=[],frozen:RollupNullifiers[]=[];
 for(let n=0;n<5;n++){
  const record:RollupEpochRecord={kind:'spend',slots:Array.from({length:BATCH_SLOTS},(_,i)=>({anchor:'1',rCur:{epoch:state.epoch,root:'1'},nullifiers:[String(n*BATCH_SLOTS+i+1)],commitments:[String(2*i+1),String(2*i+2)] as [string,string],ctDigest:'0',groupId:'0',groupSize:0,publics:[]})),noteBlockRoot:String(n+1),at:n};
  const epoch=state.epoch;state.applyFromChain(record.kind,record.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(record.noteBlockRoot));
  if(state.epoch>epoch)frozen.push(state.prevNfSet);
  records.push(record);
 }
 return {records,frozen:frozen as [RollupNullifiers,RollupNullifiers]};
}
const epochFixture=epochChain();
const cacheEpoch=(dir:string,records:RollupEpochRecord[],from=0)=>records.forEach((record,i)=>cacheBatch(dir,from+i,record as unknown as PublishedBatch));
const run=promisify(execFile);

test('stale mirror catch-up persists every recovered batch at its actual index and restarts without gaps',async t=>{
 const dir=directory(t),replica=account();cacheBatch(dir,0,fixture.records[0]!);await replica.apply(fixture.records[0]!);
 const next=new Map(fixture.txs.slice(0,-1).map((tx,i)=>[tx.id,fixture.txs[i+1]!]));
 assert.equal(await catchUpCachedBatches(dir,replica,leaves,fixture.txs[0]!.id,fixture.commitments[3]!,async head=>next.get(head.txid)),3);
 assert.deepEqual(cachedBatchNumbers(dir),[0,1,2,3]);assert.equal(replica.batchCount,4);
 for(let i=1;i<4;i++){assert.equal(read(dir,i).txid,fixture.txs[i]!.id);assert.equal(read(dir,i).noteBlockRoot,String(readBatchTx(fixture.txs[i]!,leaves).noteBlockRoot));}
 cacheBatch(dir,replica.batchCount,fixture.records[4]!);assert.deepEqual(read(dir,0),fixture.records[0]);
 const restarted=account();for(const i of cachedBatchNumbers(dir))await restarted.apply(read(dir,i));
 assert.equal(restarted.batchCount,5);assert.equal(restarted.state.commitment(),fixture.commitments[4]);
});

test('mirror refetches chain-only placeholders and preserves existing full records',t=>{
 const dir=directory(t);cacheBatch(dir,0,fixture.records[0]!);
 cacheBatch(dir,1,{...chainOnlyBatch(readBatchTx(fixture.txs[1]!,leaves)),txid:fixture.txs[1]!.id});
 cacheBatch(dir,2,fixture.records[2]!);assert.equal(mirrorStart(dir),1);
 const full=readFileSync(join(dir,'batches','0.json'),'utf8');cacheBatch(dir,0,{...chainOnlyBatch(readBatchTx(fixture.txs[0]!,leaves)),txid:fixture.txs[0]!.id});
 assert.equal(readFileSync(join(dir,'batches','0.json'),'utf8'),full);
 cacheBatch(dir,1,fixture.records[1]!);assert.equal(read(dir,1).noteBlockRoot,undefined);assert.equal(mirrorStart(dir),3);
 cacheBatch(dir,2,fixture.records[2]!);cacheBatch(dir,3,fixture.records[3]!);assert.equal(mirrorStart(dir),4);
});

test('conflicting indexes and placeholder public inputs cannot overwrite cached records',t=>{
 const dir=directory(t);cacheBatch(dir,0,fixture.records[0]!);
 const original=readFileSync(join(dir,'batches','0.json'),'utf8');assert.throws(()=>cacheBatch(dir,0,fixture.records[1]!),/conflict/i);
 assert.equal(readFileSync(join(dir,'batches','0.json'),'utf8'),original);assert.throws(()=>cacheBatch(dir,2,fixture.records[2]!),/gap/i);
 const placeholder={...chainOnlyBatch(readBatchTx(fixture.txs[1]!,leaves)),txid:fixture.txs[1]!.id};cacheBatch(dir,1,placeholder);
 const tampered=structuredClone(fixture.records[1]!);tampered.slots[0]!.publics![1]='999';assert.throws(()=>cacheBatch(dir,1,tampered),/conflict/i);assert.deepEqual(read(dir,1),placeholder);
});

test('mirror preserves an existing full record when only the publication timestamp differs',t=>{
 const dir=directory(t);cacheBatch(dir,0,fixture.records[0]!);const original=readFileSync(join(dir,'batches','0.json'),'utf8');
 cacheBatch(dir,0,{...fixture.records[0]!,at:999});assert.equal(readFileSync(join(dir,'batches','0.json'),'utf8'),original);
 for(const field of ['commitments','ciphertext'] as const){
  const altered=structuredClone(fixture.records[0]!);if(field==='commitments')altered.slots[0]!.commitments[0]='999';else altered.slots[0]!.ciphertext='01';
  assert.throws(()=>cacheBatch(dir,0,altered),/conflict/i);assert.equal(readFileSync(join(dir,'batches','0.json'),'utf8'),original);
 }
});

test('a failed chain walk preserves the existing mirror and cannot publish a partial catch-up',async t=>{
 const dir=directory(t),replica=account();cacheBatch(dir,0,fixture.records[0]!);await replica.apply(fixture.records[0]!);
 await assert.rejects(catchUpCachedBatches(dir,replica,leaves,fixture.txs[0]!.id,fixture.commitments[3]!,async head=>head.txid===fixture.txs[0]!.id?fixture.txs[1]:undefined),/chain stops/i);
 assert.deepEqual(cachedBatchNumbers(dir),[0]);assert.deepEqual(read(dir,0),fixture.records[0]);
});

test('a sparse cache is rejected before mirror resume or another append',t=>{
 const dir=directory(t);cacheBatch(dir,0,fixture.records[0]!);writeFileSync(join(dir,'batches','2.json'),JSON.stringify(fixture.records[2]));
 assert.throws(()=>mirrorStart(dir),/gap/i);assert.throws(()=>cacheBatch(dir,3,fixture.records[3]!),/gap/i);
});

test('backup and temporary filenames do not count as mirrored batches',t=>{
 const dir=directory(t);cacheBatch(dir,0,fixture.records[0]!);
 for(const name of ['1','1.json.tmp','01.json'])writeFileSync(join(dir,'batches',name),'backup');
 assert.deepEqual(cachedBatchNumbers(dir),[0]);assert.equal(mirrorStart(dir),1);
});

for(const upgrade of [false,true])test(`an interrupted ${upgrade?'upgrade preserves the old record':'append publishes no record'} and removes its temporary file`,t=>{
 const dir=directory(t),path=join(dir,'batches','0.json'),originalWrite=fs.writeFileSync;
 if(upgrade)cacheBatch(dir,0,{...chainOnlyBatch(readBatchTx(fixture.txs[0]!,leaves)),txid:fixture.txs[0]!.id});
 const old=upgrade?readFileSync(path,'utf8'):undefined;
 t.mock.method(fs,'writeFileSync',(file:fs.PathOrFileDescriptor,data:string|NodeJS.ArrayBufferView,options?:fs.WriteFileOptions)=>{
  originalWrite(file,String(data).slice(0,20),options);throw new Error('interrupted cache write');
 });
 syncBuiltinESMExports();
 try{assert.throws(()=>cacheBatch(dir,0,fixture.records[0]!),/interrupted cache write/);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 if(upgrade)assert.equal(readFileSync(path,'utf8'),old);else assert.equal(existsSync(path),false);
 assert.deepEqual(readdirSync(join(dir,'batches')),upgrade?['0.json']:[]);
});

test('an append cannot replace a competing record published during its temporary write',t=>{
 const dir=directory(t),path=join(dir,'batches','0.json'),originalWrite=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file:fs.PathOrFileDescriptor,data:string|NodeJS.ArrayBufferView,options?:fs.WriteFileOptions)=>{
  originalWrite(file,data,options);originalWrite(path,JSON.stringify(fixture.records[1]!),{flag:'wx'});
 });
 syncBuiltinESMExports();
 try{assert.throws(()=>cacheBatch(dir,0,fixture.records[0]!),(error:NodeJS.ErrnoException)=>error.code==='EEXIST');}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(read(dir,0),fixture.records[1]);assert.deepEqual(readdirSync(join(dir,'batches')),['0.json']);
});

test('an upgrade refuses a competing full record published during its temporary write',t=>{
 const dir=directory(t),path=join(dir,'batches','0.json'),originalWrite=fs.writeFileSync;
 cacheBatch(dir,0,{...chainOnlyBatch(readBatchTx(fixture.txs[0]!,leaves)),txid:fixture.txs[0]!.id});
 t.mock.method(fs,'writeFileSync',(file:fs.PathOrFileDescriptor,data:string|NodeJS.ArrayBufferView,options?:fs.WriteFileOptions)=>{
  originalWrite(file,data,options);originalWrite(path,JSON.stringify(fixture.records[1]!));
 });
 syncBuiltinESMExports();
 try{assert.throws(()=>cacheBatch(dir,0,fixture.records[0]!),/conflict/i);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(read(dir,0),fixture.records[1]);assert.deepEqual(readdirSync(join(dir,'batches')),['0.json']);
});

test('a mirror refuses a truncated, a bit-flipped and a wrong-epoch archive before writing it',t=>{
 const dir=directory(t),[nf0,nf1]=epochFixture.frozen;cacheEpoch(dir,epochFixture.records);
 const state=replayEpochMirror(dir,hash,2),good=encodeEpochNfArchive(1,nf1),flipped=Buffer.from(good);flipped[20]!^=1;
 const refused:[string,Buffer,number][]=[['truncated',good.subarray(0,-1),1],['bit-flipped',flipped,1],["epoch 0's file",encodeEpochNfArchive(0,nf0),1],
  ["epoch 0's set labelled as epoch 1's",encodeEpochNfArchive(1,nf0),1],['an epoch the records leave open',encodeEpochNfArchive(2,nf1),2]];
 for(const [label,bytes,epoch] of refused){
  assert.throws(()=>cacheEpochArchive(dir,state,epoch,bytes,hash),/does not rebuild the root|not closed/,label);
  assert.deepEqual(readdirSync(join(dir,'nullifiers')),[],label);
 }
 for(const [epoch,set] of [[0,nf0],[1,nf1]] as const){
  cacheEpochArchive(dir,state,epoch,encodeEpochNfArchive(epoch,set),hash);
  assert.deepEqual(readFileSync(join(dir,'nullifiers',`epoch-${epoch}.nf`)),encodeEpochNfArchive(epoch,set));
 }
});

test('an epoch mirror resumes where it stopped instead of re-fetching every batch',async t=>{
 const dir=directory(t),blank=(r:RollupEpochRecord)=>({...r,slots:r.slots.map(s=>({...s,commitments:['0','0'] as [string,string]}))});
 cacheEpoch(dir,epochFixture.records.slice(0,3));
 assert.deepEqual([mirrorStart(dir),epochMirrorStart(dir)],[0,3],'every epoch record carries noteBlockRoot');
 cacheEpoch(dir,[blank(epochFixture.records[3]!),epochFixture.records[4]!],3);
 assert.equal(epochMirrorStart(dir),5,'a chain-only record the pool served is final');
 // The real CLI against a pool whose batch 128 was followed chain-only.
 const record=epochRecord(64),full=(n:number)=>{const r=record(n);return n===128?r:{...r,slots:r.slots.map((s,i)=>({...s,commitments:[String(n+1),String(i+1)] as [string,string]}))};};
 const {directory:pool,service}=await bakedPool({epochLen:64,batches:130,record:full}),request=await listen(service),froms:number[]=[],files:string[]=[],{batches,archiveFile}=service;
 service.batches=(from,limit)=>{froms.push(from);return batches(from,limit);};
 // As a pool that rotates while the mirror runs lists it: the mirrored records leave epoch 2 open.
 service.archiveEpochs=()=>[0,1,2];
 // Keep-alive ends while the CLI replays after epoch 0, as it does under load, so its next fetch meets a dead pooled socket.
 service.archiveFile=name=>{files.push(name);if(name==='epoch-0.nf')setTimeout(()=>request.server.closeIdleConnections(),300);return archiveFile(name);};
 const base=`http://127.0.0.1:${(request.server.address() as AddressInfo).port}`,mirror=scratch('rollup-epoch-mirror-'),served=join(pool,'operator','nullifiers','epoch-0.nf'),good=readFileSync(served);
 const fallback=()=>run(process.execPath,['--import','tsx','tools/rollup-fallback.ts','mirror',base,mirror]);
 writeFileSync(served,good.map((b,i)=>i===20?b^1:b));
 await assert.rejects(fallback(),(error:{stderr:string})=>['refused archive 0: .*does not rebuild the root epoch 0 archived','skipped archive 2','no archive file for closed epoch 0'].every(line=>new RegExp(line).test(error.stderr)));
 assert.deepEqual([froms,files,readdirSync(join(mirror,'nullifiers'))],[[0,100],['epoch-0.nf','epoch-1.nf'],['epoch-1.nf']],'the tampered archive is never written, and the one after it still is');
 writeFileSync(served,good);froms.length=0;files.length=0;
 await fallback();
 assert.deepEqual([froms,files],[[130],['epoch-0.nf']],'the second run fetches no batch again, since the pool served 128 chain-only, and only the archive it lacks');
 assert.equal(cachedBatchNumbers(mirror).length,130);
 for(const name of ['epoch-0.nf','epoch-1.nf'])assert.deepEqual(readFileSync(join(mirror,'nullifiers',name)),readFileSync(join(pool,'operator','nullifiers',name)),name);
 assert.equal(readFileSync(join(mirror,'spec.json'),'utf8'),readFileSync(join(pool,'spec.json'),'utf8'),'the epoch spec, as the pool wrote its own');
 const mirrored=JSON.parse(readFileSync(join(mirror,'pool.json'),'utf8')),{network}=mirrored,leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(mirror,'spec.json'));
 assert.deepEqual([Object.keys(mirrored).sort(),mirrored.epochLen],[['epochLen','network','operator','script','token'],64]);
 assert.equal(hex.encode(rollupEpochPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay).tree.pkScript),mirrored.script,'the mirrored spec and keys rebuild the pool script');
});

test('a mirror fetches again only the placeholders its own chain walk wrote, never a chain-only record the pool served',t=>{
 const dir=directory(t),stamped=epochFixture.records.map((r,i)=>({...r,txid:String(i+1).padStart(64,'0')})),bare=(r:RollupEpochRecord)=>({...r,slots:r.slots.map(s=>({...s,commitments:['0','0'] as [string,string]}))});
 const {at:_,...walked}=bare(stamped[3]!);
 cacheEpoch(dir,[stamped[0]!,bare(stamped[1]!),stamped[2]!,walked,stamped[4]!]);
 assert.equal(epochMirrorStart(dir),3,'the walk\'s placeholder at 3, not the pool\'s own chain-only batch 1');
 cacheEpoch(dir,[bare(stamped[3]!)],3);
 assert.equal(epochMirrorStart(dir),5,'the pool\'s chain-only record replaces the placeholder, and is final');
 const upgraded=directory(t);cacheEpoch(upgraded,[...stamped.slice(0,3),walked]);
 cacheEpoch(upgraded,[stamped[3]!],3);cacheEpoch(upgraded,[walked],3);cacheEpoch(upgraded,[bare(stamped[3]!)],3);
 assert.deepEqual([read(upgraded,3),epochMirrorStart(upgraded)],[stamped[3],4],'a full record replaces it, and no chain-only record ever replaces a full one');
});

test('withdraw on an epoch mirror never writes the classic spec over its own',async t=>{
 const dir=directory(t),spec=JSON.stringify(rollupSpecOf('epoch','cc'.repeat(32)+'0000','aa'.repeat(32))),to=new ArkAddress(new Uint8Array(32).fill(1),new Uint8Array(32).fill(2),'tark').encode();
 writeFileSync(join(dir,'pool.json'),JSON.stringify({token:'cc'.repeat(32)+'0000',operator:'aa'.repeat(32),script:'5120'+'00'.repeat(32),network:{},epochLen:4}));writeFileSync(join(dir,'spec.json'),spec);
 await assert.rejects(run(process.execPath,['--import','tsx','tools/rollup-fallback.ts','withdraw',dir,'1000',to],{env:{...process.env,SHIELDED_PHRASE:recoveryPhraseOf('11'.repeat(32))}}));
 assert.equal(readFileSync(join(dir,'spec.json'),'utf8'),spec);
});
