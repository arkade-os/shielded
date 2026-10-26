import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,linkSync,mkdirSync,openSync,readdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Transaction} from '@arkade-os/sdk';
import type {PublishedBatch,RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {chainOnly} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import type {Hash} from '../packages/protocol/src/rollup/notes.ts';
import type {RollupLeaves} from '../src/rollup/covenant.ts';
import {epochNfArchivePath,readEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';
import {catchUpFromChain} from '../src/rollup/external.ts';

const read=(dir:string,index:number)=>JSON.parse(readFileSync(join(dir,'batches',`${index}.json`),'utf8')) as PublishedBatch;
const readEpoch=(dir:string,index:number)=>read(dir,index) as unknown as RollupEpochRecord;
export function cachedBatchNumbers(dir:string):number[]{
 const numbers=readdirSync(join(dir,'batches')).filter(name=>/^(0|[1-9]\d*)\.json$/.test(name)).map(name=>Number(name.slice(0,-5))).sort((a,b)=>a-b);
 if(numbers.some((n,i)=>n!==i))throw new Error('The mirrored batch records have a gap.');
 return numbers;
}
export function mirrorStart(dir:string):number{
 const numbers=cachedBatchNumbers(dir);
 // Chain-only records carry noteBlockRoot; the current API's full records omit it.
 return numbers.find(index=>read(dir,index).noteBlockRoot!==undefined)??numbers.length;
}
/** A chain-only epoch record the pool served is final; only a placeholder the mirror's own chain walk wrote, which no pool stamps with `at`, can still be filled in. */
const placeholder=(r:RollupEpochRecord)=>r.at===undefined&&chainOnly(r);
export function epochMirrorStart(dir:string):number{
 const numbers=cachedBatchNumbers(dir);
 return numbers.find(index=>placeholder(readEpoch(dir,index)))??numbers.length;
}
/** The mirrored records replayed from chain data alone: the only source of the archive roots the mirror checks against. */
export function replayEpochMirror(dir:string,hash:Hash,epochLen:number):EpochState{
 const state=EpochState.genesis(hash,epochLen,false);
 for(const index of cachedBatchNumbers(dir)){const r=readEpoch(dir,index);state.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));}
 return state;
}
/** Writes an epoch's nullifier archive only once it rebuilds the root `state` archived for that epoch, never a root the pool asserts. */
export function cacheEpochArchive(dir:string,state:EpochState,epoch:number,bytes:Uint8Array,hash:Hash):void{
 const folder=join(dir,'nullifiers');mkdirSync(folder,{recursive:true});
 // Until epoch e's own ER leaf exists, its root is the previous leaf's nfNextFinal.
 const root=state.archive.record(epoch)?.nfFinal??state.archive.record(epoch-1)?.nfNextFinal;
 if(root===undefined)throw new Error(`The mirrored records have not closed epoch ${epoch}.`);
 const path=epochNfArchivePath(folder,epoch),temporary=`${path}.${randomUUID()}.tmp`,descriptor=openSync(temporary,'wx');
 try{
  try{writeFileSync(descriptor,bytes);fsyncSync(descriptor);}finally{closeSync(descriptor);}
  readEpochNfArchive(temporary,hash,{epoch,root});
  renameSync(temporary,path);
 }finally{if(existsSync(temporary))unlinkSync(temporary);}
}
export function cacheBatch(dir:string,index:number,record:PublishedBatch):void{
 const numbers=cachedBatchNumbers(dir),path=join(dir,'batches',`${index}.json`);
 if(!Number.isSafeInteger(index)||index<0||index>numbers.length)throw new Error('A cached batch would create a gap.');
 let oldBytes:string|undefined;
 if(existsSync(path)){
  oldBytes=readFileSync(path,'utf8');const old=JSON.parse(oldBytes) as PublishedBatch;
  // Classic full records omit noteBlockRoot, so a classic chain-only record is one that has it.
  const epoch='anchor' in (old.slots[0]??{}),bare=(r:PublishedBatch)=>epoch?chainOnly(r as unknown as RollupEpochRecord):r.noteBlockRoot!==undefined;
  // The chain walk's placeholder gives way to the pool's own chain-only record, which differs from it only by `at`.
  const adopt=epoch&&placeholder(old as unknown as RollupEpochRecord)&&!placeholder(record as unknown as RollupEpochRecord);
  if(isDeepStrictEqual({...old,at:undefined},{...record,at:undefined})&&!adopt)return;
  const matches=!!old.txid&&old.txid===record.txid&&old.kind===record.kind&&isDeepStrictEqual(old.slots.map(s=>[s.nullifiers,s.publics]),record.slots.map(s=>[s.nullifiers,s.publics]));
  if(matches&&!bare(old)&&bare(record))return;
  if(!matches||!(bare(old)&&!bare(record)||adopt))throw new Error(`Cached batch ${index} conflicts with an existing record.`);
 }
 const bytes=JSON.stringify(record),temporary=`${path}.${randomUUID()}.tmp`;
 let descriptor:number|undefined=openSync(temporary,'wx');
 try{
  writeFileSync(descriptor,bytes);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
  if(index===numbers.length)linkSync(temporary,path);
  else{
   if(readFileSync(path,'utf8')!==oldBytes)throw new Error(`Cached batch ${index} conflicts with an existing record.`);
   renameSync(temporary,path);
  }
 }finally{
  if(descriptor!==undefined)closeSync(descriptor);
  if(existsSync(temporary))unlinkSync(temporary);
 }
 // Node cannot open directory descriptors on Windows.
 if(process.platform!=='win32'){
  const directory=openSync(join(dir,'batches'),'r');
  try{fsyncSync(directory);}finally{closeSync(directory);}
 }
}
// Discard the account on rejection; a failed walk may have advanced it.
export async function catchUpCachedBatches(dir:string,account:RollupAccount,leaves:RollupLeaves,fromTxid:string,target:bigint,nextBatchTx:(head:{txid:string;vout:number})=>Promise<Transaction|undefined>):Promise<number>{
 if(account.batchCount!==cachedBatchNumbers(dir).length)throw new Error('The account does not match its mirrored batch count.');
 const recovered:{index:number;record:PublishedBatch}[]=[];
 let txid:string|undefined;
 const count=await catchUpFromChain({state:account.state,apply:async batch=>{
  if(!txid)throw new Error('The recovered batch has no transaction id.');
  const index=account.batchCount,record={...batch,txid};
  await account.apply(record);recovered.push({index,record});
 }},leaves,fromTxid,target,async head=>{
  const tx=await nextBatchTx(head);txid=tx?.id;return tx;
 });
 for(const {index,record} of recovered)cacheBatch(dir,index,record);
 return count;
}
