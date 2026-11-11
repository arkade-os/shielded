import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {base64} from '@scure/base';
import {finalizeEvent,generateSecretKey,type Event} from 'nostr-tools/pure';
import {addressOf,NOSTR_ANSWER_KIND,NOSTR_REQUEST_KIND,readRequest,statusEvent} from '../packages/protocol/src/nostr-carrier.ts';
import {createOhttpGateway,type OhttpOpen} from '../src/rollup/ohttp-gateway.ts';
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
// The bus delivers on zero-delay timers; firing them in place keeps a relay hop from costing mocked time, so only the waits move the clock.
const flush=async(t:TestContext)=>{for(let i=0;i<8;i++){t.mock.timers.tick(0);await settle();}};
const advance=async(t:TestContext,ms:number)=>{await flush(t);for(let at=0;at<ms;at+=1000){t.mock.timers.tick(1000);await flush(t);}};
const FORBIDDEN=['accept-charset','accept-encoding','access-control-request-headers','access-control-request-method','connection','content-length','cookie','cookie2','date','dnt','expect','host','keep-alive','origin','referer','set-cookie','te','trailer','transfer-encoding','upgrade','via'];

type Rig={relays?:string[];reply?:()=>Response|Promise<Response>;gateway?:Partial<Parameters<typeof createOhttpGateway>[0]>;open?:OhttpOpen}&Pick<Parameters<typeof createSealedFetch>[0],'pick'|'timeoutMs'|'getTimeoutMs'|'attempts'|'random'>;
async function rig(t:TestContext,{relays=[A,B],reply=()=>Response.json({ok:true}),gateway={},open,...options}:Rig={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:{url:string;init:RequestInit}[]=[],bus=createNostrBus();
 const upstream=(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply();}) as unknown as typeof fetch;
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:POOL,poolLoopback:LOOPBACK,gatewayToken:'token',fetch:upstream,...gateway});
 const carrier=startNostrCarrier({open:open??router.open,secret:key.nostrSecret,relays,pool:bus.pool});t.after(()=>carrier.close());await settle();
 const sends=t.mock.method(bus.pool,'publish'),sealedFetch=createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,relays,pool:bus.pool,random:()=>0,...options});t.after(()=>sealedFetch.close());
 const answers=()=>bus.published.filter(event=>event.kind===NOSTR_ANSWER_KIND&&event.pubkey===key.nostrPublic),requests=()=>bus.published.filter(event=>event.kind===NOSTR_REQUEST_KIND);
 const inner=async(i=0)=>(await key.server.decapsulateRequest(new Request('http://gateway.test/',{method:'POST',headers:{'content-type':'message/ohttp-req'},body:Buffer.from(readRequest(requests()[i]!,key.nostrPublic)!)}))).request;
 return {key,calls,bus,fetch:sealedFetch,answers,requests,inner,address:()=>addressOf(readRequest(requests()[0]!,key.nostrPublic)!),statuses:()=>answers().filter(event=>event.tags.some(tag=>tag[0]==='status')),
  sentTo:()=>sends.mock.calls.map(call=>call.arguments[0]),sent:()=>sends.mock.calls.map(call=>call.arguments[1])};
}

test('a GET goes out sealed and comes back as a Response',async t=>{
 const g=await rig(t,{reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json'}})}),before=[g.bus.openSubscriptions(),timers()];
 const response=await g.fetch(ARK);await sleep(20);
 assert.deepEqual([response.status,response.headers.get('content-type'),await response.text()],[202,'application/json','{"height":7}']);
 assert.deepEqual(g.calls.map(call=>call.url),[ARK]);assert.ok(!JSON.stringify(g.requests()).includes('ark.example'),'the relays never see the target');
 assert.deepEqual([g.bus.openSubscriptions(),timers()],before,'the answer closed every subscription and deadline the fetch opened');
});

test('relative URLs resolve against the origin and only content-type, accept and x-digest leave the client, with its own x-date',async t=>{
 const g=await rig(t);
 assert.equal((await g.fetch('/api/rollup/status',{headers:{'X-SDK-VERSION':'ts-sdk/0.5.3',Authorization:'x',Accept:'application/json'}})).status,200);
 assert.deepEqual(g.calls.map(call=>call.url),[LOOPBACK+'/api/rollup/status']);
 const request=await g.inner();
 assert.equal(request.url,POOL+'/api/rollup/status');assert.deepEqual([...request.headers.keys()],['accept','x-date']);
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
 t.mock.timers.enable({apis:['setTimeout']});
 const advance=async(ok:()=>boolean)=>{const deadline=performance.now()+5000;while(!ok()&&performance.now()<deadline){t.mock.timers.tick(0);await settle();}assert.ok(ok(),'the condition never held');};
 let firstDone=false,secondDone=false;
 const first=g.fetch(ARK).finally(()=>{firstDone=true;});await advance(()=>g.calls.length===1);
 const second=g.fetch('/api/rollup/spends',SPEND).finally(()=>{secondDone=true;});
 await advance(()=>g.statuses().length===1);release();await advance(()=>firstDone);
 assert.deepEqual(g.statuses()[0]!.tags.find(tag=>tag[0]==='status'),['status','503']);
 t.mock.timers.tick(999);await settle();assert.equal(g.requests().length,2,'the retry has not gone out before the requested second');
 t.mock.timers.tick(1);await advance(()=>secondDone);assert.equal((await second).status,200);
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
 const g=await rig(t,{pick:1,getTimeoutMs:400});g.bus.relay(A).deliver=false;
 assert.equal((await g.fetch(ARK)).status,200);
 assert.deepEqual(g.sentTo(),[[A],[B]]);assert.equal(g.requests().length,2);
 assert.notEqual(g.sent()[0]!.content,g.sent()[1]!.content,'each GET attempt is sealed afresh');
});

test('a late answer to an earlier attempt counts',async t=>{
 // Through A the request and its answer each wait 150 ms, so the answer lands near 300 ms; five attempts keep the fetch open to 500 ms.
 let replies=0;const g=await rig(t,{pick:1,getTimeoutMs:100,attempts:5,reply:()=>Response.json({reply:++replies})});
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
 const g=await rig(t,{pick:1,getTimeoutMs:60_000});Object.assign(g.bus.relay(A),{timesOut:true,deliver:false});
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
 const g=await rig(t,{getTimeoutMs:50,attempts:3}),before=g.bus.openSubscriptions();for(const url of [A,B])g.bus.relay(url).deliver=false;
 await assert.rejects(g.fetch(ARK),failsWith('unavailable'));
 assert.equal(g.requests().length,3);assert.equal(g.bus.openSubscriptions(),before,'every attempt\'s subscription closed');
});

test('a status event cannot hold the client past its attempt deadline',{timeout:10_000},async t=>{
 let replies=0;const g=await rig(t,{relays:[A],getTimeoutMs:200,reply:()=>++replies===1?new Promise<Response>(()=>{}):Response.json({ok:true})});
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
 const {held,release}=holding(),g=await rig(t,{pick:1,getTimeoutMs:500,attempts:2,reply:()=>held});g.bus.relay(A).deliver=false;
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
 const g=await rig(t,{pick:1,getTimeoutMs:100});g.bus.relay(A).deliver=false;
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
 for(const options of [{relays:[]},{relays:[A,'not a url']},{relays:['https://relay.example']},{relays:['wss:a.example']},{relays:['wss:/a.example']},{pick:0},{attempts:0},{timeoutMs:0},{getTimeoutMs:0},{sealedForMs:0},{pick:Number.NaN}])assert.throws(()=>createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,...options}),RangeError,JSON.stringify(options));
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

test('every sealed request carries an x-date rounded to the nearest 30 s, and x-digest crosses',async t=>{
 const g=await rig(t);
 assert.equal((await g.fetch(ARK,{headers:{'x-digest':'abc',authorization:'x','x-sdk-version':'ts-sdk/0.5.3'}})).status,200);
 const {headers}=await g.inner(),at=Date.parse(headers.get('x-date')!);
 assert.ok(at%30_000===0&&Math.abs(Date.now()-at)<=16_000,String(headers.get('x-date')));
 assert.deepEqual([headers.get('x-digest'),headers.has('authorization'),headers.has('x-sdk-version')],['abc',false,false]);
});

test('the sealed request uses no header a browser would strip',async t=>{
 const g=await rig(t),stripped=Object.fromEntries([...FORBIDDEN,'proxy-authorization','sec-fetch-mode'].map(name=>[name,'x']));
 assert.equal((await g.fetch('/api/rollup/spends',{method:'POST',headers:{...stripped,'content-type':'application/json',accept:'application/json','x-digest':'abc'},body:'{"id":"ab"}'})).status,200);
 const names=[...(await g.inner()).headers.keys()];
 assert.deepEqual(names.filter(name=>FORBIDDEN.includes(name)||/^(proxy|sec)-/.test(name)),[],names.join());
});

test("a caller's own x-date is overwritten, not forwarded",async t=>{
 const g=await rig(t);
 assert.equal((await g.fetch(ARK,{headers:{'x-date':'Thu, 01 Jan 1970 00:00:00 GMT'}})).status,200);
 assert.ok(Math.abs(Date.now()-Date.parse((await g.inner()).headers.get('x-date')!))<=30_000);
});

test('a GET attempt ends after 9 s and a POST attempt after 40 s',async t=>{
 const {held}=holding(),g=await rig(t,{reply:()=>held});t.mock.timers.enable({apis:['setTimeout']});
 const stop=new AbortController(),get=g.fetch(ARK,{signal:stop.signal});await until(()=>g.sentTo().length===1);
 t.mock.timers.tick(8_999);await sleep(50);assert.equal(g.sentTo().length,1);
 t.mock.timers.tick(1);await until(()=>g.sentTo().length===2);stop.abort();await assert.rejects(get);
 let ended=false;const post=assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown')).finally(()=>{ended=true;});await until(()=>g.sentTo().length===3);
 t.mock.timers.tick(39_999);await sleep(50);assert.equal(ended,false);
 t.mock.timers.tick(1);await post;
});

test('a GET answered on its first attempt publishes once and leaves no deadline behind',async t=>{
 const g=await rig(t),before=timers();
 assert.equal((await g.fetch(ARK)).status,200);await sleep(20);
 assert.deepEqual([g.requests().length,timers()],[1,before]);
});

test('a POST stops attempting 45 s after its sealing and ends outcome-unknown',async t=>{
 for(const [retryAfter,attempts,later] of [[30,3,[30_000]],[22,3,[22_000,44_000]],[15,4,[15_000,30_000]]] as const){
  const g=await rig(t,{attempts,open:async()=>({kind:'busy',status:503,retryAfter})});t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const start=Date.now(),sent:number[]=[],spend=assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown'));await until(()=>g.sentTo().length===1);
  for(let at=0;at<100_000;at+=1000){const before=g.requests().length;await advance(t,1000);if(g.requests().length>before)sent.push(Date.now()-start);}
  await spend;
  assert.deepEqual(sent,later,`retryAfter ${retryAfter}, attempts ${attempts}`);assert.equal(new Set(g.requests().map(event=>event.content)).size,1);
  t.mock.timers.reset();
 }
});
