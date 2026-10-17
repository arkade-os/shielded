import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {EmulatorPacket,Extension,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {RollupAccount,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {ROLLUP_STATE_PACKET,rollupWitness,type RollupLeaves,type SnarkProof} from '../src/rollup/covenant.ts';
import {chainOnlyBatch,readBatchTx} from '../src/rollup/external.ts';
import {cachedBatchNumbers,cacheBatch,catchUpCachedBatches,mirrorStart} from '../tools/rollup-cache.ts';

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
