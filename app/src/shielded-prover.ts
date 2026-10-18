import * as snarkjs from 'snarkjs';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import type {BuiltSpend} from '../../packages/protocol/src/rollup/account.ts';
import {circuitUrls,provingUrls,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import type {ShieldedProver} from '../../src/shielded/wallet.ts';

export const JOIN_READY='shielded-rollup-join-ready-v1';
const files=new Map<string,Promise<Uint8Array>>();
const cooldowns=new Map<string,number>();
const cooldownError=(url:string,until:number)=>new Error(`The proving file ${url} is temporarily unavailable. Retry in ${Math.ceil((until-Date.now())/1000)} seconds.`);
export function loadProvingFile(url:string,priority:RequestPriority='auto'):Promise<Uint8Array>{
 const cached=files.get(url);if(cached)return cached;
 const cooldown=cooldowns.get(url);if(cooldown&&cooldown>Date.now())return Promise.reject(cooldownError(url,cooldown));
 cooldowns.delete(url);
 const loading=(async()=>{
  for(let attempt=0;;attempt++){
   let response:Response|undefined,failure:unknown;
   try{response=await fetch(url,{priority});if(response.ok)return new Uint8Array(await response.arrayBuffer());}
   catch(error){failure=error;}
   if(response&&!response.ok){
    failure=new Error(`The proving file ${url} answered HTTP ${response.status}.`);
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
export function prefetchProvingKeys(status:RollupPoolStatus,circuit:'spend'|'join'='spend'){
 if(!status.proving)return;
 for(const url of Object.values(circuitUrls(circuit,status.proving)))void loadProvingFile(url,'low').catch(()=>{});
}

// snarkjs races when two first proofs build its curve at once, so proofs queue.
export function browserProver(status:()=>RollupPoolStatus):ShieldedProver{
 let queue:Promise<unknown>=Promise.resolve();
 return {
  joinReady:()=>localStorage.getItem(JOIN_READY)==='1',
  prove(built:BuiltSpend){
   const next=queue.then(async()=>{
    const urls=provingUrls(built,status().proving!);
    const [wasm,zkey]=await Promise.all([loadProvingFile(urls.wasm),loadProvingFile(urls.zkey)]);
    const {proof}=await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),wasm,zkey);
    if(built.witness.slot.nullifiers.length===2)localStorage.setItem(JOIN_READY,'1');
    return proof;
   });
   queue=next.then(()=>undefined,()=>undefined);
   return next as ReturnType<ShieldedProver['prove']>;
  },
 };
}
