import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createNativeTorMonitor,type NativeTorHealthState} from '../app/src/native-tor-monitor.ts';
import type {NativeStatus} from '../src/native/transport.ts';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

function fixture(t:TestContext,initial:NativeStatus={phase:'ready',generation:1}){
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:0});
 t.mock.method(Math,'random',()=>0);
 let current=initial,visible=true,listener:(status:NativeStatus)=>void=()=>{},statusCalls=0;
 let pendingStatus:ReturnType<typeof deferred<NativeStatus>>|undefined;
 const health:NativeTorHealthState[]=[],errors:unknown[]=[],checks:{signal:AbortSignal;result:ReturnType<typeof deferred<void>>}[]=[];
 const network={
  status:async()=>{statusCalls++;return pendingStatus?await pendingStatus.promise:current;},
  subscribe:(fn:(status:NativeStatus)=>void)=>{listener=fn;return()=>{listener=()=>{};};},
  check:(signal:AbortSignal)=>{const result=deferred<void>();checks.push({signal,result});return result.promise;}
 };
 const monitor=createNativeTorMonitor(network,value=>health.push(value),error=>errors.push(error),()=>visible);
 t.after(()=>monitor.stop());
 return {
  monitor,health,errors,checks,latest:()=>health.at(-1)!,statusCalls:()=>statusCalls,
  emit:(status:NativeStatus)=>{current=status;listener(status);},
  visible:(value:boolean)=>{visible=value;},
  holdStatus:()=>{pendingStatus=deferred<NativeStatus>();return pendingStatus;}
 };
}

test('Tor status and initial reachability are monitored before a wallet exists',async t=>{
 const f=fixture(t,{phase:'bootstrapping',generation:1,progress:'25%'});await flush();
 assert.equal(f.statusCalls(),1);assert.equal(f.latest().status.phase,'bootstrapping');assert.equal(f.checks.length,0);
 f.emit({phase:'ready',generation:1});await flush();
 assert.equal(f.latest().check,'checking');assert.equal(f.checks.length,1);
 t.mock.timers.tick(120);f.checks[0]!.result.resolve();await flush();
 assert.equal(f.latest().check,'ok');assert.equal(f.latest().latencyMs,120);assert.equal(f.latest().checkedAt,120);
 assert.equal(f.latest().attempt,undefined);assert.equal(f.latest().retryAt,undefined);
});

test('status polling never overlaps and retains a newer subscription result',async t=>{
 const f=fixture(t,{phase:'bootstrapping',generation:1});await flush();
 const pending=f.holdStatus();t.mock.timers.tick(1500);await flush();
 assert.equal(f.statusCalls(),2);t.mock.timers.tick(6000);await flush();assert.equal(f.statusCalls(),2);
 f.emit({phase:'ready',generation:2});await flush();
 pending.resolve({phase:'bootstrapping',generation:1});await flush();
 assert.equal(f.latest().status.phase,'ready');assert.equal(f.latest().status.generation,2);assert.equal(f.checks.length,1);
});

test('a retired status RPC failure cannot pause a newer ready generation',async t=>{
 const f=fixture(t,{phase:'bootstrapping',generation:1});await flush();
 const pending=f.holdStatus();t.mock.timers.tick(1500);await flush();
 f.emit({phase:'ready',generation:2});await flush();
 pending.reject(new Error('retired native status unavailable'));await flush();
 assert.equal(f.latest().status.phase,'ready');assert.equal(f.latest().status.generation,2);
 assert.equal(f.latest().check,'checking');assert.equal(f.checks[0]!.signal.aborted,false);assert.equal(f.errors.length,0);
 f.checks[0]!.result.resolve();await flush();assert.equal(f.latest().check,'ok');
});

test('periodic probes wait between completions and manual checks never overlap',async t=>{
 const f=fixture(t);await flush();
 f.monitor.check();f.monitor.check();await flush();assert.equal(f.checks.length,1);
 t.mock.timers.tick(9000);f.monitor.check();await flush();assert.equal(f.checks.length,1);
 f.checks[0]!.result.resolve();await flush();
 t.mock.timers.tick(29_999);await flush();assert.equal(f.checks.length,1);
 t.mock.timers.tick(1);await flush();assert.equal(f.checks.length,2);
 assert.notEqual(f.checks[0]!.signal,f.checks[1]!.signal);
});

test('a timed out probe fails visibly even when its backend ignores abort',async t=>{
 const f=fixture(t);await flush();t.mock.timers.tick(10_000);await flush();
 assert.equal(f.checks[0]!.signal.aborted,true);assert.equal(f.latest().check,'failed');
 assert.match(f.latest().error!,/timed out/i);assert.equal(f.latest().checkedAt,10_000);
 f.checks[0]!.result.resolve();await flush();assert.equal(f.latest().check,'failed');
 f.monitor.check();await flush();assert.equal(f.checks.length,2);
 f.checks[1]!.result.resolve();await flush();assert.equal(f.latest().check,'ok');
});

test('a rejected check without an error value still reports failure',async t=>{
 const f=fixture(t);await flush();f.checks[0]!.result.reject(undefined);await flush();
 assert.equal(f.latest().check,'failed');
});

test('a failed Tor service probe retries in five seconds instead of lingering for a full interval',async t=>{
 const f=fixture(t);await flush();f.checks[0]!.result.reject(new Error('service unavailable'));await flush();
 assert.equal(f.latest().check,'failed');assert.equal(f.latest().attempt,1);assert.equal(f.latest().retryAt,5_000);
 t.mock.timers.tick(4_999);await flush();assert.equal(f.checks.length,1);
 t.mock.timers.tick(1);await flush();assert.equal(f.checks.length,2);assert.equal(f.latest().check,'checking');
 assert.equal(f.latest().attempt,2);assert.equal(f.latest().retryAt,undefined);
 f.checks[1]!.result.reject(new Error('still unavailable'));await flush();assert.equal(f.latest().retryAt,15_000);
 t.mock.timers.tick(10_000);await flush();f.checks[2]!.result.reject(new Error('still unavailable'));await flush();assert.equal(f.latest().retryAt,35_000);
 t.mock.timers.tick(20_000);await flush();f.checks[3]!.result.reject(new Error('still unavailable'));await flush();assert.equal(f.latest().retryAt,65_000);
 t.mock.timers.tick(30_000);await flush();f.checks[4]!.result.reject(new Error('still unavailable'));await flush();assert.equal(f.latest().retryAt,95_000);
 t.mock.timers.tick(30_000);await flush();f.checks[5]!.result.resolve();await flush();assert.equal(f.latest().check,'ok');
 t.mock.timers.tick(30_000);await flush();f.checks[6]!.result.reject(new Error('outage after recovery'));await flush();
 assert.equal(f.latest().attempt,1);assert.equal(f.latest().retryAt,130_000);
});

test('pause aborts a probe and its late success cannot restore connected health',async t=>{
 const f=fixture(t);await flush();f.emit({phase:'paused',generation:2});
 assert.equal(f.checks[0]!.signal.aborted,true);assert.equal(f.latest().check,'idle');
 f.checks[0]!.result.resolve();await flush();
 assert.equal(f.latest().status.phase,'paused');assert.equal(f.latest().check,'idle');
 f.monitor.check();t.mock.timers.tick(45_000);await flush();assert.equal(f.checks.length,1);
});

test('an old generation cannot publish probe success into a replacement session',async t=>{
 const f=fixture(t);await flush();f.emit({phase:'ready',generation:2});await flush();
 assert.equal(f.checks[0]!.signal.aborted,true);assert.equal(f.checks.length,2);
 f.checks[0]!.result.resolve();await flush();assert.equal(f.latest().check,'checking');
 assert.equal(f.latest().status.generation,2);
 f.checks[1]!.result.resolve();await flush();assert.equal(f.latest().check,'ok');
 f.emit({phase:'ready',generation:1});assert.equal(f.latest().status.generation,2);
});

test('hidden pages abort probes and resume checks only after returning to foreground',async t=>{
 const f=fixture(t);await flush();f.visible(false);t.mock.timers.tick(1500);await flush();
 assert.equal(f.checks[0]!.signal.aborted,true);assert.equal(f.latest().check,'idle');
 const polls=f.statusCalls();f.monitor.check();t.mock.timers.tick(45_000);await flush();
 assert.equal(f.checks.length,1);assert.equal(f.statusCalls(),polls);
 f.checks[0]!.result.reject(new Error('late hidden response'));await flush();assert.equal(f.latest().check,'idle');
 f.visible(true);t.mock.timers.tick(1500);await flush();
 assert.equal(f.checks.length,2);assert.equal(f.latest().check,'checking');
});

test('a probe completing while hidden never publishes a connected result',async t=>{
 const f=fixture(t);await flush();f.visible(false);f.checks[0]!.result.resolve();await flush();
 assert.equal(f.checks[0]!.signal.aborted,true);assert.equal(f.latest().check,'idle');
 assert.equal(f.health.some(value=>value.check==='ok'),false);
});

test('a status IPC failure clears healthy evidence and reports the failure',async t=>{
 const f=fixture(t);await flush();f.checks[0]!.result.resolve();await flush();assert.equal(f.latest().check,'ok');
 const pending=f.holdStatus();t.mock.timers.tick(1500);await flush();
 const error=new Error('native status unavailable');pending.reject(error);await flush();
 assert.deepEqual(f.errors,[error]);assert.equal(f.latest().status.phase,'error');assert.equal(f.latest().check,'idle');
 assert.equal(f.latest().checkedAt,undefined);f.monitor.check();await flush();assert.equal(f.checks.length,1);
});

test('a direct-mode status failure never relabels the connection as Tor',async t=>{
 const f=fixture(t,{phase:'ready',generation:2,mode:'direct'});await flush();
 const pending=f.holdStatus();t.mock.timers.tick(1500);await flush();
 pending.reject(new Error('IPC unavailable'));await flush();
 assert.equal(f.latest().status.mode,'direct');assert.equal(f.latest().status.phase,'error');
});

test('stopping removes timers and subscriptions and ignores outstanding work',async t=>{
 const f=fixture(t);await flush();const pending=f.holdStatus();t.mock.timers.tick(1500);await flush();
 f.monitor.stop();const count=f.health.length,polls=f.statusCalls();
 assert.equal(f.checks[0]!.signal.aborted,true);f.emit({phase:'ready',generation:3});
 pending.reject(new Error('late IPC error'));f.checks[0]!.result.reject(new Error('late check error'));
 t.mock.timers.tick(60_000);await flush();f.monitor.check();await flush();
 assert.equal(f.health.length,count);assert.equal(f.statusCalls(),polls);assert.equal(f.errors.length,0);assert.equal(f.checks.length,1);
});
