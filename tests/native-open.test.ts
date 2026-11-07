import assert from 'node:assert/strict';
import test from 'node:test';
import {openNativeVault} from '../app/src/native-open.ts';
import type {NativeStatus} from '../src/native/transport.ts';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
test('an empty vault still starts Tor before showing native setup',async()=>{
 const calls:string[]=[];
 const opened=await openNativeVault(async()=>{calls.push('Tor');return {phase:'ready',generation:1};},async()=>{calls.push('vault');return null;},()=>true);
 assert.deepEqual(calls,['Tor','vault']);assert.deepEqual(opened,{status:{phase:'ready',generation:1},secret:null});
});
test('pausing during bootstrap prevents the vault read and wallet publication',async()=>{
 const started=deferred<NativeStatus>();let current=true,reads=0;
 const opened=openNativeVault(()=>started.promise,async()=>{reads++;return 'secret';},()=>current);
 current=false;started.resolve({phase:'ready',generation:1});assert.equal(await opened,undefined);assert.equal(reads,0);
});
test('a retired vault read cannot publish a native wallet',async()=>{
 const secret=deferred<string|null>();let current=true;
 const opened=openNativeVault(async()=>({phase:'ready',generation:1}),()=>secret.promise,()=>current);
 await Promise.resolve();current=false;secret.resolve('secret');assert.equal(await opened,undefined);
});
test('a failed Tor bootstrap cannot read the vault',async()=>{
 let reads=0;
 await assert.rejects(openNativeVault(async()=>({phase:'error',generation:1,error:'Tor unavailable'}),async()=>{reads++;return null;},()=>true),/Tor unavailable/);
 assert.equal(reads,0);
});
