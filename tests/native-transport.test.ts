import assert from 'node:assert/strict';
import test from 'node:test';
import {NativeBridge,SseDecoder,type NativeBackend,type NativeEvent} from '../src/native/transport.ts';
import {NativePolicy} from '../src/native/policy.ts';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
function backend(){
 const calls:{command:string;args:any}[]=[],opened=deferred<{id:string;generation:number}>();let receive!:(event:NativeEvent)=>void;
 const api:NativeBackend={invoke:async(command,args)=>{calls.push({command,args});if(command==='native_status'||command==='native_start')return {phase:'ready',generation:1};if(command==='native_scope')return {id:'scope',generation:1};if(command==='native_stream')return opened.promise;return undefined;},channel:handler=>{receive=handler;return {};}};
 return {api,calls,opened,emit:(event:NativeEvent)=>receive(event)};
}
test('SSE decoder retains split UTF8, CRLF framing and multiline data',()=>{
 const decoder=new SseDecoder(),bytes=new TextEncoder().encode('event: payment\r\ndata: café\r\ndata: next\r\n\r\n');
 assert.deepEqual(decoder.push(bytes.subarray(0,24)),[]);
 assert.deepEqual(decoder.push(bytes.subarray(24)),[{type:'payment',data:'café\nnext',lastEventId:''}]);
});
test('closing before native stream opens cancels the request and fences late delivery',async()=>{
 const b=backend(),bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();
 const events:NativeEvent[]=[],stream=bridge.open('native_stream','https://pool.example/api/rollup/status',e=>events.push(e));
 await new Promise(r=>setTimeout(r,0));stream.close();
 b.opened.resolve({id:'remote',generation:1});await stream.ready;
 b.emit({id:'remote',generation:1,type:'data',data:'late'});
 assert.equal(events.length,0);assert.ok(b.calls.some(c=>c.command==='native_cancel'&&c.args.id===stream.id));assert.ok(b.calls.some(c=>c.command==='native_cancel'&&c.args.id==='remote'));
});
test('generation changes fence pending HTTP responses',async()=>{
 const answer=deferred<any>(),b=backend(),original=b.api.invoke;
 b.api.invoke=async(command,args)=>command==='native_http'?answer.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();
 const request=bridge.fetch('https://pool.example/api/rollup/status');await new Promise(r=>setTimeout(r,0));
 bridge.acceptStatus({phase:'paused',generation:2});answer.resolve({generation:1,status:200,headers:[],bodyBase64:'e30='});
 await assert.rejects(request,/generation|paused|retired/i);
});
test('session-bound fetch cannot adopt a resumed generation for a delayed call',async()=>{
 let generation=1,dispatches=0;
 const api:NativeBackend={invoke:async(command)=>{
  if(command==='native_status'||command==='native_start')return {phase:'ready',generation};
  if(command==='native_scope')return {id:'scope-'+generation,generation};
  if(command==='native_http'){dispatches++;return {generation,status:200,headers:[],bodyBase64:'e30='};}
 },channel:()=>({})};
 const bridge=new NativeBridge(api,new NativePolicy('https://pool.example'));await bridge.status();
 const old=bridge.bindFetch((input,init)=>bridge.fetch(input,init));
 await old('https://pool.example/api/rollup/status');assert.equal(dispatches,1);
 bridge.acceptStatus({phase:'paused',generation:2});generation=3;await bridge.start();
 await assert.rejects(old('https://pool.example/api/rollup/status'),/retired|generation|paused/i);assert.equal(dispatches,1);
 const fresh=bridge.bindFetch((input,init)=>bridge.fetch(input,init));await fresh('https://pool.example/api/rollup/status');assert.equal(dispatches,2);
});
test('SDK retry URLs retain their original generation and are stripped before IPC',async()=>{
 let generation=1;const dispatched:string[]=[];
 const api:NativeBackend={invoke:async(command,args)=>{
  if(command==='native_status'||command==='native_start')return {phase:'ready',generation};
  if(command==='native_scope')return {id:'scope-'+generation,generation};
  if(command==='native_http'){dispatched.push((args!.request as {url:string}).url);return {generation,status:200,headers:[],bodyBase64:'e30='};}
 },channel:()=>({})};
 const bridge=new NativeBridge(api,new NativePolicy('https://pool.example'));await bridge.status();
 const url=bridge.sessionUrl('https://pool.example')+'/api/rollup/status';
 await bridge.fetch(url);assert.deepEqual(dispatched,['https://pool.example/api/rollup/status']);
 bridge.acceptStatus({phase:'paused',generation:2});generation=3;await bridge.start();
 await assert.rejects(bridge.fetch(url),/retired|generation|paused/i);assert.equal(dispatched.length,1);
});
test('HTTP abort rejects promptly even if the native reply is delayed',async()=>{
 const b=backend(),original=b.api.invoke;b.api.invoke=(command,args)=>command==='native_http'?new Promise(()=>{}):original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();const abort=new AbortController(),request=bridge.fetch('https://pool.example/api/rollup/status',{signal:abort.signal});
 await new Promise(r=>setTimeout(r,0));abort.abort();await assert.rejects(request,/abort/i);assert.ok(b.calls.some(c=>c.command==='native_cancel'));
});
test('a failed durable mutation guard prevents native dispatch',async()=>{
 const b=backend(),bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();bridge.beforeMutation=()=>{throw new Error('journal unavailable');};
 await assert.rejects(bridge.fetch('https://pool.example/api/rollup/spends',{method:'POST',body:JSON.stringify({id:'a'.repeat(32)})}),/journal unavailable/);
 assert.equal(b.calls.filter(c=>c.command==='native_http').length,0);
});
test('idle item scopes are evicted while active streams remain pinned',async()=>{
 const b=backend(),original=b.api.invoke;let sequence=0;
 b.api.invoke=async(command,args)=>command==='native_http'?{generation:1,status:200,headers:[],bodyBase64:'e30='}:command==='native_scope'?{id:'scope-'+(++sequence),generation:1}:original(command,args);
 const policy=new NativePolicy('https://pool.example');policy.registerArk('https://ark.example','https://ark.example');const bridge=new NativeBridge(b.api,policy);await bridge.status();
 const stream=bridge.open('native_stream','https://pool.example/api/rollup/status',()=>{});await new Promise(r=>setTimeout(r,0));b.opened.resolve({id:'remote',generation:1});await stream.ready;
 for(let i=0;i<600;i++)await bridge.fetch('https://ark.example/v1/indexer/vtxos?scripts='+i);
 assert.ok(b.calls.some(c=>c.command==='native_scope_close'));assert.ok(!b.calls.some(c=>c.command==='native_scope_close'&&c.args.id==='scope-1'));stream.close();
});
test('colliding server subscription responses fail without unsubscribing a legitimate item',async()=>{
 const b=backend(),original=b.api.invoke;b.api.invoke=async(command,args)=>{if(command==='native_http'){b.calls.push({command,args});return {generation:1,status:200,headers:[],bodyBase64:btoa(JSON.stringify({subscriptionId:'shared'}))};}return original(command,args);};
 const policy=new NativePolicy('https://pool.example');policy.registerArk('https://ark.example','https://ark.example');const bridge=new NativeBridge(b.api,policy);await bridge.status();
 const subscribe=(script:string)=>bridge.fetch('https://ark.example/v1/indexer/script/subscribe',{method:'POST',body:JSON.stringify({scripts:[script]})});
 await subscribe('a');await assert.rejects(subscribe('b'),/reused|another/i);
 assert.equal(policy.classify('https://ark.example/v1/indexer/script/subscription/shared','GET').key,policy.classify('https://ark.example/v1/indexer/vtxos?scripts=a','GET').key);
 assert.ok(!b.calls.some(c=>(JSON.stringify(c.args)??'').includes('unsubscribe')));
});
