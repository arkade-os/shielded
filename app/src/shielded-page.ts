import {TxType,type Activity,type PaymentHandle,type RouteQuote} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import type {ShieldedNoteRepository,SentRecord} from '../../src/shielded/repository.ts';
import {idle} from '../../src/shielded/sync.ts';
import type {ShieldedWallet} from '../../src/shielded/wallet.ts';
import {watchHandle,type StepState} from '../../src/shielded/handle.ts';

export const SECRET='shielded-rollup-wallet-secret-v1',SENT='shielded-rollup-sent-v1',BORN='shielded-rollup-wallet-born-v1';
type PageStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
export const errorText=(error:unknown)=>error instanceof Error?error.message:typeof error==='string'?error:'The action failed.';
export const activityReceived=(item:Activity)=>item.amount!==0?item.amount>0:item.txs.at(-1)?.type===TxType.TxReceived;

export function pageCache(source:ShieldedNoteRepository){
 let closed=false;
 const writes=new Set<Promise<void>>();
 const repository:ShieldedNoteRepository={
  version:source.version,getAccount:token=>source.getAccount(token),clear:()=>source.clear(),[Symbol.asyncDispose]:()=>source[Symbol.asyncDispose](),
  saveAccount(token,snapshot){
   if(closed)return Promise.reject(new Error('The wallet cache was closed for restoration.'));
   const write=Promise.resolve().then(()=>source.saveAccount(token,snapshot));writes.add(write);
   void write.then(()=>writes.delete(write),()=>writes.delete(write));return write;
  },
 };
 return {repository,close(){closed=true;},async drain(){await Promise.allSettled([...writes]);}};
}

export function openPageWallet<P,W extends {dispose():Promise<void>}>(prepare:()=>Promise<P>,create:(prepared:P)=>Promise<W>){
 let cancelled=false,wallet:W|undefined,disposal:Promise<void>|undefined,closing:Promise<W|undefined>|undefined;
 const dispose=()=>disposal??=wallet!.dispose();
 const ready=(async()=>{
  const prepared=await prepare();if(cancelled)return;
  wallet=await create(prepared);
  if(cancelled){await dispose();return;}
  return wallet;
 })();
 return {ready,active:()=>!cancelled,close(){
  cancelled=true;
  return closing??=(async()=>{await ready.catch(()=>{});if(wallet)await dispose();return wallet;})();
 }};
}

export async function importLegacySent(wallet:Pick<ShieldedWallet,'account'|'recordSent'|'save'|'repositoryError'>,storage:Pick<Storage,'getItem'|'removeItem'>,current:()=>boolean){
 const raw=storage.getItem(SENT);if(!raw)return;
 const stored=JSON.parse(raw) as Record<string,SentRecord|string>;
 const entries=Object.entries(stored).map(([nullifier,value]):[bigint,SentRecord]=>{
  const record=typeof value==='string'?{to:value}:value;
  if(!record||typeof record.to!=='string')throw new Error('The saved payment log could not be read.');
  return [BigInt(nullifier),record];
 });
 wallet.recordSent(entries);
 await idle(wallet.account,()=>wallet.save());
 if(!wallet.repositoryError&&current()&&storage.getItem(SENT)===raw)storage.removeItem(SENT);
}

export async function restorePageWallet(phrase:string,o:{cache:ReturnType<typeof pageCache>;storage:PageStorage;stop:()=>Promise<void>;reload:()=>void}){
 const parsed=bytesToHex(parseMasterSecret(phrase));
 o.cache.close();await o.stop();await o.cache.drain();await o.cache.repository.clear();
 o.storage.setItem(SECRET,parsed);
 for(let i=o.storage.length-1;i>=0;i--){const key=o.storage.key(i);if(key?.startsWith(BORN))o.storage.removeItem(key);}
 o.storage.removeItem(SENT);o.reload();
}

export function pageSheet(render:(state:StepState|undefined)=>void){
 type Owner={current:()=>boolean;update:(change:(current:StepState)=>StepState)=>void;fail:(error:unknown)=>void};
 let generation=0,off=()=>{},state:StepState|undefined;
 const watched=new WeakMap<PaymentHandle,Owner>();
 function begin(title:string):Owner{
  off();off=()=>{};const mine=++generation;
  const update=(change:(current:StepState)=>StepState)=>{if(mine===generation){state=change(state??{title,steps:['Start','Done'],current:0});render(state);}};
  state=undefined;
  return {current:()=>mine===generation,update,fail:(error:unknown)=>update(s=>({...s,error:errorText(error)}))};
 }
 return {
  begin,
  watch(next:PaymentHandle,title:string){
   const previous=watched.get(next);if(previous)return previous;
   const selected=begin(title);watched.set(next,selected);
   off=watchHandle(next,title,s=>selected.update(()=>s));return selected;
  },
  clear(){generation++;off();off=()=>{};state=undefined;render(undefined);},
  stop(){generation++;off();off=()=>{};},
 };
}

type QuoteContext={wallet:object;revision:number;key:string};
export function pageQuotes(render:()=>void){
 let generation=0,selected:{context:QuoteContext;quote?:RouteQuote;error?:string}|undefined;
 const matches=(a:QuoteContext,b:QuoteContext)=>a.wallet===b.wallet&&a.revision===b.revision&&a.key===b.key;
 const clear=()=>{generation++;selected=undefined;};
 return {
  clear,
  read(context:QuoteContext):{quote?:RouteQuote;error?:string}{return selected&&matches(selected.context,context)?selected:{};},
  load(context:QuoteContext,route:()=>Promise<RouteQuote>){
   const mine=++generation;selected={context};
   void Promise.resolve().then(route).then(quote=>{if(mine===generation){selected={context,quote};render();}},error=>{if(mine===generation){selected={context,error:errorText(error)};render();}});
   return()=>{if(mine===generation)clear();};
  },
  async send(context:QuoteContext,quote:RouteQuote){
   if(!selected||!matches(selected.context,context)||selected.quote!==quote)throw new Error('The payment changed. Review its route again.');
   clear();return quote.send();
  },
 };
}

export async function renewPageCoins(renew:()=>Promise<string|undefined>,sheet:ReturnType<typeof pageSheet>){
 const owner=sheet.begin('Renewing your coins');
 owner.update(()=>({title:'Renewing your coins',steps:['Join the next batch swap','Renewed'],current:0}));
 try{const txid=await renew();owner.update(s=>({...s,current:1,done:true}));return txid;}
 catch(error){owner.fail(error);throw error;}
}
