import type { EpochBatchKind } from './constants.ts';
import type { EpochSlot } from './epoch.ts';

export interface RollupEpochRecordSlot {anchor:string;rCur?:{epoch:number;root:string};origin?:number;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[];ciphertext?:string}
/** One accepted batch as published; the block root is always kept, so a replay never needs an archived nullifier set. */
export interface RollupEpochRecord {kind:EpochBatchKind;slots:RollupEpochRecordSlot[];noteBlockRoot:string;txid?:string;at?:number}

/** A slot in the string form records, the spend store and /external share; slotOf reads it back. A recovery keeps origin alone, so /external takes back every record. */
export const recordSlotOf=(slot:EpochSlot)=>({anchor:String(slot.anchor),...(slot.rCur&&slot.origin===undefined?{rCur:{epoch:slot.rCur.epoch,root:String(slot.rCur.root)}}:{}),...(slot.origin!==undefined?{origin:slot.origin}:{}),
 nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])] as [string,string],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize});
