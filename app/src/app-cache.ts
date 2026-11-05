type Env={prod:boolean;off?:boolean;navigator?:Navigator;reload?:()=>void};

// A waiting version is offered through onUpdate; an open tab switches only when the tap runs `apply` (closing every tab also activates it), and every tab then reloads once, because activation drops the old shell cache.
export function registerAppCache(onUpdate:(apply:()=>void)=>void,{prod,off,navigator:nav=globalThis.navigator,reload=()=>location.reload()}:Env={prod:import.meta.env.PROD,off:__APP_CACHE_OFF__}):void{
 // The getter throws a SecurityError where service workers are denied, and an effect that throws unmounts the whole app.
 let container:ServiceWorkerContainer|undefined;
 try{container=nav.serviceWorker;}catch{}
 if(!prod||off||!container)return;
 let reloaded=false;
 const reloadOnce=()=>{if(!reloaded){reloaded=true;reload();}};
 container.addEventListener('controllerchange',reloadOnce);
 container.register('/sw.js',{updateViaCache:'all'}).then(registration=>{
  // Nothing waits once the version has activated, and this tab still runs the old code, so it reloads instead.
  const apply=()=>{if(registration.waiting)registration.waiting.postMessage({type:'skip-waiting'});else reloadOnce();};
  const offer=()=>{if(container.controller)onUpdate(apply);};
  // One shared listener: DOM ignores a listener added twice, so a worker reached by this check and by a later updatefound is offered once.
  const installed=(event:Event)=>{if((event.target as ServiceWorker).state==='installed')offer();};
  const watch=()=>registration.installing?.addEventListener('statechange',installed);
  if(registration.waiting)offer();
  watch();
  registration.addEventListener('updatefound',watch);
 }).catch(()=>{});
}
