import assert from 'node:assert/strict';
import test from 'node:test';
import {NativeBridge,SseDecoder,type NativeBackend,type NativeEvent,type NativeStatus} from '../src/native/transport.ts';
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

test('stream data is acknowledged after delivery and retired generations never acknowledge',async()=>{
 const b=backend(),bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();
 let delivered=false;const original=b.api.invoke;
 b.api.invoke=async(command,args)=>{if(command==='native_stream_ack')assert.equal(delivered,true);return original(command,args);};
 const stream=bridge.open('native_stream','https://pool.example/api/rollup/status',()=>{delivered=true;});
 await new Promise(r=>setTimeout(r,0));b.opened.resolve({id:'remote',generation:1});await stream.ready;
 b.emit({id:'remote',generation:1,type:'data',data:'eA==',sequence:1});
 assert.deepEqual(b.calls.filter(call=>call.command==='native_stream_ack').map(call=>call.args),[{generation:1,id:'remote',sequence:1}]);
 bridge.acceptStatus({phase:'paused',generation:2});
 b.emit({id:'remote',generation:1,type:'data',data:'eA==',sequence:2});
 assert.equal(b.calls.filter(call=>call.command==='native_stream_ack').length,1);
});

test('SSE decoding permits long streams while retaining the per-event bound',()=>{
 const decoder=new SseDecoder(),bytes=new TextEncoder().encode('data: '+ 'x'.repeat(64*1024)+'\n\n');
 for(let n=0;n<144;n++){const messages=decoder.push(bytes);assert.equal(messages.length,1);assert.equal(messages[0].data.length,64*1024);}
 assert.throws(()=>decoder.push(new Uint8Array(4*1024*1024+1).fill(120)),/limit/);
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

test('HTTP abort rejects during scope acquisition and closes the late unused lease',async()=>{
 const pending=deferred<{id:string;generation:number}>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_scope'?(b.calls.push({command,args}),pending.promise):original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();let journaled=0;
 bridge.beforeMutation=()=>{journaled++;};
 const controller=new AbortController(),reason=new Error('cancelled before scope'),request=bridge.fetch('https://pool.example/api/rollup/spends',{method:'POST',body:JSON.stringify({id:'b'.repeat(32)}),signal:controller.signal});
 let outcome:unknown='pending';void request.then(()=>{outcome='resolved';},error=>{outcome=error;});
 await new Promise(r=>setTimeout(r,0));assert.equal(b.calls.filter(c=>c.command==='native_scope').length,1);
 controller.abort(reason);await new Promise(r=>setTimeout(r,0));assert.equal(outcome,reason);
 pending.resolve({id:'late-unused-scope',generation:1});await new Promise(r=>setTimeout(r,0));
 assert.equal(journaled,0);assert.equal(b.calls.filter(c=>c.command==='native_http').length,0);
 assert.equal(b.calls.filter(c=>c.command==='native_cancel').length,0);
 assert.ok(b.calls.some(c=>c.command==='native_scope_close'&&c.args.id==='late-unused-scope'));
});

test('closing before scope acquisition does not create an unmatched native cancellation',async()=>{
 const pending=deferred<{id:string;generation:number}>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_scope'?pending.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();
 const stream=bridge.open('native_stream','https://pool.example/api/rollup/status',()=>{});stream.close();
 pending.resolve({id:'late-scope',generation:1});await stream.ready;
 assert.equal(b.calls.filter(c=>c.command==='native_cancel'||c.command==='native_stream').length,0);
});

test('aborting one scope waiter preserves another request using the same item',async()=>{
 const pending=deferred<{id:string;generation:number}>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_scope'?(b.calls.push({command,args}),pending.promise):command==='native_http'?(b.calls.push({command,args}),Promise.resolve({generation:1,status:200,headers:[],bodyBase64:'e30='})):original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.status();
 const controller=new AbortController(),aborted=bridge.fetch('https://pool.example/api/rollup/status',{signal:controller.signal}),survivor=bridge.fetch('https://pool.example/api/rollup/status');
 const stopped=assert.rejects(aborted,/abort/i);await new Promise(r=>setTimeout(r,0));controller.abort();
 pending.resolve({id:'shared-scope',generation:1});await stopped;assert.equal((await survivor).status,200);
 assert.equal(b.calls.filter(c=>c.command==='native_scope').length,1);assert.equal(b.calls.filter(c=>c.command==='native_http').length,1);
 assert.ok(!b.calls.some(c=>c.command==='native_scope_close'&&c.args.id==='shared-scope'));
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

test('a bootstrap poll cannot retire the session completed by a later start',async()=>{
 const polled=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_status'?polled.promise:command==='native_http'?Promise.resolve({generation:1,status:200,headers:[],bodyBase64:'e30='}):original(command,args);
 const policy=new NativePolicy('https://pool.example'),bridge=new NativeBridge(b.api,policy),poll=bridge.status();
 await bridge.start();policy.registerArk('https://ark.example','https://ark.example');
 await bridge.fetch('https://ark.example/v1/indexer/vtxos?scripts=a');
 polled.resolve({phase:'bootstrapping',generation:1,progress:'50%'});
 assert.equal((await poll).phase,'ready');assert.equal(bridge.current.phase,'ready');
 await bridge.fetch('https://ark.example/v1/indexer/vtxos?scripts=a');
 assert.equal(b.calls.filter(call=>call.command==='native_scope').length,1);
});
test('a newer ready poll retires an outstanding bootstrap snapshot',async()=>{
 const old=deferred<NativeStatus>(),fresh=deferred<NativeStatus>();let polls=0;
 const api:NativeBackend={invoke:async()=>++polls===1?old.promise:fresh.promise,channel:()=>({})};
 const bridge=new NativeBridge(api,new NativePolicy('https://pool.example'));bridge.acceptStatus({phase:'bootstrapping',generation:1});
 const previous=bridge.status(),next=bridge.status();fresh.resolve({phase:'ready',generation:1});await next;
 old.resolve({phase:'bootstrapping',generation:1});assert.equal((await previous).phase,'ready');
});
test('a ready poll cannot unpause while native pause is pending',async()=>{
 const polled=deferred<NativeStatus>(),paused=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_status'?polled.promise:command==='native_pause'?paused.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));bridge.acceptStatus({phase:'ready',generation:1});
 const poll=bridge.status(),pause=bridge.pause();polled.resolve({phase:'ready',generation:1});
 assert.equal((await poll).phase,'paused');assert.equal(bridge.current.phase,'paused');
 paused.resolve({phase:'paused',generation:2});await pause;
});
test('a poll started during pause stays retired after pause completes',async()=>{
 const polled=deferred<NativeStatus>(),paused=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_status'?polled.promise:command==='native_pause'?paused.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));bridge.acceptStatus({phase:'ready',generation:1});
 const pause=bridge.pause(),poll=bridge.status();paused.resolve({phase:'paused',generation:1});await pause;
 polled.resolve({phase:'ready',generation:1});assert.equal((await poll).phase,'paused');assert.equal(bridge.current.phase,'paused');
});
test('an old start cannot restore a locally paused session',async()=>{
 const started=deferred<NativeStatus>(),paused=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_start'?started.promise:command==='native_pause'?paused.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example')),start=bridge.start(),pause=bridge.pause();
 started.resolve({phase:'ready',generation:1});assert.equal((await start).phase,'paused');assert.equal(bridge.current.phase,'paused');
 paused.resolve({phase:'paused',generation:2});await pause;
});
test('a failed pause leaves stale ready polls unable to restore a session',async()=>{
 const polled=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_status'?polled.promise:command==='native_pause'?Promise.reject(new Error('pause unavailable')):original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));bridge.acceptStatus({phase:'ready',generation:1});
 const poll=bridge.status();await assert.rejects(bridge.pause(),/pause unavailable/);
 polled.resolve({phase:'ready',generation:1});assert.equal((await poll).phase,'paused');assert.equal(bridge.current.phase,'paused');
});
test('a failed pause keeps its local intent until an explicit start',async()=>{
 const b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_pause'?Promise.reject(new Error('pause unavailable')):original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.start();
 await assert.rejects(bridge.pause(),/pause unavailable/);
 assert.equal((await bridge.status()).phase,'paused');assert.throws(()=>bridge.sessionGuard(),/paused|retired/);
 assert.equal((await bridge.start()).phase,'ready');
});
test('start during a pending pause cannot release its barrier',async()=>{
 const paused=deferred<NativeStatus>(),b=backend(),original=b.api.invoke;
 b.api.invoke=(command,args)=>command==='native_pause'?paused.promise:original(command,args);
 const bridge=new NativeBridge(b.api,new NativePolicy('https://pool.example'));await bridge.start();const before=b.calls.filter(call=>call.command==='native_start').length;
 const pause=bridge.pause();assert.equal((await bridge.start()).phase,'paused');
 assert.equal(b.calls.filter(call=>call.command==='native_start').length,before);
 paused.resolve({phase:'paused',generation:2});await pause;assert.equal(bridge.current.phase,'paused');
});
