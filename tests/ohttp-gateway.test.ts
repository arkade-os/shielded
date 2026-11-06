import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import express from 'express';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey,type OhttpGatewayKey} from '../src/rollup/ohttp-keys.ts';

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
const LOOPBACK='http://127.0.0.1:9',TOKEN='per-process-token',ARK='https://ark.example/v1/info';
const UPSTREAMS=[{origin:'https://ark.example',prefix:'/v1/'},{origin:'https://esplora.example',prefix:'/api/'}];
const clientOf=(config:Uint8Array)=>new OHTTPClient(SUITE,KeyConfig.select(SUITE,KeyConfig.parseMultiple(config)),{maxMessageSize:5<<20});
type Options=Partial<Parameters<typeof createOhttpGateway>[0]>&{reply?:(init:RequestInit)=>Response|Promise<Response>};
const optionsOf=(key:OhttpGatewayKey,options:Options={})=>({key,upstreams:UPSTREAMS,poolOrigin:'https://pool.example',poolLoopback:LOOPBACK,gatewayToken:TOKEN,...options});

async function gateway(t:TestContext,{reply=()=>Response.json({ok:true}),...options}:Options={}){
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,calls:{url:string;init:RequestInit}[]=[];
 const upstream=(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply(init);}) as unknown as typeof fetch;
 const app=express();app.use('/api/rollup',createOhttpGateway(optionsOf(key,{fetch:upstream,...options})));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`,keys=await fetch(base+'/ohttp-keys'),config=new Uint8Array(await keys.arrayBuffer()),client=clientOf(config);
 const post=(body:BodyInit,type='message/ohttp-req')=>fetch(base+'/ohttp',{method:'POST',headers:{'content-type':type},body});
 const seal=(url:string,init?:RequestInit)=>client.encapsulateRequest(new Request(url,init));
 const exchange=async({init,context}:Awaited<ReturnType<typeof seal>>)=>{
  const outer=await fetch(base+'/ohttp',init);
  assert.equal(outer.status,200);assert.equal(outer.headers.get('content-type'),'message/ohttp-res');assert.equal(outer.headers.get('cache-control'),'no-store');
  return context.decapsulateResponse(outer);
 };
 return {key,keys,config,calls,post,seal,exchange,open:async(url:string,init?:RequestInit)=>exchange(await seal(url,init))};
}

test('a sealed GET to an allowed upstream comes back sealed with the upstream status and body',async t=>{
 const g=await gateway(t,{reply:()=>new Response('{"height":7}',{status:202,headers:{'content-type':'application/json','cache-control':'max-age=5','set-cookie':'id=1','x-upstream':'internal'}})});
 assert.equal(g.keys.headers.get('content-type'),'application/ohttp-keys');assert.equal(g.keys.headers.get('cache-control'),'public, max-age=3600');assert.deepEqual(g.config,g.key.config);
 const inner=await g.open('https://esplora.example/api/blocks/tip/height',{headers:{accept:'application/json'}});
 assert.equal(inner.status,202);assert.equal(await inner.text(),'{"height":7}');
 assert.deepEqual(Object.fromEntries(inner.headers),{'cache-control':'max-age=5','content-type':'application/json'},'only the status, content-type and cache-control come back');
 assert.deepEqual(g.calls.map(({url,init})=>[url,init.method,init.redirect]),[['https://esplora.example/api/blocks/tip/height','GET','error']],'an upstream redirect is never followed');
 const empty=await gateway(t,{reply:()=>new Response(null,{status:204})});
 assert.equal((await empty.open(ARK)).status,204);
});

test('a target outside the allowlist, or with a disallowed path, is refused 403 and nothing is fetched',async t=>{
 const g=await gateway(t);
 for(const url of ['https://evil.example/v1/info','http://ark.example/v1/info','https://ark.example:8443/v1/info','https://pool.example/api/rollup/ohttp','https://pool.example/api/rollup/OHTTP-keys/',
  'https://pool.example/api/rollup/..%2Fohttp','https://pool.example/api/other','https://ark.example/admin','https://esplora.example/v1/info'])assert.equal((await g.open(url)).status,403,url);
 assert.equal((await g.open(ARK,{method:'DELETE'})).status,403,'only GET and POST pass');
 assert.equal(g.calls.length,0);
 assert.throws(()=>createOhttpGateway(optionsOf(g.key,{upstreams:[{origin:'http://ark.example',prefix:'/v1/'}]})),/https/);
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
 for(const path of ['/v1/txs','/v1/batch/events','/v1/indexer/script/subscription/x','/v1/Batch/Events'])assert.equal((await g.open('https://ark.example'+path)).status,400,path);
 assert.equal(g.calls.length,0);
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
 const waits=(init:RequestInit)=>new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason)));
 const stalls=(init:RequestInit)=>new Response(new ReadableStream({start:c=>{c.enqueue(new Uint8Array(1));init.signal!.addEventListener('abort',()=>c.error(init.signal!.reason));}}));
 for(const reply of [waits,stalls])assert.equal((await (await gateway(t,{reply,timeoutMs:50})).open(ARK)).status,504);
 let clock=0;
 const busy=await gateway(t,{rate:2,now:()=>clock});
 for(let i=0;i<2;i++)assert.equal((await busy.open(ARK)).status,200);
 const refused=await busy.post((await busy.seal(ARK)).init.body!);
 assert.equal(refused.status,429);assert.equal(refused.headers.get('retry-after'),'1');assert.equal(busy.calls.length,2);
 clock+=1000;assert.equal((await busy.open(ARK)).status,200,'the next second admits again');
 for(const rate of [0,1.5,Number('twenty')])assert.throws(()=>createOhttpGateway(optionsOf(busy.key,{rate})),/rate/,`${rate} is not a whole number of requests per second`);
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
