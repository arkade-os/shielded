// What a SHIELDED_APP_CACHE_OFF=1 build ships as sw.js: it replaces the app cache's worker at once, then removes its caches, itself and the pages it took over.
self.addEventListener('install',()=>self.skipWaiting());
// Cleanup is best effort: a failing CacheStorage must not keep this worker registered or leave its tabs on the old page.
self.addEventListener('activate',event=>event.waitUntil(caches.keys()
 .then(names=>Promise.all(names.filter(name=>name.startsWith('shielded-')).map(name=>caches.delete(name))))
 .catch(()=>{})
 .then(()=>self.registration.unregister())
 .then(()=>self.clients.matchAll({type:'window'}))
 .then(tabs=>{for(const tab of tabs){const url=new URL(tab.url);url.searchParams.set('sw','off');tab.navigate(url.href).catch(()=>{});}})));
