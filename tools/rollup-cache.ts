import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,linkSync,mkdirSync,openSync,readdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {chainOnly} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import type {Hash} from '../packages/protocol/src/rollup/notes.ts';
import {epochNfArchivePath,readEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';

const read=(dir:string,index:number)=>JSON.parse(readFileSync(join(dir,'batches',`${index}.json`),'utf8')) as RollupEpochRecord;
export function cachedBatchNumbers(dir:string):number[]{
 const numbers=readdirSync(join(dir,'batches')).filter(name=>/^(0|[1-9]\d*)\.json$/.test(name)).map(name=>Number(name.slice(0,-5))).sort((a,b)=>a-b);
 if(numbers.some((n,i)=>n!==i))throw new Error('The mirrored batch records have a gap.');
 return numbers;
}
/** A chain-only epoch record the pool served is final; only a placeholder the mirror's own chain walk wrote, which no pool stamps with `at`, can still be filled in. */
const placeholder=(r:RollupEpochRecord)=>r.at===undefined&&chainOnly(r);
export function epochMirrorStart(dir:string):number{
 const numbers=cachedBatchNumbers(dir);
 return numbers.find(index=>placeholder(read(dir,index)))??numbers.length;
}
/** The mirrored records replayed from chain data alone: the only source of the archive roots the mirror checks against. */
export function replayEpochMirror(dir:string,hash:Hash,epochLen:number):EpochState{
 const state=EpochState.genesis(hash,epochLen,false);
 for(const index of cachedBatchNumbers(dir)){const r=read(dir,index);state.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));}
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
export function cacheBatch(dir:string,index:number,record:RollupEpochRecord):void{
 const numbers=cachedBatchNumbers(dir),path=join(dir,'batches',`${index}.json`);
 if(!Number.isSafeInteger(index)||index<0||index>numbers.length)throw new Error('A cached batch would create a gap.');
 let oldBytes:string|undefined;
 if(existsSync(path)){
  oldBytes=readFileSync(path,'utf8');const old=JSON.parse(oldBytes) as RollupEpochRecord;
  // The chain walk's placeholder gives way to the pool's own chain-only record, which differs from it only by `at`.
  const adopt=placeholder(old)&&!placeholder(record);
  if(isDeepStrictEqual({...old,at:undefined},{...record,at:undefined})&&!adopt)return;
  const matches=!!old.txid&&old.txid===record.txid&&old.kind===record.kind&&isDeepStrictEqual(old.slots.map(s=>[s.nullifiers,s.publics]),record.slots.map(s=>[s.nullifiers,s.publics]));
  if(matches&&!chainOnly(old)&&chainOnly(record))return;
  if(!matches||!(chainOnly(old)&&!chainOnly(record)||adopt))throw new Error(`Cached batch ${index} conflicts with an existing record.`);
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
