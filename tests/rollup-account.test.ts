import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {assetFieldOfId,destinationFieldOf,noteOf,statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeys2(byte.repeat(32),'mutinynet');
const [aliceKeys,bobKeys,padKeys]=[keys('11'),keys('22'),keys('33')];
const [aliceTo,bobTo,padTo]=[aliceKeys,bobKeys,padKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));

const published=({witness,ciphertext}:BuiltSpend)=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:'0',groupSize:0,ciphertext:hex.encode(ciphertext)});
async function batchOf(root:bigint,spends:BuiltSpend[]):Promise<PublishedBatch> {
 const padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{}})));
 return {kind:'spend',slots:[...spends,...padding].map(published)};
}

test('a deposit, a transfer and a withdrawal move notes between replicas that agree on the state',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys),bob=RollupAccount.owning(hash,bobKeys);
 const apply=async(batch:PublishedBatch)=>{await alice.apply(batch);await bob.apply(batch);assert.equal(alice.state.commitment(),bob.state.commitment());};

 const deposit=await alice.spend({deposit:1000n},aliceTo);
 assert.deepEqual(deposit.witness.publicSignals.slice(1),[1000n,0n,0n,0n]);
 assert.equal(deposit.witness.publicSignals[0],statementOf(hash,{domain:ROLLUP_DOMAIN,...deposit.witness.slot}));
 await apply(await batchOf(alice.state.latestRoot(),[deposit]));
 assert.equal(alice.balance(),1000n);assert.equal(bob.balance(),0n);
 const [note]=alice.notes();
 assert.equal(note!.index,0);
 assert.equal(alice.state.notes.node(0,note!.index),noteOf(hash,ROLLUP_DOMAIN,1000n,0n,alice.owner,note!.rho));

 await assert.rejects(alice.spend({input:note!,to:{recipient:bobTo,amount:1001n}},aliceTo),/does not balance/);
 const transfer=await alice.spend({input:note!,to:{recipient:bobTo,amount:300n}},aliceTo);
 assert.equal(transfer.change,700n);
 assert.deepEqual(transfer.witness.publicSignals.slice(1),[0n,0n,0n,0n]);
 await apply(await batchOf(alice.state.latestRoot(),[transfer]));
 assert.equal(alice.balance(),700n);assert.equal(bob.balance(),300n);
 assert.ok(!alice.notes().some(n=>n.nullifier===note!.nullifier));
 assert.equal(bob.notes()[0]!.index,32);

 const program=hex.decode('ab'.repeat(32));
 await assert.rejects(bob.spend({input:bob.notes()[0]!,withdraw:100n},bobTo),/payout program/);
 const withdrawal=await bob.spend({input:bob.notes()[0]!,withdraw:100n,program},bobTo);
 assert.deepEqual(withdrawal.witness.publicSignals.slice(1),[0n,100n,0n,destinationFieldOf(program)]);
 await apply(await batchOf(bob.state.latestRoot(),[withdrawal]));
 assert.equal(bob.balance(),200n);assert.equal(alice.balance(),700n);
});

test('a payment larger than any single note goes out as one atomic group of notes',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys),bob=RollupAccount.owning(hash,bobKeys);
 const apply=async(batch:PublishedBatch)=>{await alice.apply(batch);await bob.apply(batch);};
 await apply(await batchOf(alice.state.latestRoot(),[await alice.spend({deposit:600n},aliceTo),await alice.spend({deposit:300n},aliceTo),await alice.spend({deposit:100n},aliceTo)]));
 assert.equal(alice.balance(),1000n);
 const single=await alice.pay(bobTo,250n,aliceTo);
 assert.equal(single.length,1,'one note covers it, so no group');
 assert.equal(single[0]!.witness.slot.groupSize,0);
 await assert.rejects(alice.pay(bobTo,1001n,aliceTo),/cover/);
 const group=await alice.pay(bobTo,850n,aliceTo);
 assert.equal(group.length,2);
 assert.ok(group.every(s=>s.witness.slot.groupSize===2&&s.witness.slot.groupId===group[0]!.witness.slot.groupId&&s.witness.slot.groupId!==0n));
 await apply(await batchOf(alice.state.latestRoot(),group));
 assert.equal(bob.balance(),850n);
 assert.equal(alice.balance(),150n);
 assert.deepEqual(alice.notes().map(n=>n.amount).sort(),[100n,50n],'the untouched note and the change remain');
});

test('an asset enters and leaves with its 330-sat BTC carrier, and moves privately inside',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys),bob=RollupAccount.owning(hash,bobKeys),x=assetFieldOfId('dd'.repeat(34)),program=hex.decode('ac'.repeat(32));
 const apply=async(batch:PublishedBatch)=>{await alice.apply(batch);await bob.apply(batch);};
 const deposit=await alice.depositAsset(x,1000n,330n,aliceTo);
 assert.deepEqual(deposit.map(s=>s.witness.publicSignals.slice(1,4)),[[1000n,0n,x],[330n,0n,0n]]);
 assert.ok(deposit.every(s=>s.witness.slot.groupSize===2&&s.witness.slot.groupId===deposit[0]!.witness.slot.groupId));
 await apply(await batchOf(alice.state.latestRoot(),deposit));
 assert.equal(alice.balance(x),1000n);assert.equal(alice.balance(),330n);
 const pay=await alice.pay(bobTo,400n,aliceTo,new Set(),x);
 assert.ok(pay.every(s=>s.witness.publicSignals[3]===0n),'a transfer shows no asset');
 await apply(await batchOf(alice.state.latestRoot(),pay));
 assert.equal(bob.balance(x),400n);assert.equal(alice.balance(x),600n);
 const out=await alice.withdrawAsset(x,250n,program,aliceTo);
 assert.deepEqual(out.map(s=>s.witness.publicSignals.slice(2,5)),[[250n,x,destinationFieldOf(program)],[330n,0n,destinationFieldOf(program)]],'the payout comes first, then its carrier');
 await apply(await batchOf(alice.state.latestRoot(),out));
 assert.equal(alice.balance(x),350n);assert.equal(alice.balance(),0n);
 await assert.rejects(alice.withdrawAsset(x,10n,program,aliceTo),/carrier/);
});

test('a record that opens under our view key but commits to another owner is not ours',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys);
 // Sealed to Alice's view key, but the commitment names Bob as owner: Alice cannot spend it.
 const forged=await buildRollupSpend(hash,{root:alice.state.latestRoot(),ask:bobKeys.ask,nk:bobKeys.nk,self:{owner:bobTo.owner,viewPublic:aliceTo.viewPublic},request:{deposit:500n}});
 await alice.apply(await batchOf(alice.state.latestRoot(),[forged]));
 assert.equal(alice.balance(),0n);
});

test('each wallet keeps a history of what moved its notes, with the batch that moved them',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys),bob=RollupAccount.owning(hash,bobKeys),x=assetFieldOfId('dd'.repeat(34)),program=hex.decode('ac'.repeat(32));
 const full=(s:BuiltSpend)=>({...published(s),groupId:String(s.witness.slot.groupId),groupSize:s.witness.slot.groupSize,publics:s.witness.publicSignals.map(String)});
 let n=0;
 const apply=async(spends:BuiltSpend[])=>{
  const root=alice.state.latestRoot(),padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{}})));
  const batch={kind:'spend' as const,slots:[...spends,...padding].map(full),txid:'aa'.repeat(31)+String(n).padStart(2,'0'),at:1000*n++};
  await alice.apply(batch);await bob.apply(batch);
 };
 await apply([await alice.spend({deposit:1000n},aliceTo)]);
 await apply(await alice.pay(bobTo,300n,aliceTo));
 await apply(await alice.depositAsset(x,50n,330n,aliceTo));
 await apply([await bob.spend({input:bob.notes()[0]!,withdraw:100n,program},bobTo)]);
 const view=(account:RollupAccount)=>account.history.map(e=>[e.kind,e.batch,e.amounts.map(a=>`${a.amount}${a.asset===0n?'':'x'}`).join('+')]);
 assert.deepEqual(view(alice),[['shield',0,'1000'],['send',1,'300'],['shield',2,'50x+330']]);
 assert.deepEqual(view(bob),[['receive',1,'300'],['withdraw',3,'100']]);
 assert.deepEqual([alice.history[1]!.txid,alice.history[1]!.at],['aa'.repeat(31)+'01',1000]);
 assert.equal(bob.history[1]!.destination,destinationFieldOf(program));
 assert.deepEqual(alice.history[1]!.spent,[alice.history[0]!.created[0]!.nullifier],'a send names the notes it spent');
 assert.ok(bob.txids.has('aa'.repeat(31)+'03')&&bob.txids.size===4,'every batch txid is known, mine or not');
});

test('a wallet account that keeps only the note frontier agrees with the full replica on roots, notes, history and paths',async()=>{
 const full=RollupAccount.owning(hash,aliceKeys),light=RollupAccount.owning(hash,aliceKeys,{frontier:true}),program=hex.decode('ad'.repeat(32));
 const withLegs=(s:BuiltSpend)=>({...published(s),groupId:String(s.witness.slot.groupId),groupSize:s.witness.slot.groupSize,publics:s.witness.publicSignals.map(String)});
 const apply=async(spends:BuiltSpend[])=>{
  const root=full.latestRoot(),padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{}})));
  const batch={kind:'spend' as const,slots:[...spends,...padding].map(withLegs)};
  await full.apply(batch);await light.apply(batch);
  assert.equal(light.latestRoot(),full.latestRoot());assert.equal(light.batchCount,full.batchCount);
 };
 assert.equal(light.latestRoot(),full.latestRoot(),'both start from the same genesis root');
 await apply([await full.spend({deposit:1000n},aliceTo)]);
 await apply(await full.pay(bobTo,300n,aliceTo));
 for(let i=0;i<5;i++)await apply([]);
 const note=light.notes()[0]!;
 const out=await light.spend({input:note,withdraw:330n,program},aliceTo);
 assert.deepEqual(out.witness.input.path,full.state.notes.path(note.index),'the frontier proves the note with the replica\'s path');
 assert.equal(out.witness.slot.root,full.latestRoot());
 await apply([out]);
 assert.deepEqual(light.notes(),full.notes());
 assert.deepEqual(light.history.map(e=>[e.kind,e.batch,e.slots]),full.history.map(e=>[e.kind,e.batch,e.slots]));
});

test('a wallet born at a later batch skips opening the records before it, and still tracks the tree',async()=>{
 const full=RollupAccount.owning(hash,aliceKeys),young=RollupAccount.owning(hash,aliceKeys,{frontier:true,bornAt:1});
 const apply=async(spends:BuiltSpend[])=>{
  const root=full.latestRoot(),padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{}})));
  const batch={kind:'spend' as const,slots:[...spends,...padding].map(published)};
  await full.apply(batch);await young.apply(batch);
 };
 await apply([await full.spend({deposit:400n},aliceTo)]);
 await apply([await full.spend({deposit:600n},aliceTo)]);
 assert.deepEqual(young.notes().map(n=>n.amount),[600n],'the note from before its birth is never opened');
 assert.equal(young.latestRoot(),full.latestRoot());
});

test('an asset and sats leave together: the carrier withdraws the sats, so one output holds both',async()=>{
 const alice=RollupAccount.owning(hash,aliceKeys),x=assetFieldOfId('dd'.repeat(34)),program=hex.decode('ae'.repeat(32));
 await alice.apply(await batchOf(alice.state.latestRoot(),[...await alice.depositAsset(x,1000n,330n,aliceTo),await alice.spend({deposit:2000n},aliceTo)]));
 const out=await alice.withdrawAsset(x,100n,program,aliceTo,new Set(),1500n);
 assert.deepEqual(out.map(s=>s.witness.publicSignals.slice(2,4)),[[100n,x],[1500n,0n]]);
 await assert.rejects(alice.withdrawAsset(x,100n,program,aliceTo,new Set(),329n),/at least 330/);
});
