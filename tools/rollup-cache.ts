import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
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
 return numbers.find(index=>read(dir,index).noteBlockRoot!==undefined)??numbers.length;
}
export function cacheBatch(dir:string,index:number,record:PublishedBatch):void{
 const numbers=cachedBatchNumbers(dir),path=join(dir,'batches',`${index}.json`);
 if(!Number.isSafeInteger(index)||index<0||index>numbers.length)throw new Error('A cached batch would create a gap.');
 if(existsSync(path)){
  const old=read(dir,index);if(isDeepStrictEqual({...old,at:undefined},{...record,at:undefined}))return;
  const matches=!!old.txid&&old.txid===record.txid&&old.kind===record.kind&&isDeepStrictEqual(old.slots.map(s=>[s.nullifiers,s.publics]),record.slots.map(s=>[s.nullifiers,s.publics]));
  if(matches&&old.noteBlockRoot===undefined&&record.noteBlockRoot!==undefined)return;
  if(!matches||old.noteBlockRoot===undefined||record.noteBlockRoot!==undefined)throw new Error(`Cached batch ${index} conflicts with an existing record.`);
 }
 writeFileSync(path,JSON.stringify(record),{flag:index===numbers.length?'wx':'w'});
}
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
