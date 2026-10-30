import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {epochCircuitUrls,epochProvingUrls} from './epoch-pool.ts';
import type {RollupPoolStatus} from './pool.ts';
import type {ShieldedProver} from './wallet.ts';

const files=new Map<string,Promise<Uint8Array>>();
const cooldowns=new Map<string,number>();
const cooldownError=(url:string,until:number)=>new Error(`The proving file ${url} is temporarily unavailable. Retry in ${Math.ceil((until-Date.now())/1000)} seconds.`);
export function loadProvingFile(url:string,priority:'high'|'low'|'auto'='auto'):Promise<Uint8Array>{
 const cached=files.get(url);if(cached)return cached;
 const cooldown=cooldowns.get(url);if(cooldown&&cooldown>Date.now())return Promise.reject(cooldownError(url,cooldown));
 cooldowns.delete(url);
 const loading=(async()=>{
  for(let attempt=0;;attempt++){
   let response:Response|undefined,failure:unknown;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error(`The proving file ${url} download timed out.`)),120_000);
   try{response=await fetch(url,{priority,signal:controller.signal});if(response.ok)return new Uint8Array(await response.arrayBuffer());}
   catch(error){failure=error;}
   finally{clearTimeout(timer);}
   if(response&&!response.ok){
    failure=new Error(`The proving file ${url} answered HTTP ${response.status}.${response.status===404?' This page may be out of date; reload it.':''}`);
    if(response.status!==429&&response.status<500)throw failure;
   }
   const header=response?.headers.get('Retry-After')?.trim();
   const retryAfter=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now()):NaN;
   if(retryAfter>0)cooldowns.set(url,Date.now()+retryAfter);
   if(retryAfter>30_000)throw cooldownError(url,cooldowns.get(url)!);
   if(attempt>=4)throw failure;
   const backoff=1000*2**attempt*(1+Math.random()/4),delay=Math.max(backoff,Number.isFinite(retryAfter)?retryAfter:0);
   const until=Date.now()+delay;
   for(let remaining;(remaining=until-Date.now())>0;)await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,2_147_483_647)));
  }
 })();
 files.set(url,loading);
 void loading.catch(()=>{if(files.get(url)===loading)files.delete(url);});
 return loading;
}

/** Prefetch and proving share immutable file bytes and any download already in progress. */
export function prefetchProvingKeys(status:RollupPoolStatus,circuit:'spend'|'join'='spend',origin=''){
 if(!status.proving)return;
 void import('snarkjs').catch(()=>{});
 for(const url of Object.values(epochCircuitUrls(circuit,status.proving,origin)))void loadProvingFile(url,'low').catch(()=>{});
}

// snarkjs races when two first proofs build its process-wide curve at once, so every prover shares one queue.
let queue:Promise<unknown>=Promise.resolve();
/** snarkjs keeps a worker thread per CPU alive; in Node, call this after the last proof so the process can exit. */
export const releaseProver=async()=>{await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();};
export function snarkjsProver({status,origin='',joinReady}:{status:()=>RollupPoolStatus;origin?:string;joinReady?:{get():boolean;set():void}}):ShieldedProver{
 let joined=false;
 const ready=joinReady??{get:()=>joined,set:()=>{joined=true;}};
 return {
  // A flag store that throws (storage disabled or full) only means "not ready yet"; it must never fail a payment or discard a proof.
  joinReady:()=>{try{return ready.get();}catch{return false;}},
  prove(built:EpochBuiltSpend){
   const next=queue.then(async()=>{
    const proving=status().proving;
    if(!proving)throw new Error('The pool has not published its proving keys, so this wallet cannot prove yet.');
    const urls=epochProvingUrls(built,proving,origin);
    const [wasm,zkey]=await Promise.all([loadProvingFile(urls.wasm),loadProvingFile(urls.zkey)]);
    const {groth16}=await import('snarkjs'),{proof}=await groth16.fullProve(toCircuitInput(built.witness.input),wasm,zkey);
    if(built.witness.slot.nullifiers.length===2)try{ready.set();}catch{}
    return proof;
   });
   queue=next.then(()=>undefined,()=>undefined);
   return next as ReturnType<ShieldedProver['prove']>;
  },
 };
}
