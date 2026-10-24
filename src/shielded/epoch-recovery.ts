import {randomField} from '../../packages/protocol/src/rollup/account.ts';
import type {EpochAccount,EpochAnchorPlan,EpochOwnedNote} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {groupIdOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import type {RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import type {PoolApi} from './pool.ts';

/** EpochAccount.spendable's complement: from the batch that archives the note's epoch, only a recovery reaches it. */
export const needsRecovery=(note:EpochOwnedNote,plan:EpochAnchorPlan)=>note.epoch<plan.liveEpoch-1;
export const RECOVERY_LINE='Recovering an older note';

/** Advisory only: a warning to show, never a gate on building the recovery. The pool keeps its previous epoch's set in memory, so an unlisted file is no refusal. */
export async function archivesHeld(api:PoolApi,origin:number):Promise<'held'|'partial'|'unknown'>{
 const epochs=await api<{epochs?:unknown}|null>('/archives').then(r=>r?.epochs,()=>undefined);
 if(!Array.isArray(epochs))return 'unknown';
 return [origin,origin+1].every(e=>epochs.includes(e))?'held':'partial';
}

/** claimSpends on an epoch pool: a bearer note still on the fast path is claimed in groups as before; one past it is recovered to `to` alone, as a recover batch is one slot and takes no group, so past the window a multi-note claim is not all-or-nothing. */
export async function claimRecovery(hash:Hash,link:{account:EpochAccount;self:RollupRecipient;notes:EpochOwnedNote[]},to:RollupRecipient):Promise<EpochBuiltSpend[]>{
 if(!link.notes.length)return [];
 const plan=link.account.anchorPlan(),late=link.notes.filter(n=>needsRecovery(n,plan)),live=link.notes.filter(n=>!late.includes(n)),spends:EpochBuiltSpend[]=[];
 for(let i=0;i<live.length;i+=3){
  const run=live.slice(i,i+3),group=run.length>1?{id:groupIdOf(hash,run.map(n=>n.nullifier)),size:run.length}:undefined;
  for(const note of run)spends.push(await link.account.spend({asset:note.asset,input:note,to:{recipient:to,amount:note.amount}},link.self,randomField,group));
 }
 for(const note of late)spends.push(await link.account.recover(note,to));
 return spends;
}
