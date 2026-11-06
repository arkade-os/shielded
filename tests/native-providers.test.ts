import assert from 'node:assert/strict';
import test from 'node:test';
import {EsploraProvider,RestIndexerProvider,type SubscriptionResponse,type VirtualCoin} from '@arkade-os/sdk';
import {AsyncQueue,IsolatedIndexerProvider,IsolatedOnchainProvider} from '../src/native/providers.ts';
import {bindNativeProvider} from '../src/native/transport.ts';
import {NativeBridge,type NativeBackend} from '../src/native/transport.ts';
import {NativePolicy} from '../src/native/policy.ts';

const coin=(txid:string,vout=0)=>({txid,vout,script:'script'} as VirtualCoin);
test('retired provider rejects later calls and internal continuation before another dispatch',async()=>{
 let generation=1,dispatches=0,release!:()=>void;
 const check=()=>{if(generation!==1)throw new Error('provider generation retired');};
 const provider=bindNativeProvider({serverUrl:'https://ark.example',async pages(){
  void this.serverUrl;dispatches++;await new Promise<void>(resolve=>{release=resolve;});
  void this.serverUrl;dispatches++;
 },getSubscription(){return {async next(){dispatches++;return {done:false,value:1};},async return(){return {done:true,value:undefined};},[Symbol.asyncIterator](){return this;}};}},check);
 const pending=provider.pages();await new Promise(r=>setTimeout(r,0));generation=2;release();await assert.rejects(pending,/retired/);assert.equal(dispatches,1);
 assert.throws(()=>provider.pages(),/retired/);assert.equal(dispatches,1);
});
test('session-bound iterators reject later next calls while cleanup remains callable',async()=>{
 let live=true,reads=0,closed=0;
 const provider=bindNativeProvider({getSubscription(){return {async next(){reads++;return {done:false,value:1};},async return(){closed++;return {done:true,value:undefined};},[Symbol.asyncIterator](){return this;}};},async unsubscribeForScripts(){closed++;}},()=>{if(!live)throw new Error('retired');});
 const iterator=provider.getSubscription();assert.equal((await iterator.next()).value,1);live=false;
 await assert.rejects(iterator.next(),/retired/);assert.equal(reads,1);
 await iterator.return();await provider.unsubscribeForScripts();assert.ok(closed>=2);
});
test('an actual SDK indexer retry cannot dispatch through a resumed generation',async()=>{
 let generation=1,dispatches=0;const original=globalThis.fetch;
 const api:NativeBackend={invoke:async(command)=>{
  if(command==='native_scope')return {id:'scope',generation};
  if(command==='native_http'){dispatches++;generation=3;bridge.acceptStatus({phase:'ready',generation});return {generation:1,status:503,headers:[],bodyBase64:'e30='};}
 },channel:()=>({})};
 const policy=new NativePolicy('https://pool.example');policy.registerArk('https://ark.example','https://ark.example');const bridge=new NativeBridge(api,policy);bridge.acceptStatus({phase:'ready',generation});
 const provider=new RestIndexerProvider(bridge.sessionUrl('https://ark.example'));globalThis.fetch=(input,init)=>bridge.fetch(input,init);
 try{await assert.rejects(provider.getVtxos({scripts:['aa']}));assert.equal(dispatches,1);}finally{globalThis.fetch=original;}
});
test('isolated indexer drains each item and paginates the merged unique result',async()=>{
 const calls:any[]=[],base=new RestIndexerProvider('https://ark.example');
 base.getVtxos=async opts=>{calls.push(opts);return {vtxos:opts?.scripts?.[0]==='a'?[coin('a'),coin('b')]:[coin('b'),coin('c')]};};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base);
 assert.deepEqual((await p.getVtxos({scripts:['a','b'],pageIndex:1,pageSize:2})).vtxos.map(c=>c.txid),['c']);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.scripts.length===1&&c.pageIndex===undefined&&c.pageSize===undefined));
});
test('a live logical subscription receives scripts added later on separate server ids',async()=>{
 const subscribed:any[]=[],removed:string[]=[],sources=new Map<string,AsyncQueue<SubscriptionResponse>>(),base=new RestIndexerProvider('https://ark.example');
 base.subscribeForScripts=async(scripts,existing)=>{subscribed.push({scripts,existing});const id='remote-'+scripts[0];sources.set(id,new AsyncQueue());return id;};
 base.unsubscribeForScripts=async id=>{removed.push(id);sources.get(id)?.end();};
 base.getSubscription=(id,signal)=>{const source=sources.get(id)!;signal.addEventListener('abort',()=>source.end(),{once:true});return source;};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base),id=await p.subscribeForScripts(['a']),abort=new AbortController(),iterator=p.getSubscription(id,abort.signal);
 const a=iterator.next();await p.subscribeForScripts(['a','b'],id);sources.get('remote-b')!.push({scripts:['b'],newVtxos:[],spentVtxos:[],sweptVtxos:[]});
 assert.deepEqual((await a).value?.scripts,['b']);assert.ok(subscribed.every(c=>c.scripts.length===1&&c.existing===undefined));
 await p.unsubscribeForScripts(id,['a']);assert.deepEqual(removed,['remote-a']);
 await iterator.return?.();assert.equal(abort.signal.aborted,false);await p.unsubscribeForScripts(id);assert.deepEqual(removed,['remote-a','remote-b']);
});
test('an aborted subscription creation cleans up its late server id',async()=>{
 let release!:(id:string)=>void;const removed:string[]=[],base=new RestIndexerProvider('https://ark.example');
 base.subscribeForScripts=()=>new Promise(r=>{release=r;});base.unsubscribeForScripts=async id=>{removed.push(id);};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base),abort=new AbortController(),pending=p.subscribeForScripts(['a'],undefined,abort.signal);
 await new Promise(r=>setTimeout(r,0));abort.abort();release('late');await assert.rejects(pending,/abort|cancel/i);assert.deepEqual(removed,['late']);
});
test('retiring a logical stream rejects an already waiting next call',async()=>{
 const base=new RestIndexerProvider('https://ark.example');base.subscribeForScripts=async()=> 'remote';base.getSubscription=(_id,signal)=>{const queue=new AsyncQueue<SubscriptionResponse>();signal.addEventListener('abort',()=>queue.end(),{once:true});return queue;};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base),id=await p.subscribeForScripts(['a']),stream=p.getSubscription(id,new AbortController().signal),next=stream.next();p.retire();await assert.rejects(next,/retired/i);
});
test('a large multi-item read limits concurrent requests',async()=>{
 let active=0,maximum=0;const base=new RestIndexerProvider('https://ark.example');base.getVtxos=async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,1));active--;return {vtxos:[]};};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base);await p.getVtxos({scripts:Array.from({length:30},(_,i)=>String(i))});assert.equal(maximum,4);
});
test('ninety watched scripts preserve per-item receive and spend events beyond the stream budget',async()=>{
 const scripts=Array.from({length:90},(_,i)=>'s'+i),subscriptions:string[][]=[],reads:string[][]=[],base=new RestIndexerProvider('https://ark.example');let spent=false,swept=false;
 base.subscribeForScripts=async(items)=>{subscriptions.push(items);return 'remote-'+items[0];};base.unsubscribeForScripts=async()=>{};
 base.getSubscription=(_id,signal)=>{const q=new AsyncQueue<SubscriptionResponse>();signal.addEventListener('abort',()=>q.end(),{once:true});return q;};
 base.getVtxos=async opts=>{const items=opts!.scripts!;reads.push(items);return {vtxos:[{...coin(items[0]!),script:items[0]!,isSpent:spent&&items[0]==='s69',isSwept:swept&&items[0]==='s70',isUnrolled:false,assets:[{assetId:'asset',amount:4n}]}]};};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base,2),id=await p.subscribeForScripts(scripts),abort=new AbortController(),stream=p.getSubscription(id,abort.signal),received=new Set<string>();
 while(received.size<58){const event=await stream.next();assert.equal(event.done,false);for(const c of event.value!.newVtxos)received.add(c.script);}
 assert.equal(subscriptions.length,32);assert.ok(subscriptions.every(items=>items.length===1));assert.ok(received.has('s69'));
 spent=true;const changed=await stream.next();assert.equal(changed.value?.spentVtxos[0]?.script,'s69');swept=true;const sweep=await stream.next();assert.equal(sweep.value?.sweptVtxos[0]?.script,'s70');assert.equal(sweep.value?.spentVtxos[0]?.isSwept,true);
 assert.ok(reads.every(items=>items.length===1));abort.abort();p.retire();
});
test('native onchain watches split addresses and release every watch',async()=>{
 const original=EsploraProvider.prototype.watchAddresses,calls:string[][]=[],closed:string[]=[];
 EsploraProvider.prototype.watchAddresses=async addresses=>{calls.push(addresses);return ()=>{closed.push(...addresses);};};
 try{const p=new IsolatedOnchainProvider('https://chain.example/api'),stop=await p.watchAddresses(['a','b','a'],()=>{});assert.equal(p.forcePolling,true);assert.deepEqual(calls,[['a'],['b']]);stop();assert.deepEqual(closed,['a','b']);}finally{EsploraProvider.prototype.watchAddresses=original;}
});
