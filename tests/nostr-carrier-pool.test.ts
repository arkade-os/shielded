import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer,type AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import {base64} from '@scure/base';
import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import {matchFilters,type Filter} from 'nostr-tools/filter';
import {finalizeEvent,generateSecretKey,getPublicKey,verifyEvent,type Event} from 'nostr-tools/pure';
import WebSocket,{WebSocketServer} from 'ws';
import {addressOf,NOSTR_REQUEST_KIND,readAnswer} from '../packages/protocol/src/nostr-carrier.ts';
import {CappedSocket,startNostrCarrier} from '../src/rollup/nostr-carrier.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {createSealedFetch,SealedFetchError} from '../src/shielded/sealed-fetch.ts';

// nostr-tools' real pool over an in-memory socket: the far end is `net`, one relay per URL routing events between its sockets, which a test reaches into. A quirk makes a relay refuse request events, or take them silently, with no OK and no delivery.
function network(){
 const net={up:true,sockets:new Set<Socket>(),reqs:[] as {id:string;filters:unknown[]}[],sent:[] as Event[],closes:[] as string[],quirks:new Map<string,'refuses'|'silent'>(),unheard:[] as string[],
  push(event:Event){[...net.sockets].at(-1)!.onmessage!({data:JSON.stringify(['EVENT',net.reqs.at(-1)!.id,event])});}};
 class Socket{
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
  readyState=0;subs=new Map<string,Filter[]>();onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onclose:((event:object)=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;
  constructor(readonly url:string){queueMicrotask(()=>{if(!net.up){this.readyState=3;this.onerror?.();return;}this.readyState=1;net.sockets.add(this);this.onopen?.();});}
  send(data:string){
   const [type,...rest]=JSON.parse(data);
   if(type==='REQ'){net.reqs.push({id:rest[0],filters:rest.slice(1)});this.subs.set(rest[0],rest.slice(1));this.hear(['EOSE',rest[0]]);}
   else if(type==='EVENT')this.take(rest[0]);
   else if(type==='CLOSE'){net.closes.push(rest[0]);this.subs.delete(rest[0]);}
  }
  take(event:Event){
   const request=event.kind===NOSTR_REQUEST_KIND,quirk=request?net.quirks.get(this.url):undefined;net.sent.push(event);
   if(request&&![...this.subs.values()].flat().some(filter=>filter['#x']?.includes(addressOf(base64.decode(event.content)))))net.unheard.push(event.id);
   if(quirk==='silent')return;
   if(quirk==='refuses')return this.hear(['OK',event.id,false,'blocked: not here']);
   for(const socket of net.sockets)if(socket.url===this.url)for(const [id,filters] of socket.subs)if(matchFilters(filters,event))socket.hear(['EVENT',id,event]);
   this.hear(['OK',event.id,true,'']);
  }
  close(){this.readyState=3;net.sockets.delete(this);}
  hear(frame:unknown){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(frame)}));}
  hangUp(clean:boolean){this.readyState=3;net.sockets.delete(this);if(clean)this.onclose?.({});else this.onerror?.();}
 }
 // The default pool's sockets are ws ones, so serve() fronts relay url with a real server whose connections join net.
 const serve=async(t:TestContext,url:string)=>{const real=await relay(t);real.server.on('connection',(conn:any)=>{const socket=new Socket(url);socket.onmessage=({data})=>conn.send(data);conn.on('message',(data:Buffer)=>socket.send(String(data)));conn.on('close',()=>socket.close());});return real.url;};
 return {net,Socket,serve,pool:new AbstractSimplePool({verifyEvent,websocketImplementation:Socket as never,maxWaitForConnection:3000})};
}
/** A relay on 127.0.0.1 that emits 'req' with the socket and subscription id of each REQ it gets. */
async function relay(t:TestContext){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});
 server.on('connection',(socket:any)=>socket.on('message',(data:Buffer)=>{const [type,id]=JSON.parse(String(data));if(type==='REQ')server.emit('req',socket,id);}));
 // Hooks run in order, and this one, added at the first connection, follows the test's close: a socket cut first leaves its relay a 20 s idle timer, and ws clearing a close timer while the next test mocks timers leaves that one running.
 server.once('connection',()=>t.after(async()=>{for(const socket of server.clients)socket.terminate();for(let i=0;i<500&&process.getActiveResourcesInfo().includes('TCPSocketWrap');i++)await settle();}));
 await once(server,'listening');t.after(()=>server.close());
 return {url:`ws://127.0.0.1:${(server.address() as AddressInfo).port}`,server};
}
const A='wss://a.example/',B='wss://b.example/';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const eventually=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await settle();assert.ok(ok(),'the condition never held');};
const until=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};
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
 assert.deepEqual(readAnswer(net.sent,addressOf(base64.decode(asked.content)),gateway),{kind:'sealed',bytes:sealed});
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
 const {net,serve}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret),opened:Uint8Array[]=[];
 const carrier=startNostrCarrier({open:async sealed=>{opened.push(sealed);return {kind:'refused'};},secret,relays:[await serve(t,A)]});t.after(()=>carrier.close());
 await until(()=>net.reqs.length===1);
 const unsigned={...request(gateway),sig:'00'.repeat(64)};
 net.push({...request(gateway),id:'00'.repeat(32)});net.push(unsigned);await until(()=>opened.length===1);await settle();
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

test('a sealed fetch on the real pool at both ends: a GET, a POST its first relay refuses, and a POST whose OK times out',async t=>{
 const {net,Socket,serve}=network(),key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:string[]=[];
 const real=globalThis.WebSocket;globalThis.WebSocket=Socket as never;t.after(()=>{globalThis.WebSocket=real;});
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:'https://pool.example',poolLoopback:'http://127.0.0.1:9',gatewayToken:'token',fetch:(async(url:string)=>{calls.push(url);return Response.json({ok:true});}) as unknown as typeof fetch});
 const carrier=startNostrCarrier({open:router.open,secret:key.nostrSecret,relays:[await serve(t,A),await serve(t,B)]});t.after(()=>carrier.close());
 await until(()=>net.reqs.length===2);
 const sealedFetch=createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:'https://pool.example',relays:[A,B],pick:1,timeoutMs:5000,random:()=>0});t.after(()=>sealedFetch.close());
 const spend={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
 assert.deepEqual(await (await sealedFetch('https://ark.example/v1/info')).json(),{ok:true});
 net.quirks.set(A,'refuses');assert.equal((await sealedFetch('/api/rollup/spends',spend)).status,200);
 net.quirks.set(B,'silent');await assert.rejects(sealedFetch('/api/rollup/spends',spend),(error:unknown)=>error instanceof SealedFetchError&&error.code==='outcome-unknown');
 assert.deepEqual([net.sent.filter(event=>event.kind===NOSTR_REQUEST_KIND).length,calls.length,net.unheard],[5,2,[]],'each POST went on to the other relay: the refused one was answered there, and the one whose OK timed out on B was refused by A, each after its answer subscription');
});

test('a relay frame over 1 MiB closes that connection, and the listener subscribes again 30 s later',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {url,server}=await relay(t),first=once(server,'req');
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[url]});t.after(()=>carrier.close());
 const [socket]=await first;socket.send('a'.repeat((1<<20)+1));await once(socket,'close');
 const again=once(server,'req');t.mock.timers.tick(30_000);await again;
});

test('an event under the frame cap but longer than one request never reaches open()',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 const {url,server}=await relay(t),first=once(server,'req'),secret=generateSecretKey(),gateway=getPublicKey(secret),opened:Uint8Array[]=[];let clock=0;
 const carrier=startNostrCarrier({open:async sealed=>{opened.push(sealed);return {kind:'refused'};},secret,relays:[url],now:()=>clock});t.after(()=>carrier.close());
 const [socket,id]=await first,content=base64.encode(randomBytes(32<<10));
 clock=60_000;for(const text of [content+'A',content])socket.send(JSON.stringify(['EVENT',id,finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:text,created_at:0},generateSecretKey())]));
 await until(()=>opened.length===1);
 assert.deepEqual([content.length,opened[0]!.length,socket.readyState,lines],[43_692,32<<10,WebSocket.OPEN,['[nostr] refused 1']],'the longer one was refused before it was even counted');
});

test('an event with small content but tags bulkier than a request\'s never reaches open(), and its connection stays open',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 const {url,server}=await relay(t),first=once(server,'req'),secret=generateSecretKey(),gateway=getPublicKey(secret),opened:Uint8Array[]=[];let clock=0;
 const carrier=startNostrCarrier({open:async sealed=>{opened.push(sealed);return {kind:'refused'};},secret,relays:[url],now:()=>clock});t.after(()=>carrier.close());
 const [socket,id]=await first,sent:string[]=[];
 const send=(tags:string[][])=>{const content=base64.encode(randomBytes(40));sent.push(content);socket.send(JSON.stringify(['EVENT',id,finalizeEvent({kind:NOSTR_REQUEST_KIND,tags,content,created_at:0},generateSecretKey())]));};
 clock=60_000;send([['p',gateway,'x'.repeat(100_000)]]);send([['p',gateway]]);
 await until(()=>opened.length>0);
 assert.deepEqual([opened.map(bytes=>base64.encode(bytes)),socket.readyState,lines],[sent.slice(1),WebSocket.OPEN,['[nostr] refused 1']]);
});

test('a relay that never answers the upgrade is given up after 10 s and tried again',{timeout:30_000},async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 const server=createServer(socket=>socket.on('error',()=>{}).resume()).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 let clock=0;const started=performance.now(),carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[`ws://127.0.0.1:${(server.address() as AddressInfo).port}`],now:()=>clock});t.after(()=>carrier.close());
 const [socket]=await once(server,'connection');clock=60_000;
 await once(socket,'close');const waited=performance.now()-started;
 assert.ok(waited>=9_500&&waited<12_000,`given up after ${Math.round(waited)} ms`);assert.deepEqual(lines,['[nostr] lost 1']);
 const again=once(server,'connection');t.mock.timers.tick(30_000);await again;
});

test('a relay closed for not echoing the canary cannot crash the listener with a frame it sends after',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const {url,server}=await relay(t),first=once(server,'req');
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[url]});t.after(()=>carrier.close());
 const [socket]=await first,canary=once(socket,'message');
 t.mock.timers.tick(30_000);await canary;
 socket.send('a'.repeat((1<<20)+1));t.mock.timers.tick(15_000);await once(socket,'close');
 const again=once(server,'req');t.mock.timers.tick(30_000);await again;
});

test('after a relay dies, A resubscribes on the connection an answer opened, which carries the canary and is replaced when deaf',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 const {net,pool}=network(),secret=generateSecretKey(),gateway=getPublicKey(secret);let clock=0,at=0,opens=0,release=()=>{};
 const held=new Promise<void>(resolve=>{release=resolve;});
 const carrier=startNostrCarrier({open:async()=>{if(++opens===1)await held;return {kind:'sealed',bytes:new Uint8Array(100)};},secret,relays:[A],pool,now:()=>clock});t.after(()=>carrier.close());
 const to=async(second:number)=>{for(;at<second*1000;at+=1000){t.mock.timers.tick(1000);await settle();}};
 await eventually(()=>net.reqs.length===1);net.push(request(gateway));await eventually(()=>opens===1);
 await to(1);[...net.sockets][0]!.hangUp(true);
 await to(15);release();await eventually(()=>net.sent.length===1);
 await to(36);net.push(request(gateway));await eventually(()=>net.sent.length===2);
 assert.equal(net.sockets.size,1,'no late idle close of the dead relay dropped the answer\'s connection, so A resubscribed on it and the next answer reused it');
 clock=60_000;await to(76);
 assert.deepEqual([net.reqs.length,lines],[2,[]],'that connection carried the 60 s canary and echoed it');
 net.quirks.set(A,'silent');await to(136);
 assert.equal(net.reqs.length,3,'it stopped echoing, so it was closed and A subscribed again');
});

test('a relay whose socket died is closed at once, so close() leaves it no idle timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {net,pool}=network(),carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[A],pool});t.after(()=>carrier.close());
 await eventually(()=>net.reqs.length===1);
 const dead=(pool as unknown as {relays:Map<string,{idleTimeoutHandle:unknown}>}).relays.get(A)!;
 [...net.sockets][0]!.hangUp(true);carrier.close();
 assert.equal(dead.idleTimeoutHandle,undefined);
});

test('a socket with more than 4 MiB unsent drops further sends',async t=>{
 const {url,server}=await relay(t),heard:string[]=[];server.on('req',(_socket:unknown,id:string)=>heard.push(id));
 const socket=new CappedSocket(url);t.after(()=>socket.close());await once(socket as never,'open');
 for(const [unsent,id] of [[4<<20,'at'],[(4<<20)+1,'over'],[0,'after']] as const){Object.defineProperty(socket,'bufferedAmount',{value:unsent,configurable:true});socket.send(JSON.stringify(['REQ',id]));}
 await until(()=>heard.length===2);
 assert.deepEqual(heard,['at','after']);
});
