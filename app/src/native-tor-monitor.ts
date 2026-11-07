import type {NativeStatus} from '../../src/native/transport.ts';

export interface NativeTorHealthState {
 status:NativeStatus;
 check:'idle'|'checking'|'ok'|'failed';
 checkedAt?:number;
 latencyMs?:number;
 error?:string;
}

interface TorMonitorNetwork {
 status():Promise<NativeStatus>;
 subscribe(listener:(status:NativeStatus)=>void):()=>void;
 check(signal:AbortSignal):Promise<void>;
}

export function createNativeTorMonitor(
 network:TorMonitorNetwork,
 onHealth:(health:NativeTorHealthState)=>void,
 onStatusError:(error:unknown)=>void,
 isVisible:()=>boolean
){
 type Probe={controller:AbortController;generation:number;started:number;deadline?:ReturnType<typeof setTimeout>};
 let health:NativeTorHealthState={status:{phase:'idle',generation:0},check:'idle'};
 let stopped=false,polling=false,revision=0,visible=isVisible(),probe:Probe|undefined;
 let scheduled:ReturnType<typeof setTimeout>|undefined;
 const publish=(value:NativeTorHealthState)=>{health=value;if(!stopped)onHealth(value);};
 const invalidate=()=>{
  clearTimeout(scheduled);scheduled=undefined;
  const previous=probe;probe=undefined;
  if(previous){clearTimeout(previous.deadline);previous.controller.abort();}
 };
 const foreground=()=>{
  const next=isVisible();
  if(!next){
   if(visible||health.check!=='idle'){
    revision++;invalidate();publish({status:health.status,check:'idle'});
   }
   visible=false;return false;
  }
  const resumed=!visible;visible=true;
  if(resumed)runCheck();
  return true;
 };
 const schedule=()=>{
  clearTimeout(scheduled);
  scheduled=setTimeout(()=>{scheduled=undefined;runCheck();},30_000+Math.floor(Math.random()*15_001));
 };
 const finish=(owner:Probe,ok:boolean,error?:unknown)=>{
  if(stopped||probe!==owner)return;
  if(!foreground()||probe!==owner||health.status.phase!=='ready'||health.status.generation!==owner.generation)return;
  clearTimeout(owner.deadline);probe=undefined;
  const checkedAt=Date.now(),latencyMs=checkedAt-owner.started;
  publish({status:health.status,check:ok?'ok':'failed',checkedAt,latencyMs,
   ...(ok?{}:{error:error instanceof Error?error.message:String(error??'Tor connection check failed')})});
  schedule();
 };
 function runCheck(){
  if(stopped||!foreground()||health.status.phase!=='ready'||probe)return;
  clearTimeout(scheduled);scheduled=undefined;
  const owner:Probe={controller:new AbortController(),generation:health.status.generation,started:Date.now()};probe=owner;
  publish({status:health.status,check:'checking'});
  let abort=()=>{};
  const deadline=new Promise<void>((_,reject)=>{
   abort=()=>reject(owner.controller.signal.reason??new Error('Tor connection check cancelled'));
   owner.controller.signal.addEventListener('abort',abort,{once:true});
   owner.deadline=setTimeout(()=>{
    const error=new Error('Tor connection check timed out');reject(error);owner.controller.abort(error);
   },10_000);
  });
  const request=Promise.resolve().then(()=>network.check(owner.controller.signal));
  const cleanup=()=>{clearTimeout(owner.deadline);owner.controller.signal.removeEventListener('abort',abort);};
  void Promise.race([request,deadline]).then(()=>{cleanup();finish(owner,true);},error=>{cleanup();finish(owner,false,error);});
 }
 const accept=(status:NativeStatus)=>{
  if(stopped||!Number.isSafeInteger(status.generation)||status.generation<health.status.generation)return;
  revision++;
  const changed=status.generation!==health.status.generation||status.phase!=='ready'||health.status.phase!=='ready';
  if(changed){invalidate();publish({status,check:'idle'});}
  else publish({...health,status});
  if(foreground()&&status.phase==='ready'&&health.check==='idle')runCheck();
 };
 const poll=async()=>{
  if(stopped||!foreground()||polling)return;
  polling=true;const captured=revision;
  try{
   const status=await network.status();
   if(!stopped&&foreground()&&captured===revision)accept(status);
  }catch(error){
   if(!stopped&&foreground()&&captured===revision){
    revision++;invalidate();
    publish({status:{...health.status,phase:'error',error:'Network status unavailable'},check:'idle'});
    onStatusError(error);
   }
  }finally{polling=false;}
 };
 publish(health);
 const unsubscribe=network.subscribe(accept),interval=setInterval(()=>{void poll();},1500);
 void poll();
 return {
  check:runCheck,
  stop(){if(stopped)return;stopped=true;revision++;clearInterval(interval);unsubscribe();invalidate();}
 };
}
