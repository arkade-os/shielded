import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bech32m,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupSpend,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {decodeDisclosure,encodeDisclosure,fullViewKeyOf,incomingNotes,parseFullViewKey,parseViewKey,sentNoteOf,verifyDisclosure,viewKeyOf} from '../packages/protocol/src/rollup/disclosure.ts';
import {akOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeys2(byte.repeat(32),'mutinynet');
const [aliceKeys,bobKeys,padKeys]=[keys('11'),keys('22'),keys('33')];
const [aliceTo,bobTo,padTo]=[aliceKeys,bobKeys,padKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));
const published=({witness,ciphertext}:BuiltSpend)=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:String(witness.slot.groupId),groupSize:witness.slot.groupSize,publics:witness.publicSignals.map(String),ciphertext:hex.encode(ciphertext)});

async function world(){
 const alice=RollupAccount.owning(hash,aliceKeys),batches:PublishedBatch[]=[];
 const apply=async(spends:BuiltSpend[])=>{
  const root=alice.state.latestRoot(),padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupSpend(hash,{root,ask:padKeys.ask,nk:padKeys.nk,self:padTo,request:{}})));
  const batch:PublishedBatch={kind:'spend',slots:[...spends,...padding].map(published),txid:String(batches.length).padStart(64,'0'),at:batches.length};
  batches.push(batch);await alice.apply(batch);
 };
 await apply([await alice.spend({deposit:1000n},aliceTo)]);
 const {spends:[payment]}=await alice.pay(bobTo,300n,aliceTo);
 await apply([payment!]);
 return {alice,batches,payment:payment!};
}
const commitmentAt=(batches:PublishedBatch[])=>(index:number)=>batches[Math.floor(index/32)]?.slots[Math.floor((index%32)/2)]?.commitments[index%2];

test('a sender can reveal one private payment, and anyone can check it against the published batches',async()=>{
 const {alice,batches,payment}=await world(),bob=rollupAddressOf(bobTo);
 const note=sentNoteOf(hash,payment);
 assert.equal(note.amount,300n);
 const index=alice.locate(note,bobTo.owner);
 assert.equal(index,32,'the payment is the first output of the second batch');
 const link=encodeDisclosure({v:1,to:bob,notes:[{index,...note}]});
 const shown=decodeDisclosure(link);
 assert.deepEqual(await verifyDisclosure(hash,shown,commitmentAt(batches)),[true]);
 assert.deepEqual(await verifyDisclosure(hash,{...shown,notes:[{...shown.notes[0]!,amount:301n}]},commitmentAt(batches)),[false],'a changed amount does not verify');
 assert.deepEqual(await verifyDisclosure(hash,{...shown,to:rollupAddressOf(aliceTo)},commitmentAt(batches)),[false],'nor does another recipient');
});

test('a view key finds every note a wallet received, and nothing it could spend with',async()=>{
 const {batches}=await world(),key=viewKeyOf(bobTo.owner,bobKeys.viewSecret);
 assert.match(key,/^shview21/);
 const parsed=parseViewKey(key);
 assert.equal(parsed.owner,bobTo.owner);
 const found=await incomingNotes(hash,batches,parsed);
 assert.deepEqual(found.map(n=>[n.batch,n.amount,n.index]),[[1,300n,32]]);
 assert.deepEqual((await incomingNotes(hash,batches,parseViewKey(viewKeyOf(aliceTo.owner,aliceKeys.viewSecret)))).map(n=>n.amount),[1000n,700n],'alice sees her deposit and her change');
 assert.throws(()=>parseViewKey(rollupAddressOf(bobTo)),/view key/);
 assert.throws(()=>parseViewKey(bech32m.encode('shview',bech32m.toWords(new Uint8Array(64)),false)),/genesis.1/i);
});

test('a frontier watcher holding the full viewing key reports the same notes and history as the owner',async()=>{
 const {alice,batches}=await world(),watcher=new RollupAccount(hash,parseFullViewKey(hash,fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret)),{frontier:true});
 for(const batch of batches)await watcher.apply(batch);
 assert.deepEqual(watcher.notes().map(n=>n.index),alice.notes().map(n=>n.index));
 assert.deepEqual(watcher.history.map(h=>[h.kind,h.batch]),alice.history.map(h=>[h.kind,h.batch]));
});

test('a full viewing key sees which notes were spent, and cannot spend',async()=>{
 const {alice,batches}=await world(),key=fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret);
 assert.match(key,/^shfvk21/);
 const watcher=new RollupAccount(hash,parseFullViewKey(hash,key));
 for(const batch of batches)await watcher.apply(batch);
 assert.deepEqual(watcher.notes().map(n=>n.amount),[700n],'the 1000-sat deposit shows as spent');
 assert.deepEqual(watcher.notes(),alice.notes());
 await assert.rejects(()=>watcher.spend({input:watcher.notes()[0]!},aliceTo),/spend authority/);
 assert.throws(()=>parseFullViewKey(hash,viewKeyOf(aliceTo.owner,aliceKeys.viewSecret)),/full viewing key/);
 assert.throws(()=>parseViewKey(key),/view key/);
});

test('a full viewing key binds its nullifier key: a swapped nk derives another owner, so a watcher can tell',()=>{
 const ak=akOf(hash,aliceKeys.ask);
 assert.equal(parseFullViewKey(hash,fullViewKeyOf(ak,aliceKeys.nk,aliceKeys.viewSecret)).owner,aliceTo.owner);
 assert.notEqual(parseFullViewKey(hash,fullViewKeyOf(ak,aliceKeys.nk+1n,aliceKeys.viewSecret)).owner,aliceTo.owner);
});
