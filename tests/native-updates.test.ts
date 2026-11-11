import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createNativeUpdateMonitor,isNewerNativeRelease,type NativeBuildIdentity} from '../app/src/native-updates.ts';
import {NATIVE_RELEASE_ENDPOINT,NATIVE_RELEASE_ORIGIN,parseNativeRelease,type NativeRelease} from '../src/native-release.ts';
import type {NativeStatus} from '../src/native/transport.ts';
import {nativeReleaseFixture} from './fixtures/native-release.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const identity:NativeBuildIdentity={commit:'b'.repeat(40),buildNumber:100,platform:'windows-x86_64',channel:'native-mutinynet',network:'mutinynet'};
function fixture(t:TestContext,build=identity,initial:NativeStatus={phase:'ready',generation:1}){
 t.mock.timers.enable({apis:['setTimeout']});
 let current=initial,visible=true,listener:(status:NativeStatus)=>void=()=>{};
 const updates:(NativeRelease|undefined)[]=[],requests:{signal:AbortSignal;result:ReturnType<typeof deferred<Response>>}[]=[];
 const network={status:async()=>current,subscribe:(receive:(status:NativeStatus)=>void)=>{listener=receive;return()=>{listener=()=>{};};},fetch:async(url:RequestInfo|URL,init?:RequestInit)=>{
  assert.equal(url,NATIVE_RELEASE_ORIGIN+NATIVE_RELEASE_ENDPOINT);assert.equal(init?.credentials,'omit');assert.equal(init?.cache,'no-store');
  const result=deferred<Response>();requests.push({signal:init!.signal!,result});return result.promise;
 }};
 const monitor=createNativeUpdateMonitor(network,build,release=>updates.push(release),()=>visible);t.after(()=>monitor.stop());
 return {monitor,requests,updates,latest:()=>updates.at(-1),emit:(status:NativeStatus)=>{current=status;listener(status);},visible:(value:boolean)=>{visible=value;monitor.visibilityChanged();}};
}

test('native update comparison requires a strictly newer build and a different commit for this platform and network',()=>{
 const release=parseNativeRelease(nativeReleaseFixture());assert.equal(isNewerNativeRelease(release,identity),true);
 for(const change of [{buildNumber:0},{buildNumber:123},{buildNumber:124},{commit:release.commit},{commit:''},{platform:''},{platform:'other'},{network:'bitcoin'},{channel:'latest'}])assert.equal(isNewerNativeRelease(release,{...identity,...change}),false,JSON.stringify(change));
});

test('native update checks wait for Tor readiness and never overlap; periodic checks wait thirty minutes',async t=>{
 const f=fixture(t,identity,{phase:'bootstrapping',generation:1});await flush();assert.equal(f.requests.length,0);
 f.emit({phase:'ready',generation:1});await flush();f.monitor.check();f.emit({phase:'ready',generation:1});assert.equal(f.requests.length,1);
 f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();assert.equal(f.latest()?.buildNumber,123);
 t.mock.timers.tick(30*60_000-1);await flush();assert.equal(f.requests.length,1);
 t.mock.timers.tick(1);await flush();assert.equal(f.requests.length,2);assert.notEqual(f.requests[0]!.signal,f.requests[1]!.signal);
});

test('unknown local native build identity never makes a metadata request or update badge',async t=>{
 const f=fixture(t,{...identity,buildNumber:0});await flush();f.monitor.check();t.mock.timers.tick(60*60_000);await flush();
 assert.equal(f.requests.length,0);assert.equal(f.latest(),undefined);
});

test('explicit direct mode never checks release metadata and preserves a previously validated badge',async t=>{
 const f=fixture(t,identity,{phase:'ready',generation:1,mode:'direct'});await flush();f.monitor.check();assert.equal(f.requests.length,0);
 f.emit({phase:'ready',generation:2,mode:'tor'});await flush();assert.equal(f.requests.length,1);
 f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();const validated=f.latest();assert.equal(validated?.buildNumber,123);
 f.monitor.check();await flush();assert.equal(f.requests.length,2);f.emit({phase:'ready',generation:2,mode:'direct'});assert.equal(f.requests[1]!.signal.aborted,true);
 f.requests[1]!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();assert.equal(f.latest(),validated);
 t.mock.timers.tick(60*60_000);f.monitor.check();await flush();assert.equal(f.requests.length,2);
});

test('native offline and malformed responses are quiet and cannot become update notices',async t=>{
 const f=fixture(t);await flush();f.requests[0]!.result.reject(new Error('offline'));await flush();assert.equal(f.latest(),undefined);
 for(const response of [Response.json({schema:1}),Response.json(nativeReleaseFixture(),{status:503}),Response.json({...nativeReleaseFixture(),buildNumber:100})]){
  f.monitor.check();await flush();f.requests.at(-1)!.result.resolve(response);await flush();assert.equal(f.latest(),undefined);
 }
});

test('a stuck native release request aborts after ten seconds and cannot publish late success',async t=>{
 const f=fixture(t);await flush();t.mock.timers.tick(10_000);await flush();assert.equal(f.requests[0]!.signal.aborted,true);assert.equal(f.latest(),undefined);
 f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();assert.equal(f.latest(),undefined);
 f.monitor.check();await flush();assert.equal(f.requests.length,2);
});

test('native pause and generation changes abort checks and fence stale responses',async t=>{
 const f=fixture(t);await flush();f.emit({phase:'paused',generation:2});assert.equal(f.requests[0]!.signal.aborted,true);
 f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();assert.equal(f.latest(),undefined);
 f.emit({phase:'ready',generation:3});await flush();assert.equal(f.requests.length,2);
 f.emit({phase:'ready',generation:4});await flush();assert.equal(f.requests[1]!.signal.aborted,true);assert.equal(f.requests.length,3);
 f.requests[2]!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();
 f.requests[1]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();assert.equal(f.latest(),undefined);
 f.emit({phase:'ready',generation:3});assert.equal(f.requests.length,3);
});

test('a validated native update survives wallet cleanup, hidden pages and retired probes',async t=>{
 const f=fixture(t);await flush();f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();
 const validated=f.latest();assert.equal(validated?.buildNumber,123);
 f.monitor.check();await flush();f.emit({phase:'paused',generation:2});
 assert.equal(f.requests[1]!.signal.aborted,true);assert.equal(f.latest(),validated);
 f.requests[1]!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();assert.equal(f.latest(),validated);
 f.emit({phase:'error',generation:3});assert.equal(f.latest(),validated);
 f.emit({phase:'ready',generation:4});await flush();f.visible(false);
 assert.equal(f.requests[2]!.signal.aborted,true);assert.equal(f.latest(),validated);
 f.requests[2]!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();assert.equal(f.latest(),validated);
 f.visible(true);await flush();f.emit({phase:'ready',generation:5});await flush();
 assert.equal(f.requests[3]!.signal.aborted,true);assert.equal(f.latest(),validated);
 f.requests[3]!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();assert.equal(f.latest(),validated);
});

test('failed native probes preserve a validated update until fresh valid metadata changes the comparison',async t=>{
 const f=fixture(t);await flush();f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();
 const validated=f.latest();assert.equal(validated?.buildNumber,123);
 f.monitor.check();await flush();f.requests[1]!.result.reject(new Error('offline'));await flush();assert.equal(f.latest(),validated);
 for(const response of [Response.json({schema:1}),Response.json(nativeReleaseFixture(),{status:503})]){
  f.monitor.check();await flush();f.requests.at(-1)!.result.resolve(response);await flush();assert.equal(f.latest(),validated);
 }
 f.monitor.check();await flush();t.mock.timers.tick(10_000);await flush();assert.equal(f.requests.at(-1)!.signal.aborted,true);assert.equal(f.latest(),validated);
 f.monitor.check();await flush();f.requests.at(-1)!.result.resolve(Response.json({...nativeReleaseFixture(),buildNumber:100}));await flush();assert.equal(f.latest(),undefined);
});

test('hidden and stopped native update monitors abort work and discard late results',async t=>{
 const f=fixture(t);await flush();f.visible(false);assert.equal(f.requests[0]!.signal.aborted,true);
 f.requests[0]!.result.resolve(Response.json(nativeReleaseFixture()));await flush();assert.equal(f.latest(),undefined);
 t.mock.timers.tick(60*60_000);await flush();assert.equal(f.requests.length,1);
 f.visible(true);await flush();assert.equal(f.requests.length,2);
 f.monitor.stop();const count=f.updates.length;assert.equal(f.requests[1]!.signal.aborted,true);
 f.requests[1]!.result.resolve(Response.json(nativeReleaseFixture()));t.mock.timers.tick(60*60_000);await flush();assert.equal(f.updates.length,count);assert.equal(f.requests.length,2);
});
