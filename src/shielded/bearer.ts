import {hex} from '@scure/base';
import {randomField} from '../../packages/protocol/src/rollup/account.ts';
import type {ClaimToken} from '../../packages/protocol/src/rollup/bearer.ts';
import {ROLLUP_DOMAIN} from '../../packages/protocol/src/rollup/constants.ts';
import type {EpochHistoryEntry} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {akOf,groupIdOf,noteOf,nullifierOf,ownerOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {openRollupNotes,rollupRecipientOf,type RollupNote,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,bearerSecretOf,deriveRollupKeys2} from '../../packages/protocol/src/wallet-keys.ts';
import type {RollupEpochRecord} from '../rollup/epoch-operator.ts';
import {epochFreshAccount} from './epoch-checkpoint.ts';
import {epochCatchUp} from './epoch-sync.ts';
import type {PoolApi} from './pool.ts';

/** A link as its minter tracks it: `open` holds the bearer notes' nullifiers not yet seen spent. */
export interface LinkRecord {key:string;batch:number;asset:string;amount:string;nullifiers:string[];open:string[];tookBack?:boolean}
export const bearerOf=(master:Uint8Array,nullifier:bigint)=>bearerSecretOf(master,MUTINYNET_KEY_NETWORK,nullifier);
export const bearerKeysOf=(secret:Uint8Array)=>deriveRollupKeys2(secret,MUTINYNET_KEY_NETWORK);

/** A send whose payment outputs open under the key its first input derives is a link this wallet minted. */
export async function linkOf(hash:Hash,master:Uint8Array,entry:EpochHistoryEntry,batch:RollupEpochRecord):Promise<LinkRecord|undefined>{
 // pay() derives the key from its first chosen note, and history keeps slot and nullifier order, so that is spent[0].
 const first=entry.spent[0];
 if(entry.kind!=='send'||first===undefined)return undefined;
 const keys=bearerKeysOf(bearerOf(master,first)),owner=ownerOf(hash,ROLLUP_DOMAIN,akOf(hash,keys.ask),keys.nk),notes:RollupNote[]=[];
 for(const index of entry.slots){
  const slot=batch.slots[index];
  if(!slot?.ciphertext)continue;
  const [note]=await openRollupNotes(hex.decode(slot.ciphertext),keys.viewSecret);
  if(note&&note.amount>0n&&String(noteOf(hash,ROLLUP_DOMAIN,note.amount,note.asset,owner,note.rho))===slot.commitments[0])notes.push(note);
 }
 if(!notes.length)return undefined;
 const nullifiers=notes.map(n=>String(nullifierOf(hash,ROLLUP_DOMAIN,keys.nk,n.rho)));
 return {key:String(first),batch:entry.batch,asset:String(notes[0]!.asset),amount:String(notes.reduce((sum,n)=>sum+n.amount,0n)),nullifiers,open:[...nullifiers]};
}

/** The bearer key's account, caught up from the checkpoint before its mint batch, and the notes it holds in `assets`. */
export async function bearerAccount(hash:Hash,token:ClaimToken,api:PoolApi,assets:readonly bigint[]){
 const keys=bearerKeysOf(token.secret),account=await epochFreshAccount(hash,keys,token.batch,api);
 await epochCatchUp(account,api);
 return {account,self:rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret),notes:assets.flatMap(asset=>account.notes(asset))};
}

/** One spend per note, each paying the whole note to `to`. A mint makes at most three, sent as one group, so a racing claimer gets all or nothing. */
export async function claimSpends(hash:Hash,link:Awaited<ReturnType<typeof bearerAccount>>,to:RollupRecipient):Promise<EpochBuiltSpend[]>{
 const spends:EpochBuiltSpend[]=[];
 for(let i=0;i<link.notes.length;i+=3){
  const run=link.notes.slice(i,i+3),group=run.length>1?{id:groupIdOf(hash,run.map(n=>n.nullifier)),size:run.length}:undefined;
  for(const note of run)spends.push(await link.account.spend({asset:note.asset,input:note,to:{recipient:to,amount:note.amount}},link.self,randomField,group));
 }
 return spends;
}
