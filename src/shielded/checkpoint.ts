import {RollupAccount} from '../../packages/protocol/src/rollup/account.ts';
import {CHECKPOINT_EVERY} from '../../packages/protocol/src/rollup/constants.ts';
import type {FrontierCheckpoint} from '../../packages/protocol/src/rollup/frontier.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import type {PoolApi,RollupPoolStatus} from './pool.ts';
import {catchUp} from './sync.ts';

/** Caught up, an account must have the pool's committed root; a batch landing in between gets another try. */
export async function matchesPool(account:RollupAccount,api:PoolApi,tries=3):Promise<boolean>{
 for(let i=0;i<tries;i++){
  await catchUp(account,api);
  const pool=(await api<RollupPoolStatus>('/status')).pool;
  if(pool?.batches===account.batchCount)return BigInt(pool.root)===account.latestRoot();
 }
 return false;
}

/**
 * A frontier account for keys that hold nothing before `bornAt`, started from the pool's checkpoint at or before it so it
 * never hashes the history. With no checkpoint, or one the pool's root refutes, it starts from genesis instead.
 */
export async function freshAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},bornAt:number,api:PoolApi):Promise<RollupAccount>{
 const blocks=Math.floor(bornAt/CHECKPOINT_EVERY)*CHECKPOINT_EVERY;
 if(blocks>0)try{
  const checkpoint=await api<FrontierCheckpoint>(`/checkpoints/${blocks}`);
  const account=checkpoint.blocks===blocks?RollupAccount.atCheckpoint(hash,keys,checkpoint,bornAt):undefined;
  if(account&&await matchesPool(account,api))return account;
 }catch{/* an older pool, or a checkpoint that does not parse: the replay below is always right */}
 return RollupAccount.owning(hash,keys,{frontier:true,bornAt});
}
