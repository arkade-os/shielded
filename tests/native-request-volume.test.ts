import assert from 'node:assert/strict';
import {test} from 'node:test';
import 'fake-indexeddb/auto';
import {InMemoryContractRepository,InMemoryWalletRepository,RestIndexerProvider,SingleKey,Wallet,type ContractEvent,type SubscriptionResponse,type VirtualCoin} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import info from './fixtures/ark-info.json' with {type:'json'};
import {AsyncQueue,IsolatedIndexerProvider} from '../src/native/providers.ts';
import {createLightningWallet} from '../src/shielded/lightning-wallet.ts';
import {PRIVATE_ONCHAIN_POLL_MS,PRIVATE_VTXO_SYNC_MAX_AGE_MS} from '../src/shielded/network-privacy.ts';

const coinOn=(script:string,txid:string):VirtualCoin=>({txid,vout:0,value:1000,script,status:{confirmed:true},createdAt:new Date(1_700_000_000_000),isUnrolled:false,isSpent:false,isSwept:false,isPreconfirmed:false,commitmentTxIds:[]});
function companionFixture(){
 const reads:string[]=[],coins=new Map<string,VirtualCoin[]>(),open:AsyncQueue<SubscriptionResponse>[]=[];
 const base=new RestIndexerProvider('https://ark.example');
 base.getVtxos=async options=>{const script=options!.scripts![0]!;reads.push(script);return {vtxos:coins.get(script)??[]};};
 base.subscribeForScripts=async scripts=>'remote-'+scripts[0];
 base.unsubscribeForScripts=async()=>{};
 base.getSubscription=(_id,signal)=>{const stream=new AsyncQueue<SubscriptionResponse>();open.push(stream);signal.addEventListener('abort',()=>stream.end(),{once:true});return stream;};
 const indexer=new IsolatedIndexerProvider('https://ark.example',undefined,base,60_000);
 return {secret:hex.encode(crypto.getRandomValues(new Uint8Array(32))),reads,coins,indexer,
  refuseStreams:(error:Error)=>{for(const stream of open.splice(0))stream.fail(error);},
  announce:(event:SubscriptionResponse)=>{for(const stream of open)stream.push(event);},
  providers:{arkProvider:{getInfo:async()=>info},indexerProvider:indexer,onchainProvider:{getCoins:async()=>[],getTransactions:async()=>[],getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}}} as unknown as Parameters<typeof createLightningWallet>[1]};
}
const settle=async()=>{for(let i=0;i<40;i++)await new Promise(resolve=>setImmediate(resolve));};
const until=async(ready:()=>boolean,ms:number)=>{for(const deadline=Date.now()+ms;Date.now()<deadline;)
 {if(ready())return true;await new Promise(resolve=>setTimeout(resolve,25));}return ready();};

test('a refused stream on the main Ark address still detects the coin that landed in its backoff, without resyncing the wallet',async()=>{
 const f=companionFixture(),txid='cd'.repeat(32),events:ContractEvent[]=[];
 const wallet=await Wallet.create({identity:SingleKey.fromHex('33'.repeat(32)),...f.providers,settlementConfig:false,walletMode:'static',
  storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()}});
 try{
  const manager=await wallet.getContractManager();manager.onContractEvent(event=>{events.push(event);});
  const script=(await manager.getContracts())[0]!.script;
  assert.deepEqual(await wallet.getVtxos(),[]);
  // A Tor exit refuses this one script's subscription; the faucet payment lands while it is down.
  f.refuseStreams(new Error('429 Too Many Requests'));
  f.coins.set(script,[coinOn(script,txid)]);
  assert.ok(await until(()=>events.some(event=>event.type==='vtxo_received'&&event.contractScript===script),20_000),'the resumed script reported the payment');
  assert.ok(!events.some(event=>event.type==='connection_reset'),'the whole watched set was never re-read');
  assert.ok((await wallet.getVtxos()).some(vtxo=>vtxo.txid===txid));
 }finally{await wallet.dispose();f.indexer.retire();}
});

test('repeated companion reads inside the sync window cost no indexer requests, and the window reopens after it',async t=>{
 const f=companionFixture();let now=1_800_000_000_000;
 t.mock.method(Date,'now',()=>now);
 const wallet=await createLightningWallet(f.secret,f.providers);
 try{
  now+=PRIVATE_VTXO_SYNC_MAX_AGE_MS+1_000;
  f.reads.length=0;await wallet.getVtxos();const first=f.reads.length;
  assert.ok(first>0,'the first read out of the window syncs every watched script');
  await wallet.getVtxos();await wallet.getBalance();
  assert.equal(f.reads.length,first,'two more reads inside the window add no requests');
  now+=PRIVATE_VTXO_SYNC_MAX_AGE_MS+1_000;
  await wallet.getVtxos();
  assert.equal(f.reads.length,first*2,'the read after the window syncs again');
 }finally{await wallet.dispose();f.indexer.retire();}
});

test('a received-vtxo event reaches a companion read inside the sync window',async t=>{
 const f=companionFixture();let now=1_800_000_000_000;
 t.mock.method(Date,'now',()=>now);
 const wallet=await createLightningWallet(f.secret,f.providers);
 try{
  const script=hex.encode((await wallet.offchainTapscript).pkScript),txid='ab'.repeat(32);
  await wallet.getVtxos();f.reads.length=0;
  const coin=coinOn(script,txid);f.coins.set(script,[coin]);
  f.announce({scripts:[script],newVtxos:[coin],spentVtxos:[],sweptVtxos:[]});
  await settle();
  assert.ok(f.reads.includes(script),'the event synced its own script');
  const synced=f.reads.length,vtxos=await wallet.getVtxos();
  assert.equal(f.reads.length,synced,'the read is served from the window, so the coin can only come from the event');
  assert.ok(vtxos.some(vtxo=>vtxo.txid===txid),'the coin is readable without waiting out the window');
 }finally{await wallet.dispose();f.indexer.retire();}
});

const nativeHost=async()=>{
 Object.defineProperty(globalThis,'__SHIELDED_NATIVE__',{value:{version:1,poolOrigin:'https://pool.example'},configurable:true});
 Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
 Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{value:{invoke:async(command:string)=>command==='native_start'?{phase:'ready',generation:1,mode:'tor'}:undefined,transformCallback:(fn:unknown)=>fn,unregisterCallback(){}},configurable:true});
 const native=await import('../src/native/index.ts');
 await native.nativeNetwork.start();
 return native;
};

test('the native explorer watch polls on the private interval instead of the SDK default',async()=>{
 const {nativeWalletProviders}=await nativeHost();
 const onchain=nativeWalletProviders('https://ark.example','https://ark.example').onchainProvider('mutinynet') as unknown as {pollingInterval:number;forcePolling:boolean};
 const reads=Array.from({length:20},()=>onchain.pollingInterval);
 assert.equal(onchain.forcePolling,true);
 assert.ok(reads.every(ms=>ms>=PRIVATE_ONCHAIN_POLL_MS&&ms<=PRIVATE_ONCHAIN_POLL_MS*1.25),reads.join());
 assert.ok(new Set(reads).size>1,'the interval is re-drawn every round');
});
