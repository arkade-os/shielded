import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import express from 'express';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {matchFilters,type Filter} from 'nostr-tools/filter';
import {finalizeEvent,generateSecretKey,getPublicKey,type Event} from 'nostr-tools/pure';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {WebSocketServer} from 'ws';
import {gatewayCaller} from '../src/rollup/http.ts';
import {ANSWER_BYTES} from '../src/rollup/nostr-carrier.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {CARD_KIND,RFQ_KIND,createRendezvousRouter} from '../src/rollup/rendezvous.ts';

const TOKEN='per-process-token',wallet=generateSecretKey(),solver=generateSecretKey(),W=getPublicKey(wallet),S=getPublicKey(solver);
const until=async(ok:()=>boolean)=>{for(let i=0;i<300&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};
const at=()=>Math.floor(Date.now()/1000);
const rfq=(content='sealed to the solver')=>finalizeEvent({kind:RFQ_KIND,created_at:at(),tags:[['p',S]],content},wallet);
const replyTo=(pubkey:string)=>finalizeEvent({kind:RFQ_KIND,created_at:at(),tags:[['p',pubkey]],content:'a sealed quote'},solver);
const card=(network='mutinynet',content='{}',created_at=at())=>finalizeEvent({kind:CARD_KIND,created_at,tags:[['d',network]],content},solver);
const RFQ_FILTER={kinds:[RFQ_KIND],'#p':[W],authors:[S]},CARD_FILTER={kinds:[CARD_KIND],authors:[S],'#d':['mutinynet']};
type Socket={send(data:string):void;on(event:string,listener:(raw:Buffer)=>void):void;terminate():void};

/** A NIP-01 relay on a real socket: it answers REQ with what it stores and EOSE, takes EVENTs (or refuses them) and forwards them live. */
async function relay(t:TestContext,{stored=[],refuse=false,react}:{stored?:Event[];refuse?:boolean;react?:(event:Event,deliver:(event:Event)=>void)=>void}={}){
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
 const subs=new Map<Socket,Map<string,Filter[]>>(),published:Event[]=[];
 const send=(socket:Socket,message:unknown[])=>socket.send(JSON.stringify(message));
 const deliver=(event:Event)=>{for(const [socket,held] of subs)for(const [id,filters] of held)if(matchFilters(filters,event))send(socket,['EVENT',id,event]);};
 server.on('connection',(socket:Socket)=>{
  subs.set(socket,new Map());socket.on('close',()=>subs.delete(socket));
  socket.on('message',(raw:Buffer)=>{
   const [type,first,...rest]=JSON.parse(String(raw));
   if(type==='REQ'){subs.get(socket)!.set(first,rest);for(const event of stored)if(matchFilters(rest,event))send(socket,['EVENT',first,event]);send(socket,['EOSE',first]);}
   if(type==='CLOSE')subs.get(socket)!.delete(first);
   if(type==='EVENT'){if(refuse){send(socket,['OK',first.id,false,'blocked: not here']);return;}published.push(first);send(socket,['OK',first.id,true,'']);deliver(first);react?.(first,deliver);}
  });
 });
 t.after(()=>new Promise<void>(resolve=>{for(const socket of server.clients as Set<Socket>)socket.terminate();server.close(()=>resolve());}));
 return {url:`ws://127.0.0.1:${(server.address() as AddressInfo).port}`,published,sockets:()=>server.clients.size};
}
// The solver answers an RFQ addressed to it, from its own key, to the key that asked.
const solving=(delayMs=30)=>(event:Event,deliver:(event:Event)=>void)=>{if(event.kind===RFQ_KIND&&event.tags.some(tag=>tag[0]==='p'&&tag[1]===S))setTimeout(()=>deliver(replyTo(event.pubkey)),delayMs);};

async function route(t:TestContext,options:Partial<Parameters<typeof createRendezvousRouter>[0]>&{relays:readonly string[]}){
 const app=express();app.use('/api/rollup',createRendezvousRouter({fromGateway:gatewayCaller(TOKEN),...options}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup/rendezvous`;
 return (body:unknown,headers:Record<string,string>={'x-shielded-gateway':TOKEN})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
}

test('an RFQ is published to the configured relay and the solver\'s reply comes back at once, on a socket that then closes',async t=>{
 const r=await relay(t,{react:solving()}),post=await route(t,{relays:[r.url]}),event=rfq(),started=performance.now();
 const response=await post({kind:RFQ_KIND,event,filter:RFQ_FILTER,waitMs:20_000});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const {events}=await response.json() as {events:Event[]};
 assert.deepEqual([events.length,events[0]!.pubkey,events[0]!.tags],[1,S,[['p',W]]]);
 assert.ok(performance.now()-started<5_000,'the first reply ends the wait');
 assert.deepEqual(r.published.map(sent=>sent.id),[event.id]);
 await until(()=>r.sockets()===0);
});

test('a card read returns the stored cards at the end of stored events, and only the named solver\'s on the named network',async t=>{
 const other=finalizeEvent({kind:CARD_KIND,created_at:at(),tags:[['d','mutinynet']],content:'{}'},generateSecretKey());
 const r=await relay(t,{stored:[card(),card('bitcoin'),other]}),post=await route(t,{relays:[r.url]}),started=performance.now();
 const response=await post({kind:CARD_KIND,filter:CARD_FILTER,waitMs:20_000}),{events}=await response.json() as {events:Event[]};
 assert.equal(response.status,200);
 assert.deepEqual(events.map(event=>[event.pubkey,event.tags]),[[S,[['d','mutinynet']]]]);
 assert.ok(performance.now()-started<5_000,'EOSE ends a card read');
 assert.equal(r.published.length,0,'a card read publishes nothing');
});

test('refused before any relay is touched: a foreign kind, a body-supplied relay, an oversize or forged event, a widened filter, an out-of-budget wait',async t=>{
 const r=await relay(t),post=await route(t,{relays:[r.url]}),event=rfq();
 const forged={...event,content:'changed after signing'},stranger=getPublicKey(generateSecretKey());
 const bodies:unknown[]=[
  {kind:21470,event,filter:RFQ_FILTER,waitMs:1000},{kind:1,filter:{kinds:[1]},waitMs:1000},
  {kind:RFQ_KIND,event,filter:RFQ_FILTER,waitMs:1000,relays:['wss://elsewhere.example']},
  {kind:RFQ_KIND,event:rfq('x'.repeat((16<<10)+1)),filter:RFQ_FILTER,waitMs:1000},
  {kind:RFQ_KIND,event:forged,filter:RFQ_FILTER,waitMs:1000},{kind:RFQ_KIND,filter:RFQ_FILTER,waitMs:1000},
  {kind:RFQ_KIND,event:finalizeEvent({kind:1,created_at:at(),tags:[['p',S]],content:''},wallet),filter:RFQ_FILTER,waitMs:1000},
  {kind:RFQ_KIND,event,filter:{...RFQ_FILTER,'#p':[stranger]},waitMs:1000},{kind:RFQ_KIND,event,filter:{...RFQ_FILTER,authors:[stranger]},waitMs:1000},
  {kind:RFQ_KIND,event,filter:{...RFQ_FILTER,since:0},waitMs:1000},{kind:RFQ_KIND,event,filter:{kinds:[RFQ_KIND]},waitMs:1000},
  {kind:CARD_KIND,event,filter:CARD_FILTER,waitMs:1000},{kind:CARD_KIND,filter:{...CARD_FILTER,authors:Array(9).fill(S)},waitMs:1000},{kind:CARD_KIND,filter:{kinds:[CARD_KIND],authors:[S]},waitMs:1000},
  ...[25_001,0,1.5,'1000',undefined].map(waitMs=>({kind:RFQ_KIND,event,filter:RFQ_FILTER,waitMs})),
  [],'null','{not json',
 ];
 for(const body of bodies)assert.equal((await post(body)).status,400,JSON.stringify(body)?.slice(0,160));
 assert.equal((await post({kind:RFQ_KIND,event,filter:RFQ_FILTER,waitMs:1000,pad:'x'.repeat(70_000)})).status,413);
 assert.deepEqual([r.published.length,r.sockets()],[0,0]);
});

test('only the gateway\'s loopback hop may use it',async t=>{
 const r=await relay(t),post=await route(t,{relays:[r.url]}),body={kind:CARD_KIND,filter:CARD_FILTER,waitMs:1000};
 for(const headers of [{},{'x-shielded-gateway':'guessed-token-of-same-size'},{'x-shielded-gateway':TOKEN,'x-forwarded-for':'203.0.113.7'}])assert.equal((await post(body,headers as Record<string,string>)).status,403,JSON.stringify(headers));
 assert.equal(r.sockets(),0);
 assert.equal((await post(body)).status,200);
});

test('an answer stays inside the sealed answer cap however much the relay offers',async t=>{
 const lines:string[]=[];let clock=0;t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 const r=await relay(t,{stored:Array.from({length:12},(_,i)=>card('mutinynet','x'.repeat(40_000),at()-i))}),post=await route(t,{relays:[r.url],now:()=>clock});
 const response=await post({kind:CARD_KIND,filter:CARD_FILTER,waitMs:20_000}),text=await response.text(),{events}=JSON.parse(text) as {events:Event[]};
 assert.equal(response.status,200);assert.ok(text.length<=ANSWER_BYTES,`${text.length} bytes`);assert.ok(events.length>0&&events.length<12,String(events.length));
 clock=60_000;await post({kind:1,filter:{},waitMs:1});
 assert.deepEqual(lines,['[rendezvous] dropped 1, answered 1, refused 1']);
});

test('an RFQ no relay takes is a 502, and an unanswered one comes back empty at its wait',async t=>{
 const refusing=await relay(t,{refuse:true}),silent=await relay(t);
 const refused=await (await route(t,{relays:[refusing.url]}))({kind:RFQ_KIND,event:rfq(),filter:RFQ_FILTER,waitMs:20_000});
 assert.equal(refused.status,502);
 const started=performance.now(),empty=await (await route(t,{relays:[silent.url]}))({kind:RFQ_KIND,event:rfq(),filter:RFQ_FILTER,waitMs:400});
 assert.deepEqual([empty.status,await empty.json()],[200,{events:[]}]);assert.ok(performance.now()-started>=380);
 assert.equal(silent.published.length,1);
});

test('its own rate and in-flight caps answer 429 and 503 with Retry-After',async t=>{
 let clock=0;const r=await relay(t),rated=await route(t,{relays:[r.url],rate:1,now:()=>clock}),body={kind:CARD_KIND,filter:CARD_FILTER,waitMs:2000};
 assert.equal((await rated(body)).status,200);
 const over=await rated(body);assert.deepEqual([over.status,over.headers.get('retry-after')],[429,'1']);
 clock+=1000;assert.equal((await rated(body)).status,200,'the next second admits again');
 const held=await route(t,{relays:[r.url],maxInFlight:1}),waiting=held({kind:RFQ_KIND,event:rfq(),filter:RFQ_FILTER,waitMs:500});
 await until(()=>r.published.length===1);
 const shed=await held(body);assert.deepEqual([shed.status,shed.headers.get('retry-after')],[503,'1']);
 assert.equal((await waiting).status,200);assert.equal((await held(body)).status,200,'the slot came back');
});

test('the route takes its relays and limits from configuration only',()=>{
 const fromGateway=gatewayCaller(TOKEN);
 for(const options of [{relays:[]},{relays:['wss://r.example'],rate:0},{relays:['wss://r.example'],maxInFlight:1.5},{relays:['wss://r.example'],maxWaitMs:25_001}])assert.throws(()=>createRendezvousRouter({fromGateway,...options}),/rendezvous/,JSON.stringify(options));
});

test('through the real gateway: a sealed RFQ reaches the rendezvous over the loopback hop, with its token, and the reply comes back sealed',async t=>{
 const r=await relay(t,{react:solving()}),app=express();app.use('/api/rollup',createRendezvousRouter({relays:[r.url],fromGateway:gatewayCaller(TOKEN)}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,gateway=createOhttpGateway({key,upstreams:[],poolOrigin:'https://pool.example',poolLoopback:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,gatewayToken:TOKEN});
 const client=new OHTTPClient(new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM),KeyConfig.parseMultiple(key.config)[0]!,{maxMessageSize:5<<20});
 const event=rfq(),{init,context}=await client.encapsulateRequest(new Request('https://pool.example/api/rollup/rendezvous',{method:'POST',headers:{'content-type':'application/json','x-date':new Date().toUTCString()},body:JSON.stringify({kind:RFQ_KIND,event,filter:RFQ_FILTER,waitMs:20_000})}));
 const outcome=await gateway.open(init.body as Uint8Array);
 assert.equal(outcome.kind,'sealed');
 const inner=await context.decapsulateResponse(new Response(Buffer.from((outcome as {bytes:Uint8Array}).bytes),{headers:{'content-type':'message/ohttp-res'}}));
 const {events}=await inner.json() as {events:Event[]};
 assert.deepEqual([inner.status,events.map(reply=>reply.tags)],[200,[[['p',W]]]]);
 assert.deepEqual(r.published.map(sent=>sent.id),[event.id]);
});
