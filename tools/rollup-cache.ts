import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,linkSync,openSync,readdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Transaction} from '@arkade-os/sdk';
import type {PublishedBatch,RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import type {RollupLeaves} from '../src/rollup/covenant.ts';
import {catchUpFromChain} from '../src/rollup/external.ts';

const read=(dir:string,index:number)=>JSON.parse(readFileSync(join(dir,'batches',`${index}.json`),'utf8')) as PublishedBatch;
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
export function cacheBatch(dir:string,index:number,record:PublishedBatch):void{
 const numbers=cachedBatchNumbers(dir),path=join(dir,'batches',`${index}.json`);
 if(!Number.isSafeInteger(index)||index<0||index>numbers.length)throw new Error('A cached batch would create a gap.');
 let oldBytes:string|undefined;
 if(existsSync(path)){
  oldBytes=readFileSync(path,'utf8');const old=JSON.parse(oldBytes) as PublishedBatch;
  if(isDeepStrictEqual({...old,at:undefined},{...record,at:undefined}))return;
  const matches=!!old.txid&&old.txid===record.txid&&old.kind===record.kind&&isDeepStrictEqual(old.slots.map(s=>[s.nullifiers,s.publics]),record.slots.map(s=>[s.nullifiers,s.publics]));
  if(matches&&old.noteBlockRoot===undefined&&record.noteBlockRoot!==undefined)return;
  if(!matches||old.noteBlockRoot===undefined||record.noteBlockRoot!==undefined)throw new Error(`Cached batch ${index} conflicts with an existing record.`);
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
