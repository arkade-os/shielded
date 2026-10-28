import {base64} from '@scure/base';
import type {EpochAccount} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {RollupEpochRecord} from '../../packages/protocol/src/rollup/epoch-record.ts';
import {decodeEpochScan,type EpochScanBatch} from '../../packages/protocol/src/rollup/epoch-scan.ts';
import type {PoolApi} from './pool.ts';

export const WATCHDOG_MS=60_000,EVENT_RETRY_MS=[0,1000,2000,4000,8000],SCAN_FROM=256,SCAN_AFTER=64,SCAN_PAGE=500;
export interface ScanPage {from:number;total:number;data:string}
export interface EpochBatchPage {total:number;batches:RollupEpochRecord[]}
export type EpochOnBatch=(cursor:number,batch:RollupEpochRecord,account:EpochAccount)=>Promise<void>|void;
const running=new WeakMap<EpochAccount,Promise<unknown>>();

export async function epochIdle<T>(account:EpochAccount,use:()=>T|Promise<T>):Promise<T>{
 for(;;){
  const current=running.get(account);
  if(!current)return use();
  await current.then(()=>undefined,()=>undefined);
 }
}

/** Runs `job` as the account's only sync: a call that finds one in flight waits for it to settle, then runs against what it applied. */
export function epochExclusive<T>(account:EpochAccount,job:()=>Promise<T>):Promise<T>{
 const inFlight=running.get(account);
 if(inFlight)return inFlight.then(()=>epochExclusive(account,job),()=>epochExclusive(account,job));
 const run=job();
 running.set(account,run);
 return run.finally(()=>{if(running.get(account)===run)running.delete(account);});
}

/** Single-flight per account: a skipped scan entry still rotates the account on its own count. */
export function epochCatchUp(account:EpochAccount,api:PoolApi,onBatch?:EpochOnBatch,onPage?:(cursor:number)=>Promise<void>|void,watched?:()=>Iterable<bigint>):Promise<number>{
 return epochExclusive(account,async()=>{
  let applied=0,total=0,scanning=false,whole=!account.canSkip;
  for(;;){
   scanning=!whole&&total-account.batchCount>(scanning?SCAN_AFTER:SCAN_FROM);
   if(scanning){
    let entries:EpochScanBatch[]=[],page:ScanPage|undefined;
    try{page=await api<ScanPage>(`/scan?from=${account.batchCount}&limit=${Math.min(SCAN_PAGE,total-SCAN_AFTER-account.batchCount)}`);if(page.from===account.batchCount)entries=decodeEpochScan(base64.decode(page.data),page.from,account.epochLen);}
    catch(error){if(page===undefined&&(error as {status?:number})?.status!==404)throw error;/* a 404 (an older pool) or a page that does not parse: whole pages are always right; any other failed fetch is the caller's to retry */}
    if(!entries.length){whole=true;continue;}
    total=page!.total;
    for(const entry of entries){
     if(await account.concerns(entry,watched?.())){
      const [batch]=(await api<EpochBatchPage>(`/batches?from=${entry.batch}&limit=1`)).batches;
      if(!batch)throw new Error(`The pool scanned batch ${entry.batch} but did not serve it.`);
      await account.apply(batch);await onBatch?.(account.batchCount,batch,account);
     }else account.skip(entry);
     applied++;
    }
    await onPage?.(account.batchCount);
    continue;
   }
   const page=await api<EpochBatchPage>(`/batches?from=${account.batchCount}&limit=50`);
   total=page.total;
   if(!page.batches.length)return applied;
   for(const batch of page.batches){await account.apply(batch);applied++;await onBatch?.(account.batchCount,batch,account);}
   await onPage?.(account.batchCount);
   if(account.batchCount>=page.total)return applied;
  }
 });
}

/** The head moves as soon as arkd takes a batch, a moment before the pool records it, so a catch-up that finds nothing looks again. */
export async function catchUpAfterEvent(run:()=>Promise<number>,stopped:()=>boolean,delays:readonly number[]=EVENT_RETRY_MS):Promise<number>{
 for(const ms of delays){
  if(ms)await new Promise(resolve=>setTimeout(resolve,ms));
  if(stopped())return 0;
  try{const applied=await run();if(applied)return applied;}catch{/* the next delay looks again */}
 }
 return 0;
}
