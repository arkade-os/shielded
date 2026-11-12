import assert from 'node:assert/strict';
import test from 'node:test';
import {NativeBridge,type NativeStatus} from '../src/native/transport.ts';
import {NativePolicy} from '../src/native/policy.ts';

test('warm suspension permanently retires old consumers and explicitly requests only client warmth',async()=>{
 const calls:{command:string;args?:Record<string,unknown>}[]=[];
 const bridge=new NativeBridge({invoke:async(command,args)=>{calls.push({command,args});return {phase:'paused',generation:2,mode:'tor',foreground:true,warmFromGeneration:1};},channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus({phase:'ready',generation:1});const old=bridge.sessionGuard();
 await bridge.pause(true);assert.equal(calls[0]!.args?.warm,true);assert.throws(old,/retired|paused/);
 bridge.acceptLifecycle({phase:'ready',generation:3,mode:'tor',foreground:true});assert.throws(old,/retired|paused/);
});

test('a native lifecycle event fences an older status poll without starting the network',async()=>{
 let resolve!:(status:NativeStatus)=>void;const calls:string[]=[];
 const bridge=new NativeBridge({invoke:command=>{calls.push(command);return new Promise(done=>{resolve=done;});},channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus({phase:'ready',generation:1});const pending=bridge.status();
 bridge.acceptLifecycle({phase:'paused',generation:2,foreground:false});
 resolve({phase:'ready',generation:1});await pending;
 assert.equal(bridge.current.phase,'paused');assert.equal(bridge.current.foreground,false);
 bridge.acceptLifecycle({phase:'paused',generation:2,foreground:true});
 assert.equal(bridge.current.phase,'paused');assert.deepEqual(calls,['native_status']);
 const resumedPoll=bridge.status();bridge.acceptLifecycle({phase:'paused',generation:2,foreground:true});
 resolve({phase:'paused',generation:2,foreground:false});await resumedPoll;assert.equal(bridge.current.foreground,true);
});

test('new foreground metadata fences an older pause response when the resume event is missed',async()=>{
 let paused!:(status:NativeStatus)=>void,polled!:(status:NativeStatus)=>void;
 const bridge=new NativeBridge({invoke:command=>new Promise(resolve=>{if(command==='native_pause')paused=resolve;else if(command==='native_status')polled=resolve;else assert.fail(command);}),channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus({phase:'ready',generation:1});const retiring=bridge.pause(true),poll=bridge.status();
 polled({phase:'paused',generation:2,foreground:true});await poll;
 paused({phase:'paused',generation:2,foreground:false});await retiring;
 assert.equal(bridge.current.foreground,true);assert.equal(bridge.current.phase,'paused');
 assert.throws(()=>bridge.sessionGuard(),/retired|paused/);
});

test('proof work captured before warm suspension cannot begin its first mutation after resume',async()=>{
 let finishProof!:()=>void,dispatches=0;
 const bridge=new NativeBridge({invoke:async command=>{
  if(command==='native_pause')return {phase:'paused',generation:2,mode:'tor'};
  if(command==='native_start')return {phase:'ready',generation:3,mode:'tor'};
  if(command==='native_http')dispatches++;
  throw new Error('Unexpected dispatch');
 },channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus({phase:'ready',generation:1});
 const fetcher=bridge.bindFetch((input,init)=>bridge.fetch(input,init));
 const operation=(async()=>{await new Promise<void>(resolve=>{finishProof=resolve;});return fetcher('https://pool.example/api/rollup/spends',{method:'POST',body:'proof'});})();
 await bridge.pause(true);await bridge.start();finishProof();
 await assert.rejects(operation,/retired|paused/);assert.equal(dispatches,0);
});

test('paused status polling recovers a missed native resume event without releasing pause intent',async()=>{
 let foreground=false;
 const bridge=new NativeBridge({invoke:async()=>({phase:'paused',generation:2,foreground}),channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus({phase:'ready',generation:1});await bridge.pause(true);
 assert.equal(bridge.current.foreground,false);foreground=true;
 const current=await bridge.status();assert.equal(current.foreground,true);assert.equal(current.phase,'paused');
 assert.throws(()=>bridge.sessionGuard(),/retired|paused/);
});
