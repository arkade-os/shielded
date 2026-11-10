import assert from 'node:assert/strict';
import {test} from 'node:test';
import {saveNativeSetup} from '../app/src/native-setup.ts';
import type {NativeStatus} from '../src/native/transport.ts';

const ready:NativeStatus={phase:'ready',generation:3};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};

test('native setup never generates or writes keys while its transport connects',async()=>{
 let made=0,written=0;
 await assert.rejects(saveNativeSetup({phase:'bootstrapping',generation:3},async()=>ready,()=>true,()=>{made++;return 'test';},async()=>{written++;}),/ready/);
 assert.equal(made,0);assert.equal(written,0);
});

test('a stale enabled create action cannot write after a generation or mode change',async()=>{
 for(const status of [{phase:'paused',generation:3},{phase:'ready',generation:4},{phase:'ready',generation:3,mode:'direct'}] as NativeStatus[]){
  let writes=0;
  await assert.rejects(saveNativeSetup(ready,async()=>status,()=>true,()=>{throw new Error('must not generate');},async()=>{writes++;}),/ready|changed/);
  assert.equal(writes,0);
 }
});

test('a queued pause or mode change fences a delayed readiness result',async()=>{
 const status=deferred<NativeStatus>();let current=true,writes=0;
 const saving=saveNativeSetup(ready,()=>status.promise,()=>current,()=>{throw new Error('must not generate');},async()=>{writes++;});
 current=false;status.resolve(ready);await assert.rejects(saving,/changed/);assert.equal(writes,0);
});

test('confirmed direct setup uses the same ready gate and waits for the actual vault write',async()=>{
 const written=deferred<void>(),direct={...ready,mode:'direct'} as NativeStatus;let settled=false,writes=0;
 const saving=saveNativeSetup(direct,async()=>direct,()=>true,()=>'test-only',async value=>{assert.equal(value,'test-only');writes++;await written.promise;}).then(()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1);assert.equal(settled,false);
 written.resolve();await saving;assert.equal(settled,true);
});
