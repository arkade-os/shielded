import assert from 'node:assert/strict';
import test from 'node:test';
import {NativePolicy} from '../src/native/policy.ts';
import {NativeBridge,encode64,type NativeEvent,type NativeBackend} from '../src/native/transport.ts';
import {NativeEventSource,NativeWebSocket} from '../src/native/streams.ts';

const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(){
 let receive!:(event:NativeEvent)=>void,resolve!:(opened:any)=>void;const calls:{command:string;args:any}[]=[];
 const api:NativeBackend={channel:fn=>{receive=fn;return {};},invoke:async(command,args)=>{calls.push({command,args});if(command==='native_scope')return {id:'scope',generation:1};if(command==='native_stream'||command==='native_socket')return new Promise(r=>{resolve=r;});}};
 const bridge=new NativeBridge(api,new NativePolicy('https://pool.example'));bridge.acceptStatus({phase:'ready',generation:1});
 return {bridge,calls,emit:(event:NativeEvent)=>receive(event),opened:(id='remote')=>resolve({id,generation:1})};
}
test('native SSE emits parsed events and retires a waiting reader on pause',async()=>{
 const f=fixture(),source=new NativeEventSource('https://pool.example/api/rollup/status',f.bridge),messages:string[]=[];let errors=0;
 source.addEventListener('message',event=>messages.push(event.data));source.addEventListener('error',()=>{errors++;});
 await tick();f.opened();await tick();f.emit({id:'remote',generation:1,type:'open',status:200});
 const bytes=new TextEncoder().encode('id: 8\ndata: café\n\n');
 f.emit({id:'remote',generation:1,type:'data',data:encode64(bytes.subarray(0,16))});f.emit({id:'remote',generation:1,type:'data',data:encode64(bytes.subarray(16))});
 assert.deepEqual(messages,['café']);f.bridge.acceptStatus({phase:'paused',generation:2});assert.equal(errors,1);assert.equal(source.readyState,source.CLOSED);
 f.emit({id:'remote',generation:1,type:'data',data:encode64(bytes)});assert.deepEqual(messages,['café']);
});
test('closing a connecting WebSocket cancels before open and never dispatches late data',async()=>{
 const f=fixture(),route=f.bridge.policy.explicit('wss://relay.example','swap','rfq-a'),socket=new NativeWebSocket('wss://relay.example',f.bridge,route);let delivered=0;
 socket.onopen=()=>{delivered++;};socket.onmessage=()=>{delivered++;};await tick();socket.close();f.opened();await tick();
 f.emit({id:'remote',generation:1,type:'open'});f.emit({id:'remote',generation:1,type:'data',data:'secret'});
 assert.equal(delivered,0);assert.equal(socket.readyState,socket.CLOSED);assert.ok(f.calls.some(c=>c.command==='native_cancel'&&c.args.id==='remote'));
});
test('WebSocket messages only send through the established native handle',async()=>{
 const f=fixture(),socket=new NativeWebSocket('wss://relay.example',f.bridge,f.bridge.policy.explicit('wss://relay.example','swap','rfq-b'));
 assert.throws(()=>socket.send('early'),/not open/i);await tick();f.opened();await tick();f.emit({id:'remote',generation:1,type:'open'});socket.send('["REQ"]');
 assert.ok(f.calls.some(c=>c.command==='native_socket_send'&&c.args.id==='remote'&&c.args.data==='["REQ"]'));socket.close();assert.throws(()=>socket.send('late'),/not open/i);
});
