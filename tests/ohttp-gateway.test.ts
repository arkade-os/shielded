import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {connect,type AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import express from 'express';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {createOhttpGateway,type OhttpOpen} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey,type OhttpGatewayKey} from '../src/rollup/ohttp-keys.ts';

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
const LOOPBACK='http://127.0.0.1:9',TOKEN='per-process-token',ARK='https://ark.example/v1/info';
const UPSTREAMS=[{origin:'https://ark.example',prefix:'/v1/'},{origin:'https://esplora.example',prefix:'/api/'}];
const clientOf=(config:Uint8Array)=>new OHTTPClient(SUITE,KeyConfig.select(SUITE,KeyConfig.parseMultiple(config)),{maxMessageSize:5<<20});
type Options=Partial<Parameters<typeof createOhttpGateway>[0]>&{reply?:(init:RequestInit,url:string)=>Response|Promise<Response>;before?:express.RequestHandler};
const optionsOf=(key:OhttpGatewayKey,options:Options={})=>({key,upstreams:UPSTREAMS,poolOrigin:'https://pool.example',poolLoopback:LOOPBACK,gatewayToken:TOKEN,...options});
const waits=(init:RequestInit)=>new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason)));
const until=async(ok:()=>boolean)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),'the condition never held');};

async function gateway(t:TestContext,{reply=()=>Response.json({ok:true}),before,...options}:Options={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:{url:string;init:RequestInit}[]=[];
 const upstream=(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply(init,url);}) as unknown as typeof fetch;
 const app=express(),router=createOhttpGateway(optionsOf(key,{fetch:upstream,...options}));if(before)app.use(before);app.use('/api/rollup',router);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`,keys=await fetch(base+'/ohttp-keys'),config=new Uint8Array(await keys.arrayBuffer()),client=clientOf(config);
 const post=(body:BodyInit,type='message/ohttp-req')=>fetch(base+'/ohttp',{method:'POST',headers:{'content-type':type},body});
 const seal=(url:string,init?:RequestInit)=>client.encapsulateRequest(new Request(url,init));
 const exchange=async({init,context}:Awaited<ReturnType<typeof seal>>)=>{
  const outer=await fetch(base+'/ohttp',init);
  assert.equal(outer.status,200);assert.equal(outer.headers.get('content-type'),'message/ohttp-res');assert.equal(outer.headers.get('cache-control'),'no-store');
  return context.decapsulateResponse(outer);
 };
 return {key,keys,config,calls,base,post,seal,exchange,router,open:async(url:string,init?:RequestInit)=>exchange(await seal(url,init))};
}

test('a sealed GET to an allowed upstream comes back sealed with the upstream status and body',async t=>{
 const g=await gateway(t,{reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json','cache-control':'max-age=5','set-cookie':'id=1','x-upstream':'internal'}})});
 assert.equal(g.keys.headers.get('content-type'),'application/ohttp-keys');assert.equal(g.keys.headers.get('cache-control'),'public, max-age=3600');assert.deepEqual(g.config,g.key.config);
 const inner=await g.open('https://esplora.example/api/blocks/tip/height',{headers:{accept:'application/json'}});
 assert.equal(inner.status,202);assert.equal(await inner.text(),'{"height":7}');
 assert.deepEqual(Object.fromEntries(inner.headers),{'cache-control':'max-age=5','content-type':'application/json'},'only the status, content-type, cache-control and retry-after come back');
 assert.deepEqual(g.calls.map(({url,init})=>[url,init.method,init.redirect]),[['https://esplora.example/api/blocks/tip/height','GET','error']],'an upstream redirect is never followed');
 const empty=await gateway(t,{reply:()=>new Response(null,{status:204})});
 assert.equal((await empty.open(ARK)).status,204);
});

test('an upstream Retry-After reaches the sealed client',async t=>{
 const g=await gateway(t,{reply:()=>new Response(null,{status:429,headers:{'retry-after':'7','set-cookie':'id=1'}})});
 const inner=await g.open(ARK);
 assert.deepEqual([inner.status,inner.headers.get('retry-after'),inner.headers.has('set-cookie')],[429,'7',false]);
});

test('a target outside the allowlist, or with a disallowed path, is refused 403 and nothing is fetched',async t=>{
 const g=await gateway(t);
 for(const url of ['https://evil.example/v1/info','http://ark.example/v1/info','https://ark.example:8443/v1/info','https://pool.example/api/rollup/ohttp','https://pool.example/api/rollup/OHTTP-keys/',
  'https://pool.example/api/rollup/..%2Fohttp','https://pool.example/api/other','https://ark.example/admin','https://esplora.example/v1/info',
  'https://ark.example/v1/%zz','https://pool.example/api/rollup/%6Fhttp','https://pool.example/api/rollup//ohttp','https://ark.example/v1//txs'])assert.equal((await g.open(url)).status,403,url);
 assert.equal((await g.open(ARK,{method:'DELETE'})).status,403,'only GET and POST pass');
 assert.equal(g.calls.length,0);
 assert.throws(()=>createOhttpGateway(optionsOf(g.key,{upstreams:[{origin:'http://ark.example',prefix:'/v1/'}]})),/https/);
});

test('an empty path segment is refused, but a // in the query is not',async t=>{
 const g=await gateway(t),url='https://esplora.example/api/blocks?next=//y';
 assert.equal((await g.open(url)).status,200);
 assert.deepEqual(g.calls.map(call=>call.url),[url]);
});

test('a pool and an upstream on one origin are told apart by path',async t=>{
 const g=await gateway(t,{poolOrigin:'https://shared.example',upstreams:[{origin:'https://shared.example',prefix:'/v1/'},{origin:'https://shared.example',prefix:'/api/'}]});
 for(const [path,status] of [['/v1/info',200],['/api/rollup/status',200],['/api/ROLLUP/status',200],['/api/blocks/tip/height',200],['/api/rollup/ohttp',403],['/api/ROLLUP/ohttp',403],['/api/Rollup/OHTTP-keys',403]] as const)assert.equal((await g.open('https://shared.example'+path)).status,status,path);
 assert.deepEqual(g.calls.map(({url,init})=>[url,new Headers(init.headers).get('x-shielded-gateway')]),[['https://shared.example/v1/info',null],[LOOPBACK+'/api/rollup/status',TOKEN],[LOOPBACK+'/api/ROLLUP/status',TOKEN],['https://shared.example/api/blocks/tip/height',null]],'the token goes to the pool alone, and no spelling of the gateway path leaves');
});

test('only content-type and accept reach the upstream',async t=>{
 const g=await gateway(t),hostile={'x-forwarded-for':'203.0.113.7',host:'evil.example',cookie:'session=1',authorization:'Bearer stolen','x-shielded-gateway':'guessed'};
 const headers={...hostile,'content-type':'application/json',accept:'application/json'},sealed=await g.seal('https://pool.example/api/rollup/spends',{method:'POST',headers,body:'{"id":"ab"}'});
 const carried=(await g.key.server.decapsulateRequest(new Request('http://gateway.test/',sealed.init))).request.headers;
 for(const name of Object.keys(hostile))assert.ok(carried.has(name),`the sealed request carries ${name}, so its absence upstream is the gateway's doing`);
 assert.equal((await g.exchange(sealed)).status,200);
 assert.equal((await g.open(ARK,{headers})).status,200);
 const [pool,ark]=g.calls;
 assert.equal(pool!.url,LOOPBACK+'/api/rollup/spends');assert.equal(new TextDecoder().decode(pool!.init.body as ArrayBuffer),'{"id":"ab"}');
 assert.deepEqual(Object.fromEntries(new Headers(pool!.init.headers)),{accept:'application/json','content-type':'application/json','x-shielded-gateway':TOKEN});
 assert.equal(ark!.url,ARK);assert.deepEqual(Object.fromEntries(new Headers(ark!.init.headers)),{accept:'application/json','content-type':'application/json'});
});

test('streaming requests are refused 400',async t=>{
 const g=await gateway(t);
 assert.equal((await g.open(ARK,{headers:{accept:'text/event-stream'}})).status,400);
 for(const path of ['/v1/txs','/v1/batch/events','/v1/indexer/script/subscription/x','/v1/Batch/Events','/v1/tx%73','/v1/%74xs','/v1/batch/event%73','/v1/indexer/script/%73ubscription/x','/v1/indexer/subscription','/v1/indexer/subscription?filter.expressions=x'])assert.equal((await g.open('https://ark.example'+path)).status,400,path);
 assert.equal(g.calls.length,0);
 assert.equal((await g.open('https://ark.example/v1/%74x/abc')).status,200);
 assert.deepEqual(g.calls.map(call=>call.url),['https://ark.example/v1/%74x/abc'],'the path goes up as sealed, for the upstream to decode once');
});

test('limits answer instead of hanging',async t=>{
 const g=await gateway(t);
 assert.equal((await g.post(new Uint8Array((1<<20)+1))).status,413);
 assert.equal((await g.post(new Uint8Array(1<<20))).status,400,'exactly 1 MiB is read, then refused only for not being sealed');
 const sized=(bytes:number)=>gateway(t,{reply:()=>new Response(new Uint8Array(bytes).fill(1))});
 assert.equal((await (await (await sized(4<<20)).open(ARK)).arrayBuffer()).byteLength,4<<20,'exactly 4 MiB still comes back');
 assert.equal((await (await sized((4<<20)+1)).open(ARK)).status,502);
 let pulled=0,cancelled=false;
 const large=await gateway(t,{reply:()=>new Response(new ReadableStream({pull:c=>{c.enqueue(new Uint8Array(64<<10));if((pulled+=64<<10)>=64<<20)c.close();},cancel:()=>{cancelled=true;}}))});
 assert.equal((await large.open(ARK)).status,502);assert.ok(cancelled&&pulled<5<<20,`the upstream body is abandoned just past 4 MiB, not read whole (${pulled} bytes pulled)`);
 const stalls=(init:RequestInit)=>new Response(new ReadableStream({start:c=>{c.enqueue(new Uint8Array(1));init.signal!.addEventListener('abort',()=>c.error(init.signal!.reason));}}));
 for(const reply of [waits,stalls])assert.equal((await (await gateway(t,{reply,timeoutMs:500})).open(ARK)).status,504);
 let clock=0;
 const busy=await gateway(t,{rate:2,now:()=>clock});
 for(let i=0;i<2;i++)assert.equal((await busy.open(ARK)).status,200);
 const refused=await busy.post((await busy.seal(ARK)).init.body!);
 assert.equal(refused.status,429);assert.equal(refused.headers.get('retry-after'),'1');assert.equal(busy.calls.length,2);
 clock+=1000;assert.equal((await busy.open(ARK)).status,200,'the next second admits again');
 for(const rate of [0,1.5,Number('twenty')])assert.throws(()=>createOhttpGateway(optionsOf(busy.key,{rate})),/rate/,`${rate} is not a whole number of requests per second`);
});

test('requests beyond the in-flight cap are shed with 503',async t=>{
 let clock=0,hold=true;const gates:(()=>void)[]=[];
 const g=await gateway(t,{rate:33,now:()=>clock,reply:()=>hold&&gates.length<32?new Promise<Response>(resolve=>gates.push(()=>resolve(Response.json({ok:true})))):Response.json({ok:true})});
 const held=Array.from({length:32},()=>g.open(ARK));await until(()=>gates.length===32);
 const shed=await g.seal(ARK),refused=await g.post(shed.init.body!);
 assert.equal(refused.status,503);assert.equal(refused.headers.get('retry-after'),'1');assert.equal(g.calls.length,32,'a shed request is never opened');
 gates.shift()!();assert.equal((await Promise.race(held)).status,200);
 hold=false;assert.equal((await g.exchange(shed)).status,200,'the same bytes retried are neither a replay nor over the rate');
 clock+=1000;hold=true;held.push(g.open(ARK));await until(()=>gates.length===32);
 assert.equal((await g.post((await g.seal(ARK)).init.body!)).status,503,'the count is exact once slots come back');
 hold=false;for(const open of gates.splice(0))open();
 for(const response of await Promise.all(held))assert.equal(response.status,200);
 for(const maxInFlight of [0,1.5,NaN])assert.throws(()=>createOhttpGateway(optionsOf(g.key,{maxInFlight})),/in-flight/,`${maxInFlight} is not a whole number of slots`);
});

test('a failed or timed-out upstream frees its slot',async t=>{
 const at=(name:string)=>`https://ark.example/v1/${name}`;
 const g=await gateway(t,{maxInFlight:2,timeoutMs:500,rate:1000,reply:(init,url)=>url===at('slow')?waits(init):url===at('broken')?Promise.reject(new TypeError('fetch failed')):
  url===at('huge')?new Response(new Uint8Array((4<<20)+1)):url===at('failing')?new Response(null,{status:500}):Response.json({ok:true})});
 const sealed=await g.seal(ARK);assert.equal((await g.exchange(sealed)).status,200);
 const exits:[()=>Promise<Response>,number][]=[[()=>g.open(at('slow')),504],[()=>g.open(at('broken')),502],[()=>g.open(at('huge')),502],[()=>g.open(at('failing')),500],[()=>g.open('https://evil.example/'),403],
  [()=>g.open(at('txs')),400],[()=>g.post(new Uint8Array(64)),400],[()=>g.post(sealed.init.body!),400]];
 for(const [exit,status] of exits)for(let i=0;i<2;i++)assert.equal((await exit()).status,status);
 assert.equal((await g.open(ARK)).status,200,'every exit path gave its slot back');
 const big=await gateway(t,{maxInFlight:2});
 for(let i=0;i<2;i++)assert.equal((await big.post(new Uint8Array((1<<20)+1))).status,413);
 assert.equal((await big.open(ARK)).status,200,'a refused upload gave its slot back');
 const dropped=await gateway(t,{maxInFlight:1,reply:(init,url)=>url===at('slow')?waits(init):Response.json({ok:true})});
 const client=new AbortController(),pending=fetch(dropped.base+'/ohttp',{...(await dropped.seal(at('slow'))).init,signal:client.signal});
 await until(()=>dropped.calls.length===1);client.abort();await assert.rejects(pending);
 await until(()=>dropped.calls[0]!.init.signal!.aborted);
 assert.equal((await dropped.open(ARK)).status,200,'a dropped client gives its slot back and stops its upstream fetch');
 let holding=false,passed=false;
 const late=await gateway(t,{maxInFlight:1,before:(req,res,next)=>{if(req.method!=='POST'||holding)return next();holding=true;res.once('close',()=>{next();passed=true;});}}),early=new AbortController();
 const abandoned=fetch(late.base+'/ohttp',{...(await late.seal(ARK)).init,signal:early.signal});
 await until(()=>holding);early.abort();await assert.rejects(abandoned);await until(()=>passed);
 assert.equal((await late.open(ARK)).status,200,'a request dropped before it reached the gateway takes no slot');
});

test('a stalled upload is cut off at the deadline and frees its slot',async t=>{
 const g=await gateway(t,{maxInFlight:1,timeoutMs:500}),port=Number(new URL(g.base).port);
 for(const length of [1000,(1<<20)+1]){
  const socket=connect(port,'127.0.0.1').on('error',()=>{});
  socket.write(`POST /api/rollup/ohttp HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: message/ohttp-req\r\ncontent-length: ${length}\r\n\r\n0123456789`);
  try{await until(()=>socket.destroyed);}finally{socket.destroy();}
  assert.equal((await g.open(ARK)).status,200,`the stalled ${length}-byte upload gave its slot back`);
 }
 const quick=await gateway(t),timers=()=>process.getActiveResourcesInfo().filter(type=>type==='Timeout').length;
 await quick.open(ARK);const before=timers();
 for(let i=0;i<10;i++)await quick.open(ARK);
 assert.ok(timers()<=before,'no deadline outlives its response');
});

test('a request nothing answers is cut off at three deadlines and frees its slot',async t=>{
 let calls=0;const timeoutMs=200;
 const g=await gateway(t,{maxInFlight:1,timeoutMs,reply:()=>++calls===1?new Promise<Response>(()=>{}):Response.json({ok:true})});
 const sealed=await g.seal(ARK),start=performance.now();
 const sent=fetch(g.base+'/ohttp',{...sealed.init,signal:AbortSignal.timeout(5000)}).then(()=>'answered',()=>'cut');
 await until(()=>g.calls.length===1);const armed=performance.now();
 assert.equal(await sent,'cut');
 const cut=performance.now();
 assert.ok(cut-start>=2.5*timeoutMs&&cut-armed<12*timeoutMs,`cut ${Math.round(cut-start)} ms after the send, not at about ${3*timeoutMs}`);
 assert.equal((await g.open(ARK)).status,200,'the slot came back');
});

test('a request sealed to another key id is refused 400',async t=>{
 const g=await gateway(t),other=(await loadOhttpKey(`${(g.key.keyId+1)%256}:${(await generateOhttpKey()).env.split(':')[1]}`))!;
 const refused=await g.post((await clientOf(other.config).encapsulateRequest(new Request(ARK))).init.body!);
 assert.equal(refused.status,400);assert.doesNotMatch(await refused.text(),/OHTTP|KEY|DECRYPT/i,'the refusal names no cause');
 assert.equal(g.calls.length,0);
});

test('an outer request typed anything but exactly message/ohttp-req is refused 400',async t=>{
 const g=await gateway(t),sealed=await g.seal(ARK);
 for(const type of ['application/octet-stream','message/ohttp-req; charset=utf-8'])assert.equal((await g.post(sealed.init.body!,type)).status,400,type);
 assert.equal(g.calls.length,0);assert.equal((await g.exchange(sealed)).status,200,'the same bytes open under the exact type');
});

test('the same sealed request sent twice is answered once and refused 400 the second time',async t=>{
 const g=await gateway(t),spend={method:'POST',headers:{'content-type':'application/json'},body:'{}'},sealed=await g.seal('https://pool.example/api/rollup/spends',spend);
 assert.equal((await g.exchange(sealed)).status,200);
 assert.equal((await g.post(sealed.init.body!)).status,400);assert.equal(g.calls.length,1,'the replay never reaches the upstream');
 assert.equal((await g.open('https://pool.example/api/rollup/spends',spend)).status,200,'the same request sealed afresh is a new request');
});

test('the gateway logs counts by kind, never a target or a body',async t=>{
 const lines:string[]=[];t.mock.method(console,'log',(line:string)=>{lines.push(line);});
 let clock=0;const g=await gateway(t,{now:()=>clock});
 await g.open('https://esplora.example/api/address/tb1qwatched/txs');await g.open('https://evil.example/tb1qwatched');
 assert.deepEqual(lines,[],'nothing is logged per request');
 clock=60_000;await g.open('https://esplora.example/api/address/tb1qwatched/txs');
 assert.deepEqual(lines,['[ohttp] forwarded 2, refused 1']);
});

type Sealed=Awaited<ReturnType<OHTTPClient['encapsulateRequest']>>;
const bytesOf=(sealed:Sealed)=>sealed.init.body as Uint8Array;
const through=async(router:{open:OhttpOpen},sealed:Sealed,options?:Parameters<OhttpOpen>[1])=>{
 const outcome=await router.open(bytesOf(sealed),options);assert.ok(outcome.kind==='sealed',outcome.kind);
 return sealed.context.decapsulateResponse(new Response(Buffer.from(outcome.bytes),{headers:{'content-type':'message/ohttp-res'}}));
};

test('open() answers a sealed request like the HTTP route',async t=>{
 const g=await gateway(t,{reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json','set-cookie':'id=1'}})});
 const posted=await g.seal(ARK),viaHttp=await posted.context.decapsulateResponse(await g.post(posted.init.body!)),viaOpen=await through(g.router,await g.seal(ARK));
 for(const inner of [viaHttp,viaOpen])assert.deepEqual([inner.status,Object.fromEntries(inner.headers),await inner.text()],[202,{'content-type':'application/json'},'{"height":7}']);
 assert.equal(g.calls.length,2);
});

test('open() sheds and rate-limits before opening',async t=>{
 let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
 const shed=await gateway(t,{maxInFlight:1,rate:2,now:()=>0,reply:async()=>{await held;return Response.json({ok:true});}});
 const first=through(shed.router,await shed.seal(ARK)),again=await shed.seal(ARK);await until(()=>shed.calls.length===1);
 assert.deepEqual(await shed.router.open(bytesOf(again)),{kind:'busy',status:503,retryAfter:1});assert.equal(shed.calls.length,1);
 release();assert.equal((await first).status,200);
 assert.equal((await through(shed.router,again)).status,200,'the shed bytes were neither opened nor counted against the rate');
 let clock=0;const rated=await gateway(t,{rate:1,now:()=>clock});
 assert.equal((await through(rated.router,await rated.seal(ARK))).status,200);
 const over=await rated.seal(ARK);
 assert.deepEqual(await rated.router.open(bytesOf(over)),{kind:'busy',status:429,retryAfter:1});assert.equal(rated.calls.length,1);
 clock+=1000;assert.equal((await through(rated.router,over)).status,200,'the refused bytes were never opened, so they are no replay');
});

test('open() refuses garbage and replays, sharing the register with the HTTP route',async t=>{
 const g=await gateway(t),opened=await g.seal(ARK),posted=await g.seal(ARK);
 assert.deepEqual(await g.router.open(randomBytes(64)),{kind:'refused'});
 assert.equal((await through(g.router,opened)).status,200);
 assert.deepEqual(await g.router.open(bytesOf(opened)),{kind:'refused'});assert.equal((await g.post(opened.init.body!)).status,400);
 assert.equal((await g.exchange(posted)).status,200);assert.deepEqual(await g.router.open(bytesOf(posted)),{kind:'refused'});
 assert.equal(g.calls.length,2,'one upstream call for each sealed request');
});

test('open() refuses a copy of a request it already opened, at the cap and over the rate, instead of telling it busy',async t=>{
 let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
 const g=await gateway(t,{maxInFlight:1,rate:2,now:()=>0,reply:async()=>{await held;return Response.json({ok:true});}});
 const first=await g.seal(ARK),running=through(g.router,first);await until(()=>g.calls.length===1);
 assert.deepEqual(await g.router.open(bytesOf(first)),{kind:'refused'},'a copy of the running request is refused, not shed');
 assert.deepEqual(await g.router.open(bytesOf(await g.seal(ARK))),{kind:'busy',status:503,retryAfter:1},'fresh bytes at the cap are still shed');
 release();assert.equal((await running).status,200);
 assert.equal((await through(g.router,await g.seal(ARK))).status,200);
 assert.deepEqual(await g.router.open(bytesOf(await g.seal(ARK))),{kind:'busy',status:429,retryAfter:1},'fresh bytes over the rate are still counted');
 assert.deepEqual(await g.router.open(bytesOf(first)),{kind:'refused'},'a copy of a finished request is refused, not rate-limited');
 assert.equal(g.calls.length,2,'no copy reached the upstream');
});

test('open() caps the inner answer at maxAnswer',async t=>{
 const g=await gateway(t,{reply:()=>new Response(new Uint8Array(600<<10))});
 assert.equal((await through(g.router,await g.seal(ARK),{maxAnswer:512<<10})).status,502);
 assert.equal((await (await through(g.router,await g.seal(ARK))).arrayBuffer()).byteLength,600<<10,'the default cap stays 4 MiB');
});

test('open() never lifts the 4 MiB cap, for NaN or a larger maxAnswer',async t=>{
 const g=await gateway(t,{reply:()=>new Response(new Uint8Array((4<<20)+1))});
 for(const maxAnswer of [Number.NaN,8<<20])assert.equal((await through(g.router,await g.seal(ARK),{maxAnswer})).status,502,String(maxAnswer));
});

test('open() gives its slot back on every path',async t=>{
 const at=(name:string)=>`https://ark.example/v1/${name}`;let release=()=>{};
 const g=await gateway(t,{maxInFlight:1,timeoutMs:50,reply:(init,url)=>url===at('slow')?waits(init):url===at('held')?new Promise<Response>(resolve=>{release=()=>resolve(Response.json({ok:true}));}):Response.json({ok:true})});
 const held=through(g.router,await g.seal(at('held'))),spare=await g.seal(ARK);await until(()=>g.calls.length===1);
 assert.deepEqual(await g.router.open(bytesOf(spare)),{kind:'busy',status:503,retryAfter:1});
 release();assert.equal((await held).status,200);
 assert.equal((await through(g.router,await g.seal(at('slow')))).status,504);
 assert.deepEqual(await g.router.open(randomBytes(64)),{kind:'refused'});
 assert.equal((await through(g.router,spare)).status,200,'every path gave its slot back');
});

test('http:false omits POST /ohttp and keeps the key config',async t=>{
 const g=await gateway(t,{http:false});
 assert.deepEqual([g.keys.status,g.keys.headers.get('content-type')],[200,'application/ohttp-keys']);
 assert.equal((await g.post((await g.seal(ARK)).init.body!)).status,404);
 assert.equal((await through(g.router,await g.seal(ARK))).status,200,'open() still answers');
});
