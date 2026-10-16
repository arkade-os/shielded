import {base64} from '@scure/base';
import type {PublishedBatch,RollupAccount} from '../../packages/protocol/src/rollup/account.ts';
import {decodeScan,type ScanBatch} from '../../packages/protocol/src/rollup/scan.ts';
import type {PoolApi} from './pool.ts';

export const WATCHDOG_MS=60_000,EVENT_RETRY_MS=[0,1000,2000,4000,8000],SCAN_FROM=256,SCAN_AFTER=64,SCAN_PAGE=500;
export interface BatchPage {total:number;batches:PublishedBatch[]}
export interface ScanPage {from:number;total:number;data:string}
export type OnBatch=(cursor:number,batch:PublishedBatch,account:RollupAccount)=>Promise<void>|void;
const running=new WeakMap<RollupAccount,Promise<number>>();

export async function idle<T>(account:RollupAccount,use:()=>T|Promise<T>):Promise<T>{
 for(;;){
  const current=running.get(account);
  if(!current)return use();
  await current.then(()=>undefined,()=>undefined);
 }
}

/**
 * Applies every batch after the account's cursor. Single-flight per account: watchScript is at-least-once, so a
 * duplicate event must not replay a batch, and the cursor is the only thing that decides what is new.
 */
export function catchUp(account:RollupAccount,api:PoolApi,onBatch?:OnBatch,onPage?:(cursor:number)=>Promise<void>|void,watched?:()=>Iterable<bigint>):Promise<number>{
 const inFlight=running.get(account);
 if(inFlight)return inFlight.then(()=>catchUp(account,api,onBatch,onPage,watched),()=>catchUp(account,api,onBatch,onPage,watched));
 const run=(async()=>{
  let applied=0,total=0,scanning=false,whole=!account.canSkip;
  for(;;){
   // A long gap scans and fetches only the batches that may be this wallet's; live sync, the newest SCAN_AFTER, always comes whole.
   scanning=!whole&&total-account.batchCount>(scanning?SCAN_AFTER:SCAN_FROM);
   if(scanning){
    let entries:ScanBatch[]=[],page:ScanPage|undefined;
    try{page=await api<ScanPage>(`/scan?from=${account.batchCount}&limit=${Math.min(SCAN_PAGE,total-SCAN_AFTER-account.batchCount)}`);if(page.from===account.batchCount)entries=decodeScan(base64.decode(page.data),page.from);}
    catch{/* an older pool, or a page that does not parse: whole pages are always right */}
    if(!entries.length){whole=true;continue;}
    total=page!.total;
    for(const entry of entries){
     if(await account.concerns(entry,watched?.())){
      const [batch]=(await api<BatchPage>(`/batches?from=${entry.batch}&limit=1`)).batches;
      await account.apply(batch!);await onBatch?.(account.batchCount,batch!,account);
     }else account.skip(entry);
     applied++;
    }
    await onPage?.(account.batchCount);
    continue;
   }
   const page=await api<BatchPage>(`/batches?from=${account.batchCount}&limit=50`);
   total=page.total;
   if(!page.batches.length)return applied;
   for(const batch of page.batches){await account.apply(batch);applied++;await onBatch?.(account.batchCount,batch,account);}
   await onPage?.(account.batchCount);
   if(account.batchCount>=page.total)return applied;
  }
 })();
 running.set(account,run);
 return run.finally(()=>{if(running.get(account)===run)running.delete(account);});
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
