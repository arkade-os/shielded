import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import {base64} from '@scure/base';
import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import {finalizeEvent,generateSecretKey,getPublicKey,verifyEvent,type Event} from 'nostr-tools/pure';
import {NOSTR_REQUEST_KIND,readAnswer} from '../packages/protocol/src/nostr-carrier.ts';
import {startNostrCarrier} from '../src/rollup/nostr-carrier.ts';

// nostr-tools' real pool over an in-memory socket: the far end is `net`, which a test reaches into.
function network(){
 const net={up:true,sockets:new Set<Socket>(),reqs:[] as {id:string;filters:unknown[]}[],sent:[] as Event[],closes:[] as string[],
  push(event:Event){[...net.sockets].at(-1)!.onmessage!({data:JSON.stringify(['EVENT',net.reqs.at(-1)!.id,event])});}};
 class Socket{
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
  readyState=0;onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onclose:((event:object)=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;
  constructor(readonly url:string){queueMicrotask(()=>{if(!net.up){this.readyState=3;this.onerror?.();return;}this.readyState=1;net.sockets.add(this);this.onopen?.();});}
  send(data:string){
   const [type,...rest]=JSON.parse(data);
   if(type==='REQ'){net.reqs.push({id:rest[0],filters:rest.slice(1)});this.hear(['EOSE',rest[0]]);}
   else if(type==='EVENT'){net.sent.push(rest[0]);this.hear(['OK',rest[0].id,true,'']);}
   else if(type==='CLOSE')net.closes.push(rest[0]);
  }
  close(){this.readyState=3;net.sockets.delete(this);}
  hear(frame:unknown){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(frame)}));}
  hangUp(clean:boolean){this.readyState=3;net.sockets.delete(this);if(clean)this.onclose?.({});else this.onerror?.();}
 }
 return {net,Socket,pool:new AbstractSimplePool({verifyEvent,websocketImplementation:Socket as never,maxWaitForConnection:3000})};
}
const A='wss://a.example';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const eventually=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await settle();assert.ok(ok(),'the condition never held');};
const collect=()=>{v8.setFlagsFromString('--expose-gc');const gc=vm.runInNewContext('gc') as ()=>void;gc();gc();};
const request=(gateway:string,bytes=40,created_at=Math.floor(Date.now()/1000))=>finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:base64.encode(randomBytes(bytes)),created_at},generateSecretKey());

test('a flood of 40 KB requests leaves no per-event memory behind',async t=>{
 const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret);let opened=0;
 const carrier=startNostrCarrier({open:async()=>{opened++;return {kind:'refused'};},secret,relays:[A],pool});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 const flood=async(count:number)=>{for(let i=0;i<count;i++){net.push(request(gateway,30_000));if(i%50===49)await sleep(0);}};
 await flood(50);await eventually(()=>opened===50);
 collect();const before=process.memoryUsage().heapUsed;
 await flood(600);await eventually(()=>opened===650);
 collect();const retained=(process.memoryUsage().heapUsed-before)/600;
 assert.ok(retained<8192,`${Math.round(retained)} bytes stay behind for every 40 KB request`);
});

test('the listener asks only for new requests, answers through the relay and leaves no socket open',async t=>{
 const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret),sealed=new Uint8Array(randomBytes(100));
 const carrier=startNostrCarrier({open:async()=>({kind:'sealed',bytes:sealed}),secret,relays:[A],pool,now:()=>Date.UTC(2020,0,1,8,0,16)});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 assert.deepEqual(net.reqs[0]!.filters,[{kinds:[NOSTR_REQUEST_KIND],'#p':[gateway],limit:0,since:Date.UTC(2020,0,1,7,59,30)/1000}]);
 const asked=request(gateway);net.push(asked);await eventually(()=>net.sent.length===1);
 assert.deepEqual(readAnswer(net.sent,asked.id,gateway),{kind:'sealed',bytes:sealed});
 carrier.close();await settle();assert.equal(net.sockets.size,0);
});

test('a relay that is down when the listener starts is subscribed once it is up',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {net,pool}=network();net.up=false;
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[A],pool});t.after(()=>carrier.close());
 await settle();assert.equal(net.reqs.length,0);
 net.up=true;t.mock.timers.tick(29_999);await settle();assert.equal(net.reqs.length,0,'not before 30 s');
 t.mock.timers.tick(1);await eventually(()=>net.reqs.length===1);
});

for(const clean of [false,true])test(`a connection the relay ${clean?'closes':'drops'} is reopened after 30 s and delivers again`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret);let opened=0;
 const carrier=startNostrCarrier({open:async()=>{opened++;return {kind:'refused'};},secret,relays:[A],pool});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 [...net.sockets][0]!.hangUp(clean);await settle();assert.equal(net.reqs.length,1);
 t.mock.timers.tick(29_999);await settle();assert.equal(net.reqs.length,1,'not before 30 s');
 t.mock.timers.tick(1);await eventually(()=>net.reqs.length===2);
 net.push(request(gateway));await eventually(()=>opened===1);
});

test('the default pool checks a request by its id alone, so a bad signature reaches open() and a bad id does not',async t=>{
 const {net,Socket}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret),opened:Uint8Array[]=[];
 const real=globalThis.WebSocket;globalThis.WebSocket=Socket as never;t.after(()=>{globalThis.WebSocket=real;});
 const carrier=startNostrCarrier({open:async sealed=>{opened.push(sealed);return {kind:'refused'};},secret,relays:[A]});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 const unsigned={...request(gateway),sig:'00'.repeat(64)};
 net.push({...request(gateway),id:'00'.repeat(32)});net.push(unsigned);await eventually(()=>opened.length===1);await settle();
 assert.deepEqual(opened,[base64.decode(unsigned.content)]);
});

test('a relay NOTICE is not printed',async t=>{
 const {net,pool}=network(),debug=t.mock.method(console,'debug',()=>{});
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[A],pool});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 [...net.sockets][0]!.onmessage!({data:JSON.stringify(['NOTICE','rate-limited: slow down'])});await settle();
 assert.equal(debug.mock.callCount(),0);
});

test('a failing clock never makes a handler throw into the library, which would print the event',async t=>{
 const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret),warn=t.mock.method(console,'warn',()=>{});let broken=false;
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret,relays:[A],pool,now:()=>{if(broken)throw new Error('clock');return 0;}});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 broken=true;net.push(finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:'not base64!',created_at:0},generateSecretKey()));net.push(request(gateway));await settle();await settle();
 assert.equal(warn.mock.callCount(),0);
});

test('a relay that refuses only the subscription (CLOSED) is subscribed again after 30 s, from a fresh since',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let clock=Date.UTC(2020,0,1,8,0,0);const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret);let opened=0;
 const carrier=startNostrCarrier({open:async()=>{opened++;return {kind:'refused'};},secret,relays:[A],pool,now:()=>clock});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 [...net.sockets][0]!.onmessage!({data:JSON.stringify(['CLOSED',net.reqs[0]!.id,'rate-limited: slow down'])});
 await settle();assert.equal(net.reqs.length,1);
 t.mock.timers.tick(29_999);await settle();assert.equal(net.reqs.length,1,'not before 30 s');
 clock+=30_000;t.mock.timers.tick(1);await eventually(()=>net.reqs.length===2);
 assert.deepEqual(net.reqs.map(req=>(req.filters[0] as {since:number}).since),[clock/1000-90,clock/1000-60]);
 net.push(request(gateway));await eventually(()=>opened===1);
});
