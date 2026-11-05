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
  if(registration.waiting)offer();
  registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')offer();});});
 }).catch(()=>{});
}
