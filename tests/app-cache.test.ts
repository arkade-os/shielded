import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mock,test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {appCacheManifest} from '../app/app-cache-manifest.ts';

const origin='https://shielded.example',version='0123456789ab',shell=`shielded-shell-${version}`;
const files=['/assets/geist-b2.woff2','/assets/index-a1.js','/index.html'];
type Entry={headers:Headers;response:Response};

// app/sw.js over Map-backed caches; `fetch` is the network, which also answers every request the worker leaves alone.
function worker(force=false){
 const listeners=new Map<string,(event:object)=>void>(),stores=new Map<string,Map<string,Entry>>();
 const key=(request:Request|string)=>new URL(typeof request==='string'?request:request.url,origin).href;
 const headers=(request:Request|string)=>typeof request==='string'?new Headers():request.headers;
 const caches={keys:async()=>[...stores.keys()],delete:async(name:string)=>stores.delete(name),open:async(name:string)=>{
  const entries=stores.get(name)??new Map<string,Entry>();stores.set(name,entries);
  return {
   match:async(request:Request|string,options?:CacheQueryOptions)=>{
    const entry=entries.get(key(request)),vary=options?.ignoreVary?[]:entry?.response.headers.get('vary')?.split(',').map(name=>name.trim())??[];
    return vary.every(name=>headers(request).get(name)===entry!.headers.get(name))?entry?.response.clone():undefined;
   },
   put:async(request:Request|string,response:Response)=>{entries.set(key(request),{headers:headers(request),response});},
   addAll:async(urls:string[])=>{for(const url of urls)entries.set(key(url),{headers:new Headers(),response:new Response(`cached ${url}`,{headers:{vary:'Origin'}})});},
  };
 }};
 const fetch=mock.fn(async(_request:Request)=>new Response('net')),skipWaiting=mock.fn(async()=>{});
 const self={addEventListener:(type:string,listener:(event:object)=>void)=>listeners.set(type,listener),skipWaiting,location:{origin}};
 runInNewContext(readFileSync('app/sw.js','utf8').replace(/^const APP_CACHE=__APP_CACHE__;/,`const APP_CACHE=${JSON.stringify({version,files,force})};`),{self,caches,fetch,Request,Response,URL});
 const dispatch=async(type:string,event:object={})=>{
  const pending:Promise<unknown>[]=[];let answer=undefined as Promise<Response>|undefined;
  listeners.get(type)!({...event,respondWith:(response:Promise<Response>)=>{answer=response;},waitUntil:(promise:Promise<unknown>)=>pending.push(promise)});
  const response=await answer;await Promise.all(pending);return response;
 };
 const get=async(path:string,{navigate,...init}:RequestInit&{navigate?:boolean}={})=>{
  const request=new Request(origin+path,init);if(navigate)Object.defineProperty(request,'mode',{value:'navigate'});
  const answer=await dispatch('fetch',{request});
  return {body:await (answer??await fetch(request)).text(),intercepted:!!answer};
 };
 return {stores,caches,fetch,skipWaiting,dispatch,get};
}

test('install puts index.html and every built file into one cache named for the build',async()=>{
 const sw=worker();await sw.dispatch('install');
 assert.deepEqual([...sw.stores.keys()],[shell]);
 assert.deepEqual([...sw.stores.get(shell)!.keys()].sort(),files.map(file=>origin+file));
 assert.deepEqual(await sw.get('/assets/index-a1.js',{headers:{origin}}),{body:'cached /assets/index-a1.js',intercepted:true},'a crossorigin script sends Origin');
 assert.equal(sw.fetch.mock.callCount(),0);
});

test('a navigation to /wallet or /claim is answered with the cached index.html',async()=>{
 const sw=worker();await sw.dispatch('install');
 for(const path of ['/wallet','/claim#token'])assert.deepEqual(await sw.get(path,{navigate:true}),{body:'cached /index.html',intercepted:true},path);
 assert.equal(sw.fetch.mock.callCount(),0);
 assert.deepEqual(await sw.get('/stock-wallet',{navigate:true}),{body:'net',intercepted:false},'the server still redirects legacy paths');
 await sw.caches.delete(shell);
 assert.deepEqual(await sw.get('/claim',{navigate:true}),{body:'net',intercepted:true},'a cache miss goes to the network');
});

test('pool API calls are never answered from the cache',async()=>{
 const sw=worker(),paths=['/api/rollup/status','/api/rollup/batches?from=1'];await sw.dispatch('install');
 for(const name of [shell,'shielded-proving'])for(const path of paths)await (await sw.caches.open(name)).put(path,new Response('cached'));
 for(const path of paths)assert.deepEqual(await sw.get(path),{body:'net',intercepted:false},path);
 assert.deepEqual(sw.fetch.mock.calls.map(call=>call.arguments[0].url),paths.map(path=>origin+path));
});

test('proving keys come from the cache after the first fetch',async()=>{
 const sw=worker(),file='/api/rollup/proving/epoch-spend.zkey?v=aa',calls=()=>sw.fetch.mock.callCount();
 assert.deepEqual(await sw.get(file),{body:'net',intercepted:true});
 assert.deepEqual(await sw.get(file),{body:'net',intercepted:true});
 assert.equal(calls(),1);
 await sw.get('/api/rollup/proving/epoch-spend.zkey?v=bb');
 assert.equal(calls(),2,'the ?v= digest is part of the key');
 sw.fetch.mock.mockImplementationOnce(async()=>new Response('gone',{status:404}));
 await sw.get('/api/rollup/proving/epoch-join.zkey?v=cc');await sw.get('/api/rollup/proving/epoch-join.zkey?v=cc');
 assert.equal(calls(),4,'a failed download is not kept');
 await sw.get(file,{cache:'reload'});
 assert.equal(calls(),5,'the digest-mismatch retry in loadProvingFile gets past the cached copy');
 assert.deepEqual([...sw.stores.keys()],['shielded-proving']);
});

test('activate removes caches of older builds and keeps the proving cache',async()=>{
 const sw=worker();for(const name of ['shielded-shell-old','shielded-proving','other'])await sw.caches.open(name);
 await sw.dispatch('install');await sw.dispatch('activate');
 assert.deepEqual((await sw.caches.keys()).sort(),['other','shielded-proving',shell]);
});

test('only the skip-waiting message activates a waiting version',async()=>{
 const sw=worker();await sw.dispatch('install');await sw.dispatch('message',{data:{type:'other'}});
 assert.equal(sw.skipWaiting.mock.callCount(),0);
 await sw.dispatch('message',{data:{type:'skip-waiting'}});
 assert.equal(sw.skipWaiting.mock.callCount(),1);
});

test('a forced build activates without waiting',async()=>{
 const sw=worker(true);await sw.dispatch('install');
 assert.equal(sw.skipWaiting.mock.callCount(),1);
});

test('the manifest lists every emitted file once and its version follows the file names',()=>{
 const names=['assets/index-a1.js','index.html','sw.js','assets/geist-b2.woff2','assets/plex-c3.woff'];
 const manifest=appCacheManifest(names);
 assert.deepEqual(manifest.files,['/assets/geist-b2.woff2','/assets/index-a1.js','/index.html'],'sorted, without sw.js or a woff fallback');
 assert.equal(manifest.version,createHash('sha256').update(manifest.files.join('\n')).digest('hex').slice(0,12));
 assert.equal(manifest.force,false);
 assert.deepEqual(appCacheManifest(names.filter(name=>name!=='index.html').reverse(),true),{...manifest,force:true},'index.html is added when missing, and order does not matter');
 assert.notEqual(appCacheManifest(names.map(name=>name.replace('a1','a2'))).version,manifest.version);
});
