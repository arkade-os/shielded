import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {base64} from '@scure/base';
import {finalizeEvent,generateSecretKey,type Event} from 'nostr-tools/pure';
import {addressOf,NOSTR_ANSWER_KIND,NOSTR_REQUEST_KIND,readRequest,statusEvent} from '../packages/protocol/src/nostr-carrier.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {startNostrCarrier} from '../src/rollup/nostr-carrier.ts';
import {createSealedFetch,SealedFetchError} from '../src/shielded/sealed-fetch.ts';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const A='wss://a.example',B='wss://b.example',C='wss://c.example',D='wss://d.example';
const ARK='https://ark.example/v1/info',POOL='https://pool.example',LOOPBACK='http://127.0.0.1:9',SPEND={method:'POST',headers:{'content-type':'application/json'},body:'{"id":"ab"}'};
const until=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const holding=(reply=()=>Response.json({ok:true}))=>{let release=()=>{};const held=new Promise<Response>(resolve=>{release=()=>resolve(reply());});return {held,release};};
const failsWith=(code:SealedFetchError['code'])=>(error:unknown)=>error instanceof SealedFetchError&&error.code===code;
const timers=()=>process.getActiveResourcesInfo().filter(type=>type==='Timeout').length;

type Rig={relays?:string[];reply?:()=>Response|Promise<Response>;gateway?:Partial<Parameters<typeof createOhttpGateway>[0]>}&Pick<Parameters<typeof createSealedFetch>[0],'pick'|'timeoutMs'|'attempts'|'random'>;
async function rig(t:TestContext,{relays=[A,B],reply=()=>Response.json({ok:true}),gateway={},...options}:Rig={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:{url:string;init:RequestInit}[]=[],bus=createNostrBus();
 const upstream=(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply();}) as unknown as typeof fetch;
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:POOL,poolLoopback:LOOPBACK,gatewayToken:'token',fetch:upstream,...gateway});
 const carrier=startNostrCarrier({open:router.open,secret:key.nostrSecret,relays,pool:bus.pool});t.after(()=>carrier.close());await settle();
 const sends=t.mock.method(bus.pool,'publish'),sealedFetch=createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,relays,pool:bus.pool,random:()=>0,...options});t.after(()=>sealedFetch.close());
 const answers=()=>bus.published.filter(event=>event.kind===NOSTR_ANSWER_KIND&&event.pubkey===key.nostrPublic),requests=()=>bus.published.filter(event=>event.kind===NOSTR_REQUEST_KIND);
 return {key,calls,bus,fetch:sealedFetch,answers,requests,address:()=>addressOf(readRequest(requests()[0]!,key.nostrPublic)!),statuses:()=>answers().filter(event=>event.tags.some(tag=>tag[0]==='status')),
  sentTo:()=>sends.mock.calls.map(call=>call.arguments[0]),sent:()=>sends.mock.calls.map(call=>call.arguments[1])};
}

test('a GET goes out sealed and comes back as a Response',async t=>{
 const g=await rig(t,{reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json'}})}),before=[g.bus.openSubscriptions(),timers()];
 const response=await g.fetch(ARK);await sleep(20);
 assert.deepEqual([response.status,response.headers.get('content-type'),await response.text()],[202,'application/json','{"height":7}']);
 assert.deepEqual(g.calls.map(call=>call.url),[ARK]);assert.ok(!JSON.stringify(g.requests()).includes('ark.example'),'the relays never see the target');
 assert.deepEqual([g.bus.openSubscriptions(),timers()],before,'the answer closed every subscription and deadline the fetch opened');
});

test('relative URLs resolve against the origin and only content-type and accept leave the client',async t=>{
 const g=await rig(t);
 assert.equal((await g.fetch('/api/rollup/status',{headers:{'X-SDK-VERSION':'ts-sdk/0.5.3',Authorization:'x',Accept:'application/json'}})).status,200);
 assert.deepEqual(g.calls.map(call=>call.url),[LOOPBACK+'/api/rollup/status']);
 const sealed=Buffer.from(readRequest(g.requests()[0]!,g.key.nostrPublic)!),{request}=await g.key.server.decapsulateRequest(new Request('http://gateway.test/',{method:'POST',headers:{'content-type':'message/ohttp-req'},body:sealed}));
 assert.equal(request.url,POOL+'/api/rollup/status');assert.deepEqual([...request.headers],[['accept','application/json']]);
});

test('a large answer is reassembled, from chunks in any order, past a chunk another key signed',async t=>{
 const body=new Uint8Array(100<<10).map((_,i)=>i%251),{held,release}=holding(()=>new Response(body)),g=await rig(t,{relays:[A],reply:()=>held});
 const pending=g.fetch(ARK);await until(()=>g.calls.length===1);
 g.bus.relay(A).deliver=false;release();await until(()=>g.answers().length===4);
 const forged=finalizeEvent({kind:NOSTR_ANSWER_KIND,tags:[['x',g.address()],['chunk','0','1']],content:base64.encode(new Uint8Array(64)),created_at:0},generateSecretKey());
 Object.assign(g.bus.relay(A),{deliver:true,unfiltered:true});
 for(const event of [forged,...g.answers().reverse()])await Promise.all(g.bus.pool.publish([A],event));
 const got=Buffer.from(await (await pending).arrayBuffer());assert.ok(got.equals(body),`${got.length} bytes came back, not the ${body.length} sent`);
});

test('a status event delays the retry',async t=>{
 let replies=0;const {held,release}=holding(),g=await rig(t,{gateway:{maxInFlight:1},reply:()=>++replies===1?held:Response.json({ok:true})});
 const first=g.fetch(ARK);await until(()=>g.calls.length===1);
 const started=performance.now(),second=g.fetch('/api/rollup/spends',SPEND);
 await until(()=>g.statuses().length===1);release();
 assert.deepEqual(g.statuses()[0]!.tags.find(tag=>tag[0]==='status'),['status','503']);
 assert.equal((await second).status,200);assert.ok(performance.now()-started>=1000,'the retry waited the second the status asked for');
 assert.equal((await first).status,200);assert.equal(g.calls.length,2);assert.equal(g.requests().length,3);
 const [,shed,retry]=g.sent();assert.equal(shed!.content,retry!.content,'the shed POST went out again with the same sealing, which the gateway had never recorded');
});

test('a POST shed on two attempts within 30 s hears both statuses and runs on its third',async t=>{
 const real=Date.now,shift=(45_000-real()%30_000)%30_000;t.mock.method(Date,'now',()=>real()+shift); // starts a 30 s rounding window, so both statuses fall in one
 let replies=0;const {held,release}=holding(),g=await rig(t,{pick:1,timeoutMs:5000,gateway:{maxInFlight:1},reply:()=>++replies===1?held:Response.json({ok:true})});
 const first=g.fetch(ARK);await until(()=>g.calls.length===1);
 const spend=g.fetch('/api/rollup/spends',SPEND);await until(()=>g.statuses().length===2);release();
 assert.equal((await spend).status,200);assert.deepEqual(g.sentTo(),[[A],[A],[B],[A]]);
 assert.equal(g.calls.filter(call=>call.url===LOOPBACK+'/api/rollup/spends').length,1);assert.equal((await first).status,200);
});

test('a GET whose relay never delivers is retried on another relay',async t=>{
 const g=await rig(t,{pick:1,timeoutMs:100});g.bus.relay(A).deliver=false;
 assert.equal((await g.fetch(ARK)).status,200);
 assert.deepEqual(g.sentTo(),[[A],[B]]);assert.equal(g.requests().length,2);
 assert.notEqual(g.sent()[0]!.content,g.sent()[1]!.content,'each GET attempt is sealed afresh');
});

test('a late answer to an earlier attempt counts',async t=>{
 // Through A the request and its answer each wait 150 ms, so the answer lands near 300 ms; five attempts keep the fetch open to 500 ms.
 let replies=0;const g=await rig(t,{pick:1,timeoutMs:100,attempts:5,reply:()=>Response.json({reply:++replies})});
 g.bus.relay(A).delayMs=150;g.bus.relay(B).deliver=false;
 assert.deepEqual(await (await g.fetch(ARK)).json(),{reply:1},'the first attempt\'s answer, the first the gateway gave');
 assert.deepEqual(g.sentTo().slice(0,2),[[A],[B]]);
});

test('a POST whose answer never comes is not published again',async t=>{
 for(const mode of [{deliver:false},{deliver:false,timesOut:true}]){
  const g=await rig(t,{timeoutMs:100});for(const url of [A,B])Object.assign(g.bus.relay(url),mode);
  const started=performance.now();
  await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown'));
  assert.ok(performance.now()-started>=90,'it waited out the deadline');assert.equal(g.requests().length,1,JSON.stringify(mode));
 }
});

test('a POST that no relay accepted is retried',async t=>{
 const g=await rig(t,{relays:[A,B,C,D]});g.bus.relay(A).accept=false;g.bus.relay(B).unreachable=true;
 assert.equal((await g.fetch('/api/rollup/spends',SPEND)).status,200);
 assert.deepEqual(g.sentTo(),[[A,B],[C,D]]);assert.equal(g.requests().length,1,'one accepted request event in total');
 assert.deepEqual(g.calls.map(({url,init})=>[url,new TextDecoder().decode(init.body as ArrayBuffer),new Headers(init.headers).get('content-type')]),[[LOOPBACK+'/api/rollup/spends','{"id":"ab"}','application/json']]);
 const [first,second]=g.sent();assert.equal(first!.id,second!.id,'the event no relay took went on to the next picks');
});

test('a POST through a relay that delivers what it says it never took runs once, and its answer comes back',async t=>{
 for(const mode of ['refusesButDelivers','claimsUnreachable'] as const){
  const g=await rig(t,{pick:1});g.bus.relay(A)[mode]=true;
  assert.equal((await g.fetch('/api/rollup/spends',SPEND)).status,200,mode);await sleep(100);
  assert.deepEqual(g.sentTo(),[[A],[B]],mode);assert.equal(g.calls.length,1,`${mode}: the listener grouped the copy on B with A's by x`);
 }
});

test('a pick that times out without delivering is hedged at once, and the answer comes from the next relay',{timeout:10_000},async t=>{
 const g=await rig(t,{pick:1,timeoutMs:60_000});Object.assign(g.bus.relay(A),{timesOut:true,deliver:false});
 assert.equal((await g.fetch(ARK)).status,200);
 assert.deepEqual(g.sentTo(),[[A],[B]]);assert.equal(g.sent()[0]!.id,g.sent()[1]!.id,'the same event went to B');assert.equal(g.requests().length,1);
});

test('a POST hedged across relays carries one sealing and runs once',{timeout:10_000},async t=>{
 const g=await rig(t,{pick:1,timeoutMs:60_000});Object.assign(g.bus.relay(A),{timesOut:true,deliver:false});
 assert.equal((await g.fetch('/api/rollup/spends',SPEND)).status,200);
 assert.deepEqual([g.sentTo(),g.calls.length,new Set(g.sent().map(event=>event.content)).size],[[[A],[B]],1,1]);
});

test('a refusal without a NIP-01 prefix is hedged like a timeout',{timeout:10_000},async t=>{
 const g=await rig(t,{pick:1});Object.assign(g.bus.relay(A),{accept:false,refusal:'Policy violated and pubkey is not in our web of trust.'});
 assert.equal((await g.fetch(ARK)).status,200);assert.deepEqual(g.sentTo(),[[A],[B]]);
});

test('a relay that did not acknowledge is benched for 5 minutes, and an acknowledgement lifts it',{timeout:10_000},async t=>{
 let clock=0,r=0;t.mock.method(performance,'now',()=>clock);
 const g=await rig(t,{relays:[A,B,C],pick:1,gateway:{rate:1000},random:()=>r}),dead={timesOut:true,deliver:false};
 const fetches=async(...to:string[][])=>{const before=g.sentTo().length;assert.equal((await g.fetch(ARK)).status,200);assert.deepEqual(g.sentTo().slice(before),to);};
 Object.assign(g.bus.relay(A),dead);
 await fetches([A],[B]);
 clock=299_999;await fetches([B]);
 clock=300_000;await fetches([A],[B]);
 Object.assign(g.bus.relay(A),{timesOut:false,deliver:true});for(const url of [B,C])Object.assign(g.bus.relay(url),dead);
 await fetches([B],[C],[A]);
 r=0.99;await fetches([A]);
});

test('a round whose OK is still out when another relay brings the answer hedges nothing after the fetch',async t=>{
 const gate=holding(),g=await rig(t,{relays:[A,B,C],pick:1});g.bus.relay(A).refusesButDelivers=true;Object.assign(g.bus.relay(B),{timesOut:true,deliver:false,okGate:gate.held});
 assert.equal((await g.fetch(ARK)).status,200);assert.deepEqual(g.sentTo(),[[A],[B]],'A delivered as it refused, and B was still out at the answer');
 gate.release();await settle();assert.deepEqual(g.sentTo(),[[A],[B]],'B\'s late timeout hedged nothing once the fetch was done');
});

test('a round whose OK is still out when a status ends its attempt hedges nothing',async t=>{
 let replies=0;const upstream=holding(),gate=holding(),g=await rig(t,{relays:[A,B,C],pick:1,gateway:{maxInFlight:1},reply:()=>++replies===1?upstream.held:Response.json({ok:true})});
 const first=g.fetch(ARK);await until(()=>g.calls.length===1);
 Object.assign(g.bus.relay(A),{timesOut:true,okGate:gate.held});
 const second=g.fetch(ARK);await until(()=>g.statuses().length===1);await sleep(10);gate.release();await settle();
 assert.deepEqual(g.sentTo(),[[A],[A]],'A\'s late timeout came in the back-off and hedged nothing');
 upstream.release();assert.equal((await second).status,200);assert.deepEqual(g.sentTo(),[[A],[A],[B]]);assert.equal((await first).status,200);
});

test('attempts run out as unavailable',async t=>{
 const g=await rig(t,{timeoutMs:50,attempts:3}),before=g.bus.openSubscriptions();for(const url of [A,B])g.bus.relay(url).deliver=false;
 await assert.rejects(g.fetch(ARK),failsWith('unavailable'));
 assert.equal(g.requests().length,3);assert.equal(g.bus.openSubscriptions(),before,'every attempt\'s subscription closed');
});

test('a status event cannot hold the client past its attempt deadline',{timeout:10_000},async t=>{
 let replies=0;const g=await rig(t,{relays:[A],timeoutMs:200,reply:()=>++replies===1?new Promise<Response>(()=>{}):Response.json({ok:true})});
 const started=performance.now(),pending=g.fetch(ARK);await until(()=>g.calls.length===1);
 await Promise.all(g.bus.pool.publish([A],statusEvent(503,3600,g.address(),g.sent()[0]!.id,g.key.nostrSecret,Date.now())));
 assert.equal((await pending).status,200);assert.ok(performance.now()-started<2000,'the hour the status asked for was cut to the deadline');
});

test('a stored status from an earlier attempt does not end a later one',async t=>{
 let replies=0;const {held,release}=holding(),g=await rig(t,{relays:[A],pick:1,attempts:2,gateway:{maxInFlight:1},reply:()=>++replies===1?held:Response.json({ok:true})});
 g.bus.relay(A).stores=true;
 const first=g.fetch(ARK);await until(()=>g.calls.length===1);
 const spend=g.fetch('/api/rollup/spends',SPEND);await until(()=>g.statuses().length===1);release();
 assert.equal((await spend).status,200,'the status A replayed to the second, last attempt did not end it');
 assert.equal(g.calls.filter(call=>call.url===LOOPBACK+'/api/rollup/spends').length,1);assert.equal((await first).status,200);
});

test('a status for an earlier GET attempt does not end the current attempt',async t=>{
 const {held,release}=holding(),g=await rig(t,{pick:1,timeoutMs:500,attempts:2,reply:()=>held});g.bus.relay(A).deliver=false;
 const pending=g.fetch(ARK);await until(()=>g.calls.length===1);
 g.bus.relay(A).deliver=true;await Promise.all(g.bus.pool.publish([A],statusEvent(503,1,g.address(),g.sent()[0]!.id,g.key.nostrSecret,Date.now())));await sleep(20);release();
 assert.equal((await pending).status,200,'the second, last attempt kept waiting for its own answer');assert.deepEqual(g.sentTo().slice(0,2),[[A],[B]]);
});

test('a late status for an earlier copy of a POST does not end a later attempt',async t=>{
 let replies=0;const slot=holding(),spent=holding(),g=await rig(t,{pick:1,attempts:2,gateway:{maxInFlight:1},reply:()=>++replies===1?slot.held:spent.held});
 const first=g.fetch(ARK);await until(()=>g.calls.length===1);
 const spend=g.fetch('/api/rollup/spends',SPEND);await until(()=>g.statuses().length===1);slot.release();await until(()=>g.calls.length===2);
 const [,shed]=g.sent(),late=finalizeEvent({kind:NOSTR_ANSWER_KIND,tags:[['x',addressOf(readRequest(shed!,g.key.nostrPublic)!)],['e',shed!.id],['status','503'],['retry-after','1']],content:'',created_at:g.statuses()[0]!.created_at+1},g.key.nostrSecret);
 await Promise.all(g.bus.pool.publish([B],late));await sleep(20);spent.release();
 assert.equal((await spend).status,200,'the second, last attempt kept waiting for its own answer');
 assert.deepEqual([g.sentTo().slice(0,3),g.calls.length,(await first).status],[[[A],[A],[B]],2,200]);
});

test('a status, then the complete answer, resolves with the answer',async t=>{
 const {held,release}=holding(),g=await rig(t,{pick:1,reply:()=>held}),pending=g.fetch(ARK);await until(()=>g.calls.length===1);
 await Promise.all(g.bus.pool.publish([A],statusEvent(503,1,g.address(),g.sent()[0]!.id,g.key.nostrSecret,Date.now())));release();
 assert.equal((await pending).status,200);assert.equal(g.requests().length,1,'nothing more went out');
});

test('a relay\'s OK with no message, or with any JSON for one, has taken the event, and nothing throws',async t=>{
 for(const value of [undefined,JSON.parse('{"toString":1}'),['connection failure: x']]){
  const g=await rig(t),publish=g.bus.pool.publish;
  t.mock.method(g.bus.pool,'publish',(urls:string[],event:Event)=>publish(urls,event).map(sent=>sent.then(()=>value as string)));
  assert.equal((await g.fetch(ARK)).status,200);assert.deepEqual(g.sentTo(),[[A,B]],`${JSON.stringify(value)}: no second attempt`);
 }
});

test('a request too large for one event is refused before publishing',async t=>{
 const g=await rig(t),before=g.bus.openSubscriptions();
 for(const size of [32<<10,40<<10,6<<20])await assert.rejects(g.fetch('/api/rollup/spends',{method:'POST',body:new Uint8Array(size)}),failsWith('too-large'),`${size} bytes`);
 assert.deepEqual([g.sentTo().length,g.requests().length,g.bus.openSubscriptions()],[0,0,before]);
});

test('close() refuses new fetches and stops one in flight before its next attempt goes out',async t=>{
 const g=await rig(t,{pick:1,timeoutMs:100});g.bus.relay(A).deliver=false;
 const pending=g.fetch(ARK);await until(()=>g.sentTo().length===1);
 g.fetch.close();assert.equal(g.bus.openSubscriptions(),0,'the pool is destroyed');
 let refused=false;const late=g.fetch(ARK).catch(error=>{refused=true;throw error;});await null;
 assert.ok(refused,'a fetch after close() is refused at once, before it seals');
 await assert.rejects(late,failsWith('unavailable'));await assert.rejects(pending,failsWith('unavailable'));
 assert.deepEqual(g.sentTo(),[[A]],'nothing went out after close()');
});

test('a POST that went out ends outcome-unknown when its attempts run out, where a GET ends unavailable',async t=>{
 const g=await rig(t);for(const url of [A,B])g.bus.relay(url).unreachable=true;
 await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown'));await assert.rejects(g.fetch(ARK),failsWith('unavailable'));
 assert.equal(g.sentTo().length,6,'each used its three attempts');
});

test('close() ends a POST that went out as outcome-unknown, and one that never did as unavailable',async t=>{
 const g=await rig(t,{pick:1}),publish=g.bus.pool.publish;g.bus.relay(A).accept=false;
 t.mock.method(g.bus.pool,'publish',(urls:string[],event:Event)=>{const sent=publish(urls,event);g.fetch.close();return sent;});
 await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown'));await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('unavailable'));
 assert.equal(g.sentTo().length,1,'neither its second attempt nor the second POST went out');
 const fresh=await rig(t),sealing=fresh.fetch('/api/rollup/spends',SPEND);fresh.fetch.close();
 await assert.rejects(sealing,failsWith('unavailable'));assert.equal(fresh.sentTo().length,0,'closed while it sealed, it never went out');
});

test('a sealed fetch with no relay, a relay that is not a ws:// or wss:// URL, or a pick, attempt count or timeout under one, is refused when it is made',async()=>{
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!;
 for(const options of [{relays:[]},{relays:[A,'not a url']},{relays:['https://relay.example']},{relays:['wss:a.example']},{relays:['wss:/a.example']},{pick:0},{attempts:0},{timeoutMs:0},{pick:Number.NaN}])assert.throws(()=>createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,...options}),RangeError,JSON.stringify(options));
 createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,relays:['ws://127.0.0.1:7777',A]}).close();
});

test('abort closes the attempt',async t=>{
 const {held,release}=holding(),g=await rig(t,{reply:()=>held}),before=g.bus.openSubscriptions(),reason=new Error('stopped');
 const waiting=new AbortController(),pending=g.fetch(ARK,{signal:waiting.signal});await until(()=>g.calls.length===1);
 assert.ok(g.bus.openSubscriptions()>before);
 waiting.abort(reason);await assert.rejects(pending,error=>error===reason);
 assert.equal(g.bus.openSubscriptions(),before,'only the gateway\'s own subscriptions are left');
 const sealing=new AbortController(),early=g.fetch(ARK,{signal:sealing.signal});sealing.abort(reason);
 await assert.rejects(early,error=>error===reason);await assert.rejects(g.fetch(ARK,{signal:AbortSignal.abort(reason)}),error=>error===reason);await sleep(50);
 assert.deepEqual([g.requests().length,g.bus.openSubscriptions()],[1,before],'a fetch aborted before it published never publishes');release();
});
