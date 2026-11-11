export type SyncRequest='status'|'history';
export type ShieldedSyncProgress=
 | {stage:'history';from:number;through:number;total?:number}
 | {stage:'verifying';through:number;total?:number}
 | {stage:'verified';through:number;total:number}
 | {stage:'request';request:SyncRequest;attempt:number}
 | {stage:'waiting';request:SyncRequest;attempt:number;retryInMs:number;status?:number};
export type SyncProgressObserver=(progress:ShieldedSyncProgress)=>void;

export function reportSyncProgress(observer:SyncProgressObserver|undefined,progress:ShieldedSyncProgress):void{
 if(!observer)return;
 try{void Promise.resolve(observer(progress)).catch(()=>{});}catch{/* Observation cannot change synchronization or verification. */}
}

export function paintSyncProgress(observer:SyncProgressObserver|undefined):Promise<void>|undefined{
 if(observer&&typeof window!=='undefined')return new Promise(resolve=>setTimeout(resolve,0));
}
