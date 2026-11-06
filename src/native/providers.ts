import {EsploraProvider,RestIndexerProvider,isVtxoSpent,type EventSourceFactory,type ExplorerTransaction,type GetVtxosOptions,type IndexerProvider,type PaginationOptions,type SubscriptionResponse,type SubscriptionFilter,type SubscriptionEvent,type SubscriptionHeartbeat,type VirtualCoin} from '@arkade-os/sdk';

export class AsyncQueue<T> implements AsyncIterableIterator<T> {
 private values:T[]=[];private waiters:{resolve:(value:IteratorResult<T>)=>void;reject:(error:unknown)=>void}[]=[];private done=false;private error:unknown;
 constructor(private onClose:()=>void=()=>{}){}
 [Symbol.asyncIterator](){return this;}
 push(value:T){if(this.done)return;const waiter=this.waiters.shift();if(waiter)waiter.resolve({done:false,value});else if(this.values.length>=256)this.fail(new Error('Native stream consumer fell behind'));else this.values.push(value);}
 next():Promise<IteratorResult<T>>{if(this.values.length)return Promise.resolve({done:false,value:this.values.shift()!});if(this.done)return this.error?Promise.reject(this.error):Promise.resolve({done:true,value:undefined});return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));}
 end(){if(this.done)return;this.done=true;this.values=[];this.onClose();for(const waiter of this.waiters.splice(0))if(this.error)waiter.reject(this.error);else waiter.resolve({done:true,value:undefined});}
 fail(error:unknown){if(this.done)return;this.error=error;this.end();}
 async return():Promise<IteratorResult<T>>{this.end();return {done:true,value:undefined};}
}
const pageOf=<T>(items:T[],opts?:PaginationOptions)=>{
 if(opts?.pageIndex===undefined&&opts?.pageSize===undefined)return {items};
 const index=opts?.pageIndex??0,size=opts?.pageSize??500;if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(size)||size<=0)throw new Error('Invalid native pagination');
 return {items:items.slice(index*size,(index+1)*size),page:{current:index,next:index+1,total:Math.max(0,Math.ceil(items.length/size)-1)}};
};
const mapItems=async<T,R>(items:T[],read:(item:T)=>Promise<R>)=>{const results:R[]=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{for(;;){const index=next++;if(index>=items.length)return;results[index]=await read(items[index]!);}}));return results;};
let streamReservations=0,polling=0;const pollWaiters:(()=>void)[]=[];
const pollRead=async<T>(signal:AbortSignal,read:()=>Promise<T>):Promise<T|undefined>=>{if(polling>=4)await new Promise<void>(resolve=>pollWaiters.push(resolve));else polling++;try{return signal.aborted?undefined:await read();}finally{const next=pollWaiters.shift();if(next)next();else polling--;}};
const pollDelay=(signal:AbortSignal,ms:number)=>new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,ms);if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
interface LogicalStream {queue:AsyncQueue<SubscriptionResponse>;attach:(script:string,id:string|null)=>void;detach:(script:string)=>void}
interface LogicalSubscription {entries:Map<string,string|null>;streams:Set<LogicalStream>;tail:Promise<unknown>;closed:boolean}
export class IsolatedIndexerProvider extends RestIndexerProvider {
 private base:IndexerProvider;private subscriptions=new Map<string,LogicalSubscription>();
 constructor(url:string,eventSource?:EventSourceFactory,base?:IndexerProvider,private pollMs=20_000){super(url,{eventSource});this.base=base??new RestIndexerProvider(url,{eventSource});}
 override async getVtxos(opts?:GetVtxosOptions):ReturnType<IndexerProvider['getVtxos']>{
  if(opts?.scripts&&opts?.outpoints)throw new Error('scripts and outpoints are mutually exclusive options');
  const items=opts?.scripts??opts?.outpoints;
  if(!items||items.length<=1)return this.base.getVtxos(opts);
  const rows=(await mapItems(items as (string|{txid:string;vout:number})[],item=>this.base.getVtxos({...opts,pageIndex:undefined,pageSize:undefined,...(typeof item==='string'?{scripts:[item]}:{outpoints:[item]})} as GetVtxosOptions))).flatMap(result=>result.vtxos);
  const unique=[...new Map(rows.map(coin=>[coin.txid+':'+coin.vout,coin])).values()].sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout),result=pageOf(unique,opts);
  return {vtxos:result.items,...(result.page?{page:result.page}:{})};
 }
 override async getVirtualTxs(txids:string[],opts?:PaginationOptions):ReturnType<IndexerProvider['getVirtualTxs']>{
  if(txids.length<=1)return this.base.getVirtualTxs(txids,opts);
  const rows=(await mapItems([...new Set(txids)],id=>this.base.getVirtualTxs([id]))).flatMap(result=>result.txs),result=pageOf([...new Set(rows)].sort(),opts);
  return {txs:result.items,...(result.page?{page:result.page}:{})};
 }
 override async subscribeForScripts(scripts:string[],existingId?:string,signal?:AbortSignal):Promise<string>{
  if(signal?.aborted)throw signal.reason??new DOMException('Subscription cancelled','AbortError');
  if(!scripts.length||scripts.some(script=>typeof script!=='string'||!script))throw new Error('Native subscriptions need scripts');
  const id=existingId??crypto.randomUUID(),record=existingId?this.subscriptions.get(id):{entries:new Map(),streams:new Set<LogicalStream>(),tail:Promise.resolve(),closed:false};
  if(!record||record.closed)throw new Error('Native subscription not found');this.subscriptions.set(id,record);
  const update=record.tail.catch(()=>{}).then(async()=>{
   const added:string[]=[];
   try{
    for(const script of new Set(scripts)){
     if(record.closed||signal?.aborted)throw signal?.reason??new DOMException('Subscription cancelled','AbortError');
     if(record.entries.has(script))continue;
     let remote:string|null=null;
     if(streamReservations<32){streamReservations++;try{remote=await this.base.subscribeForScripts([script],undefined,signal);}catch(error){streamReservations--;throw error;}}
     if(record.closed||signal?.aborted){if(remote){streamReservations--;await this.base.unsubscribeForScripts(remote).catch(()=>{});}throw signal?.reason??new DOMException('Subscription cancelled','AbortError');}
     record.entries.set(script,remote);added.push(script);for(const stream of record.streams)stream.attach(script,remote);
    }
   }catch(error){
    for(const script of added){const remote=record.entries.get(script);record.entries.delete(script);for(const stream of record.streams)stream.detach(script);if(remote){streamReservations--;await this.base.unsubscribeForScripts(remote).catch(()=>{});}}
    if(!existingId){record.closed=true;this.subscriptions.delete(id);}throw error;
   }
  });
  record.tail=update;await update;return id;
 }
 override getSubscription(id:string,signal:AbortSignal):AsyncIterableIterator<SubscriptionResponse>{
  const record=this.subscriptions.get(id);if(!record||record.closed)throw new Error('Native subscription not found');
  for(const previous of [...record.streams])previous.queue.end();
  const controllers=new Map<string,AbortController>(),iterators=new Map<string,AsyncIterableIterator<SubscriptionResponse>>();
  const stop=()=>{signal.removeEventListener('abort',stop);for(const script of [...controllers.keys()])stream.detach(script);record.streams.delete(stream);queue.end();};
  const queue=new AsyncQueue<SubscriptionResponse>(stop);
  const stream:LogicalStream={queue,detach:script=>{controllers.get(script)?.abort();controllers.delete(script);const iterator=iterators.get(script);iterators.delete(script);void iterator?.return?.().catch(()=>{});},attach:(script,remote)=>{
   if(signal.aborted||controllers.has(script))return;
   const controller=new AbortController();controllers.set(script,controller);
   void (async()=>{
    try{
     const iterator=remote===null?this.pollScript(script,controller.signal):this.base.getSubscription(remote,controller.signal);iterators.set(script,iterator);
     for await(const event of iterator){if(controller.signal.aborted||signal.aborted)break;queue.push(event);}
     if(!controller.signal.aborted&&!signal.aborted)queue.fail(new Error('An isolated subscription closed; catch up before reconnecting'));
    }catch(error){if(!controller.signal.aborted&&!signal.aborted)queue.fail(error);}
   })();
  }};
  record.streams.add(stream);if(signal.aborted)stop();else{signal.addEventListener('abort',stop,{once:true});for(const [script,remote] of record.entries)stream.attach(script,remote);}
  return queue;
 }
 override async unsubscribeForScripts(id:string,scripts?:string[]):Promise<void>{
  const record=this.subscriptions.get(id);if(!record)return;
  if(!scripts){record.closed=true;this.subscriptions.delete(id);}
  await record.tail.catch(()=>{});
  const selected=scripts??[...record.entries.keys()];
  await Promise.all(selected.map(async script=>{if(!record.entries.has(script))return;const remote=record.entries.get(script);record.entries.delete(script);for(const stream of record.streams)stream.detach(script);if(remote){streamReservations--;await this.base.unsubscribeForScripts(remote);}}));
  if(!record.entries.size){record.closed=true;this.subscriptions.delete(id);for(const stream of [...record.streams])stream.queue.end();}
 }
 override getFilteredSubscription(_filter:SubscriptionFilter,_signal:AbortSignal):AsyncIterableIterator<SubscriptionEvent|SubscriptionHeartbeat>{throw new Error('Native privacy uses individual script subscriptions, not global filters');}
 private async* pollScript(script:string,signal:AbortSignal):AsyncIterableIterator<SubscriptionResponse>{
  let previous=new Map<string,VirtualCoin>();
  while(!signal.aborted){
   const result=await pollRead(signal,()=>this.base.getVtxos({scripts:[script]}));if(signal.aborted||!result)return;
   const current=new Map(result.vtxos.map(coin=>[coin.txid+':'+coin.vout,coin]));
   if([...previous.keys()].some(key=>!current.has(key)))throw new Error('An isolated polling snapshot lost a coin; catch up before reconnecting');
   const fingerprint=(coin:VirtualCoin)=>JSON.stringify(coin,(_key,value)=>typeof value==='bigint'?String(value):value);
   const changed=result.vtxos.filter(coin=>{const before=previous.get(coin.txid+':'+coin.vout);return !before||fingerprint(before)!==fingerprint(coin);});
   // SDK watchers consume removals from spentVtxos; keep the actual swept/unrolled flags.
   if(changed.length)yield {scripts:[script],newVtxos:changed.filter(coin=>!isVtxoSpent(coin)&&!coin.isSwept&&!coin.isUnrolled),spentVtxos:changed.filter(coin=>isVtxoSpent(coin)||coin.isUnrolled||coin.isSwept),sweptVtxos:changed.filter(coin=>coin.isSwept)};
   previous=current;await pollDelay(signal,this.pollMs*(1+Math.random()/4));
  }
 }
 retire(){for(const record of this.subscriptions.values()){record.closed=true;for(const remote of record.entries.values())if(remote)streamReservations--;record.entries.clear();for(const stream of [...record.streams])stream.queue.fail(new Error('Native network generation retired'));}this.subscriptions.clear();}
}
export class IsolatedOnchainProvider extends EsploraProvider {
 constructor(url:string){super(url,{forcePolling:true});}
 override async watchAddresses(addresses:string[],callback:(txs:ExplorerTransaction[])=>void):Promise<()=>void>{
  const stopped:(()=>void)[]=[];
  try{for(const address of new Set(addresses))stopped.push(await super.watchAddresses([address],callback));}
  catch(error){for(const stop of stopped)stop();throw error;}
  return ()=>{for(const stop of stopped)stop();};
 }
}
