import {BATCH_SLOTS} from '../../packages/protocol/src/rollup/constants.ts';
import type {BatchSlot} from '../../packages/protocol/src/rollup/state.ts';
import type {RollupCoin,RollupLeg,SnarkProof} from './covenant.ts';

export const RESERVE_DEPOSIT_INPUTS=8;
export const BATCH_WAIT_MS=10_000;

/** One slot as the operator receives it: the opening, its five public inputs, the client proof and boundary details. */
export interface RollupSpend {
 id:string;
 slot:BatchSlot;
 publics:readonly [bigint,bigint,bigint,bigint,bigint];
 proof:SnarkProof;
 receivedAt:number;
 asset?:string;
 program?:Uint8Array;
 coin?:RollupCoin&{assetAmount?:bigint};
 /** The sealed note record whose digest the slot's ctDigest commits to; padding has none. */
 ciphertext?:Uint8Array;
}
export interface RollupSelection {spends:RollupSpend[];asset?:string;legs:RollupLeg[]}

const legOf=(s:RollupSpend):RollupLeg=>({deposit:s.publics[1],withdraw:s.publics[2],asset:s.publics[3]!==0n,...(s.program?{program:s.program}:{})});

/** Units are single spends or complete groups, oldest first; a unit waits while its group is incomplete or its asset differs. */
function units(pending:readonly RollupSpend[]):RollupSpend[][] {
 const out:RollupSpend[][]=[],seen=new Set<bigint>();
 for(const spend of pending){
  const {groupId,groupSize}=spend.slot;
  if(groupId===0n){out.push([spend]);continue;}
  if(seen.has(groupId))continue;
  seen.add(groupId);
  const members=pending.filter(other=>other.slot.groupId===groupId);
  if(members.length===groupSize)out.push(members);
 }
 return out;
}

/** The next batch, or undefined while it should keep waiting. `padding` fills empty slots with operator zero spends. */
export function selectRollupBatch(pending:readonly RollupSpend[],now:number,padding:(count:number)=>RollupSpend[],maxCoins=BATCH_SLOTS):RollupSelection|undefined {
 if(!pending.length)return undefined;
 const chosen:RollupSpend[]=[];
 let asset:string|undefined,coins=0;
 for(const unit of units(pending)){
  const unitAsset=unit.find(s=>s.publics[3]!==0n)?.asset;
  if(unitAsset&&asset&&unitAsset!==asset)continue;
  const nextAsset=asset??unitAsset,nextCoins=coins+unit.filter(s=>s.coin).length;
  if(chosen.length+unit.length>BATCH_SLOTS||nextCoins>Math.min(maxCoins,nextAsset?RESERVE_DEPOSIT_INPUTS:BATCH_SLOTS))continue;
  chosen.push(...unit);asset=nextAsset;coins=nextCoins;
 }
 if(!chosen.length)return undefined;
 const oldest=Math.min(...pending.map(s=>s.receivedAt));
 if(chosen.length<BATCH_SLOTS&&now-oldest<BATCH_WAIT_MS)return undefined;
 const spends=[...chosen,...padding(BATCH_SLOTS-chosen.length)];
 return {spends,...(asset?{asset}:{}),legs:spends.map(legOf)};
}
