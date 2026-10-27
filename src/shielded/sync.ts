export const WATCHDOG_MS=60_000,EVENT_RETRY_MS=[0,1000,2000,4000,8000],SCAN_FROM=256,SCAN_AFTER=64,SCAN_PAGE=500;
export interface ScanPage {from:number;total:number;data:string}

/** The head moves as soon as arkd takes a batch, a moment before the pool records it, so a catch-up that finds nothing looks again. */
export async function catchUpAfterEvent(run:()=>Promise<number>,stopped:()=>boolean,delays:readonly number[]=EVENT_RETRY_MS):Promise<number>{
 for(const ms of delays){
  if(ms)await new Promise(resolve=>setTimeout(resolve,ms));
  if(stopped())return 0;
  try{const applied=await run();if(applied)return applied;}catch{/* the next delay looks again */}
 }
 return 0;
}
