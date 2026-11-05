type Env={prod:boolean;navigator?:Navigator;reload?:()=>void};

// A waiting version is offered through onUpdate and only activates when the tap runs `apply`; every tab then reloads once, because activation drops the old shell cache.
export function registerAppCache(onUpdate:(apply:()=>void)=>void,{prod,navigator:nav=globalThis.navigator,reload=()=>location.reload()}:Env={prod:import.meta.env.PROD}):void{
 // The getter throws a SecurityError where service workers are denied, and an effect that throws unmounts the whole app.
 let container:ServiceWorkerContainer|undefined;
 try{container=nav.serviceWorker;}catch{}
 if(!prod||!container)return;
 let reloaded=false;
 container.addEventListener('controllerchange',()=>{if(!reloaded){reloaded=true;reload();}});
 container.register('/sw.js',{updateViaCache:'all'}).then(registration=>{
  const offer=()=>{if(container.controller)onUpdate(()=>registration.waiting?.postMessage({type:'skip-waiting'}));};
  // One shared listener: DOM ignores a listener added twice, so a worker reached by this check and by a later updatefound is offered once.
  const installed=(event:Event)=>{if((event.target as ServiceWorker).state==='installed')offer();};
  const watch=()=>registration.installing?.addEventListener('statechange',installed);
  if(registration.waiting)offer();
  watch();
  registration.addEventListener('updatefound',watch);
 }).catch(()=>{});
}
