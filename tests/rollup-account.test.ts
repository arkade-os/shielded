import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {destinationFieldOf,noteOf,statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeyMaterial(byte.repeat(32),'mutinynet');
const [aliceKeys,bobKeys,padKeys]=[keys('11'),keys('22'),keys('33')];
const [aliceTo,bobTo,padTo]=[aliceKeys,bobKeys,padKeys].map(k=>rollupRecipientOf(hash,k.spendSecret,k.viewSecret));

const published=({witness,ciphertext}:BuiltSpend)=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:'0',groupSize:0,ciphertext:hex.encode(ciphertext)});
async function batchOf(root:bigint,spends:BuiltSpend[]):Promise<PublishedBatch> {
 const padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,spendSecret:padKeys.spendSecret,self:padTo,request:{}})));
 return {kind:'spend',slots:[...spends,...padding].map(published)};
}

test('a deposit, a transfer and a withdrawal move notes between replicas that agree on the state',async()=>{
 const alice=new RollupAccount(hash,aliceKeys),bob=new RollupAccount(hash,bobKeys);
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
 const alice=new RollupAccount(hash,aliceKeys),bob=new RollupAccount(hash,bobKeys);
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

test('a record that opens under our view key but commits to another owner is not ours',async()=>{
 const alice=new RollupAccount(hash,aliceKeys);
 // Sealed to Alice's view key, but the commitment names Bob as owner: Alice cannot spend it.
 const forged=await buildRollupSpend(hash,{root:alice.state.latestRoot(),spendSecret:bobKeys.spendSecret,self:{owner:bobTo.owner,viewPublic:aliceTo.viewPublic},request:{deposit:500n}});
 await alice.apply(await batchOf(alice.state.latestRoot(),[forged]));
 assert.equal(alice.balance(),0n);
});
