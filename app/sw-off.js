// What a SHIELDED_APP_CACHE_OFF=1 build ships as sw.js: it replaces the app cache's worker at once, then removes its caches, itself and the pages it took over.
self.addEventListener('install',()=>self.skipWaiting());
// Each step is best effort: a failing CacheStorage or unregister must not stop the steps after it, down to reloading the tabs.
self.addEventListener('activate',event=>event.waitUntil(caches.keys()
 .then(names=>Promise.all(names.filter(name=>name.startsWith('shielded-')).map(name=>caches.delete(name))))
 .catch(()=>{})
 .then(()=>self.registration.unregister())
 .catch(()=>{})
 .then(()=>self.clients.matchAll({type:'window'}))
 .then(tabs=>{for(const tab of tabs){const url=new URL(tab.url);url.searchParams.set('sw','off');tab.navigate(url.href).catch(()=>{});}})
 .catch(()=>{})));
