import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ActivityRegistry,ReadonlyWallet,TxType,type Activity,type ArkTransaction} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import {decodeDisclosure,sentNoteOf,verifyDisclosure} from '../packages/protocol/src/rollup/disclosure.ts';
import {EpochAccount,type EpochHistoryEntry,type EpochOwnedNote} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {destinationFieldOf} from '../packages/protocol/src/rollup/notes.ts';
import {entryForActivity,revealLinkOf,shieldedActivityResolver,shieldedRows,SHIELDED_TAG} from '../src/shielded/activity.ts';
import type {SentRecord} from '../src/shielded/repository.ts';
import {epochPool,posted} from './fixtures/epoch-pool.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const address=(byte:string)=>{const k=deriveRollupKeys2(byte.repeat(32),'mutinynet');return rollupAddressOf(rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));};
const SELF=address('11'),THEM=address('22');
const ASSET='ee'.repeat(34);
const note=(amount:bigint,nullifier:bigint,index=0,asset=0n):EpochOwnedNote=>({amount,asset,rho:5n,index,nullifier,epoch:0});
const entry=(over:Partial<EpochHistoryEntry>):EpochHistoryEntry=>({kind:'send',batch:3,epoch:0,txid:'ab'.repeat(32),at:1000,amounts:[{asset:0n,amount:500n}],spent:[7n],created:[],slots:[0],...over});
const row=(over:Partial<ArkTransaction>):ArkTransaction=>({key:{boardingTxid:'',commitmentTxid:'',arkTxid:'cd'.repeat(32)},type:TxType.TxSent,amount:900,settled:true,createdAt:2000,...over});
const assetIdOf=(field:bigint)=>field===0n?undefined:ASSET;
const indexOf=(entries:EpochHistoryEntry[],nativeDestination?:bigint)=>shieldedRows(()=>entries,assetIdOf,nativeDestination);
const activityOf=(txs:ArkTransaction[],intent?:Activity['intent']):Activity=>({id:'x',txs,amount:0,createdAt:txs[0]?.createdAt??0,settled:true,...(intent?{intent}:{})});

test('a private payment, a receipt and a merge each become one synthetic row',()=>{
 const rows=indexOf([
  entry({kind:'send'}),
  entry({kind:'receive',spent:[],created:[note(400n,9n)],amounts:[{asset:0n,amount:400n}]}),
  entry({kind:'merge',amounts:[],created:[note(900n,11n)]}),
 ]).rows();
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(r=>[r.type,r.amount,r.settled,r.tag]),[
  [TxType.TxSent,500,true,SHIELDED_TAG],
  [TxType.TxReceived,400,true,SHIELDED_TAG],
  [TxType.TxSent,0,true,SHIELDED_TAG],
 ]);
 assert.equal(rows[0]!.key.arkTxid,'ab'.repeat(32));
 assert.equal(rows[0]!.createdAt,1000);
});

test('a shield gets no synthetic row because the SDK already has one',()=>{
 assert.deepEqual(indexOf([entry({kind:'shield'})]).rows(),[]);
});

test('unknown withdrawal destinations and missing native destinations preserve the SDK-only history',()=>{
 assert.deepEqual(indexOf([entry({kind:'withdraw'})],1n).rows(),[]);
 assert.deepEqual(indexOf([entry({kind:'withdraw',destination:2n})]).rows(),[]);
 assert.deepEqual(indexOf([entry({kind:'withdraw'})]).rows(),[]);
});

test('external pool withdrawals produce negative BTC and asset-carrier activities even in one batch',async()=>{
 const entries=[entry({kind:'withdraw',destination:2n,amounts:[{asset:0n,amount:1000n}],slots:[0]}),entry({kind:'withdraw',destination:3n,amounts:[{asset:1234n,amount:9n},{asset:0n,amount:330n}],slots:[1,2]})],index=indexOf(entries,1n),activity=new ActivityRegistry();
 activity.use(shieldedActivityResolver({index,entries:()=>entries,isPoolBatch:()=>true,isListing:()=>false}));
 const items=await ReadonlyWallet.prototype.getActivityHistory.call({getTransactionHistory:async()=>index.rows(),activity} as never);
 assert.equal(items.length,2);assert.deepEqual(items.map(item=>[item.intent?.kind,item.intent?.label,item.amount]),[['unshield','Withdrawn from the pool',-1000],['unshield','Withdrawn from the pool',-330]]);
 assert.deepEqual(items[1]!.txs[0]!.assets,[{assetId:ASSET,amount:9n}]);assert.equal(new Set(items.map(item=>item.id)).size,2);
 assert.deepEqual(items.map(item=>entryForActivity(item,{index,entries})),entries);
});

test('withdrawal history survives snapshot reload and full batch replay',async()=>{
 const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret),fresh=()=>EpochAccount.owning(hash,keys,{epochLen:64}),account=fresh(),pool=epochPool(hash,64);
 const funded=pool.land('spend',[posted(await account.spend({deposit:5000n},self))]);await account.apply(funded);
 const program=new Uint8Array(32).fill(7),withdrawn=pool.land('spend',[posted(await account.spend({input:account.notes()[0],withdraw:1000n,program},self))]);await account.apply(withdrawn);
 const restored=EpochAccount.fromSnapshot(hash,keys,JSON.parse(JSON.stringify(account.snapshot())),64),replayed=fresh();await replayed.apply(funded);await replayed.apply(withdrawn);
 for(const history of [account.history,restored.history,replayed.history]){
  assert.equal(history.at(-1)!.destination,destinationFieldOf(program));const rows=indexOf(history,1n).rows();
  assert.equal(rows.length,1);assert.equal(rows[0]!.amount,1000);assert.equal(rows[0]!.type,TxType.TxSent);assert.equal(rows[0]!.key.arkTxid,withdrawn.txid);
 }
 const legacySnapshot=account.snapshot();for(const e of legacySnapshot.history)delete e.destination;
 assert.deepEqual(indexOf(EpochAccount.fromSnapshot(hash,keys,legacySnapshot,64).history,1n).rows(),[]);
});

test('an asset payment carries its units in assets, not in sats',()=>{
 const [only]=indexOf([entry({amounts:[{asset:1234n,amount:9n}]})]).rows();
 assert.equal(only!.amount,0);
 assert.deepEqual(only!.assets,[{assetId:ASSET,amount:9n}]);
});

test('each synthetic row resolves to its own entry even when a batch holds three of them',async()=>{
 const entries=[entry({kind:'send',slots:[0]}),entry({kind:'receive',spent:[],created:[note(400n,9n)],amounts:[{asset:0n,amount:400n}],slots:[1]}),entry({kind:'merge',amounts:[],created:[note(900n,11n)],slots:[2]})];
 const index=indexOf(entries);
 const rows=index.rows();
 assert.deepEqual(rows.map(r=>index.entryOf(r)?.kind),['send','receive','merge']);
 const resolver=shieldedActivityResolver({index,entries:()=>entries,isPoolBatch:()=>false,isListing:()=>false});
 assert.deepEqual(rows.map(r=>resolver.resolve(r)?.[0]?.label),['Sent privately','Received','Merged notes']);
 assert.deepEqual(rows.map(r=>resolver.resolve(r)?.[0]?.kind),['shielded-send','shielded-receive','merge']);
 const linked=shieldedActivityResolver({index,entries:()=>entries,isPoolBatch:()=>false,isListing:()=>false,isLink:()=>true});
 assert.deepEqual(rows.map(r=>[linked.resolve(r)?.[0]?.kind,linked.resolve(r)?.[0]?.label]),[['claim-link','Claim link'],['shielded-receive','Received'],['merge','Merged notes']],'only a send goes into a claim link');
 const ids=rows.map(r=>resolver.resolve(r)![0]!.groupId);
 assert.equal(new Set(ids).size,3,'one group per entry, so three rows never merge into one activity');
 for(const id of ids)assert.match(id,/^shielded:/,'namespaced so it cannot collide with an SDK group');
 const activity=new ActivityRegistry();activity.use(resolver);
 const items=await ReadonlyWallet.prototype.getActivityHistory.call({getTransactionHistory:async()=>rows,activity} as never);
 assert.equal(items.length,3);
 assert.deepEqual(items.map(item=>item.amount),[-500,400,0]);
 assert.deepEqual(items.map(item=>entryForActivity(item,{index,entries})?.kind),['send','receive','merge']);
 assert.equal(index.entryOf({...rows[0]!}),undefined,'a copied row cannot open an unrelated entry');
 const newRows=index.rows();
 assert.equal(index.entryOf(rows[0]!),entries[0],'reading fresh rows keeps an older activity revealable');
 assert.equal(index.entryOf(newRows[0]!),entries[0]);
 const unpublished=[entry({batch:8,txid:undefined,slots:[0]}),entry({batch:9,txid:undefined,slots:[0]})];
 const unpublishedIndex=indexOf(unpublished),unpublishedActivity=new ActivityRegistry();
 unpublishedActivity.use(shieldedActivityResolver({index:unpublishedIndex,entries:()=>unpublished,isPoolBatch:()=>false,isListing:()=>false}));
 const unpublishedItems=await ReadonlyWallet.prototype.getActivityHistory.call({getTransactionHistory:async()=>unpublishedIndex.rows(),activity:unpublishedActivity} as never);
 assert.equal(unpublishedItems.length,2,'entries without published txids still form separate activities');
});

test('a pool batch that moved your coin is labelled shield or withdrawn, and a listing is labelled from its txid',()=>{
 const entries=[entry({kind:'shield',txid:'11'.repeat(32),batch:7})];
 const resolver=shieldedActivityResolver({index:indexOf(entries),entries:()=>entries,isPoolBatch:txid=>['11','22'].includes(txid.slice(0,2)),isListing:txid=>txid.startsWith('33')});
 const shielded=resolver.resolve(row({key:{boardingTxid:'',commitmentTxid:'',arkTxid:'11'.repeat(32)},type:TxType.TxSent}))![0]!;
 assert.deepEqual([shielded.label,shielded.kind,shielded.metadata?.batch],['Shielded','shield',7]);
 const paidOut=resolver.resolve(row({key:{boardingTxid:'',commitmentTxid:'',arkTxid:'22'.repeat(32)},type:TxType.TxReceived}))![0]!;
 assert.deepEqual([paidOut.label,paidOut.kind,paidOut.metadata?.batch],['Withdrawn from the pool','unshield',undefined]);
 const listing=resolver.resolve(row({key:{boardingTxid:'',commitmentTxid:'',arkTxid:'33'.repeat(32)},type:TxType.TxSent,assets:[{assetId:ASSET,amount:1n}],amount:330}))![0]!;
 assert.deepEqual([listing.label,listing.kind],['Listed asset','list']);
 assert.equal(resolver.resolve(row({key:{boardingTxid:'',commitmentTxid:'',arkTxid:'ff'.repeat(32)},assets:[{assetId:ASSET,amount:1n}]})),undefined,'a one-unit send the wallet did not make stays plain');
 assert.equal(resolver.resolve(row({key:{boardingTxid:'',commitmentTxid:'',arkTxid:''}})),undefined);
});

test('an activity maps back to its entry by row identity, and a shield by its batch',()=>{
 const sendEntry=entry({kind:'send'}),shieldEntry=entry({kind:'shield',txid:'11'.repeat(32),batch:7});
 const entries=[sendEntry,shieldEntry];
 const index=indexOf(entries);
 const [syntheticRow]=index.rows();
 assert.equal(entryForActivity(activityOf([syntheticRow!]),{index,entries}),sendEntry);
 assert.equal(entryForActivity(activityOf([row({})],{kind:'shield',metadata:{batch:7}}),{index,entries}),shieldEntry);
 assert.equal(entryForActivity(activityOf([row({})],{kind:'unshield',metadata:{txid:'22'.repeat(32)}}),{index,entries}),undefined);
 assert.equal(entryForActivity(activityOf([row({})]),{index,entries}),undefined);
});

test('a reveal link opens the recipient note for a send and your own notes otherwise',()=>{
 const sentOf=(nullifier:bigint)=>nullifier===7n?{to:THEM,note:{amount:'500',asset:'0',rho:'9'}}:undefined;
 const link=revealLinkOf('https://example.test',entry({kind:'send'}),{self:SELF,sentOf})!;
 assert.match(link,/^https:\/\/example\.test\/verify#/);
 const disclosed=decodeDisclosure(link.split('#')[1]!);
 assert.equal(disclosed.to,THEM);
 assert.deepEqual(disclosed.notes,[{index:3*32+2*0,amount:500n,asset:0n,rho:9n}]);
 const grouped=revealLinkOf('https://example.test',entry({spent:[7n,8n],slots:[1,4]}),{self:SELF,sentOf:n=>n===8n?{to:THEM,note:{amount:'9',asset:'1234',rho:'10'}}:sentOf(n)})!;
 assert.deepEqual(decodeDisclosure(grouped.split('#')[1]!).notes,[{index:98,amount:500n,asset:0n,rho:9n},{index:104,amount:9n,asset:1234n,rho:10n}]);
 const joined=revealLinkOf('https://example.test',entry({spent:[7n,99n],slots:[4]}),{self:SELF,sentOf})!;
 assert.deepEqual(decodeDisclosure(joined.split('#')[1]!).notes,[{index:104,amount:500n,asset:0n,rho:9n}]);
 const received=revealLinkOf('https://example.test',entry({kind:'receive',spent:[],created:[note(400n,9n,77)]}),{self:SELF,sentOf})!;
 assert.equal(decodeDisclosure(received.split('#')[1]!).to,SELF);
 assert.deepEqual(decodeDisclosure(received.split('#')[1]!).notes,[{index:3*32+77%32,amount:400n,asset:0n,rho:5n}],'leaf 77 is named by its batch and its place in that block');
 assert.equal(revealLinkOf('https://example.test',entry({kind:'withdraw'}),{self:SELF,sentOf}),undefined,'a withdrawal is already public');
 assert.equal(revealLinkOf('https://example.test',entry({kind:'merge',created:[]}),{self:SELF,sentOf}),undefined);
 assert.equal(revealLinkOf('https://example.test',entry({kind:'send',spent:[99n]}),{self:SELF,sentOf}),undefined,'no remembered note, no link');
 assert.ok(revealLinkOf('https://example.test',entry({kind:'shield',spent:[],created:[note(900n,12n,5)]}),{self:SELF,sentOf}),'a shield discloses the note it created');
});

test('a joined payment reveal excludes a failed payment recorded on its second input',async()=>{
 const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 const recipients=['22','33'].map(byte=>{const k=deriveRollupKeys2(byte.repeat(32),'mutinynet');return rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret);});
 const [bob,carol]=recipients,account=EpochAccount.owning(hash,keys,{epochLen:64}),pool=epochPool(hash,64),sent=new Map<bigint,SentRecord>();
 const remember=(built:EpochBuiltSpend,to:string)=>{const n=sentNoteOf(hash,built);sent.set(built.witness.slot.nullifiers[0]!,{to,note:{amount:String(n.amount),asset:String(n.asset),rho:String(n.rho)}});};
 const deposits=await Promise.all([400n,500n].map(amount=>account.spend({deposit:amount},self)));
 await account.apply(pool.land('spend',deposits.map(posted)));
 const failed=await account.pay(bob!,300n,self);remember(failed.spends[0]!,rollupAddressOf(bob!));
 const joined=await account.pay(carol!,800n,self,new Set(),0n,{join:true});remember(joined.spends[0]!,rollupAddressOf(carol!));
 assert.equal(joined.spends.length,1);
 assert.equal(joined.spends[0]!.witness.slot.nullifiers[1],failed.spends[0]!.witness.slot.nullifiers[0]);
 assert.equal(sent.size,2,'the unapplied failed payment leaves its sent record behind');
 const record=pool.land('join',joined.spends.map(posted)),{slots}=record;
 await account.apply(record);
 const payment=account.history.at(-1)!;
 assert.equal(payment.kind,'send');assert.equal(payment.spent.length,2);assert.equal(payment.slots.length,1);
 const link=revealLinkOf('https://example.test',payment,{self:SELF,sentOf:n=>sent.get(n)});
 assert.ok(link);
 const disclosed=decodeDisclosure(link.split('#')[1]!);
 assert.equal(disclosed.to,rollupAddressOf(carol!));assert.equal(disclosed.notes.length,1);
 assert.equal(disclosed.notes[0]!.index,32);assert.equal(disclosed.notes[0]!.amount,800n);
 assert.deepEqual(await verifyDisclosure(hash,disclosed,index=>index===32?slots[0]!.commitments[0]:undefined),[true]);
});
