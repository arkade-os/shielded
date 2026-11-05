import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mock,test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {appCacheManifest} from '../app/app-cache-manifest.ts';
import {registerAppCache} from '../app/src/app-cache.ts';

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
 const names=['assets/index-a1.js','index.html','sw.js','assets/geist-b2.woff2','assets/plex-c3.woff'],html='<!doctype html><title>a</title>';
 const manifest=appCacheManifest(names,false,html);
 assert.deepEqual(manifest.files,['/assets/geist-b2.woff2','/assets/index-a1.js','/index.html'],'sorted, without sw.js or a woff fallback');
 assert.equal(manifest.version,createHash('sha256').update(manifest.files.join('\n')).update('\0').update(html).digest('hex').slice(0,12));
 assert.equal(manifest.force,false);
 assert.deepEqual(appCacheManifest(names.filter(name=>name!=='index.html').reverse(),true,html),{...manifest,force:true},'index.html is added when missing, and order does not matter');
 assert.notEqual(appCacheManifest(names.map(name=>name.replace('a1','a2')),false,html).version,manifest.version);
});

test('a deploy that changes only index.html gets a new version',()=>{
 const names=['assets/index-a1.js','index.html'],version=(html:string)=>appCacheManifest(names,false,html).version;
 assert.notEqual(version('<title>a</title>'),version('<title>b</title>'));
 assert.equal(version('<title>a</title>'),version('<title>a</title>'));
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fakeWorker=(state:string)=>Object.assign(new EventTarget(),{state,postMessage:mock.fn()});
type Fake=ReturnType<typeof fakeWorker>;
// The page's service worker container: `controller` controls the page and `waiting` is installed behind it.
function browser(controller:object|null,waiting:Fake|null=null){
 const registration=Object.assign(new EventTarget(),{waiting,installing:null as Fake|null});
 const container=Object.assign(new EventTarget(),{controller,register:mock.fn(async(_url:string,_options:object)=>registration)});
 return {registration,container,navigator:{serviceWorker:container} as unknown as Navigator};
}

test('registerAppCache does nothing without service workers',async()=>{
 const onUpdate=mock.fn(),reload=mock.fn(),dev=browser({});
 assert.doesNotThrow(()=>registerAppCache(onUpdate,{prod:true,navigator:{} as Navigator,reload}));
 const denied=Object.defineProperty({},'serviceWorker',{get:()=>{throw new DOMException('Access is denied','SecurityError');}}) as Navigator;
 assert.doesNotThrow(()=>registerAppCache(onUpdate,{prod:true,navigator:denied,reload}),'a browser that denies access to service workers must not take the page down');
 registerAppCache(onUpdate,{prod:false,navigator:dev.navigator,reload});await tick();
 assert.equal(dev.container.register.mock.callCount(),0,'vite dev serves the unfilled template at /sw.js');
 assert.equal(onUpdate.mock.callCount(),0);
});

test('a waiting version is offered once and applying it reloads once',async()=>{
 const waiting=fakeWorker('installed'),page=browser({},waiting),offers:(()=>void)[]=[],reload=mock.fn();
 registerAppCache(apply=>offers.push(apply),{prod:true,navigator:page.navigator,reload});await tick();
 assert.deepEqual(page.container.register.mock.calls.map(call=>call.arguments),[['/sw.js',{updateViaCache:'all'}]]);
 assert.equal(offers.length,1);assert.equal(waiting.postMessage.mock.callCount(),0,'the version waits for the tap');
 offers[0]();
 assert.deepEqual(waiting.postMessage.mock.calls.map(call=>call.arguments),[[{type:'skip-waiting'}]]);
 const newer=fakeWorker('installed');page.registration.waiting=newer;offers[0]();
 assert.equal(newer.postMessage.mock.callCount(),1,'apply reaches whichever version waits when it is tapped');
 page.container.dispatchEvent(new Event('controllerchange'));page.container.dispatchEvent(new Event('controllerchange'));
 assert.equal(reload.mock.callCount(),1);
 const offered=async(tab:ReturnType<typeof browser>,...states:string[])=>{
  const seen:(()=>void)[]=[],installing=fakeWorker('installing');
  registerAppCache(apply=>seen.push(apply),{prod:true,navigator:tab.navigator,reload});await tick();
  if(states.length){tab.registration.installing=installing;tab.registration.dispatchEvent(new Event('updatefound'));}
  for(const state of states){installing.state=state;if(state==='installed')tab.registration.waiting=installing;installing.dispatchEvent(new Event('statechange'));}
  return seen.length;
 };
 assert.equal(await offered(browser({}),'installed'),1,'a version that finishes installing under a controlling worker is offered');
 assert.equal(await offered(browser({}),'redundant'),0,'a failed install is not');
 assert.equal(await offered(browser(null),'installed'),0,'the first install is not an update');
 assert.equal(await offered(browser(null,fakeWorker('installed'))),0,'a page no worker controls has nothing to replace');
});

test('a version already installing when the page registers is offered once it has installed',async()=>{
 const run=async(controller:object|null,replay=false)=>{
  const tab=browser(controller),installing=fakeWorker('installing'),seen:(()=>void)[]=[];
  tab.registration.installing=installing;
  registerAppCache(apply=>seen.push(apply),{prod:true,navigator:tab.navigator});await tick();
  assert.equal(seen.length,0,'nothing is offered while it is still installing');
  if(replay)tab.registration.dispatchEvent(new Event('updatefound'));
  installing.state='installed';tab.registration.installing=null;tab.registration.waiting=installing;installing.dispatchEvent(new Event('statechange'));
  return seen.length;
 };
 assert.equal(await run({}),1,'updatefound had already fired before the page could listen for it');
 assert.equal(await run({},true),1,'the same worker reported again by updatefound is not offered twice');
 assert.equal(await run(null),0,'the first install is not an update');
});
