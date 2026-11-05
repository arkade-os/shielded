const APP_CACHE=__APP_CACHE__;
// appCache() in vite.config.ts fills in line 1 with this build's files, version, force flag and index.html hash.
const SHELL=`shielded-shell-${APP_CACHE.version}`,PROVING='shielded-proving',ROUTES=['/','/wallet','/claim','/verify','/watch'];
// Built files have one copy each; crossorigin scripts send Origin, so a Vary: Origin answer would never match the precache.
// A failing CacheStorage falls back to the network: recovering by clearing site data would also wipe the wallet secret.
const cacheFirst=(request,key=request)=>caches.open(SHELL).then(cache=>cache.match(key,{ignoreVary:true})).catch(()=>{}).then(hit=>hit??fetch(request));
// index.html is the one file not named for its content: an HTTP-cached or other build's copy fails the hash, so the install fails and is retried later.
const precache=file=>file==='/index.html'?new Request(file,{cache:'no-cache',integrity:APP_CACHE.integrity}):file;
self.addEventListener('install',event=>{event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(APP_CACHE.files.map(precache))));if(APP_CACHE.force)self.skipWaiting();});
// A page that crashed early never attached its controllerchange listener, so a forced build reloads its tabs itself; the query is there because a fragment URL navigated to itself can be a same-document scroll, not a reload.
// Not awaited: the new page's fetch waits for this activation to finish, so awaiting navigate() here stalls it.
self.addEventListener('activate',event=>event.waitUntil(caches.keys()
 .then(names=>Promise.all(names.filter(name=>name.startsWith('shielded-shell-')&&name!==SHELL).map(name=>caches.delete(name))))
 .then(()=>APP_CACHE.force?self.clients.matchAll({type:'window'}):[])
 .then(tabs=>{for(const tab of tabs){const url=new URL(tab.url);url.searchParams.set('sw',APP_CACHE.version);tab.navigate(url.href).catch(()=>{});}})));
self.addEventListener('message',event=>{if(event.data?.type==='skip-waiting')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const {request}=event,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 // cache:'reload' is loadProvingFile's retry after a digest mismatch, so it must replace a bad cached copy.
 if(url.pathname.startsWith('/api/rollup/proving/'))return event.respondWith(caches.open(PROVING).then(async cache=>{
  const hit=request.cache==='reload'?undefined:await cache.match(request).catch(()=>{});if(hit)return hit;
  const response=await fetch(request);if(response.ok)event.waitUntil(cache.put(request,response.clone()));return response;
 },()=>fetch(request)));
 if(url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate'&&ROUTES.includes(url.pathname))return event.respondWith(cacheFirst(request,'/index.html'));
 if(APP_CACHE.files.includes(url.pathname))event.respondWith(cacheFirst(request));
});
