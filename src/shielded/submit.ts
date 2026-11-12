import type {Identity} from '@arkade-os/sdk';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {epochTransferBody,type EpochSpendBody} from './epoch-pool.ts';
import {PRIVATE_SIGN_POLL_MS,PRIVATE_SPEND_POLL_MS} from './network-privacy.ts';
import {checkSigningRequest,signDeposit,waitForSpend,type PoolApi,type SpendStatus} from './pool.ts';
import type {ShieldedProver} from './wallet.ts';

export type TransferExtra=NonNullable<Parameters<typeof epochTransferBody>[3]>;
export interface SubmitMember {built:EpochBuiltSpend;extra?:TransferExtra;coin?:{txid:string;vout:number}}
export interface SubmitDeps {api:PoolApi;prover:ShieldedProver;identity:Identity;poolScript:string;jitterMs?:number;landedBy?:(nullifiers:readonly bigint[])=>Promise<SpendStatus|undefined>}
export const randomSubmissionId=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');

/** Proves every member, submits them in the order the group id commits to, and waits for all; only a coin's member signs. */
export async function submitAll(members:SubmitMember[],o:SubmitDeps&{step:(n:number)=>void;first:number;deadlineMs?:number}):Promise<SpendStatus>{
 o.step(o.first);
 const proofs=[];for(const m of members)proofs.push(await o.prover.prove(m.built,m.built.witness.slot.nullifiers.length===2?'join':'spend'));
 o.step(o.first+1);
 if(o.jitterMs){const ms=Math.floor(Math.random()*o.jitterMs);await new Promise(resolve=>setTimeout(resolve,ms));}
 const ids:string[]=[];
 for(const [i,m] of members.entries()){const id=randomSubmissionId(),body:EpochSpendBody=epochTransferBody(id,m.built,proofs[i]!,m.extra);await o.api('/spends',body);ids.push(id);}
 o.step(o.first+2);
 const finals=await Promise.all(ids.map((id,i)=>{
  // A deposit's slot spends a dummy nullifier that no batch records against us, and its signing round needs the id anyway.
  const nullifiers=members[i]!.built.witness.slot.nullifiers,deposit=!!members[i]!.coin,priv=o.landedBy!==undefined;
  const landed=priv&&!deposit?()=>o.landedBy!(nullifiers):undefined;
  return waitForSpend(id,async request=>{
   const coin=members[i]!.coin;if(!coin)throw new Error('The pool asked to sign a spend with no deposit coin.');
   checkSigningRequest(request,coin,o.poolScript,members[i]!.built.witness.publicSignals[0]!);o.step(o.first+3);
   await o.api(`/spends/${id}/sign`,await signDeposit(o.identity,request));
  },o.api,!priv?1000:deposit?PRIVATE_SIGN_POLL_MS:PRIVATE_SPEND_POLL_MS,o.deadlineMs??Infinity,landed,priv);
 }));
 return finals.find(f=>f.status==='dropped')??finals[0]!;
}
