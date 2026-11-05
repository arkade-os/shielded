// What a SHIELDED_APP_CACHE_OFF=1 build ships as sw.js: it replaces the app cache's worker at once, then removes its caches, itself and the pages it took over.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(caches.keys()
 .then(names=>Promise.all(names.filter(name=>name.startsWith('shielded-')).map(name=>caches.delete(name))))
 .then(()=>self.registration.unregister())
 .then(()=>self.clients.matchAll({type:'window'}))
 .then(tabs=>{for(const tab of tabs)tab.navigate(tab.url).catch(()=>{});})));
