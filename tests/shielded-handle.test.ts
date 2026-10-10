import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeHandle} from '@arkade-os/sdk';
import {isShieldedHandle,shieldedHandle,watchHandle,type StepState} from '../src/shielded/handle.ts';

const steps=['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'];

test('a shielded handle is a payment handle that also streams its steps, and settles',async()=>{
 const seen:number[]=[],statuses:string[]=[];
 let release=(_:{txid?:string})=>{};
 const handle=shieldedHandle({title:'Sending privately',steps,railId:'shielded'},async step=>{step(0);return new Promise(resolve=>{release=resolve;});});
 handle.subscribeSteps(s=>seen.push(s.current));
 handle.subscribe(u=>statuses.push(u.status));
 assert.equal(handle.title,'Sending privately');
 assert.deepEqual(handle.steps,steps);
 assert.equal(statuses[0],'pending','subscribe replays the latest update');
 assert.deepEqual(seen,[0],'subscribeSteps replays the current step too');
 release({txid:'ab'.repeat(32)});
 const result=await handle.settled({timeoutMs:1000});
 assert.deepEqual(result,{railId:'shielded',txid:'ab'.repeat(32)});
 assert.equal(handle.status,'settled');
 assert.deepEqual([handle.stepState().done,handle.stepState().current],[true,steps.length-1]);
 assert.ok(statuses.includes('settled'));
});

test('a failing action ends failed and the step state keeps the step it failed on',async()=>{
 const handle=shieldedHandle({title:'Withdrawing',steps,railId:'shielded-withdraw'},async step=>{step(1);throw new Error('No single note covers this amount.');});
 await assert.rejects(handle.settled({timeoutMs:1000}),/No single note covers/);
 assert.equal(handle.status,'failed');
 const state=handle.stepState();
 assert.equal(state.current,1,'the sheet keeps the step it failed on');
 assert.equal(state.done,undefined);
});

test('steps advance in order and a late subscriber sees only the current one',()=>{
 const states:number[]=[];
 const handle=shieldedHandle({title:'Shielding 2,000 sats',steps,railId:'shielded-deposit'},async step=>{step(0);step(1);step(2);return new Promise(()=>{});});
 handle.subscribeSteps(s=>states.push(s.current));
 assert.deepEqual(states,[2],'the stream replays the latest state, not the whole history');
 assert.deepEqual([handle.stepState().current,handle.stepState().title],[2,'Shielding 2,000 sats']);
});

test('unsubscribing stops the step stream',async()=>{
 let count=0;
 let release=(_:{txid?:string})=>{};
 const handle=shieldedHandle({title:'Merging notes',steps,railId:'shielded-merge'},async step=>{step(0);return new Promise(resolve=>{release=resolve;});});
 const off=handle.subscribeSteps(()=>count++);
 assert.equal(count,1);
 off();
 release({});
 await handle.settled({timeoutMs:1000});
 assert.equal(count,1);
});

// The ark, ark-asset and onchain rails return plain SDK handles, so the sheet needs one call that fits both.
test('watchHandle renders a plain SDK handle as statuses and a shielded one as its own labelled steps',async()=>{
 const shielded=shieldedHandle({title:'Sending privately',steps,railId:'shielded'},async step=>{step(3);return {};});
 const fromShielded:StepState[]=[];
 watchHandle(shielded,'ignored',s=>fromShielded.push(s));
 await shielded.settled({timeoutMs:1000});
 assert.equal(isShieldedHandle(shielded),true);
 assert.deepEqual(fromShielded.at(-1)!.steps,steps,'a shielded handle keeps its own labels');
 assert.equal(fromShielded.at(-1)!.done,true);

 let finish=(_:{railId:string})=>{};
 // Mirrors the real ark rail: it emits its own terminal update (chunk-MLOZHTBN.js:24991).
 const plain=makeHandle('ark:1',async emit=>{emit({status:'pending'});const result=await new Promise<{railId:string}>(resolve=>{finish=resolve;});emit({status:'settled',result});return result;});
 const fromPlain:StepState[]=[];
 watchHandle(plain,'Arkade payment',s=>fromPlain.push(s));
 assert.equal(isShieldedHandle(plain),false);
 assert.deepEqual([fromPlain[0]!.title,fromPlain[0]!.current,fromPlain[0]!.steps.length],['Arkade payment',0,3]);
 finish({railId:'ark'});
 await plain.settled({timeoutMs:1000});
 assert.equal(fromPlain.at(-1)!.done,true);
 assert.equal(fromPlain.at(-1)!.current,2);
});
