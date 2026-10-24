import {base64} from '@scure/base';
import type {RollupEpochRecord} from '../rollup/epoch-operator.ts';
import type {EpochAccount} from '../../packages/protocol/src/rollup/epoch-account.ts';
import {decodeEpochScan,type EpochScanBatch} from '../../packages/protocol/src/rollup/epoch-scan.ts';
import type {PoolApi} from './pool.ts';
import {SCAN_AFTER,SCAN_FROM,SCAN_PAGE,type ScanPage} from './sync.ts';

export interface EpochBatchPage {total:number;batches:RollupEpochRecord[]}
export type EpochOnBatch=(cursor:number,batch:RollupEpochRecord,account:EpochAccount)=>Promise<void>|void;
const running=new WeakMap<EpochAccount,Promise<number>>();

export async function epochIdle<T>(account:EpochAccount,use:()=>T|Promise<T>):Promise<T>{
 for(;;){
  const current=running.get(account);
  if(!current)return use();
  await current.then(()=>undefined,()=>undefined);
 }
}

/** sync.ts's catchUp on an epoch pool, single-flight per account: a skipped scan entry still rotates the account on its own count. */
export function epochCatchUp(account:EpochAccount,api:PoolApi,onBatch?:EpochOnBatch,onPage?:(cursor:number)=>Promise<void>|void,watched?:()=>Iterable<bigint>):Promise<number>{
 const inFlight=running.get(account);
 if(inFlight)return inFlight.then(()=>epochCatchUp(account,api,onBatch,onPage,watched),()=>epochCatchUp(account,api,onBatch,onPage,watched));
 const run=(async()=>{
  let applied=0,total=0,scanning=false,whole=!account.canSkip;
  for(;;){
   scanning=!whole&&total-account.batchCount>(scanning?SCAN_AFTER:SCAN_FROM);
   if(scanning){
    let entries:EpochScanBatch[]=[],page:ScanPage|undefined;
    try{page=await api<ScanPage>(`/scan?from=${account.batchCount}&limit=${Math.min(SCAN_PAGE,total-SCAN_AFTER-account.batchCount)}`);if(page.from===account.batchCount)entries=decodeEpochScan(base64.decode(page.data),page.from,account.epochLen);}
    catch{/* a page that does not parse: whole pages are always right */}
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
 })();
 running.set(account,run);
 return run.finally(()=>{if(running.get(account)===run)running.delete(account);});
}
