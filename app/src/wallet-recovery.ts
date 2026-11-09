import type {UnifiedReceiveStage} from '../../src/shielded/lnurl-receive.ts';

export const PRIVATE_RECEIVE_RESTART_KEY='shielded-private-receive-restart-v1';
export const PRIVATE_RECEIVE_RESTART_COOLDOWN_MS=120_000;
export const PRIVATE_RECEIVE_STALL_MS=90_000;

type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type TransientWalletControls={
 closeSheet:()=>void;
 closeScanner:()=>void;
 closeAbout:()=>void;
 closeRequest:()=>void;
 closeSecurity:()=>void;
};

const stages:UnifiedReceiveStage[]=[
 'Reading your saved receiver',
 'Checking the Lightning address service through Tor',
 'Registering your unified address',
 'Restoring payout watches',
 'Binding your payment routes',
];

export function privateReceiveStageLabel(stage:string){
 const index=stage==='Unified address ready'?4:stages.indexOf(stage as UnifiedReceiveStage);
 if(index<0)return stage;
 return `Step ${Math.max(0,index)+1} of 5 · ${stage}`;
}

export function claimPrivateReceiveRestart(storage:StorageLike,now=Date.now()){
 try{
  const previous=Number(storage.getItem(PRIVATE_RECEIVE_RESTART_KEY));
  // A future timestamp from a backwards clock must not hold recovery hostage.
  if(Number.isFinite(previous)&&previous>0&&now>=previous&&now-previous<PRIVATE_RECEIVE_RESTART_COOLDOWN_MS)return false;
  storage.setItem(PRIVATE_RECEIVE_RESTART_KEY,String(now));
  return true;
 }catch{
  return false;
 }
}

export function clearPrivateReceiveRestart(storage:StorageLike){
 try{storage.removeItem(PRIVATE_RECEIVE_RESTART_KEY);}catch{}
}

type WatchdogTimer=ReturnType<typeof setTimeout>;
type WatchdogTimers={set:(callback:()=>void,delay:number)=>WatchdogTimer;clear:(timer:WatchdogTimer)=>void};

export function createProgressWatchdog(
 timeoutMs:number,
 onStall:()=>void,
 timers:WatchdogTimers={set:(callback,delay)=>setTimeout(callback,delay),clear:timer=>clearTimeout(timer)},
){
 let timer:WatchdogTimer|undefined,stopped=false,revision=0;
 const clear=()=>{revision++;if(timer!==undefined)timers.clear(timer);timer=undefined;};
 return {
  arm(){
   if(stopped)return;clear();const mine=revision;
   timer=timers.set(()=>{timer=undefined;if(!stopped&&mine===revision)onStall();},timeoutMs);
  },
  stop(){stopped=true;clear();},
 };
}

export function restartWhenVisible(isHidden:()=>boolean,restart:()=>void,defer:()=>void){
 if(isHidden()){defer();return false;}
 restart();return true;
}

export function shouldAutoDismissPaymentResult(state:{done?:boolean}|undefined,visible:boolean){
 return visible&&!!state?.done;
}

export function dismissTransientWalletViews(controls:TransientWalletControls){
 controls.closeScanner();
 controls.closeSheet();
 controls.closeAbout();
 controls.closeRequest();
 controls.closeSecurity();
}
