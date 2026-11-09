import assert from 'node:assert/strict';
import {test} from 'node:test';
import 'fake-indexeddb/auto';
import {DefaultVtxo,MnemonicIdentity,RestIndexerProvider,SingleKey,type Wallet} from '@arkade-os/sdk';
import {InMemoryAssetSwapRepository,type SwapClient,type SwapClientConfig} from '@arkade-os/swap';
import {hex} from '@scure/base';
import info from './fixtures/ark-info.json' with {type:'json'};
import {recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import {AsyncQueue,IsolatedIndexerProvider} from '../src/native/providers.ts';
import {createLightningWallet,createPrivateLightning,lightningOwner} from '../src/shielded/lightning-wallet.ts';
import {InMemoryLightningRepository} from '../src/shielded/lightning-repository.ts';
import {createLnurlReceive} from '../src/shielded/lnurl-receive.ts';
import type {ShieldedWallet} from '../src/shielded/wallet.ts';
import {startPageLightning} from '../app/src/shielded-page.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const bounded=async<T,>(promise:Promise<T>,stage='startup')=>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`${stage} waited for the unrelated HD look-ahead scan`)),1500);})]);}
 finally{clearTimeout(timer);}
};
async function fixture(){
 const secret=hex.encode(crypto.getRandomValues(new Uint8Array(32))),identity=MnemonicIdentity.fromMnemonic(recoveryPhraseOf(secret),{isMainnet:false});
 const pubKey=await identity.xOnlyPublicKey(),baseline=new Set<string>(),defaultReads=[...new Set(
  [info.signerPubkey,...info.deprecatedSigners.map(row=>row.pubkey)]
   .flatMap(signer=>[info.unilateralExitDelay,info.boardingExitDelay].map(delay=>({signer,delay})))
   .map(({signer,delay})=>hex.encode(new DefaultVtxo.Script({pubKey,serverPubKey:hex.decode(signer.slice(-64)),csvTimelock:{type:'seconds',value:BigInt(delay)}}).pkScript)),
 )];
 for(const row of defaultReads)baseline.add(row);
 for(const signer of [info.signerPubkey,...info.deprecatedSigners.map(row=>row.pubkey)])for(const delay of [info.unilateralExitDelay,info.boardingExitDelay])
  baseline.add(hex.encode(new DefaultVtxo.Script({pubKey,serverPubKey:hex.decode(signer.slice(-64)),csvTimelock:{type:'seconds',value:BigInt(delay)}}).pkScript));
 const boot=deferred(),bootEntered=deferred(),payout=deferred(),payoutEntered=deferred(),readScripts=new Set<string>(),payoutScripts=new Set<string>();
 let held=true,holdPayout=false,subscribed=0;
 const base=new RestIndexerProvider('https://ark.example');
 base.getVtxos=async options=>{
  const script=options!.scripts![0]!;readScripts.add(script);
  if(!baseline.has(script)&&options!.after!==undefined&&!payoutScripts.has(script)&&held){bootEntered.resolve();await boot.promise;}
  if(!baseline.has(script)&&options!.after===undefined&&holdPayout){payoutScripts.add(script);payoutEntered.resolve();await payout.promise;}
  return {vtxos:[]};
 };
 base.subscribeForScripts=async()=>`subscription-${++subscribed}`;
 base.unsubscribeForScripts=async()=>{};
 base.getSubscription=(_id,signal)=>{const queue=new AsyncQueue();signal.addEventListener('abort',()=>queue.end(),{once:true});return queue as ReturnType<Wallet['indexerProvider']['getSubscription']>;};
 const indexer=new IsolatedIndexerProvider('https://ark.example',undefined,base,60_000);
 const providers={arkProvider:{getInfo:async()=>info},indexerProvider:indexer,onchainProvider:{getCoins:async()=>[],getTransactions:async()=>[],getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}}};
 return {secret,pubKey,baseline,providers:providers as unknown as Parameters<typeof createLightningWallet>[1],indexer,bootEntered,payoutEntered,readScripts,
  releaseBoot(){held=false;boot.resolve();},holdPayout(){holdPayout=true;},releasePayout(){holdPayout=false;payout.resolve();}};
}

test('native Lightning can bind its hydrated payout while unrelated SDK HD look-ahead reads wait',async()=>{
 const f=await fixture(),journal=new InMemoryLightningRepository();let active=true,binds=0,finished=false;
 const main={self:{owner:1n},pool:{status:{pool:{token:'pool'}}},changed(){},getAddress:async()=>'test-address'} as unknown as ShieldedWallet;
 const clientFactory=()=>({ready:Promise.resolve(),start:async()=>{},onUpdate:()=>()=>{},[Symbol.asyncDispose]:async()=>{}}) as unknown as SwapClient;
 const aliases:unknown[]=[],receiver={handle:'ab'.repeat(32),username:null,lightningAddress:null,domain:'lnurl.example',status:'active',lnurl:'LNURL1SESSION',nameless:true,sessionLnurl:'LNURL1SESSION'};
 const fetcher=async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/lnurl/address')){if(init?.method==='POST'){aliases.push(receiver);return Response.json(receiver);}return Response.json(aliases);}
  if(url.endsWith('/arkade')){binds++;return Response.json({ok:true});}
  throw new Error('Unexpected LNURL request');
 };
 const start=startPageLightning({
  pairing:createLightningWallet(f.secret,{...f.providers,lazyInitialization:true}),
  swaps:companion=>createPrivateLightning({wallet:main,companion,journal,clientFactory:clientFactory as (config:SwapClientConfig)=>SwapClient,repositoryFor:()=>new InMemoryAssetSwapRepository(),acquireSession:async()=>async()=>{}}),
  lnurl:async(companion,swaps)=>createLnurlReceive({identity:SingleKey.fromHex('22'.repeat(32)),companion,journal,owner:await lightningOwner(companion),pool:'pool',baseUrl:'https://lnurl.example',fetch:fetcher,onPayouts:async rows=>(await swaps).registerPayouts(rows)}),
  active:()=>active,handOver(){},report(error){throw error;},
 });
 let parts:Awaited<typeof start>;
 try{
  await bounded(f.bootEntered.promise,'first look-ahead read');
  parts=await bounded(start,'Lightning handover');assert.ok(parts);
  f.holdPayout();const unified=parts.lnurl.ensureUnified().then(value=>{finished=true;return value;});
  await bounded(f.payoutEntered.promise,'payout hydration');assert.equal(finished,false);assert.equal(binds,0);
  f.releasePayout();assert.equal((await bounded(unified,'unified receiver')).lnurl,'LNURL1SESSION');assert.equal(binds,1);
  const manager=await parts.companion.getContractManager(),[registered]=await parts.lnurl.payouts();
  assert.equal((await manager.getContracts({script:[registered!.script]}))[0]?.watch,'watched');
  f.releaseBoot();await bounded(manager.whenBooted());assert.ok(f.readScripts.size>=43);assert.equal(manager.getSyncState().mode,'online');
  const legacyScript=hex.encode(new DefaultVtxo.Script({pubKey:f.pubKey,serverPubKey:hex.decode(info.signerPubkey.slice(-64)),csvTimelock:{type:'seconds',value:BigInt(info.unilateralExitDelay)}}).pkScript);
   assert.ok(f.readScripts.has(legacyScript),'fixture actually read the default legacy funding script');
 }finally{
  active=false;f.releaseBoot();f.releasePayout();parts??=await start;
  await parts?.lnurl.dispose();await parts?.swaps[Symbol.asyncDispose]();await parts?.companion.dispose();f.indexer.retire();await journal[Symbol.asyncDispose]();
 }
});

test('the default companion still waits for SDK HD look-ahead initialization',async()=>{
 const f=await fixture();let ready=false;const opening=createLightningWallet(f.secret,f.providers).then(wallet=>{ready=true;return wallet;});
 try{await bounded(f.bootEntered.promise);await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);}
 finally{f.releaseBoot();const wallet=await opening;await wallet.dispose();f.indexer.retire();}
});
