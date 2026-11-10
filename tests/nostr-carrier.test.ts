import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {base64} from '@scure/base';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {finalizeEvent,generateSecretKey,getPublicKey,type Event} from 'nostr-tools/pure';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {addressOf,NOSTR_ANSWER_KIND,NOSTR_RELAYS,NOSTR_REQUEST_KIND,readAnswer,requestEvent} from '../packages/protocol/src/nostr-carrier.ts';
import {createOhttpGateway,type OhttpOpen} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey,type OhttpGatewayKey} from '../src/rollup/ohttp-keys.ts';
import {nostrRelaysFromEnv,startNostrCarrier,type RelayPool} from '../src/rollup/nostr-carrier.ts';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
const A='wss://a.example',B='wss://b.example',ARK='https://ark.example/v1/info';
const until=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};
const quiet=()=>sleep(100);
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const advance=async(t:TestContext,ms:number)=>{for(let at=0;at<ms;at+=1000){t.mock.timers.tick(1000);await settle();}};
const holding=()=>{let release=()=>{};const held=new Promise<Response>(resolve=>{release=()=>resolve(Response.json({ok:true}));});return {held,release};};

async function rig(t:TestContext,{relays=[A],reply=()=>Response.json({ok:true}),gateway={},now,open,restarting,cacheBytes}:{relays?:string[];reply?:(url:string)=>Response|Promise<Response>;gateway?:Partial<Parameters<typeof createOhttpGateway>[0]>;now?:()=>number;open?:OhttpOpen;restarting?:{key:OhttpGatewayKey;bus:ReturnType<typeof createNostrBus>};cacheBytes?:number}={}){
 const key=restarting?.key??(await loadOhttpKey((await generateOhttpKey()).env))!,calls:string[]=[],outcomes:string[]=[],bus=restarting?.bus??createNostrBus();
 const upstream=(async(url:string)=>{calls.push(url);return reply(url);}) as unknown as typeof fetch;
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:'https://pool.example',poolLoopback:'http://127.0.0.1:9',gatewayToken:'token',fetch:upstream,...gateway});
 const opener:OhttpOpen=async(sealed,options)=>{const outcome=await (open??router.open)(sealed,options);outcomes.push(outcome.kind);return outcome;};
 const carrier=startNostrCarrier({open:opener,secret:key.nostrSecret,relays,pool:bus.pool,...(now?{now}:{}),cacheBytes});t.after(()=>carrier.close());await settle();
 const client=new OHTTPClient(SUITE,KeyConfig.select(SUITE,KeyConfig.parseMultiple(key.config)),{maxMessageSize:5<<20});
 const ask=async(url:string,{to=[A],listen=to}:{to?:string[];listen?:string[]}={})=>{
  const sealed=await client.encapsulateRequest(new Request(url)),bytes=sealed.init.body as Uint8Array,event=requestEvent(bytes,key.nostrPublic,Date.now()),x=addressOf(bytes),heard=new Map<string,Event[]>();
  for(const relay of listen){heard.set(relay,[]);bus.pool.subscribeMany([relay],{kinds:[NOSTR_ANSWER_KIND],authors:[key.nostrPublic],'#x':[x]},{onevent:answer=>heard.get(relay)!.push(answer)});}
  await Promise.all(bus.pool.publish(to,event));
  const answer=(relay=listen[0]!)=>readAnswer(heard.get(relay)!,x,key.nostrPublic);
  const inner=async(relay=listen[0]!)=>{const got=answer(relay);assert.ok(got?.kind==='sealed');return sealed.context.decapsulateResponse(new Response(Buffer.from(got.bytes),{headers:{'content-type':'message/ohttp-res'}}));};
  return {event,bytes,heard,answer,inner};
 };
 const answers=()=>bus.published.filter(event=>event.kind===NOSTR_ANSWER_KIND&&event.pubkey===key.nostrPublic),statuses=()=>answers().filter(event=>event.tags.some(tag=>tag[0]==='status'));
 const forged=(content:string,{tags=[['p',key.nostrPublic]],kind=NOSTR_REQUEST_KIND}:{tags?:string[][];kind?:number}={})=>finalizeEvent({kind,tags,content,created_at:0},generateSecretKey());
 return {key,calls,outcomes,bus,carrier,ask,forged,answers,statuses};
}

test('a request on one relay is answered on that relay',async t=>{
 const g=await rig(t,{relays:[A,B],reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json'}})});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});
 await until(()=>sent.answer(A)?.kind==='sealed');await quiet();
 const inner=await sent.inner(A);
 assert.deepEqual([inner.status,inner.headers.get('content-type'),await inner.text()],[202,'application/json','{"height":7}']);
 assert.equal(sent.heard.get(B)!.length,0,'the other relay never carried the request, so it carries no answer');
 assert.deepEqual(g.calls,[ARK]);
});

test('the same request from two relays is opened once and answered on both',async t=>{
 const {held,release}=holding(),g=await rig(t,{relays:[A,B],reply:()=>held});
 const sent=await g.ask(ARK,{to:[A,B]});
 await until(()=>g.calls.length===1);await quiet();
 release();await until(()=>sent.answer(A)?.kind==='sealed'&&sent.answer(B)?.kind==='sealed');
 assert.equal(g.calls.length,1);assert.equal(g.answers().length,1,'one set of answer events, sent to both relays');
 assert.deepEqual(sent.answer(A),sent.answer(B));assert.equal((await sent.inner(B)).status,200);
});

test('a large answer goes out in chunks the client reassembles',async t=>{
 const body=new Uint8Array(100<<10).map((_,i)=>i%251),g=await rig(t,{reply:()=>new Response(body)});
 const sent=await g.ask(ARK);await until(()=>sent.answer()?.kind==='sealed');
 assert.equal(sent.heard.get(A)!.length,4);
 const got=new Uint8Array(await (await sent.inner()).arrayBuffer()),digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 assert.deepEqual([got.length,digest(got)],[body.length,digest(body)]);
});

test('a shed request gets a status event and no upstream call',async t=>{
 const {held,release}=holding(),g=await rig(t,{gateway:{maxInFlight:1},reply:()=>held});
 const first=await g.ask(ARK);await until(()=>g.calls.length===1);
 const second=await g.ask(ARK);await until(()=>second.answer()!==undefined);
 assert.deepEqual(second.answer(),{kind:'status',status:503,retryAfter:1});assert.equal(g.calls.length,1);
 release();await until(()=>first.answer()?.kind==='sealed');assert.equal(g.calls.length,1);
});

test('status events are capped at 5 a second of the monotonic clock, the rest are counted, and the next second publishes again',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0,tick=0;t.mock.method(performance,'now',()=>tick);
 const {held,release}=holding(),g=await rig(t,{now:()=>clock,gateway:{maxInFlight:1,rate:1000},reply:()=>held});
 await g.ask(ARK);await until(()=>g.calls.length===1);
 for(let i=0;i<8;i++)await g.ask(ARK,{listen:[]});
 await until(()=>g.outcomes.length===8);await quiet();
 assert.equal(g.statuses().length,5,'eight requests were shed, five were told');
 tick=1000;await g.ask(ARK,{listen:[]});await until(()=>g.statuses().length===6);
 clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] busy 6, status-capped 3, dropped 1']);
 release();await quiet();
});

test('the status cap does not touch answers',async t=>{
 const g=await rig(t,{now:()=>0,gateway:{rate:1000}}),sent:Awaited<ReturnType<typeof g.ask>>[]=[];
 for(let i=0;i<8;i++)sent.push(await g.ask(ARK));
 await until(()=>sent.every(one=>one.answer()?.kind==='sealed'));
 assert.equal(g.answers().length,8);
});

test('garbage, replays and hostile events get nothing',async t=>{
 const g=await rig(t);g.bus.relay(A).unfiltered=true;
 const first=await g.ask(ARK);await until(()=>first.answer()?.kind==='sealed');
 const hostile=[
  g.forged('not base64!'),g.forged(base64.encode(randomBytes(64)),{tags:[['p','ab'.repeat(32)]]}),g.forged(base64.encode(randomBytes(64)),{tags:[]}),
  g.forged(base64.encode(randomBytes(64)),{kind:NOSTR_ANSWER_KIND}),g.forged(base64.encode(randomBytes((32<<10)+1))),g.forged(''),
  g.forged(base64.encode(randomBytes(200))),requestEvent(first.bytes,g.key.nostrPublic,Date.now()),
 ];
 for(const event of hostile)await Promise.all(g.bus.pool.publish([A],event));
 await quiet();
 assert.deepEqual(g.outcomes,['sealed','refused'],'only the unopenable bytes got as far as open(): the replay is a copy of the answered request');
 assert.equal(g.calls.length,1,'no hostile event reached the upstream');
 assert.equal(g.answers().length,1,'the only answer is the first request\'s');
});

test('a restarted listener is not handed the requests a storing relay kept, so none runs again',async t=>{
 const first=await rig(t);first.bus.relay(A).stores=true;
 const sent=await first.ask(ARK);await until(()=>sent.answer()?.kind==='sealed');
 first.carrier.close();const second=await rig(t,{restarting:first});await quiet();
 assert.deepEqual([first.calls.length,second.calls.length,second.outcomes],[1,0,[]]);
});

test('a relay that ignores limit:0 hands back only what is dated from since, a minute before now',async t=>{
 const at=Date.UTC(2026,10,6,8,0,0),since=at/1000-60,bus=createNostrBus(),secret=generateSecretKey(),gateway=getPublicKey(secret),opened:string[]=[];
 Object.assign(bus.relay(A),{stores:true,ignoresLimit:true});
 const kept=[since-1,since,since+30].map(created_at=>finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:base64.encode(randomBytes(40)),created_at},generateSecretKey()));
 for(const event of kept)await Promise.all(bus.pool.publish([A],event));
 const carrier=startNostrCarrier({open:async sealed=>{opened.push(base64.encode(sealed));return {kind:'refused'};},secret,relays:[A],pool:bus.pool,now:()=>at});t.after(()=>carrier.close());
 await quiet();
 assert.deepEqual(opened,kept.slice(1).map(event=>event.content));
});

test('close() stops listening',async t=>{
 const g=await rig(t,{relays:[A,B]});
 assert.equal(g.bus.openSubscriptions(),2);g.carrier.close();assert.equal(g.bus.openSubscriptions(),0);
 const sent=await g.ask(ARK,{to:[A,B]});await quiet();
 assert.equal(sent.answer(),undefined);assert.equal(g.calls.length,0);assert.equal(g.answers().length,0);
});

test('a relay listed twice is subscribed once',async t=>{
 const g=await rig(t,{relays:[A,B,A]});
 assert.equal(g.bus.openSubscriptions(),2);
});

test('an answer that finishes after close() is not published',async t=>{
 const {held,release}=holding(),g=await rig(t,{reply:()=>held});
 await g.ask(ARK);await until(()=>g.calls.length===1);
 g.carrier.close();release();await quiet();
 assert.equal(g.answers().length,0);
});

test('nostrRelaysFromEnv',()=>{
 for(const value of [undefined,'  '])assert.deepEqual(nostrRelaysFromEnv(value),NOSTR_RELAYS);
 assert.deepEqual(nostrRelaysFromEnv('wss://a.example, wss://b.example'),['wss://a.example/','wss://b.example/']);
 assert.deepEqual(nostrRelaysFromEnv('wss://a.example,wss://a.example/, WSS://A.Example:443,wss://b.example'),['wss://a.example/','wss://b.example/'],'one connection each, however a URL is spelled');
 for(const value of ['https://a.example','ws://a.example',',','wss://a.example,','not a url'])assert.throws(()=>nostrRelaysFromEnv(value),/wss/,value);
 const many=(count:number)=>Array.from({length:count},(_,i)=>`wss://r${i}.example`).join(',');
 assert.equal(nostrRelaysFromEnv(many(12)).length,12);assert.equal(nostrRelaysFromEnv(many(12)+',wss://r0.example').length,12,'counted after deduplication');
 assert.throws(()=>nostrRelaysFromEnv(many(13)),/at most 12/);
});

test('a copy of a request that is still running is dropped, so no status goes out for it',async t=>{
 const {held,release}=holding(),g=await rig(t,{relays:[A,B],gateway:{maxInFlight:1},reply:()=>held});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>g.calls.length===1);
 await Promise.all([...g.bus.pool.publish([A],sent.event),...g.bus.pool.publish([B],sent.event)]);await quiet();
 assert.equal(g.calls.length,1);assert.deepEqual(g.statuses(),[],'the gateway is at its cap, so a copy that reached open() would have been told busy');
 release();await until(()=>sent.answer(A)?.kind==='sealed'&&sent.answer(B)?.kind==='sealed');
 assert.equal(g.calls.length,1);assert.deepEqual(sent.answer(A),sent.answer(B));
});

test('a copy from a new relay after the answer gets the cached answer there, and runs nothing',async t=>{
 const g=await rig(t,{relays:[A,B]});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>sent.answer(A)?.kind==='sealed');
 await Promise.all(g.bus.pool.publish([B],sent.event));await until(()=>sent.answer(B)?.kind==='sealed');
 assert.deepEqual([g.calls.length,g.outcomes.length,g.statuses()],[1,1,[]]);
 const lookups=t.mock.method(g.bus.pool,'ensureRelay');
 await Promise.all(g.bus.pool.publish([A],sent.event));await quiet();
 assert.equal(lookups.mock.callCount(),0,'A already has the answer, so nothing is published to it again');
});

test('a cached answer is not re-published 30 s after it was signed',async t=>{
 let clock=0;const g=await rig(t,{relays:[A,B],now:()=>clock});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>sent.answer(A)?.kind==='sealed');
 clock=30_000;await Promise.all(g.bus.pool.publish([B],sent.event));await quiet();
 assert.deepEqual([sent.heard.get(B)!.length,g.calls.length],[0,1]);
});

test('two events carrying the same sealed bytes run once, and both relays hear the one answer',async t=>{
 const g=await rig(t,{relays:[A,B]}),sent=await g.ask(ARK,{to:[],listen:[A,B]}),copy=requestEvent(sent.bytes,g.key.nostrPublic,Date.now()),x=addressOf(sent.bytes);
 await Promise.all([...g.bus.pool.publish([A],sent.event),...g.bus.pool.publish([B],copy)]);await until(()=>sent.answer(A)?.kind==='sealed'&&sent.answer(B)?.kind==='sealed');await quiet();
 assert.deepEqual([g.calls.length,g.outcomes],[1,['sealed']],'the copy never reached open()');
 assert.ok(g.answers().every(answer=>answer.tags.find(tag=>tag[0]==='x')?.[1]===x));
});

test('a shed request leaves no entry, so its next copy runs',async t=>{
 let replies=0;const {held,release}=holding(),g=await rig(t,{relays:[A,B],gateway:{maxInFlight:1},reply:()=>++replies===1?held:Response.json({ok:true})});
 const first=await g.ask(ARK);await until(()=>g.calls.length===1);
 const second=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>second.answer(A)!==undefined);
 assert.deepEqual(second.answer(A),{kind:'status',status:503,retryAfter:1});
 release();await until(()=>first.answer()?.kind==='sealed');
 await Promise.all(g.bus.pool.publish([B],second.event));await until(()=>second.answer(B)?.kind==='sealed');
 assert.equal(g.calls.length,2);assert.equal((await second.inner(B)).status,200);
});

test('a refused request leaves no entry, so each copy is refused by open()',async t=>{
 const g=await rig(t,{relays:[A,B]}),event=requestEvent(randomBytes(200),g.key.nostrPublic,Date.now());
 await Promise.all(g.bus.pool.publish([A],event));await until(()=>g.outcomes.length===1);
 await Promise.all(g.bus.pool.publish([B],event));await until(()=>g.outcomes.length===2);await quiet();
 assert.deepEqual([g.outcomes,g.answers()],[['refused','refused'],[]]);
});

test('a spent outbound budget sheds a new request with a 503 before any upstream call, and an admitted answer is still published whole',async t=>{
 let tick=0;t.mock.method(performance,'now',()=>tick);
 const relays=[A,B,'wss://c.example'],body=new Uint8Array(100<<10),g=await rig(t,{relays,gateway:{rate:1000},reply:()=>new Response(body)});
 const answered=async()=>{const sent=await g.ask(ARK,{to:relays});await until(()=>relays.every(relay=>sent.answer(relay)?.kind==='sealed'));return sent;};
 for(let i=0;i<5;i++)await answered();
 const sixth=await answered();
 assert.deepEqual(relays.map(relay=>sixth.heard.get(relay)!.length),[4,4,4],'admitted on a balance of 4, it still sent all 12');
 const seventh=await g.ask(ARK,{to:relays});await until(()=>seventh.answer(A)?.kind==='status');
 assert.deepEqual([seventh.answer(A),g.calls.length],[{kind:'status',status:503,retryAfter:1},6]);
 tick+=1000;await answered();assert.equal(g.calls.length,7);
});

test('a re-published answer draws on the outbound budget',async t=>{
 t.mock.method(performance,'now',()=>0);let room=()=>true;
 const g=await rig(t,{relays:[A,B],open:async(_sealed,options)=>{room=options!.room!;return {kind:'sealed',bytes:new Uint8Array(32<<15)};}});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>sent.answer(A)?.kind==='sealed');assert.ok(room(),'32 of 64 spent on A');
 await Promise.all(g.bus.pool.publish([B],sent.event));await until(()=>sent.answer(B)?.kind==='sealed');
 assert.ok(!room(),'the 32 re-published to B spent the rest');
});

test('the answer cache drops the oldest answer past its byte cap',async t=>{
 const g=await rig(t,{relays:[A,B],cacheBytes:3000}),sent:Awaited<ReturnType<typeof g.ask>>[]=[];
 for(let i=0;i<2;i++){sent.push(await g.ask(ARK,{to:[A],listen:[A,B]}));await until(()=>sent[i]!.answer(A)?.kind==='sealed');}
 for(const one of sent)await Promise.all(g.bus.pool.publish([B],one.event));
 await until(()=>sent[1]!.answer(B)?.kind==='sealed');await quiet();
 assert.deepEqual([sent[0]!.heard.get(B)!.length,g.outcomes],[0,['sealed','sealed','refused']],'the evicted request ran again as far as the replay check');
});

test('an open() that rejects publishes nothing, not even a status, and is counted as failed',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0,calls=0;const g=await rig(t,{now:()=>clock,open:async()=>{calls++;throw new Error('boom');}});
 const sent=await g.ask(ARK);await until(()=>calls===1);await quiet();
 await Promise.all(g.bus.pool.publish([A],sent.event));await quiet();
 assert.equal(calls,2,'a throw leaves no entry, so a copy reaches open() again, whose register refuses one that opened');assert.equal(g.answers().length,0);
 clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] failed 2, dropped 1']);
});

test('an answer a relay refuses is counted, not thrown',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0;const {held,release}=holding(),g=await rig(t,{now:()=>clock,reply:()=>held});
 const sent=await g.ask(ARK);await until(()=>g.calls.length===1);
 const lookups=t.mock.method(g.bus.pool,'ensureRelay'),before=lookups.mock.callCount();
 g.bus.relay(A).accept=false;release();await until(()=>lookups.mock.callCount()>before);await sleep(10);
 assert.equal(sent.answer(),undefined);
 g.bus.relay(A).accept=true;clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] answered 1, unpublished 1, dropped 1']);
});

test('the carrier logs counts by kind, never an id, a relay or a body',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0;const g=await rig(t,{now:()=>clock});
 const sent=await g.ask(ARK);await until(()=>sent.answer()?.kind==='sealed');
 await Promise.all(g.bus.pool.publish([A],sent.event));await quiet();
 await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,[],'nothing is logged per request');
 clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] answered 1, duplicate 1, dropped 2']);
});

test('a subscription the relay closes is opened again after a delay, and close() cancels the wait',async t=>{
 const g=await rig(t,{relays:[A,B]});
 t.mock.timers.enable({apis:['setTimeout']});
 g.bus.drop(A);assert.equal(g.bus.openSubscriptions(),1);
 t.mock.timers.tick(29_999);await settle();assert.equal(g.bus.openSubscriptions(),1);
 t.mock.timers.tick(1);await settle();assert.equal(g.bus.openSubscriptions(),2);
 g.bus.drop(B);const lookups=t.mock.method(g.bus.pool,'ensureRelay');g.carrier.close();t.mock.timers.tick(60_000);await settle();
 assert.equal(lookups.mock.callCount(),0,'a closed carrier does not reach for a relay again');assert.equal(g.bus.openSubscriptions(),0);
});

test('a resubscribed relay still delivers requests',async t=>{
 const g=await rig(t,{relays:[A]});
 t.mock.timers.enable({apis:['setTimeout']});
 g.bus.drop(A);t.mock.timers.tick(30_000);t.mock.timers.reset();await settle();
 const sent=await g.ask(ARK);await until(()=>sent.answer()?.kind==='sealed');
 assert.equal((await sent.inner()).status,200);
});

test('close() closes every subscription and destroys the pool, and a late event is not opened',async t=>{
 const secret=generateSecretKey(),gateway=getPublicKey(secret),taps:((event:Event)=>void)[]=[];let opened=0,closes=0,destroys=0;
 const relay={subscribe:(_filters:unknown,params:{onevent:(event:Event)=>void})=>{taps.push(params.onevent);return {close(){closes++;}};},publish:async()=>'',close(){}};
 const pool={ensureRelay:async()=>relay,destroy(){destroys++;}} as unknown as RelayPool;
 const carrier=startNostrCarrier({open:async()=>{opened++;return {kind:'refused'};},secret,relays:[A,B],pool});t.after(()=>carrier.close());
 await until(()=>taps.length===2);
 taps[0]!(requestEvent(randomBytes(40),gateway,Date.now()));await until(()=>opened===1);
 carrier.close();assert.deepEqual([closes,destroys],[2,1]);
 taps[0]!(requestEvent(randomBytes(40),gateway,Date.now()));await quiet();
 assert.equal(opened,1);
});

test('an upstream body at the cap fits 8 answer events beside the largest headers fetch passes, and one byte more is a sealed 502',async t=>{
 const cap=241_644,headers={'content-type':'a'.repeat(16_219),'cache-control':'b'.repeat(64),'retry-after':'c'.repeat(64)};
 for(const [size,status] of [[cap,200],[cap+1,502]] as const){
  const g=await rig(t,{reply:()=>new Response(new Uint8Array(size),{headers})}),sent=await g.ask(ARK);await until(()=>sent.answer()?.kind==='sealed');
  const inner=await sent.inner();
  assert.deepEqual([inner.status,(await inner.arrayBuffer()).byteLength],[status,status===200?size:0]);
  assert.ok(sent.heard.get(A)!.length<=8,`${sent.heard.get(A)!.length} answer events`);
 }
});

test('open() is told the answer cap unless the caller sets one',async t=>{
 const secret=generateSecretKey(),gateway=getPublicKey(secret),seen:(number|undefined)[]=[],bus=createNostrBus();
 const open:OhttpOpen=async(_sealed,options)=>{seen.push(options?.maxAnswer);return {kind:'refused'};};
 for(const maxAnswer of [undefined,1234]){
  const carrier=startNostrCarrier({open,secret,relays:[A],pool:bus.pool,...(maxAnswer?{maxAnswer}:{})}),before=seen.length;t.after(()=>carrier.close());await settle();
  await Promise.all(bus.pool.publish([A],requestEvent(randomBytes(40),gateway,Date.now())));await until(()=>seen.length>before);carrier.close();
 }
 assert.deepEqual(seen,[241_644,1234]);
});

test('an answer for a relay that cannot be reached is counted unpublished, and the other relay still gets it',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0;const {held,release}=holding(),g=await rig(t,{relays:[A,B],now:()=>clock,reply:()=>held});
 const sent=await g.ask(ARK,{to:[A,B],listen:[A,B]});await until(()=>g.calls.length===1);await quiet();
 g.bus.drop(B);g.bus.relay(B).unreachable=true;
 release();await until(()=>sent.answer(A)?.kind==='sealed');
 assert.equal(sent.heard.get(B)!.length,0);
 clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] duplicate 1, lost 1, answered 1, unpublished 1, dropped 1']);
});

test('after many requests there is still one subscription per relay, and none was lost',async t=>{
 let tick=0;t.mock.method(performance,'now',()=>tick);
 const g=await rig(t,{relays:[A,B],gateway:{rate:1000,now:()=>0}}),count=150;
 assert.equal(g.bus.openSubscriptions(),2);
 for(let i=0;i<count;i++){tick+=1000;await g.ask(ARK,{to:[i%2?A:B],listen:[]});} // a second apart, so the outbound budget never sheds one
 await until(()=>g.answers().length===count);
 assert.equal(g.bus.openSubscriptions(),2);assert.equal(g.calls.length,count);
 const last=await g.ask(ARK,{to:[A]});await until(()=>last.answer()?.kind==='sealed');
 assert.equal((await last.inner()).status,200);
});

test('every 30 s each relay gets one canary signed by the gateway, which is never opened, and a relay that echoes it stays subscribed',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const g=await rig(t,{relays:[A,B],now:()=>45_999});
 await advance(t,30_000);
 const canaries=g.bus.published.filter(event=>event.pubkey===g.key.nostrPublic).map(({kind,tags,content,created_at})=>({kind,tags,content,created_at}));
 assert.deepEqual(canaries,[{kind:NOSTR_REQUEST_KIND,tags:[['p',g.key.nostrPublic]],content:'',created_at:45}]);
 await advance(t,15_000);
 assert.deepEqual([g.bus.openSubscriptions(),g.outcomes],[2,[]]);
});

test('a relay that does not echo the canary in 15 s is closed and subscribed again 30 s later',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 let clock=0;const g=await rig(t,{relays:[A,B],now:()=>clock});g.bus.relay(B).deliver=false;
 await advance(t,30_000);clock=60_000;await advance(t,15_000);
 assert.deepEqual([g.bus.openSubscriptions(),lines],[1,['[nostr] deaf 1']]);
 g.bus.relay(B).deliver=true;await advance(t,30_000);
 assert.equal(g.bus.openSubscriptions(),2);
 t.mock.timers.reset();
 const sent=await g.ask(ARK,{to:[B],listen:[B]});await until(()=>sent.answer(B)?.kind==='sealed');
});

test('a relay that refuses the canary is not taken for deaf and stays subscribed, but one whose canary times out is closed',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 let clock=0;const g=await rig(t,{relays:[A,B],now:()=>clock});Object.assign(g.bus.relay(B),{accept:false,refusal:'rate-limited: slow down'});
 await advance(t,30_000);clock=60_000;await advance(t,15_000);assert.equal(g.bus.openSubscriptions(),2);
 await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await advance(t,1000);
 assert.deepEqual(lines,['[nostr] canary-refused 1, dropped 1']);
 Object.assign(g.bus.relay(B),{accept:true,timesOut:true,deliver:false});await advance(t,30_000);
 assert.equal(g.bus.openSubscriptions(),1);
});

test('close() destroys the pool, then closes each relay that holds a subscription',async t=>{
 const bus=createNostrBus(),order:string[]=[],ensure=bus.pool.ensureRelay;
 t.mock.method(bus.pool,'ensureRelay',async(url:string)=>{const relay=await ensure(url),close=relay.close;relay.close=()=>{order.push(url);close();};return relay;});
 t.mock.method(bus.pool,'destroy',()=>{order.push('destroy');});
 const carrier=startNostrCarrier({open:async()=>({kind:'refused'}),secret:generateSecretKey(),relays:[A,B],pool:bus.pool});t.after(()=>carrier.close());await settle();
 carrier.close();
 assert.deepEqual(order,['destroy',A,B]);
});
