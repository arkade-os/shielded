import type {UnifiedReceiveStage} from '../../src/shielded/lnurl-receive.ts';

export const PRIVATE_RECEIVE_RESTART_KEY='shielded-private-receive-restart-v1';
export const PRIVATE_RECEIVE_RESTART_COOLDOWN_MS=120_000;

type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type TransientWalletControls={
 closeSheet:()=>void;
 closeScanner:()=>void;
 closeAbout:()=>void;
 closeRequest:()=>void;
 closeSecurity:()=>void;
 clearStatus:()=>void;
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
  if(Number.isFinite(previous)&&previous>0&&now-previous<PRIVATE_RECEIVE_RESTART_COOLDOWN_MS)return false;
  storage.setItem(PRIVATE_RECEIVE_RESTART_KEY,String(now));
  return true;
 }catch{
  return false;
 }
}

export function clearPrivateReceiveRestart(storage:StorageLike){
 try{storage.removeItem(PRIVATE_RECEIVE_RESTART_KEY);}catch{}
}

export function dismissTransientWalletViews(controls:TransientWalletControls){
 controls.closeScanner();
 controls.closeSheet();
 controls.closeAbout();
 controls.closeRequest();
 controls.closeSecurity();
 controls.clearStatus();
}
