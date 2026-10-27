import {encodeDisclosure,incomingNotes,type DisclosedNote} from '../../packages/protocol/src/rollup/disclosure.ts';
import type {EpochHistoryEntry} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {RollupEpochRecord} from '../../packages/protocol/src/rollup/epoch-record.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import type {SentRecord} from './repository.ts';

/** /verify reads an index as a place in the /batches stream, batch*32 + 2*slot + output, and a leaf index starts over at every rotation, so a received note is named by its batch and its place in that batch's block. */
export function epochRevealLinkOf(origin:string,e:EpochHistoryEntry,o:{self:string;sentOf:(nullifier:bigint)=>SentRecord|undefined}):string|undefined{
 if(e.kind!=='send'&&e.kind!=='receive'&&e.kind!=='shield')return undefined;
 let to=o.self,notes:DisclosedNote[];
 if(e.kind==='send'){
  const parts=e.slots.map((slot,i)=>({sent:o.sentOf(e.spent[i]!),index:e.batch*32+2*slot})).filter(p=>p.sent?.note);
  if(!parts.length)return undefined;
  to=parts[0]!.sent!.to;
  notes=parts.map(({sent,index})=>({index,amount:BigInt(sent!.note!.amount),asset:BigInt(sent!.note!.asset),rho:BigInt(sent!.note!.rho)}));
 }else notes=e.created.map(n=>({index:e.batch*32+n.index%32,amount:n.amount,asset:n.asset,rho:n.rho}));
 return notes.length?`${origin}/verify#${encodeDisclosure({v:1,to,notes})}`:undefined;
}

export const epochIncomingNotes=(hash:Hash,batches:readonly RollupEpochRecord[],key:Parameters<typeof incomingNotes>[2],first=0)=>incomingNotes(hash,batches,key,first);
