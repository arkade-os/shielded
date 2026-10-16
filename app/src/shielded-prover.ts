import * as snarkjs from 'snarkjs';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import type {BuiltSpend} from '../../packages/protocol/src/rollup/account.ts';
import {circuitUrls,provingUrls,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import type {ShieldedProver} from '../../src/shielded/wallet.ts';

export const JOIN_READY='shielded-rollup-join-ready-v1';
const fetched=new Set<string>();
/** Warms the HTTP cache with a circuit's keys (immutable, about 13 MB) while the user is still typing, once per page. */
export function prefetchProvingKeys(status:RollupPoolStatus,circuit:'spend'|'join'='spend'){
 if(!status.proving)return;
 for(const url of Object.values(circuitUrls(circuit,status.proving)))if(!fetched.has(url)){fetched.add(url);void fetch(url,{priority:'low'} as RequestInit).then(r=>r.arrayBuffer()).catch(()=>fetched.delete(url));}
}

// snarkjs races when two first proofs build its curve at once, so proofs queue.
export function browserProver(status:()=>RollupPoolStatus):ShieldedProver{
 let queue:Promise<unknown>=Promise.resolve();
 return {
  joinReady:()=>localStorage.getItem(JOIN_READY)==='1',
  prove(built:BuiltSpend){
   const next=queue.then(async()=>{
    const urls=provingUrls(built,status().proving!);
    const {proof}=await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),urls.wasm,urls.zkey,undefined,undefined,{singleThread:true});
    if(built.witness.slot.nullifiers.length===2)localStorage.setItem(JOIN_READY,'1');
    return proof;
   });
   queue=next.then(()=>undefined,()=>undefined);
   return next as ReturnType<ShieldedProver['prove']>;
  },
 };
}
