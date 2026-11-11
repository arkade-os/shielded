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
 assert.deepEqual(await p.getVtxos({scripts:['a','b'],pageIndex:2,pageSize:2}),{vtxos:[coin('c')],page:{current:2,next:2,total:2}});
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.scripts.length===1&&c.pageIndex===1&&c.pageSize===100));
 for(const pageIndex of [0,1])assert.deepEqual(await p.getVtxos({scripts:['a','b'],pageIndex,pageSize:2}),{vtxos:[coin('a'),coin('b')],page:{current:1,next:2,total:2}});
 assert.deepEqual(await p.getVtxos({scripts:['a','b'],pageIndex:3,pageSize:2}),{vtxos:[],page:{current:3,next:2,total:2}});
});

test('isolated reads accept Arkd empty pages through the installed SDK',async()=>{
 const original=globalThis.fetch,calls:URL[]=[],p=new IsolatedIndexerProvider('https://ark.example');
 globalThis.fetch=async input=>{calls.push(new URL(String(input)));return Response.json({vtxos:[],page:{current:1,next:0,total:0}});};
 try{
  for(const selector of [{scripts:['empty']},{outpoints:[{txid:'a'.repeat(64),vout:0}]}]){
   assert.deepEqual(await p.getVtxos(selector),{vtxos:[]});
   assert.deepEqual(await p.getVtxos({...selector,pageIndex:0,pageSize:2}),{vtxos:[],page:{current:1,next:0,total:0}});
  }
  assert.equal(calls.length,4);assert.ok(calls.every(url=>url.searchParams.get('page.index')==='1'&&url.searchParams.get('page.size')==='100'));
 }finally{globalThis.fetch=original;}
});

test('isolated reads drain Arkd page counts through the installed SDK',async()=>{
 const original=globalThis.fetch,all=Array.from({length:106},(_,n)=>({outpoint:{txid:n.toString(16).padStart(64,'0'),vout:0},createdAt:'1',expiresAt:null,amount:'1',script:'aa',isPreconfirmed:false,isSwept:false,isUnrolled:false,isSpent:false,commitmentTxids:[]}));
 try{
  for(const selector of [{scripts:['aa']},{outpoints:[{txid:'a'.repeat(64),vout:0}]}]){
   const calls:URL[]=[];globalThis.fetch=async input=>{const url=new URL(String(input)),index=Math.max(1,Number(url.searchParams.get('page.index')));calls.push(url);return Response.json({vtxos:all.slice((index-1)*100,index*100),page:{current:index,next:Math.min(index+1,2),total:2}});};
   const result=await new IsolatedIndexerProvider('https://ark.example').getVtxos({...selector,spendableOnly:true});
   assert.deepEqual(result.vtxos.map(v=>v.txid),all.map(v=>v.outpoint.txid));
   assert.deepEqual(calls.map(url=>url.searchParams.get('page.index')),['1','2']);
   assert.ok(calls.every(url=>url.searchParams.getAll('scripts').length+url.searchParams.getAll('outpoints').length===1&&url.searchParams.get('page.size')==='100'&&url.searchParams.get('spendableOnly')==='true'));
  }
 }finally{globalThis.fetch=original;}
});

test('isolated reads follow short server pages for single and multiple selectors',async()=>{
 for(const scripts of [['a'],['a','b']]){
  const calls:any[]=[],base=new RestIndexerProvider('https://ark.example'),all=Array.from({length:106},(_,n)=>coin('a'+String(n).padStart(3,'0')));
  base.getVtxos=async opts=>{calls.push(opts);const index=opts?.pageIndex??1;return opts?.scripts?.[0]==='a'?{vtxos:all.slice((index-1)*100,index*100),page:{current:index,next:Math.min(index+1,2),total:2}}:{vtxos:[coin('b')]};};
  const p=new IsolatedIndexerProvider('https://ark.example',undefined,base),result=await p.getVtxos({scripts});
  assert.deepEqual(result.vtxos.map(v=>v.txid),[...all.map(v=>v.txid),...(scripts.length===2?['b']:[])]);
  assert.ok(calls.every(call=>call.scripts.length===1&&call.pageSize===100));
  assert.deepEqual(calls.filter(call=>call.scripts[0]==='a').map(call=>call.pageIndex),[1,2]);
 }
});

test('isolated reads reject pagination that cannot advance without repeating a request',async()=>{
 for(const page of [{current:2,next:3,total:3},{current:1,next:1,total:2},{current:1,next:3,total:2},{current:1,next:3,total:3},{current:1,next:0,total:-1},{current:1,next:0.5,total:1},{current:1,next:1,total:1.5}]){
  let calls=0;const base=new RestIndexerProvider('https://ark.example');base.getVtxos=async()=>{calls++;return {vtxos:[coin('a')],page};};
  await assert.rejects(new IsolatedIndexerProvider('https://ark.example',undefined,base).getVtxos({scripts:['a']}),/page/i);assert.equal(calls,1);
 }
});
test('isolated reads accept terminal pages whose next marker is omitted or reset',async()=>{
 for(const {page,items} of [{page:{current:1,next:0,total:0},items:[]},{page:{current:1,next:2,total:1},items:[coin('a')]},{page:{current:1,next:0,total:1},items:[coin('a')]}]){
  const base=new RestIndexerProvider('https://ark.example');base.getVtxos=async()=>({vtxos:items,page});
  assert.deepEqual((await new IsolatedIndexerProvider('https://ark.example',undefined,base).getVtxos({scripts:['a']})).vtxos,items);
 }
});
test('isolated reads accept an empty terminal page after the server result shrinks',async()=>{
 const calls:number[]=[],base=new RestIndexerProvider('https://ark.example');
 base.getVtxos=async opts=>{calls.push(opts!.pageIndex!);return opts!.pageIndex===1?{vtxos:[coin('a')],page:{current:1,next:2,total:2}}:{vtxos:[],page:{current:2,next:1,total:1}};};
 assert.deepEqual((await new IsolatedIndexerProvider('https://ark.example',undefined,base).getVtxos({scripts:['a']})).vtxos,[coin('a')]);assert.deepEqual(calls,[1,2]);
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
test('an indexer provider built with no stream reservations polls every script instead of subscribing',async()=>{
 const base=new RestIndexerProvider('https://ark.example'),polled=new Map<string,SubscriptionResponse>();
 base.subscribeForScripts=async()=>{throw new Error('a stream was reserved');};
 base.getVtxos=async opts=>{const script=opts!.scripts![0]!;return {vtxos:[{...coin('t'+script),script,isSpent:false,isSwept:false,isUnrolled:false}]};};
 const p=new IsolatedIndexerProvider('https://ark.example',undefined,base,20_000,0),abort=new AbortController(),stream=p.getSubscription(await p.subscribeForScripts(['a','b']),abort.signal);
 while(polled.size<2){const event=(await stream.next()).value!;polled.set(event.scripts[0]!,event);}
 for(const script of ['a','b'])assert.deepEqual(polled.get(script)!.newVtxos.map(c=>c.script),[script]);
 abort.abort();p.retire();
 const subscribed:string[][]=[],streaming=new RestIndexerProvider('https://ark.example');
 streaming.subscribeForScripts=async scripts=>{subscribed.push(scripts);return 'remote-1';};streaming.unsubscribeForScripts=async()=>{};
 const q=new IsolatedIndexerProvider('https://ark.example',undefined,streaming);await q.unsubscribeForScripts(await q.subscribeForScripts(['a']));
 assert.deepEqual(subscribed,[['a']],'the three-argument default still reserves a stream');
});
test('an isolated onchain provider without a poll interval keeps the SDK default, and one with it re-randomizes every read',()=>{
 const url='https://chain.example/api',plain=new IsolatedOnchainProvider(url),slow=new IsolatedOnchainProvider(url,60_000),reads=Array.from({length:20},()=>slow.pollingInterval);
 assert.equal(plain.pollingInterval,15_000);assert.ok('value' in Object.getOwnPropertyDescriptor(plain,'pollingInterval')!,'no getter is installed without a poll interval');
 assert.ok(reads.every(ms=>ms>=60_000&&ms<=75_000)&&new Set(reads).size>1,reads.join());
 assert.deepEqual([plain.forcePolling,slow.forcePolling],[true,true]);
});
test("the SDK's own poll loop schedules every round on a freshly drawn interval",async t=>{
 const armed:{ms:number;run:()=>void}[]=[],stats={tx_count:0,funded_txo_count:0,spent_txo_count:0},flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
 t.mock.method(console,'warn',()=>{});
 t.mock.method(globalThis,'setTimeout',((run:()=>void,ms:number)=>armed.push({ms,run})) as never);
 t.mock.method(globalThis,'fetch',(async(url:string)=>Response.json(url.endsWith('/txs')?[]:url.endsWith('/blocks')?[{id:'00',height:1,mediantime:1}]:{chain_stats:stats,mempool_stats:stats})) as never);
 const stop=await new IsolatedOnchainProvider('https://chain.example/api',60_000).watchAddresses(['a'],()=>{});
 for(let round=0;round<6;round++){await flush();armed[round]!.run();}
 await flush();stop();
 const delays=armed.map(timer=>timer.ms);
 assert.equal(delays.length,7);assert.ok(delays.every(ms=>ms>=60_000&&ms<=75_000)&&new Set(delays).size>1,delays.join());
});
test('native onchain watches split addresses and release every watch',async()=>{
 const original=EsploraProvider.prototype.watchAddresses,calls:string[][]=[],closed:string[]=[];
 EsploraProvider.prototype.watchAddresses=async addresses=>{calls.push(addresses);return ()=>{closed.push(...addresses);};};
 try{const p=new IsolatedOnchainProvider('https://chain.example/api'),stop=await p.watchAddresses(['a','b','a'],()=>{});assert.equal(p.forcePolling,true);assert.deepEqual(calls,[['a'],['b']]);stop();assert.deepEqual(closed,['a','b']);}finally{EsploraProvider.prototype.watchAddresses=original;}
});
