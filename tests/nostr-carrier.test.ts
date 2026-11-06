import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {base64} from '@scure/base';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {finalizeEvent,generateSecretKey,getPublicKey,type Event} from 'nostr-tools/pure';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {NOSTR_ANSWER_KIND,NOSTR_RELAYS,NOSTR_REQUEST_KIND,readAnswer,requestEvent} from '../packages/protocol/src/nostr-carrier.ts';
import {createOhttpGateway,type OhttpOpen} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {nostrRelaysFromEnv,startNostrCarrier,type RelayPool} from '../src/rollup/nostr-carrier.ts';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
const A='wss://a.example',B='wss://b.example',ARK='https://ark.example/v1/info';
const until=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};
const quiet=()=>sleep(100);
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const holding=()=>{let release=()=>{};const held=new Promise<Response>(resolve=>{release=()=>resolve(Response.json({ok:true}));});return {held,release};};

async function rig(t:TestContext,{relays=[A],reply=()=>Response.json({ok:true}),gateway={},now,open}:{relays?:string[];reply?:(url:string)=>Response|Promise<Response>;gateway?:Partial<Parameters<typeof createOhttpGateway>[0]>;now?:()=>number;open?:OhttpOpen}={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:string[]=[],outcomes:string[]=[],bus=createNostrBus();
 const upstream=(async(url:string)=>{calls.push(url);return reply(url);}) as unknown as typeof fetch;
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:'https://pool.example',poolLoopback:'http://127.0.0.1:9',gatewayToken:'token',fetch:upstream,...gateway});
 const opener:OhttpOpen=async(sealed,options)=>{const outcome=await (open??router.open)(sealed,options);outcomes.push(outcome.kind);return outcome;};
 const carrier=startNostrCarrier({open:opener,secret:key.nostrSecret,relays,pool:bus.pool,...(now?{now}:{})});t.after(()=>carrier.close());await settle();
 const client=new OHTTPClient(SUITE,KeyConfig.select(SUITE,KeyConfig.parseMultiple(key.config)),{maxMessageSize:5<<20});
 const ask=async(url:string,{to=[A],listen=to}:{to?:string[];listen?:string[]}={})=>{
  const sealed=await client.encapsulateRequest(new Request(url)),bytes=sealed.init.body as Uint8Array,event=requestEvent(bytes,key.nostrPublic,Date.now()),heard=new Map<string,Event[]>();
  for(const relay of listen){heard.set(relay,[]);bus.pool.subscribeMany([relay],{kinds:[NOSTR_ANSWER_KIND],authors:[key.nostrPublic],'#e':[event.id]},{onevent:answer=>heard.get(relay)!.push(answer)});}
  await Promise.all(bus.pool.publish(to,event));
  const answer=(relay=listen[0]!)=>readAnswer(heard.get(relay)!,event.id,key.nostrPublic);
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
 assert.deepEqual(new Uint8Array(await (await sent.inner()).arrayBuffer()),body);
});

test('a shed request gets a status event and no upstream call',async t=>{
 const {held,release}=holding(),g=await rig(t,{gateway:{maxInFlight:1},reply:()=>held});
 const first=await g.ask(ARK);await until(()=>g.calls.length===1);
 const second=await g.ask(ARK);await until(()=>second.answer()!==undefined);
 assert.deepEqual(second.answer(),{kind:'status',status:503,retryAfter:1});assert.equal(g.calls.length,1);
 release();await until(()=>first.answer()?.kind==='sealed');assert.equal(g.calls.length,1);
});

test('status events are capped at 5 a second, the rest are counted, and the next second publishes again',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0;const {held,release}=holding(),g=await rig(t,{now:()=>clock,gateway:{maxInFlight:1,rate:1000},reply:()=>held});
 await g.ask(ARK);await until(()=>g.calls.length===1);
 for(let i=0;i<8;i++)await g.ask(ARK,{listen:[]});
 await until(()=>g.outcomes.length===8);await quiet();
 assert.equal(g.statuses().length,5,'eight requests were shed, five were told');
 clock=1000;await g.ask(ARK,{listen:[]});await until(()=>g.statuses().length===6);
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
 assert.deepEqual(g.outcomes,['sealed','refused','refused'],'only the unopenable bytes and the replay got as far as open()');
 assert.equal(g.calls.length,1,'no hostile event reached the upstream');
 assert.equal(g.answers().length,1,'the only answer is the first request\'s');
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
 assert.deepEqual(nostrRelaysFromEnv('wss://a.example, wss://b.example'),[A,B]);
 for(const value of ['https://a.example','ws://a.example',',','wss://a.example,','not a url'])assert.throws(()=>nostrRelaysFromEnv(value),/wss/,value);
});

test('a copy of a request that is still running is dropped, so no status goes out for it',async t=>{
 const {held,release}=holding(),g=await rig(t,{relays:[A,B],gateway:{maxInFlight:1},reply:()=>held});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>g.calls.length===1);
 await Promise.all([...g.bus.pool.publish([A],sent.event),...g.bus.pool.publish([B],sent.event)]);await quiet();
 assert.equal(g.calls.length,1);assert.deepEqual(g.statuses(),[],'the gateway is at its cap, so a copy that reached open() would have been told busy');
 release();await until(()=>sent.answer(A)?.kind==='sealed'&&sent.answer(B)?.kind==='sealed');
 assert.equal(g.calls.length,1);assert.deepEqual(sent.answer(A),sent.answer(B));
});

test('a copy that arrives after the answer is ignored',async t=>{
 const g=await rig(t,{relays:[A,B]});
 const sent=await g.ask(ARK,{to:[A],listen:[A,B]});await until(()=>sent.answer(A)?.kind==='sealed');
 await Promise.all(g.bus.pool.publish([B],sent.event));await quiet();
 assert.equal(g.calls.length,1);assert.equal(sent.heard.get(B)!.length,0,'the answer went to the relay that carried the request in time');assert.deepEqual(g.statuses(),[]);
});

test('an open() that rejects publishes nothing, not even a status, and is counted as failed',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0,calls=0;const g=await rig(t,{now:()=>clock,open:async()=>{calls++;throw new Error('boom');}});
 const sent=await g.ask(ARK);await until(()=>calls===1);await quiet();
 await Promise.all(g.bus.pool.publish([A],sent.event));await quiet();
 assert.equal(calls,1,'a copy of a request whose open() threw is not opened again');assert.equal(g.answers().length,0);
 clock=60_000;await Promise.all(g.bus.pool.publish([A],g.forged('not base64!')));await quiet();
 assert.deepEqual(lines,['[nostr] failed 1, duplicate 1, dropped 1']);
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

test('close() closes every subscription and destroys the pool, and a late event is not opened',async()=>{
 const secret=generateSecretKey(),gateway=getPublicKey(secret),taps:((event:Event)=>void)[]=[];let opened=0,closes=0,destroys=0;
 const relay={subscribe:(_filters:unknown,params:{onevent:(event:Event)=>void})=>{taps.push(params.onevent);return {close(){closes++;}};},publish:async()=>''};
 const pool={ensureRelay:async()=>relay,destroy(){destroys++;}} as unknown as RelayPool;
 const carrier=startNostrCarrier({open:async()=>{opened++;return {kind:'refused'};},secret,relays:[A,B],pool});
 await until(()=>taps.length===2);
 taps[0]!(requestEvent(randomBytes(40),gateway,Date.now()));await until(()=>opened===1);
 carrier.close();assert.deepEqual([closes,destroys],[2,1]);
 taps[0]!(requestEvent(randomBytes(40),gateway,Date.now()));await quiet();
 assert.equal(opened,1);
});

test('open() is told the answer cap: 960 KiB unless the caller sets one',async()=>{
 const secret=generateSecretKey(),gateway=getPublicKey(secret),seen:(number|undefined)[]=[],bus=createNostrBus();
 const open:OhttpOpen=async(_sealed,options)=>{seen.push(options?.maxAnswer);return {kind:'refused'};};
 for(const maxAnswer of [undefined,1234]){
  const carrier=startNostrCarrier({open,secret,relays:[A],pool:bus.pool,...(maxAnswer?{maxAnswer}:{})}),before=seen.length;await settle();
  await Promise.all(bus.pool.publish([A],requestEvent(randomBytes(40),gateway,Date.now())));await until(()=>seen.length>before);carrier.close();
 }
 assert.deepEqual(seen,[960<<10,1234]);
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
 const g=await rig(t,{relays:[A,B],gateway:{rate:1000}}),count=150;
 assert.equal(g.bus.openSubscriptions(),2);
 for(let i=0;i<count;i++)await g.ask(ARK,{to:[i%2?A:B],listen:[]});
 await until(()=>g.answers().length===count);
 assert.equal(g.bus.openSubscriptions(),2);assert.equal(g.calls.length,count);
 const last=await g.ask(ARK,{to:[A]});await until(()=>last.answer()?.kind==='sealed');
 assert.equal((await last.inner()).status,200);
});
