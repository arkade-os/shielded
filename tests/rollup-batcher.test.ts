import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectRollupBatch,type RollupSpend} from '../src/rollup/batcher.ts';

let next=0;
function spend(extra:{at?:number;group?:[bigint,number];asset?:string;deposit?:bigint;coin?:boolean}={}):RollupSpend {
 const id=String(++next),[groupId,groupSize]=extra.group??[0n,0];
 return {id,receivedAt:extra.at??0,slot:{root:1n,nullifiers:[BigInt(next)],commitments:[1n,2n],ctDigest:3n,groupId,groupSize},
  publics:[BigInt(next),extra.deposit??0n,0n,extra.asset?7n:0n,0n],proof:{pi_a:[],pi_b:[],pi_c:[]},
  ...(extra.asset?{asset:extra.asset}:{}),...(extra.coin?{coin:{txid:'',vout:0,value:0,sourceTx:new Uint8Array(),tapTree:new Uint8Array(),leaf:[] as never}}:{})};
}
const pad=(count:number)=>Array.from({length:count},()=>spend({at:Infinity}));
const ids=(s:RollupSpend[])=>s.map(x=>x.id);

test('a batch closes at 11 spends, or after 10 s padded with zero spends',()=>{
 const few=[spend(),spend()];
 assert.equal(selectRollupBatch(few,9_999,pad),undefined);
 const closed=selectRollupBatch(few,10_000,pad)!;
 assert.equal(closed.spends.length,11);
 assert.deepEqual(ids(closed.spends.slice(0,2)),ids(few));
 const full=Array.from({length:12},()=>spend());
 assert.deepEqual(ids(selectRollupBatch(full,0,pad)!.spends),ids(full.slice(0,11)));
});

test('a group goes in whole and consecutive, or waits',()=>{
 const lone=spend(),first=spend({group:[5n,2]}),other=spend(),second=spend({group:[5n,2]});
 assert.deepEqual(ids(selectRollupBatch([lone,first,other],10_000,pad)!.spends.slice(0,2)),ids([lone,other]));
 assert.deepEqual(ids(selectRollupBatch([lone,first,other,second],10_000,pad)!.spends.slice(0,4)),ids([lone,first,second,other]));
});

test('one non-BTC asset per batch, and at most 8 deposit coins beside its reserve',()=>{
 const x=spend({asset:'x',deposit:1n,coin:true}),y=spend({asset:'y',deposit:1n,coin:true}),btc=spend();
 const batch=selectRollupBatch([x,y,btc],10_000,pad)!;
 assert.equal(batch.asset,'x');
 assert.deepEqual(ids(batch.spends.slice(0,2)),ids([x,btc]));
 const nine=Array.from({length:9},()=>spend({asset:'x',deposit:1n,coin:true}));
 assert.equal(selectRollupBatch(nine,10_000,pad)!.spends.filter(s=>s.coin).length,8);
 assert.equal(selectRollupBatch(Array.from({length:11},()=>spend({deposit:1n,coin:true})),0,pad)!.spends.filter(s=>s.coin).length,11);
});

test('a deposit cap, set after an over-weight batch, holds back further deposit coins',()=>{
 const deposits=Array.from({length:3},()=>spend({deposit:1n,coin:true})),transfer=spend();
 const capped=selectRollupBatch([...deposits,transfer],10_000,pad,1)!;
 assert.deepEqual(ids(capped.spends.slice(0,2)),ids([deposits[0]!,transfer]));
});
