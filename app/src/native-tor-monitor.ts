import type {NativeStatus} from '../../src/native/transport.ts';

export interface NativeTorHealthState {
 status:NativeStatus;
 check:'idle'|'checking'|'ok'|'failed';
 checkedAt?:number;
 latencyMs?:number;
 error?:string;
 attempt?:number;
 retryAt?:number;
}

interface TorMonitorNetwork {
 status():Promise<NativeStatus>;
 subscribe(listener:(status:NativeStatus)=>void):()=>void;
 check(signal:AbortSignal):Promise<void>;
}

export const TOR_CHECK_INTERVAL_MS=30_000;
export const TOR_CHECK_RETRY_MS=5_000;
export const TOR_CHECK_JITTER_MS=15_000;
export const TOR_STATUS_FAILURE_LIMIT=3;

export function createNativeTorMonitor(
 network:TorMonitorNetwork,
 onHealth:(health:NativeTorHealthState)=>void,
 onStatusError:(error:unknown)=>void,
 isVisible:()=>boolean
){
 type Probe={controller:AbortController;generation:number;started:number;attempt:number;deadline?:ReturnType<typeof setTimeout>};
 let health:NativeTorHealthState={status:{phase:'idle',generation:0},check:'idle'},warmEvidence:NativeTorHealthState|undefined;
 let stopped=false,polling=false,revision=0,visible=isVisible(),probe:Probe|undefined,failures=0,statusFailures=0;
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
  if(resumed&&health.check!=='ok')runCheck();
  return true;
 };
 const schedule=(delay=TOR_CHECK_INTERVAL_MS+Math.floor(Math.random()*TOR_CHECK_JITTER_MS))=>{
  clearTimeout(scheduled);
  scheduled=setTimeout(()=>{scheduled=undefined;runCheck();},delay);
 };
 const finish=(owner:Probe,ok:boolean,error?:unknown)=>{
  if(stopped||probe!==owner)return;
  if(!foreground()||probe!==owner||health.status.phase!=='ready'||health.status.generation!==owner.generation)return;
  clearTimeout(owner.deadline);probe=undefined;
  const checkedAt=Date.now(),latencyMs=checkedAt-owner.started;
  if(ok){
   failures=0;
   warmEvidence={status:health.status,check:'ok',checkedAt,latencyMs};publish(warmEvidence);
   schedule();
   return;
  }
  warmEvidence=undefined;failures++;
  const delay=Math.min(TOR_CHECK_RETRY_MS*2**(failures-1),TOR_CHECK_INTERVAL_MS);
  publish({status:health.status,check:'failed',checkedAt,latencyMs,attempt:owner.attempt,retryAt:checkedAt+delay,
   error:error instanceof Error?error.message:String(error??'Tor connection check failed')});
  schedule(delay);
 };
 function runCheck(){
  if(stopped||!foreground()||health.status.phase!=='ready'||probe)return;
  clearTimeout(scheduled);scheduled=undefined;
  const owner:Probe={controller:new AbortController(),generation:health.status.generation,started:Date.now(),attempt:failures+1};probe=owner;
  publish({status:health.status,check:'checking',attempt:owner.attempt});
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
 statusFailures=0;
  revision++;
  const changed=status.generation!==health.status.generation||status.phase!=='ready'||health.status.phase!=='ready';
  if(changed)failures=0;
  if(changed){
   invalidate();
   const age=warmEvidence?.checkedAt===undefined?undefined:Date.now()-warmEvidence.checkedAt;
   const reuse=status.phase==='ready'&&(status.mode??'tor')==='tor'&&(warmEvidence?.status.mode??'tor')==='tor'&&status.warmFromGeneration===warmEvidence?.status.generation&&age!==undefined&&age>=0&&age<TOR_CHECK_INTERVAL_MS;
   if(reuse){warmEvidence={...warmEvidence!,status};publish(warmEvidence);schedule(TOR_CHECK_INTERVAL_MS-(Date.now()-warmEvidence.checkedAt!));}
   else{if(status.generation!==warmEvidence?.status.generation&&status.warmFromGeneration!==warmEvidence?.status.generation)warmEvidence=undefined;publish({status,check:'idle'});}
  }
  else publish({...health,status});
  if(foreground()&&status.phase==='ready'&&health.check==='idle')runCheck();
 };
 const poll=async()=>{
  if(stopped||!foreground()||polling)return;
  polling=true;const captured=revision;
  try{
   const status=await network.status();
   if(!stopped&&foreground()&&captured===revision){statusFailures=0;accept(status);}
  }catch(error){
   if(!stopped&&foreground()&&captured===revision){
    statusFailures++;
    if(statusFailures<TOR_STATUS_FAILURE_LIMIT)return;
    revision++;invalidate();warmEvidence=undefined;
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
