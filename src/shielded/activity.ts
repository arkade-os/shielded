import {TxType,type Activity,type ActivityResolver,type ArkTransaction} from '@arkade-os/sdk';
import type {EpochHistoryEntry} from '../../packages/protocol/src/rollup/epoch-account.ts';

export const SHIELDED_TAG='shielded';
const SYNTHETIC={send:'shielded-send',receive:'shielded-receive',merge:'merge',withdraw:'unshield'} as const;
type SyntheticKind=keyof typeof SYNTHETIC;
const LABELS={'shielded-send':'Sent privately','shielded-receive':'Received',merge:'Merged notes','claim-link':'Claim link',shield:'Shielded',unshield:'Withdrawn from the pool',list:'Listed asset'} as const;
export interface ShieldedRowIndex {rows():ArkTransaction[];entryOf(tx:ArkTransaction):EpochHistoryEntry|undefined}

export function shieldedRows(entries:()=>readonly EpochHistoryEntry[],assetIdOf:(field:bigint)=>string|undefined,nativeDestination?:bigint):ShieldedRowIndex{
 const index=new WeakMap<ArkTransaction,EpochHistoryEntry>();
 return {
  rows(){
   // Only synthesize withdrawals known to be external; older snapshots may omit their destination.
   return entries().filter(e=>e.kind in SYNTHETIC&&(e.kind!=='withdraw'||nativeDestination!==undefined&&e.destination!==undefined&&e.destination!==nativeDestination)).map(e=>{
    const sats=e.amounts.filter(a=>a.asset===0n).reduce((sum,a)=>sum+a.amount,0n);
    const assets=e.amounts.flatMap(a=>{const assetId=a.asset===0n?undefined:assetIdOf(a.asset);return assetId?[{assetId,amount:a.amount}]:[];});
    const row:ArkTransaction={key:{boardingTxid:'',commitmentTxid:'',arkTxid:e.txid??''},type:e.kind==='receive'?TxType.TxReceived:TxType.TxSent,
     amount:Number(sats),settled:true,createdAt:e.at??0,tag:SHIELDED_TAG,...(assets.length?{assets}:{})};
    index.set(row,e);
    return row;
   });
  },
  entryOf(tx){return index.get(tx);},
 };
}

export function shieldedActivityResolver(o:{index:ShieldedRowIndex;entries:()=>readonly EpochHistoryEntry[];isPoolBatch:(txid:string)=>boolean;isListing:(txid:string)=>boolean;isLink?:(entry:EpochHistoryEntry)=>boolean}):ActivityResolver{
 return {
  id:SHIELDED_TAG,
  resolve(tx){
   const entry=o.index.entryOf(tx);
   if(entry){
    const kind=entry.kind==='send'&&o.isLink?.(entry)?'claim-link':SYNTHETIC[entry.kind as SyntheticKind];
    return [{groupId:`${SHIELDED_TAG}:${entry.batch}:${entry.slots.join('-')}`,label:LABELS[kind],kind,metadata:{batch:entry.batch,notes:entry.created.length,spent:entry.spent.length}}];
   }
   const txid=tx.key.arkTxid||tx.key.commitmentTxid;
   if(!txid)return undefined;
   if(o.isListing(txid))return [{groupId:`${SHIELDED_TAG}:list:${txid}`,label:LABELS.list,kind:'list',metadata:{txid}}];
   if(o.isPoolBatch(txid)){
    const kind=tx.type===TxType.TxSent?'shield':'unshield';
    const batch=o.entries().find(e=>e.txid===txid&&e.kind===(kind==='shield'?'shield':'withdraw'));
    return [{groupId:`${SHIELDED_TAG}:batch:${txid}:${kind}`,label:LABELS[kind],kind,metadata:{txid,...(batch?{batch:batch.batch}:{})}}];
   }
   return undefined;
  },
 };
}

export function entryForActivity(item:Activity,o:{index:ShieldedRowIndex;entries:readonly EpochHistoryEntry[]}):EpochHistoryEntry|undefined{
 for(const tx of item.txs){const entry=o.index.entryOf(tx);if(entry)return entry;}
 const batch=item.intent?.metadata?.batch,kind=item.intent?.kind;
 if(typeof batch!=='number'||kind!=='shield')return undefined;
 return o.entries.find(e=>e.batch===batch&&e.kind==='shield');
}
