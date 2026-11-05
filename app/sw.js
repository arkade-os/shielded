const APP_CACHE=__APP_CACHE__;
// appCache() in vite.config.ts fills in line 1 with this build's files, version and force flag.
const SHELL=`shielded-shell-${APP_CACHE.version}`,PROVING='shielded-proving',ROUTES=['/','/wallet','/claim','/verify','/watch'];
// Built files have one copy each; crossorigin scripts send Origin, so a Vary: Origin answer would never match the precache.
const cacheFirst=(request,key=request)=>caches.open(SHELL).then(cache=>cache.match(key,{ignoreVary:true})).then(hit=>hit??fetch(request));
self.addEventListener('install',event=>{event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(APP_CACHE.files)));if(APP_CACHE.force)self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('shielded-shell-')&&name!==SHELL).map(name=>caches.delete(name))))));
self.addEventListener('message',event=>{if(event.data?.type==='skip-waiting')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const {request}=event,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 // cache:'reload' is loadProvingFile's retry after a digest mismatch, so it must replace a bad cached copy.
 if(url.pathname.startsWith('/api/rollup/proving/'))return event.respondWith(caches.open(PROVING).then(async cache=>{
  const hit=request.cache==='reload'?undefined:await cache.match(request);if(hit)return hit;
  const response=await fetch(request);if(response.ok)event.waitUntil(cache.put(request,response.clone()));return response;
 }));
 if(url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate'&&ROUTES.includes(url.pathname))return event.respondWith(cacheFirst(request,'/index.html'));
 if(APP_CACHE.files.includes(url.pathname))event.respondWith(cacheFirst(request));
});
