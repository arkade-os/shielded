import type {ShieldedSyncProgress} from '../../src/shielded/sync-progress.ts';

export function walletSyncProgressLabel(progress:ShieldedSyncProgress,elapsedMs=0):string{
 const elapsed=Math.floor(Math.max(0,elapsedMs)/5000)*5,tail=elapsed?` · ${elapsed}s`:'';
 if(progress.stage==='verified')return 'Private pool history verified';
 if(progress.stage==='verifying')return 'Verifying private pool history'+tail;
 if(progress.stage==='waiting'){
  const seconds=Math.ceil(Math.max(0,progress.retryInMs-elapsedMs)/1000);
  const target=progress.request==='history'?'private pool history':'the private pool connection';
  return seconds?`Retrying ${target} in ${seconds}s`:`Retrying ${target}`;
 }
 if(progress.stage==='request')return (progress.request==='history'?'Reading private pool history':'Checking the private pool connection')+tail;
 const {from,through,total}=progress;
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(through)||from<0||through<from)return 'Reading private pool history'+tail;
 const done=through-from;
 if(total!==undefined&&Number.isSafeInteger(total)&&total>=through&&total>from){
  const count=total-from,percent=Math.min(99,Math.floor(done/count*100));
  return `Reading private pool history · ${percent}% · ${done} of ${count} updates`+tail;
 }
 return `Reading private pool history · ${done} updates`+tail;
}

type ProgressClock={now?:()=>number;repeat?:(tick:()=>void)=>()=>void};
export function createWalletOpeningProgress(report:(line:string)=>void,{now=Date.now,repeat=tick=>{
 const timer=setInterval(tick,1000);return()=>clearInterval(timer);
}}:ProgressClock={}){
 let stopped=false,progress:ShieldedSyncProgress|undefined,started=0,last='',cancel:(()=>void)|undefined;
 const publish=()=>{
  if(stopped||!progress)return;
  const line=walletSyncProgressLabel(progress,now()-started);
  if(line===last)return;last=line;report(line);
 };
 return {
  update(value:ShieldedSyncProgress){
   if(stopped)return;progress=value;started=now();publish();
   if(value.stage==='verified'){cancel?.();cancel=undefined;}
   else if(!cancel)cancel=repeat(publish);
  },
  stop(){if(stopped)return;stopped=true;cancel?.();cancel=undefined;},
 };
}
