import assert from 'node:assert/strict';
import test from 'node:test';
import {base64} from '@scure/base';
import {Transaction} from '@arkade-os/sdk';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {assertUnsealedTransferRejected,modeMutationPaths,pendingSettlementMatches,selectExactFundingCoin} from '../tools/stock-live-smoke.ts';

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
