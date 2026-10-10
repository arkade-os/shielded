import type {PublishedBatch,RollupAccount} from '../../packages/protocol/src/rollup/account.ts';
import type {PoolApi} from './pool.ts';

export const WATCHDOG_MS=60_000;
export interface BatchPage {total:number;batches:PublishedBatch[]}
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
export function catchUp(account:RollupAccount,api:PoolApi,onBatch?:(cursor:number)=>Promise<void>|void):Promise<number>{
 const inFlight=running.get(account);
 if(inFlight)return inFlight.then(()=>catchUp(account,api,onBatch),()=>catchUp(account,api,onBatch));
 const run=(async()=>{
  let applied=0;
  for(;;){
   const page=await api<BatchPage>(`/batches?from=${account.batchCount}&limit=50`);
   if(!page.batches.length)return applied;
   for(const batch of page.batches){await account.apply(batch);applied++;await onBatch?.(account.batchCount);}
   if(account.batchCount>=page.total)return applied;
  }
 })();
 running.set(account,run);
 return run.finally(()=>{if(running.get(account)===run)running.delete(account);});
}
