import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Request,RequestHandler,Response as ExpressResponse} from 'express';
import {createNativeReleasesHandler} from '../src/native-releases.ts';
import {NATIVE_RELEASE_ENDPOINT,NATIVE_RELEASE_MANIFEST_URL} from '../src/native-release.ts';
import {NATIVE_RELEASE_MAX_BYTES,readNativeReleaseResponse} from '../src/native-release-response.ts';
import {nativeReleaseFixture} from './fixtures/native-release.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function request(handler:RequestHandler,method='GET',url=NATIVE_RELEASE_ENDPOINT){
 return new Promise<{status:number;body:any;cache?:string}>(resolve=>{
  const result={status:200,body:undefined as any,cache:undefined as string|undefined};
  const response={set(_name:string,value:string){result.cache=value;return this;},status(code:number){result.status=code;return this;},json(body:any){result.body=body;resolve(result);return this;},end(){resolve(result);return this;}};
  handler({method,originalUrl:url,headers:{authorization:'secret',cookie:'wallet-id'}} as Request,response as ExpressResponse,()=>{});
 });
}

test('native release endpoint fetches only the fixed public manifest, coalesces and caches for five minutes',async()=>{
 let calls=0,now=100;
 const pending=deferred<Response>(),fetchImpl:typeof fetch=async(url,init)=>{
  calls++;assert.equal(url,NATIVE_RELEASE_MANIFEST_URL);assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');
  assert.deepEqual(init?.headers,{Accept:'application/json'});return calls===1?pending.promise:Response.json(nativeReleaseFixture());
 };
 const handler=createNativeReleasesHandler({fetchImpl,now:()=>now}),first=request(handler),second=request(handler);
 assert.equal(calls,1);pending.resolve(Response.json({...nativeReleaseFixture(),wallet:'ignored'}));
 for(const response of await Promise.all([first,second])){assert.equal(response.status,200);assert.equal(response.cache,'no-store');assert.equal('wallet' in response.body,false);}
 now+=299_999;assert.equal((await request(handler)).status,200);assert.equal(calls,1);
 now++;assert.equal((await request(handler)).status,200);assert.equal(calls,2);
});

test('native release endpoint rejects extra methods and query data without fetching',async()=>{
 let calls=0;const handler=createNativeReleasesHandler({fetchImpl:async()=>{calls++;throw new Error('must not fetch');}});
 for(const [method,path] of [['POST',NATIVE_RELEASE_ENDPOINT],['HEAD',NATIVE_RELEASE_ENDPOINT],['GET',NATIVE_RELEASE_ENDPOINT+'?wallet=hidden'],['GET',NATIVE_RELEASE_ENDPOINT+'?'],['GET',NATIVE_RELEASE_ENDPOINT+'/']])assert.equal((await request(handler,method,path)).status,404);
 assert.equal(calls,0);
});

test('native release endpoint fails nonfatally and retries offline, invalid and oversized manifests',async()=>{
 const responses=[()=>Promise.reject(new Error('offline')),()=>Response.json({schema:1}),()=>new Response('bad',{status:502}),()=>new Response('x'.repeat(NATIVE_RELEASE_MAX_BYTES+1))];
 let calls=0,now=0;const handler=createNativeReleasesHandler({fetchImpl:async()=>responses[calls++]!(),now:()=>now});
 for(let i=0;i<responses.length;i++){const response=await request(handler);assert.equal(response.status,503);assert.deepEqual(response.body,{error:'Native release metadata unavailable'});assert.equal((await request(handler)).status,503);assert.equal(calls,i+1);now+=30_000;}
 assert.equal(calls,4);
});

test('native release endpoint coalesces failures and serves bounded last-good metadata during outages',async()=>{
 let now=0,calls=0;
 const pending=deferred<Response>(),handler=createNativeReleasesHandler({now:()=>now,fetchImpl:async()=>{
  calls++;if(calls===1)return Response.json(nativeReleaseFixture());if(calls===2)return pending.promise;throw new Error('offline');
 }});
 assert.equal((await request(handler)).status,200);now=300_000;
 const first=request(handler),second=request(handler);assert.equal(calls,2);pending.resolve(new Response('unavailable',{status:503}));
 for(const response of await Promise.all([first,second])){assert.equal(response.status,200);assert.equal(response.body.commit,nativeReleaseFixture().commit);}
 now+=29_999;assert.equal((await request(handler)).status,200);assert.equal(calls,2);
 now++;assert.equal((await request(handler)).status,200);assert.equal(calls,3);
 now=3_600_000;assert.equal((await request(handler)).status,503);assert.equal(calls,4);
 assert.equal((await request(handler)).status,503);assert.equal(calls,4);
});

test('native release endpoint deadline aborts a stuck upstream and ignores its late response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal:AbortSignal|undefined,calls=0;
 const pending=deferred<Response>(),handler=createNativeReleasesHandler({now:()=>0,fetchImpl:async(_url,init)=>{calls++;signal=init!.signal!;return pending.promise;}}),response=request(handler);
 t.mock.timers.tick(10_000);await flush();assert.equal(signal?.aborted,true);assert.equal((await response).status,503);
 pending.resolve(Response.json(nativeReleaseFixture()));await flush();
 const duringBackoff=await request(handler);
 assert.equal(duringBackoff.status,503);assert.deepEqual(duringBackoff.body,{error:'Native release metadata unavailable'});assert.equal(calls,1);
});

test('release reader rejects declared and streamed oversize data, HTTP errors and invalid UTF8',async()=>{
 await assert.rejects(readNativeReleaseResponse(Response.json(nativeReleaseFixture(),{status:503})),/unavailable/);
 await assert.rejects(readNativeReleaseResponse(new Response('{}',{headers:{'content-length':String(NATIVE_RELEASE_MAX_BYTES+1)}})),/too large/);
 let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(NATIVE_RELEASE_MAX_BYTES));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
 await assert.rejects(readNativeReleaseResponse(new Response(stream)),/too large/);assert.equal(cancelled,true);
 await assert.rejects(readNativeReleaseResponse(new Response(new Uint8Array([0xff]))));
});

test('each freshly loaded release is handed to the host mirror, cached responses are not',async()=>{
 let now=0;const seen:string[]=[];
 const handler=createNativeReleasesHandler({fetchImpl:async()=>Response.json(nativeReleaseFixture()),now:()=>now,onRelease:release=>seen.push(release.commit)});
 await request(handler);await request(handler);assert.deepEqual(seen,['a'.repeat(40)]);
 now+=300_000;await request(handler);assert.equal(seen.length,2);
});
