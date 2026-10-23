import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {transferBody,type Groth16Proof,type RollupPoolStatus} from './pool.ts';

/** Plan 4b's epoch /spends body: slot.anchor where a classic slot has root, and exactly one of rCur (fast path) and origin (recovery). */
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
