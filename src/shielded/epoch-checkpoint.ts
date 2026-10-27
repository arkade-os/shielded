import {EpochAccount,type EpochAccountSnapshot} from '../../packages/protocol/src/rollup/epoch-account.ts';
import {CHECKPOINT_EVERY,NOTE_DEPTH,SUBTREE_DEPTH} from '../../packages/protocol/src/rollup/constants.ts';
import type {FrontierCheckpoint} from '../../packages/protocol/src/rollup/frontier.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import type {PoolApi,RollupPoolStatus} from './pool.ts';
import {epochCatchUp,type EpochOnBatch} from './epoch-sync.ts';

/** /times is indexed by global batch on an epoch pool too, so the classic answer stands. */
export async function epochBirthCheckpoint(api:PoolApi,createdAt:number):Promise<number>{
 const {every,at}=await api<{every:number;at:number[]}>('/times');
 let k=0;at.forEach((time,i)=>{if(time<=createdAt-86_400_000)k=i;});
 return k*every;
}
type Keys={ask:bigint;nk:bigint;viewSecret:Uint8Array};

export const epochPoolOf=async(api:PoolApi)=>{
 const pool=(await api<RollupPoolStatus>('/status')).pool;
 if(!pool?.epochLen)throw new Error('That pool is not an open epoch pool.');
 return {...pool,epochLen:pool.epochLen};
};

/** Caught up, an account must have the pool's accepted root. A previous-epoch root that contradicts the account's throws: a quiet replay would hide the drift. */
export async function epochMatchesPool(account:EpochAccount,api:PoolApi,tries=3,onBatch?:EpochOnBatch,watched?:()=>Iterable<bigint>):Promise<boolean>{
 for(let i=0;i<tries;i++){
  await epochCatchUp(account,api,onBatch,undefined,watched);
  const pool=(await api<RollupPoolStatus>('/status')).pool;
  if(pool?.batches!==account.batchCount)continue;
  const prev=account.prevNoteRoot();
  if(pool.prevNoteRoot!==undefined&&prev!==undefined&&BigInt(pool.prevNoteRoot)!==prev)throw Object.assign(new Error(`The pool says epoch ${account.epoch-1} closed on another root than this wallet holds; its saved state drifted across a rotation.`),{code:'root-drift'});
  return BigInt(pool.root)===account.latestRoot();
 }
 return false;
}

/**
 * An account for keys that hold nothing before `bornAt`. Born in the pool's current epoch at or past a checkpoint, it starts at the last one not
 * after its birthday, with the pool's previous-epoch root; otherwise it replays from the start of the epoch before its birthday, whose rotation teaches it that root.
 */
export async function epochFreshAccount(hash:Hash,keys:Keys,bornAt:number,api:PoolApi,onBatch?:EpochOnBatch,watched?:()=>Iterable<bigint>):Promise<EpochAccount>{
 const pool=await epochPoolOf(api),{epochLen}=pool,epoch=Math.floor(bornAt/epochLen),blocks=Math.floor((bornAt-epoch*epochLen)/CHECKPOINT_EVERY)*CHECKPOINT_EVERY;
 // pool.epoch is the last accepted batch's: at an epoch's end the count alone names the next epoch, whose checkpoint 404s.
 if(epoch===pool.epoch&&blocks>0&&pool.prevNoteRoot!==undefined)try{
  const checkpoint=await api<FrontierCheckpoint&{epoch:number}>(`/checkpoints/${epoch}/${blocks}`);
  const account=checkpoint.epoch===epoch&&checkpoint.blocks===blocks?EpochAccount.atCheckpoint(hash,keys,{epochLen,checkpoint,prevNoteRoot:BigInt(pool.prevNoteRoot),bornAt}):undefined;
  if(account&&await epochMatchesPool(account,api,undefined,onBatch,watched))return account;
 }catch{/* the checkpoint start is only a shortcut, so any failure confirming it (a 404, a checkpoint that does not parse, a 429, an onBatch that threw) falls back instead of rejecting: the replay start below needs none of it and is always right */}
 const start=Math.max(epoch-1,0);
 return start?EpochAccount.atCheckpoint(hash,keys,{epochLen,checkpoint:{epoch:start,blocks:0,filled:Array<string>(NOTE_DEPTH-SUBTREE_DEPTH).fill('0')},bornAt}):EpochAccount.owning(hash,keys,{epochLen,bornAt});
}

/** Resumes a v2 snapshot the pool agrees with. One it refuses, or whose root it refutes, gives way to a fresh account and the reason; a contradicting prevNoteRoot throws. */
export async function loadEpochAccount(hash:Hash,keys:Keys,o:{snapshot?:EpochAccountSnapshot;bornAt:number;api:PoolApi;onBatch?:EpochOnBatch;watched?:()=>Iterable<bigint>}):Promise<{account:EpochAccount;resumed:boolean;error?:string}>{
 const fresh=async(error?:string)=>({account:await epochFreshAccount(hash,keys,o.bornAt,o.api,o.onBatch,o.watched),resumed:false,...(error?{error}:{})});
 if(!o.snapshot)return fresh();
 let account:EpochAccount;
 try{account=EpochAccount.fromSnapshot(hash,keys,o.snapshot,(await epochPoolOf(o.api)).epochLen);}
 catch(error){return fresh(error instanceof Error?error.message:String(error));}
 return await epochMatchesPool(account,o.api,undefined,o.onBatch,o.watched)?{account,resumed:true}:fresh('The saved wallet does not match the pool; syncing from the pool.');
}
