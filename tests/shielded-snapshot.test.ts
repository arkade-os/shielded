import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupTransfer,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeys2(byte.repeat(32),'mutinynet');
const [aliceKeys,padKeys]=[keys('11'),keys('33')];
const [aliceTo,padTo]=[aliceKeys,padKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));
const published=({witness,ciphertext}:BuiltSpend)=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:'0',groupSize:0,ciphertext:hex.encode(ciphertext),publics:witness.publicSignals.map(String)});
async function batchOf(root:bigint,spends:BuiltSpend[],txid:string):Promise<PublishedBatch>{
 const padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupTransfer(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{},width:1})));
 return {kind:'spend',slots:[...spends,...padding].map(published),txid,at:1000};
}
const wallet=(bornAt=0)=>RollupAccount.owning(hash,aliceKeys,{frontier:true,bornAt});

test('a frontier survives a snapshot round-trip, root and tracked paths alike',()=>{
 const a=new NoteFrontier(hash);
 a.append([1n,2n,3n],[0,2]);
 a.append([4n,5n],[1]);
 const b=NoteFrontier.fromSnapshot(hash,a.snapshot());
 assert.equal(b.root(),a.root());
 for(const index of [0,2,33])assert.deepEqual(b.path(index),a.path(index));
 a.append([6n],[]);b.append([6n],[]);
 assert.equal(b.root(),a.root());
 assert.deepEqual(b.path(0),a.path(0));
});

test('an empty frontier round-trips to the same root, and a future version is refused',()=>{
 const a=new NoteFrontier(hash);
 assert.equal(NoteFrontier.fromSnapshot(hash,a.snapshot()).root(),a.root());
 assert.throws(()=>NoteFrontier.fromSnapshot(hash,{...a.snapshot(),v:2 as unknown as 1}),/version/i);
});

test('an account resumed from a snapshot equals continuous sync, including a later spend',async()=>{
 const live=wallet(),batches:PublishedBatch[]=[];
 for(let i=1;i<=3;i++){
  const deposits=await Promise.all([100n*BigInt(i),200n*BigInt(i)].map(amount=>live.spend({deposit:amount},aliceTo)));
  const batch=await batchOf(live.latestRoot(),deposits,String(i).repeat(64));
  batches.push(batch);await live.apply(batch);
 }
 const resumed=RollupAccount.fromSnapshot(hash,aliceKeys,live.snapshot());
 assert.equal(resumed.batchCount,live.batchCount);
 assert.equal(resumed.balance(),live.balance());
 assert.equal(resumed.latestRoot(),live.latestRoot());
 assert.deepEqual(resumed.notes().map(n=>[n.amount,n.index,n.nullifier]),live.notes().map(n=>[n.amount,n.index,n.nullifier]));
 assert.deepEqual(resumed.history.map(e=>[e.kind,e.batch,e.txid,e.at]),live.history.map(e=>[e.kind,e.batch,e.txid,e.at]));
 assert.deepEqual([...resumed.txids],[...live.txids]);
 // A spend from the resumed account must prove against the same root with the same path, or the pool rejects it.
 const note=resumed.notes()[0]!;
 const [fromResumed,fromLive]=await Promise.all([resumed.spend({input:note,withdraw:note.amount,program:new Uint8Array(32).fill(7)},aliceTo),live.spend({input:live.notes()[0]!,withdraw:note.amount,program:new Uint8Array(32).fill(7)},aliceTo)]);
 assert.equal(fromResumed.witness.slot.root,fromLive.witness.slot.root);
 assert.deepEqual(fromResumed.witness.slot.nullifiers,fromLive.witness.slot.nullifiers);
 const fourth=await batchOf(live.latestRoot(),[fromLive],'44'.repeat(32));
 await live.apply(fourth);await resumed.apply(fourth);
 assert.equal(resumed.balance(),live.balance());
 assert.equal(resumed.latestRoot(),live.latestRoot());
});

test('a snapshot is JSON-safe and carries its own version, owner and birth batch',async()=>{
 const live=wallet(2);
 await live.apply(await batchOf(live.latestRoot(),[await live.spend({deposit:500n},aliceTo)],'aa'.repeat(32)));
 const snapshot=live.snapshot();
 assert.equal(snapshot.v,1);
 assert.equal(snapshot.bornAt,2);
 assert.equal(snapshot.owner,String(live.owner));
 assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),snapshot,'every field element is a string, so JSON is lossless');
});

test('a snapshot from another key or another version is refused rather than silently adopted',async()=>{
 const live=wallet();
 await live.apply(await batchOf(live.latestRoot(),[await live.spend({deposit:500n},aliceTo)],'bb'.repeat(32)));
 const snapshot=live.snapshot();
 assert.throws(()=>RollupAccount.fromSnapshot(hash,keys('22'),snapshot),/another key/i);
 assert.throws(()=>RollupAccount.fromSnapshot(hash,aliceKeys,{...snapshot,v:2 as unknown as 1}),/version/i);
});

test('a full replica refuses to snapshot, since it keeps no frontier to restore',async()=>{
 const full=RollupAccount.owning(hash,aliceKeys);
 await full.apply(await batchOf(full.latestRoot(),[await full.spend({deposit:500n},aliceTo)],'cc'.repeat(32)));
 assert.throws(()=>full.snapshot(),/frontier/i);
});
