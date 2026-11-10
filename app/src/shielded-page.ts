import {FetchError,isRetryableProviderError,TxType,type Activity,type PaymentHandle,type RouteQuote} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import type {ShieldedNoteRepository,SentRecord} from '../../src/shielded/repository.ts';
import {epochIdle} from '../../src/shielded/epoch-sync.ts';
import type {ShieldedWallet} from '../../src/shielded/wallet.ts';
import type {ArkCoin} from '../../src/shielded/pool.ts';
import {isShieldedHandle,watchHandle,type StepState} from '../../src/shielded/handle.ts';
import {pausedErrorText} from './rollup-client.ts';
import {restoreNativeStorage} from './native-storage.ts';

export const SECRET='shielded-rollup-wallet-secret-v1',SENT='shielded-rollup-sent-v1',BORN='shielded-rollup-wallet-born-v1',CREATED='shielded-rollup-wallet-created-v1';
type PageStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
function fetchErrorText(error:unknown){
 if(!(error instanceof FetchError))return;
 if(!['GET','HEAD'].includes((error.method??'GET').toUpperCase()))return 'The wallet service request did not finish. Its outcome may be unknown. Check its status before trying again.';
 let url:URL|undefined;try{url=new URL(error.url??'');}catch{}
 const service=url?.hostname.startsWith('mempool.')||url?.pathname.includes('/api/address/')?'Bitcoin explorer':url?.pathname.includes('/v1/indexer/')?'Wallet indexer':'Wallet service';
 const native=url&&/^\/\.shielded-native-session\/[1-9]\d*\//.test(url.pathname);
 const causes:Record<string,string>={
  'Tor connection failed':'The Tor connection failed.',
  'private TLS verification failed':'The service failed secure connection verification.',
  'private HTTP handshake failed':'The service connection failed.',
  'private HTTP request failed; outcome may be unknown':'The service connection was interrupted.',
  'private request timed out; outcome may be unknown':'The service timed out.',
  'Native network generation is retired or paused':'The private connection was paused.',
 };
 const cause=typeof error.cause==='string'?error.cause:error.cause instanceof Error?error.cause.message:'';
 const reason=Object.hasOwn(causes,cause)?causes[cause]:undefined;
 return `${service} could not be reached${native?' through Tor':''}. Wallet data may be out of date.${reason?' '+reason:''}`;
}
export const errorText=(error:unknown)=>pausedErrorText(error)??fetchErrorText(error)??(error instanceof Error?error.message:typeof error==='string'?error:'The action failed.');
export const activityReceived=(item:Activity)=>item.amount!==0?item.amount>0:item.txs.at(-1)?.type===TxType.TxReceived;
export const historyDirection=(item:Activity):'in'|'out'|'own'=>item.intent?.kind==='shield'||item.intent?.kind==='merge'?'own':activityReceived(item)?'in':'out';
export function pageActivityHistory(history:Activity[],lightning:Activity[]){
 const receipts=lightning.filter(row=>row.intent?.kind==='lightning-send'&&row.intent.outcome==='paid');
 const matches=(row:Activity,receipt:Activity)=>row.intent?.kind==='unshield'&&!activityReceived(row)&&row.amount===receipt.amount&&typeof receipt.intent?.metadata?.fundingTxid==='string'&&row.txs.some(tx=>tx.key.arkTxid===receipt.intent!.metadata!.fundingTxid);
 const rows=history.map(row=>{
  const candidates=receipts.filter(receipt=>matches(row,receipt));
  if(candidates.length!==1||history.filter(item=>matches(item,candidates[0]!)).length!==1)return row;
  return {...row,intent:{...row.intent!,label:'Paid via Lightning',outcome:'paid'}};
 });
 return [...rows,...lightning.filter(row=>row.intent?.kind!=='lightning-send')].sort((a,b)=>b.createdAt-a.createdAt);
}

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

type PageRetry={delayMs?:number;onError?:(error:unknown)=>void;onTerminal?:(error:unknown)=>void;shouldRetry?:()=>boolean};
function retryablePageError(error:unknown){
 if(!(error instanceof Error))return false;
 const status=(error as Error&{status?:number}).status;
 if(status!==undefined)return status===408||status===429||status>=500;
 return isRetryableProviderError(error)||/^The pool did not answer \((?:5\d\d|network error)\)\.$/.test(error.message);
}
export async function retryPageRead<T>(read:()=>Promise<T>,signal:AbortSignal,options:PageRetry={}):Promise<T|undefined>{
 for(let attempt=0;!signal.aborted;attempt++){
  try{const value=await read();return signal.aborted?undefined:value;}
  catch(error){
   if(signal.aborted)return;
   options.onError?.(error);
   const retry=retryablePageError(error)&&options.shouldRetry?.()!==false;
   if(signal.aborted)return;
   if(!retry){options.onTerminal?.(error);throw error;}
   await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,Math.min((options.delayMs??5000)*2**Math.min(attempt,4),60_000)*(1+Math.random()/4));
    signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
   });
  }
 }
}

export function pageClose<A extends unknown[],T>(close:(...args:A)=>Promise<T>){
 let completed:Promise<T>|undefined;
 return(...args:A)=>completed??=Promise.resolve().then(()=>close(...args)).catch(error=>{completed=undefined;throw error;});
}

export function pageActions(changed:()=>void){
 const pending=new Set<PaymentHandle>();
 return {get busy(){return pending.size>0;},track(handle:PaymentHandle){
  if(pending.has(handle))return;
  pending.add(handle);changed();
  const finish=()=>{pending.delete(handle);changed();};
  void Promise.resolve().then(()=>handle.settled({timeoutMs:30*60_000})).then(finish,finish);
 }};
}

export function openPageWallet<P,W extends {dispose():Promise<void>}>(prepare:()=>Promise<P>,create:(prepared:P)=>Promise<W>,disposeWallet:(wallet:W)=>Promise<void>=wallet=>wallet.dispose(),retry:PageRetry={}){
 let cancelled=false,wallet:W|undefined;
 const controller=new AbortController();
 const dispose=pageClose(()=>disposeWallet(wallet!));
 const ready=(async()=>{
  const prepared=await prepare();if(cancelled)return;
  await retryPageRead(async()=>{wallet=await create(prepared);return wallet;},controller.signal,retry);
  if(cancelled){if(wallet)await dispose();return;}
  return wallet;
 })();
 const close=pageClose(async()=>{await ready.catch(()=>{});if(wallet)await dispose();return wallet;});
 return {ready,active:()=>!cancelled,close(){
  cancelled=true;controller.abort();
  return close();
 }};
}

export type PageLightning<C,S,L>={companion:C;swaps:S;lnurl:L};
export async function startPageLightning<C extends {dispose():Promise<void>},S extends AsyncDisposable,L extends {dispose():Promise<void>}>(o:{pairing:Promise<C>;swaps:(companion:C,signal:AbortSignal)=>Promise<S>;lnurl:(companion:C,swaps:Promise<S>,signal:AbortSignal)=>Promise<L>;onLnurl?:(lnurl:L)=>void;signal:AbortSignal;active:()=>boolean;handOver:(parts:PageLightning<C,S,L>)=>void;report:(error:unknown)=>void}){
 let companion:C|undefined,swaps:S|undefined,lnurl:L|undefined,pendingSwaps:Promise<S>|undefined,pendingLnurl:Promise<L>|undefined;
 const waitFor=<T,>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  if(o.signal.aborted){reject(new Error('Lightning start was cancelled'));return;}
  const stopped=()=>reject(new Error('Lightning start was cancelled'));
  o.signal.addEventListener('abort',stopped,{once:true});
  work.then(value=>{o.signal.removeEventListener('abort',stopped);resolve(value);},error=>{o.signal.removeEventListener('abort',stopped);reject(error);});
 });
 try{
  companion=await waitFor(o.pairing);
  if(o.active()){
   pendingSwaps=o.swaps(companion,o.signal);pendingSwaps.catch(()=>{});
   pendingLnurl=o.lnurl(companion,pendingSwaps,o.signal);
   lnurl=await waitFor(pendingLnurl);
    if(o.active())o.onLnurl?.(lnurl);
   if(o.active()){
     swaps=await waitFor(pendingSwaps);
     if(o.active()){const parts={companion,swaps,lnurl};o.handOver(parts);return parts;}
   }
  }
 }catch(error){
  if(!o.signal.aborted&&o.active())o.report(new Error(`Lightning could not start: ${errorText(error)}`));
  if(o.signal.aborted&&!companion)void o.pairing.then(value=>value.dispose(),()=>{}).catch(()=>{});
  if(o.signal.aborted&&!lnurl)void pendingLnurl?.then(value=>value.dispose(),()=>{}).catch(()=>{});
 }
 // No hand-over, so this start still owns them; swaps and the address service both run on the companion, so it goes last.
 try{await lnurl?.dispose();}catch{}
 let shutdownTimer:ReturnType<typeof setTimeout>|undefined;
 try{
  const pending=pendingSwaps?.then(async service=>{if(swaps!==service)await service[Symbol.asyncDispose]();},()=>{}).catch(()=>{});
  if(pending)await Promise.race([pending,new Promise(resolve=>{shutdownTimer=setTimeout(resolve,1500);})]);
 }finally{if(shutdownTimer)clearTimeout(shutdownTimer);}
 try{await swaps?.[Symbol.asyncDispose]();}catch{}
 try{await companion?.dispose();}catch{}
 return;
}

export function pageRefresh<T extends Record<string,unknown>>(readers:{[K in keyof T]:()=>Promise<T[K]>},publish:(values:Partial<T>,errors:Partial<Record<keyof T,string>>)=>void,options:{retry?:boolean;delayMs?:number}={}){
 let closed=false;const controller=new AbortController();
 const values:Partial<T>={},errors:Partial<Record<keyof T,string>>={};
 const reads=(Object.keys(readers) as (keyof T)[]).map(key=>{
  let queued=false,running:Promise<void>|undefined;
  const report=(error:unknown)=>{if(closed)return;errors[key]=errorText(error);publish({...values},{...errors});};
  const request=()=>{
   if(closed)return;queued=true;
   running??=Promise.resolve().then(async()=>{
    while(queued&&!closed){
     queued=false;
     try{
      const value=options.retry?await retryPageRead(readers[key],controller.signal,{delayMs:options.delayMs,onError:report}):await readers[key]();
      if(closed)return;values[key]=value;delete errors[key];publish({...values},{...errors});
     }catch(error){if(!options.retry)report(error);}
    }
   }).finally(()=>{running=undefined;if(queued&&!closed)request();});
  };
  return {request,drain:()=>running};
 });
 return {request(){for(const read of reads)read.request();},async close(){closed=true;controller.abort();await Promise.all(reads.map(read=>read.drain()));}};
}

export async function disposeAfterPageReads(wallet:object,refreshes:WeakMap<object,{close:()=>Promise<void>}>,dispose:()=>Promise<void>){
 const owned=refreshes.get(wallet);await owned?.close();
 await dispose();
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
 await epochIdle(wallet.account,()=>wallet.save());
 if(!wallet.repositoryError&&current()&&storage.getItem(SENT)===raw)storage.removeItem(SENT);
}

export function createPageWallet(storage:PageStorage){
 if(storage.getItem(SECRET))throw new Error('A wallet already exists in this browser. Reload to open it.');
 const secret=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
 storage.setItem(BORN,'new');storage.setItem(CREATED,String(Date.now()));storage.setItem(SECRET,secret);
 return secret;
}

export async function restorePageWallet(phrase:string,o:{cache:ReturnType<typeof pageCache>;storage:PageStorage;stop:()=>Promise<void>;reload:()=>void;born?:{token:string;batches:number;at:number}}){
 const parsed=bytesToHex(parseMasterSecret(phrase));
 o.cache.close();await o.stop();await o.cache.drain();
 const nativeRestore=restoreNativeStorage(o.storage,parsed,o.born);
 if(nativeRestore){await nativeRestore;await o.cache.repository.clear();o.reload();return;}
 await o.cache.repository.clear();
 o.storage.setItem(SECRET,parsed);
 for(let i=o.storage.length-1;i>=0;i--){const key=o.storage.key(i);if(key?.startsWith(BORN))o.storage.removeItem(key);}
 if(o.born){o.storage.setItem(`${BORN}:${o.born.token}`,String(o.born.batches));o.storage.setItem(CREATED,String(o.born.at));}else o.storage.removeItem(CREATED);
 o.storage.removeItem(SENT);o.reload();
}

export function pageSheet(render:(state:StepState|undefined)=>void){
 type Owner={current:()=>boolean;update:(change:(current:StepState)=>StepState)=>void;fail:(error:unknown)=>void;dismiss:()=>void;attach:(off:()=>void)=>void};
 let generation=0,active:Owner|undefined,state:StepState|undefined;
 const watched=new WeakMap<PaymentHandle,Owner>();
 function begin(title:string):Owner{
  let off=()=>{},dismissed=false;active?.attach(()=>{});const mine=++generation;
  const publish=(next:StepState,terminal:boolean)=>{if(dismissed&&!terminal)return;state=next;render(next);};
  const update=(change:(current:StepState)=>StepState)=>{
   if(mine!==generation)return;
   const next=change(state??{title,steps:['Start','Done'],current:0});
   publish(next,!!next.done||!!next.error);
  };
  state=undefined;
  const owner:Owner={current:()=>mine===generation,update,fail:(error:unknown)=>update(s=>({...s,error:errorText(error)})),
   dismiss(){if(mine!==generation)return;dismissed=true;state=undefined;render(undefined);},
   attach(next){off();off=next;}};
  active=owner;
  return owner;
 }
 return {
  begin,
  watch(next:PaymentHandle,title:string){
   const previous=watched.get(next);if(previous)return previous;
   const selected=begin(title);watched.set(next,selected);
   selected.attach(watchHandle(next,title,s=>selected.update(()=>s)));
   // StepState keeps only the message, and a handle the wallet started (auto-shield) has no run() to word its failure.
   if(isShieldedHandle(next))void next.settled().catch(error=>{if(pausedErrorText(error))selected.fail(error);});
   return selected;
  },
  clear(){active?.dismiss();},
  stop(){generation++;active?.attach(()=>{});active=undefined;state=undefined;},
 };
}

type QuoteFunds={token?:string;notes:readonly {nullifier:bigint;asset:bigint;amount:bigint}[];inFlight:ReadonlySet<bigint>};
export function pageQuoteFunds(read:()=>QuoteFunds,invalidate:()=>void){
 const ordered=(rows:unknown[][])=>rows.map(row=>JSON.stringify(row)).sort();
 const fingerprint=(coins:readonly ArkCoin[])=>{
  const funds=read();
  return JSON.stringify([funds.token,ordered(funds.notes.map(note=>[String(note.nullifier),String(note.asset),String(note.amount)])),[...funds.inFlight].map(String).sort(),
   ordered(coins.map(coin=>[coin.txid,coin.vout,coin.value,coin.expiresAt,ordered((coin.assets??[]).map(asset=>[asset.assetId,String(asset.amount)]))]))]);
 };
 let revision=0,coins:readonly ArkCoin[]=[],key=fingerprint(coins);
 return {get revision(){return revision;},update(nextCoins=coins){
  const next=fingerprint(nextCoins);coins=nextCoins;
  if(next!==key){key=next;revision++;invalidate();}return revision;
 }};
}

type QuoteContext={wallet:object;revision:number;key:string};
export function pageQuotes(render:()=>void){
 let generation=0,selected:{context:QuoteContext;quote?:RouteQuote;error?:string;pending?:boolean}|undefined;
 const matches=(a:QuoteContext,b:QuoteContext)=>a.wallet===b.wallet&&a.revision===b.revision&&a.key===b.key;
 const clear=()=>{generation++;selected=undefined;};
 return {
  clear,
  invalidate(context:QuoteContext){if(selected&&!matches(selected.context,context))clear();},
  read(context:QuoteContext):{quote?:RouteQuote;error?:string;pending?:boolean}{return selected&&matches(selected.context,context)?selected:{};},
  load(context:QuoteContext,route:()=>Promise<RouteQuote>){
   const mine=++generation;selected={context,pending:true};render();
   void Promise.resolve().then(route).then(quote=>{if(mine===generation){selected={context,quote};render();}},error=>{if(mine===generation){selected={context,error:errorText(error)};render();}});
   return()=>{if(mine===generation)clear();};
  },
  async send(context:QuoteContext,quote:RouteQuote){
   if(!selected||!matches(selected.context,context)||selected.quote!==quote)throw new Error('The payment changed. Review its route again.');
   clear();return quote.send();
  },
 };
}
export async function pageQuoteRoute<T>(route:()=>Promise<T>,pending:()=>Promise<unknown>|undefined){
 // Any error, not only "no rail": a Bitcoin address fails differently before Lightning attaches, and route() only reads.
 try{return await route();}
 catch(error){const start=pending();if(!start)throw error;await start.catch(()=>{});return route();}
}

export async function renewPageCoins(renew:()=>Promise<string|undefined>,sheet:ReturnType<typeof pageSheet>){
 const owner=sheet.begin('Renewing your coins');
 owner.update(()=>({title:'Renewing your coins',steps:['Join the next batch swap','Renewed'],current:0}));
 try{const txid=await renew();owner.update(s=>({...s,current:1,done:true}));return txid;}
 catch(error){owner.fail(error);throw error;}
}
