import assert from 'node:assert/strict';
import test from 'node:test';
import {base64} from '@scure/base';
import {Transaction} from '@arkade-os/sdk';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {assertUnsealedTransferRejected,createSavedStoreView,modeMutationPaths,pendingSettlementMatches,selectExactFundingCoin} from '../tools/stock-live-smoke.ts';

const coin=(txid:string,vout:number,value:number)=>({amount:value,funding:{txid,vout,value,sourceTxHex:'00',tapTreeHex:'00',leafHex:'51'}});

test('exact payout selection never falls forward to another customer coin',()=>{
 const first=coin('11'.repeat(32),0,330),later=coin('22'.repeat(32),1,1_000);
 assert.equal(selectExactFundingCoin([first,later],`${first.funding.txid}:0`).funding.txid,first.funding.txid);
 assert.throws(()=>selectExactFundingCoin([later],`${first.funding.txid}:0`),/no fallback coin/);
 assert.throws(()=>selectExactFundingCoin([first],`${first.funding.txid}:0`,331),/no fallback coin/);
});

test('verify-only has no mutating HTTP paths',()=>{
 assert.deepEqual(modeMutationPaths('verify-only'),[]);
 assert.deepEqual(modeMutationPaths('prepare'),[]);
 assert.ok(modeMutationPaths('run').length>0);
});

test('live journal view follows each successful persisted save and survives reload',()=>{
 const initial={registrations:{alice:'signed-registration'},pending:{name:'alice:transfer'},completed:{},fundingCoins:{alice:'exact-coin'}};
 let durable=structuredClone(initial);
 const vault=createSavedStoreView(initial,next=>{durable=structuredClone(next);});
 vault.save({...vault.saved,completed:{...vault.saved.completed,deposit:{txid:'deposit-tx'}}});
 assert.equal(vault.saved.registrations.alice,'signed-registration');
 assert.equal(vault.saved.pending?.name,'alice:transfer');
 vault.save({...vault.saved,completed:{...vault.saved.completed,transfer:{txid:'transfer-tx'}}});
 const cleared={...vault.saved,completed:{...vault.saved.completed,transfer:{txid:'transfer-tx',acceptedAt:'now'}}} as typeof initial;
 delete (cleared as any).pending;
 vault.save(cleared);
 assert.equal(vault.saved.pending,undefined);
 assert.deepEqual(Object.keys(vault.saved.completed).sort(),['deposit','transfer']);
 const reopened=createSavedStoreView(structuredClone(durable),next=>{durable=structuredClone(next);});
 assert.equal(reopened.saved.registrations.alice,'signed-registration');
 assert.equal(reopened.saved.fundingCoins.alice,'exact-coin');
 assert.equal(reopened.saved.pending,undefined);
 assert.deepEqual(Object.keys(reopened.saved.completed).sort(),['deposit','transfer']);
});

test('failed live journal persistence leaves the saved view at the last committed value',()=>{
 type Journal={completed:Record<string,{txid:string}>;pending?:{name:string}};
 const initial:Journal={completed:{first:{txid:'kept'}},pending:{name:'exact-pending'}};
 const view=createSavedStoreView(initial,()=>{throw new Error('disk full');});
 const before=view.saved;
 assert.throws(()=>view.save({completed:{},pending:undefined}),/disk full/);
 assert.equal(view.saved,before);
 assert.deepEqual(view.saved,{completed:{first:{txid:'kept'}},pending:{name:'exact-pending'}});
});

test('unsealed transfer probe accepts only the expected local sealed-state rejection',async()=>{
 await assertUnsealedTransferRejected(async()=>{throw new Error('Pool must be sealed before spending notes.');});
 await assert.rejects(assertUnsealedTransferRejected(async()=>{}),/prepared a private transfer before the pool was sealed/);
 await assert.rejects(assertUnsealedTransferRejected(async()=>{throw new Error('insufficient balance');}),/unexpected reason/);
});

test('lost settlement response resumes only when the full accepted request matches',()=>{
 const tx=offlineNativeFixture([{script:Uint8Array.of(0x51),amount:330n}]);
 const encoded=base64.encode(tx.toPSBT()),signed={arkTx:encoded,checkpoints:[]},prepared={id:'ab'.repeat(12),operation:'transfer'},proof={version:1,proof:{pi_a:['a'],pi_b:[['b']],pi_c:['c']}};
 const pending={kind:'settlement',name:'transfer:one',prepared,proof,signed,expectedTxids:[tx.id],before:{head:'33'.repeat(32),vout:0,phase:18,historyLength:1,revision:1},createdAt:'2026-10-05T00:00:00.000Z'} as any;
 const item={prepared,proof,request:signed,receipt:{txid:tx.id},operation:'transfer'} as any;
 assert.equal(pendingSettlementMatches(pending,item),true);
 assert.equal(pendingSettlementMatches(pending,{...item,request:{...signed,arkTx:base64.encode(offlineNativeFixture([{script:Uint8Array.of(0x51),amount:331n}]).toPSBT())}}),false);
 assert.equal(pendingSettlementMatches({...pending,proof:{...proof,proof:{pi_a:['different']}}},item),false);
 assert.equal(pendingSettlementMatches(pending,undefined),false);
});
