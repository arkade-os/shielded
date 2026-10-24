import type {EpochAccount} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import type {EpochBatchPage} from './epoch-sync.ts';
import {poolApiOf,transferBody,type Groth16Proof,type PoolApi,type RollupPoolStatus} from './pool.ts';

/** The epoch pool's POST /spends body: slot.anchor where a classic slot has root, and exactly one of rCur (fast path) and origin (recovery). */
export function epochTransferBody(id:string,built:EpochBuiltSpend,proof:Groth16Proof,extra:Parameters<typeof transferBody>[3]={}){
 const s=built.slot;
 if((s.rCur===undefined)===(s.origin===undefined))throw new Error('An epoch slot names exactly one of rCur and origin.');
 const {slot:_,...body}=transferBody(id,built,proof,extra);
 return {...body,slot:{anchor:String(s.anchor),...(s.rCur?{rCur:{epoch:s.rCur.epoch,root:String(s.rCur.root)}}:{origin:s.origin!}),
  nullifiers:s.nullifiers.map(String),commitments:s.commitments.map(String),ctDigest:String(s.ctDigest),groupId:String(s.groupId),groupSize:s.groupSize}};
}
export type EpochSpendBody=ReturnType<typeof epochTransferBody>;

/** /status.proving keeps the logical names spend and join, but an epoch pool serves only the epoch-* files. */
export function epochCircuitUrls(circuit:'spend'|'join',proving:NonNullable<RollupPoolStatus['proving']>,origin=''){
 const keys=proving[circuit],file=`epoch-${circuit}`;
 return {wasm:`${origin}/api/rollup/proving/${file}.wasm?v=${keys.wasm}`,zkey:`${origin}/api/rollup/proving/${file}.zkey?v=${keys.zkey}`};
}
export const epochProvingUrls=(built:EpochBuiltSpend,proving:NonNullable<RollupPoolStatus['proving']>,origin='')=>epochCircuitUrls(built.slot.nullifiers.length===2?'join':'spend',proving,origin);

/** syncAccount on an epoch pool: every batch, whole, from the account's own count. */
export async function epochSyncAccount(account:EpochAccount,api:PoolApi=poolApiOf('')){
 for(;;){
  const page=await api<EpochBatchPage>(`/batches?from=${account.batchCount}&limit=50`);
  for(const batch of page.batches)await account.apply(batch);
  if(account.batchCount>=page.total||!page.batches.length)return;
 }
}
