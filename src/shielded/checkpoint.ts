import {RollupAccount} from '../../packages/protocol/src/rollup/account.ts';
import {CHECKPOINT_EVERY} from '../../packages/protocol/src/rollup/constants.ts';
import type {FrontierCheckpoint} from '../../packages/protocol/src/rollup/frontier.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import type {PoolApi,RollupPoolStatus} from './pool.ts';
import {catchUp,type OnBatch} from './sync.ts';

/** Caught up, an account must have the pool's committed root; a batch landing in between gets another try. */
export async function matchesPool(account:RollupAccount,api:PoolApi,tries=3,onBatch?:OnBatch,watched?:()=>Iterable<bigint>):Promise<boolean>{
 for(let i=0;i<tries;i++){
  await catchUp(account,api,onBatch,undefined,watched);
  const pool=(await api<RollupPoolStatus>('/status')).pool;
  if(pool?.batches===account.batchCount)return BigInt(pool.root)===account.latestRoot();
 }
 return false;
}

/**
 * A frontier account for keys that hold nothing before `bornAt`, started from the pool's checkpoint at or before it so it
 * never hashes the history. With no checkpoint, or one the pool's root refutes, it starts from genesis instead.
 */
export async function freshAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},bornAt:number,api:PoolApi,onBatch?:OnBatch,watched?:()=>Iterable<bigint>):Promise<RollupAccount>{
 const blocks=Math.floor(bornAt/CHECKPOINT_EVERY)*CHECKPOINT_EVERY;
 if(blocks>0)try{
  const checkpoint=await api<FrontierCheckpoint>(`/checkpoints/${blocks}`);
  const account=checkpoint.blocks===blocks?RollupAccount.atCheckpoint(hash,keys,checkpoint,bornAt):undefined;
  if(account&&await matchesPool(account,api,undefined,onBatch,watched))return account;
 }catch{/* an older pool, or a checkpoint that does not parse: the replay below is always right */}
 return RollupAccount.owning(hash,keys,{frontier:true,bornAt});
}

/** The batch a restore starts at for a wallet made on or after `createdAt`, a day early; picked from every checkpoint's time so the pool never learns the date. */
export async function birthCheckpoint(api:PoolApi,createdAt:number):Promise<number>{
 const {every,at}=await api<{every:number;at:number[]}>('/times');
 let k=0;at.forEach((time,i)=>{if(time<=createdAt-86_400_000)k=i;});
 return k*every;
}
