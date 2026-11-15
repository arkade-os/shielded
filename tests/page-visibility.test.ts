import assert from 'node:assert/strict';
import test from 'node:test';
import {watchPageVisibility} from '../app/src/page-visibility.ts';
import {createNativeTorMonitor} from '../app/src/native-tor-monitor.ts';
import {NativeBridge,type NativeStatus} from '../src/native/transport.ts';
import {NativePolicy} from '../src/native/policy.ts';

function fixture(){
 const doc=Object.assign(new EventTarget(),{hidden:false}),win=new EventTarget(),seen:boolean[]=[];
 const stop=watchPageVisibility(value=>seen.push(value),doc,win);
 return {doc,win,seen,stop};
}

test('freeze is received on document and stays hidden until document resume',()=>{
 const f=fixture();f.doc.dispatchEvent(new Event('freeze'));
 assert.deepEqual(f.seen,[true,false]);
 f.doc.dispatchEvent(new Event('visibilitychange'));assert.deepEqual(f.seen,[true,false]);
 f.win.dispatchEvent(new Event('focus'));assert.deepEqual(f.seen,[true,false]);
 f.doc.dispatchEvent(new Event('resume'));assert.deepEqual(f.seen,[true,false,true]);f.stop();
});

test('pagehide and freeze are independent and either return order waits for both',()=>{
 for(const order of [['pageshow','resume'],['resume','pageshow']]){
  const f=fixture();f.win.dispatchEvent(new Event('pagehide'));f.doc.dispatchEvent(new Event('freeze'));
  for(const [i,event]of order.entries()){
   (event==='pageshow'?f.win:f.doc).dispatchEvent(new Event(event));
   assert.equal(f.seen.at(-1),i===1);
  }
  assert.deepEqual(f.seen,[true,false,true]);f.stop();
 }
});

test('native activation or page return cannot override document.hidden',()=>{
 const f=fixture();f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));
 f.win.dispatchEvent(new Event('pageshow'));f.doc.dispatchEvent(new Event('resume'));
 assert.deepEqual(f.seen,[true,false]);
 f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));assert.deepEqual(f.seen,[true,false,true]);
 f.stop();f.doc.dispatchEvent(new Event('freeze'));assert.deepEqual(f.seen,[true,false,true]);
});

test('initial hidden state and duplicate background events do not create extra transitions',()=>{
 const doc=Object.assign(new EventTarget(),{hidden:true}),win=new EventTarget(),seen:boolean[]=[];
 const stop=watchPageVisibility(value=>seen.push(value),doc,win);
 doc.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('pagehide'));
 assert.deepEqual(seen,[false]);stop();stop();
});

test('repeated page and native switches keep one ready owner while explicit lock still revokes it',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:0});
 const doc=Object.assign(new EventTarget(),{hidden:false}),win=new EventTarget(),calls:string[]=[];
 let visible=true,status:NativeStatus={phase:'ready',generation:1,foreground:true};
 const bridge=new NativeBridge({invoke:async command=>{calls.push(command);if(command==='native_pause')status={phase:'paused',generation:2,foreground:true};return status;},channel:()=>({})},new NativePolicy('https://pool.example'));
 bridge.acceptStatus(status);const owner=bridge.sessionGuard();
 const monitor=createNativeTorMonitor({status:()=>bridge.status(),subscribe:fn=>bridge.subscribe(fn),check:async()=>{}},()=>{},error=>{throw error;},()=>visible);
 const stop=watchPageVisibility(value=>{visible=value;monitor.visibilityChanged();},doc,win);
 t.after(()=>{stop();monitor.stop();});
 const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));await flush();
 for(let i=0;i<3;i++){
  doc.dispatchEvent(new Event('freeze'));win.dispatchEvent(new Event('pagehide'));
  status={...status,foreground:false};bridge.acceptLifecycle(status);await flush();
  t.mock.timers.tick(60_000);await flush();assert.doesNotThrow(owner);
  status={...status,foreground:true};bridge.acceptLifecycle(status);
  win.dispatchEvent(new Event('pageshow'));assert.equal(visible,false);
  doc.dispatchEvent(new Event('resume'));await flush();assert.equal(visible,true);assert.doesNotThrow(owner);
 }
 assert.ok(calls.every(command=>command==='native_status'));
 await bridge.pause();assert.throws(owner,/retired|paused/);
 bridge.acceptLifecycle({...status,foreground:true});assert.throws(owner,/retired|paused/);
});
