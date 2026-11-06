import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {base64} from '@scure/base';
import {finalizeEvent,generateSecretKey,type Event} from 'nostr-tools/pure';
import {NOSTR_ANSWER_KIND,NOSTR_REQUEST_KIND,readRequest,statusEvent} from '../packages/protocol/src/nostr-carrier.ts';
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

type Rig={relays?:string[];reply?:()=>Response|Promise<Response>;gateway?:Partial<Parameters<typeof createOhttpGateway>[0]>}&Pick<Parameters<typeof createSealedFetch>[0],'pick'|'timeoutMs'|'attempts'>;
async function rig(t:TestContext,{relays=[A,B],reply=()=>Response.json({ok:true}),gateway={},...options}:Rig={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:{url:string;init:RequestInit}[]=[],bus=createNostrBus();
 const upstream=(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply();}) as unknown as typeof fetch;
 const router=createOhttpGateway({key,upstreams:[{origin:'https://ark.example',prefix:'/v1/'}],poolOrigin:POOL,poolLoopback:LOOPBACK,gatewayToken:'token',fetch:upstream,...gateway});
 const carrier=startNostrCarrier({open:router.open,secret:key.nostrSecret,relays,pool:bus.pool});t.after(()=>carrier.close());await settle();
 const sends=t.mock.method(bus.pool,'publish'),sealedFetch=createSealedFetch({config:key.config,gateway:key.nostrPublic,origin:POOL,relays,pool:bus.pool,random:()=>0,...options});t.after(()=>sealedFetch.close());
 const answers=()=>bus.published.filter(event=>event.kind===NOSTR_ANSWER_KIND&&event.pubkey===key.nostrPublic);
 return {key,calls,bus,fetch:sealedFetch,answers,statuses:()=>answers().filter(event=>event.tags.some(tag=>tag[0]==='status')),
  requests:()=>bus.published.filter(event=>event.kind===NOSTR_REQUEST_KIND),sentTo:()=>sends.mock.calls.map(call=>call.arguments[0]),sent:()=>sends.mock.calls.map(call=>call.arguments[1])};
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
 const forged=finalizeEvent({kind:NOSTR_ANSWER_KIND,tags:[['e',g.requests()[0]!.id],['chunk','0','1']],content:base64.encode(new Uint8Array(64)),created_at:0},generateSecretKey());
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
 const [first,second]=g.sent();assert.equal(first!.content,second!.content,'both attempts carry the one sealed request');assert.notEqual(first!.id,second!.id);
});

test('a POST through a relay that delivers what it says it never took runs once, and its answer comes back',async t=>{
 for(const mode of ['refusesButDelivers','claimsUnreachable'] as const){
  const g=await rig(t,{pick:1});g.bus.relay(A)[mode]=true;
  assert.equal((await g.fetch('/api/rollup/spends',SPEND)).status,200,mode);await sleep(100);
  assert.deepEqual(g.sentTo(),[[A],[B]],mode);assert.equal(g.calls.length,1,`${mode}: the gateway refused the copy on B`);
 }
});

test('attempts run out as unavailable',async t=>{
 const g=await rig(t,{timeoutMs:50,attempts:3}),before=g.bus.openSubscriptions();for(const url of [A,B])g.bus.relay(url).deliver=false;
 await assert.rejects(g.fetch(ARK),failsWith('unavailable'));
 assert.equal(g.requests().length,3);assert.equal(g.bus.openSubscriptions(),before,'every attempt\'s subscription closed');
});

test('a status event cannot hold the client past its attempt deadline',{timeout:10_000},async t=>{
 let replies=0;const g=await rig(t,{relays:[A],timeoutMs:200,reply:()=>++replies===1?new Promise<Response>(()=>{}):Response.json({ok:true})});
 const started=performance.now(),pending=g.fetch(ARK);await until(()=>g.calls.length===1);
 await Promise.all(g.bus.pool.publish([A],statusEvent(503,3600,g.requests()[0]!,g.key.nostrSecret,Date.now())));
 assert.equal((await pending).status,200);assert.ok(performance.now()-started<2000,'the hour the status asked for was cut to the deadline');
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

test('close() ends a POST that went out as outcome-unknown, and refuses a new one as unavailable',async t=>{
 const g=await rig(t,{pick:1}),publish=g.bus.pool.publish;g.bus.relay(A).accept=false;
 t.mock.method(g.bus.pool,'publish',(urls:string[],event:Event)=>{const sent=publish(urls,event);g.fetch.close();return sent;});
 await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('outcome-unknown'));await assert.rejects(g.fetch('/api/rollup/spends',SPEND),failsWith('unavailable'));
 assert.equal(g.sentTo().length,1,'neither its second attempt nor the second POST went out');
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
