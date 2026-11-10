import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeViewHandoff,currentNativeWalletView,isNativeWalletViewActive} from '../app/src/native-view-handoff.ts';
import {createNativeCleanup} from '../app/src/native-cleanup.ts';

const session=(generation:number)=>({generation});
const mounted=(handoff:ReturnType<typeof createNativeViewHandoff<ReturnType<typeof session>>>,generation:number)=>{
 const view=handoff.stage(session(generation));view.onShutdown(async()=>{});return view;
};

test('an initial wallet stays inactive until its first ready signal',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),first=handoff.stage(session(1),{awaitReady:true});
 first.onShutdown(async()=>{});
 assert.equal(handoff.snapshot.shown,undefined);assert.equal(handoff.snapshot.candidate,first);
 assert.equal(isNativeWalletViewActive(first,false),false);
 assert.equal(handoff.promote(first,()=>true),true);
 assert.equal(handoff.snapshot.shown,first);assert.equal(handoff.snapshot.candidate,undefined);
 assert.equal(isNativeWalletViewActive(first,true),true);
});

test('a resumed candidate cannot replace the retired balance view before it is ready',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),old=mounted(handoff,1);
 handoff.retire(true);const next=mounted(handoff,3);
 assert.equal(handoff.snapshot.shown,old);assert.equal(handoff.snapshot.candidate,next);assert.equal(old.retired,true);
 assert.equal(currentNativeWalletView(handoff.snapshot.shown),undefined);
 assert.equal(currentNativeWalletView(handoff.snapshot.candidate),next);
 assert.equal(isNativeWalletViewActive(old,true),false);assert.equal(isNativeWalletViewActive(next,false),false);
 assert.equal(handoff.promote(next,()=>false),false);assert.equal(handoff.snapshot.shown,old);
 assert.equal(handoff.promote(next,()=>true),true);assert.equal(handoff.snapshot.shown,next);assert.equal(handoff.snapshot.candidate,undefined);
 assert.equal(isNativeWalletViewActive(next,true),true);
});

test('lock removes both views immediately and fences an already captured readiness callback',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>();mounted(handoff,1);handoff.retire(true);
 const next=mounted(handoff,3),ready=()=>handoff.promote(next,()=>true);
 const closing=handoff.retire(false);
 assert.equal(closing.length,1);assert.deepEqual(handoff.snapshot,{shown:undefined,candidate:undefined});assert.equal(ready(),false);
});

test('repeated pause retires the hidden candidate and only the latest candidate can publish',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),old=mounted(handoff,1);handoff.retire(true);
 const stale=mounted(handoff,3);handoff.retire(true);const next=mounted(handoff,5);
 assert.equal(handoff.promote(stale,()=>true),false);assert.equal(handoff.snapshot.shown,old);assert.equal(handoff.snapshot.candidate,next);
 assert.equal(handoff.promote(next,()=>true),true);assert.equal(handoff.snapshot.shown,next);
});

test('an old unmount cannot erase a replacement shutdown registration',async()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>();const old=mounted(handoff,1);handoff.retire(true);
 const next=mounted(handoff,3);let closed=0;next.onShutdown(async()=>{closed++;});old.onShutdown(undefined);
 const retiring=handoff.retire(true);assert.equal(retiring.length,1);await retiring[0]!.shutdown?.();assert.equal(closed,1);
});

test('retirement captures shutdown ownership before React unregisters the old view',async()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),old=mounted(handoff,1);let closed=0;
 old.onShutdown(async()=>{closed++;});const retiring=handoff.retire(true);old.onShutdown(undefined);
 await retiring[0]!.shutdown?.();assert.equal(closed,1);
});

test('a failed candidate leaves the old view inert and cannot clear a subsequent candidate',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),old=mounted(handoff,1);handoff.retire(true);
 const failed=mounted(handoff,3);assert.ok(handoff.discard(failed));
 assert.equal(handoff.snapshot.shown,old);assert.equal(old.retired,true);assert.equal(handoff.snapshot.candidate,undefined);
 const next=mounted(handoff,5);assert.equal(handoff.discard(failed),undefined);assert.equal(handoff.snapshot.candidate,next);assert.equal(handoff.promote(failed,()=>true),false);
});

test('a lazy wallet that never mounted is removed on pause instead of starting under a replacement generation',()=>{
 const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),lazy=handoff.stage(session(1));handoff.retire(true);
 assert.deepEqual(handoff.snapshot,{shown:undefined,candidate:undefined});assert.equal(handoff.promote(lazy,()=>true),false);
});

test('a shutdown registered after retirement joins the cleanup gate',async()=>{
 const cleanup=createNativeCleanup(),handoff=createNativeViewHandoff<ReturnType<typeof session>>(shutdown=>{void cleanup.add(shutdown).catch(()=>{});});
 const lazy=handoff.stage(session(1));handoff.retire(true);let close=0;
 lazy.onShutdown(async()=>{if(++close===1)throw new Error('closing');});
 await assert.rejects(cleanup.drain(),/closing/);await cleanup.drain();assert.equal(close,2);
 assert.equal(handoff.snapshot.shown,undefined);assert.equal(handoff.promote(lazy,()=>true),false);
});

test('final readiness cannot publish while hidden, locked, or on another generation',()=>{
 for(const state of [{visible:false,locked:false,generation:3},{visible:true,locked:true,generation:3},{visible:true,locked:false,generation:4}]){
  const handoff=createNativeViewHandoff<ReturnType<typeof session>>(),old=mounted(handoff,1);handoff.retire(true);const next=mounted(handoff,3);
  assert.equal(handoff.promote(next,()=>state.visible&&!state.locked&&state.generation===next.session.generation),false);
  assert.equal(handoff.snapshot.shown,old);assert.equal(handoff.snapshot.candidate,next);
 }
});
