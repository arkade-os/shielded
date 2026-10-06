import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EngineStore} from '../src/storage.ts';
import {createStockInstallation,type StockInstallationRecord,type StockInstallationContext} from '../src/stock/install.ts';

const pin:any={version:1,network:'mutinynet',networkInfo:{arkUrl:'https://ark.test',emulatorUrl:'https://emulator.test',indexerUrl:'https://indexer.test'},descriptorProfileId:'profile',programsHash:'programs',artifactsHash:'artifacts',checkpointHash:'checkpoint',serverKey:'server',emulatorKey:'emulator',policyVersion:1,developmentOnly:true};
const manifest:any={version:1};
const programs:any={version:1};
const base=():StockInstallationRecord=>({version:1,network:{name:'mutinynet',arkUrl:pin.networkInfo.arkUrl,emulatorUrl:pin.networkInfo.emulatorUrl,indexerUrl:pin.networkInfo.indexerUrl,dataDirectory:'/data'},funding:{kind:'mnemonic',secret:'never-public mnemonic',publicKey:'owner'},manifest,programs});
const coin=(txid:string,value:number)=>({txid,vout:0,value,sourceTxHex:'aa',tapTreeHex:'bb',leafHex:'cc'});
function harness(args:{coins?:ReturnType<typeof coin>[];phase?:string;reconcile?:any;planFailure?:boolean;activationFailure?:boolean;pinOverride?:any;saved?:any;failSaveAt?:number;failReconcileAt?:number}={}){
 const writes:any[]=[];let opened=0,closed=0,plans=0,applies=0,reconciles=0,activations=0;
 let coins=args.coins??[];
 let activationFailure=!!args.activationFailure;
 let saveCount=0,currentSaved=args.saved;const store={load:<T>()=>currentSaved as T|undefined,save:(value:unknown)=>{saveCount++;if(saveCount===args.failSaveAt)throw Error('disk error');currentSaved=structuredClone(value);writes.push(structuredClone(value));}};
 let applied=false;
 const context:StockInstallationContext={pin:args.pinOverride??pin,fundingAddress:'tark1public-address',get coins(){return coins;},close:()=>{closed++;},makeBootstrap:async(_evidence,_fingerprint)=>({
  status:()=>({phase:applied?'indexed':args.phase??'empty',blocked:(args.phase??'').includes('unknown')}),
  plan:async(outpoint:string)=>{plans++;assert.equal(((writes.at(-1)??args.saved) as StockInstallationRecord|undefined)?.outpoint,outpoint);if(args.planFailure)throw Error('private details');return {outpoint,releaseFingerprint:'a'.repeat(64)} as any;},
  apply:async()=>{applies++;applied=true;return {phase:'indexed',releaseDirectory:'/release'} as any;},
  reconcile:async()=>{reconciles++;if(reconciles===args.failReconcileAt)throw Error('release publication failure');if(applied||(args.phase==='indexed'))return {resolved:true,phase:'indexed'} as any;if(args.reconcile)return args.reconcile;return {resolved:false,phase:args.phase??'unknown-submit'} as any;},
 }) as any};
 const controller=createStockInstallation({store,record:base(),openContext:async()=>{opened++;return context;},qualify:async()=>({} as any),activate:async()=>{activations++;if(activationFailure)throw Error('private activation details');}});
 return {controller,writes,get saved(){return currentSaved;},setCoins:(value:ReturnType<typeof coin>[])=>{coins=value;},setActivationFailure:(value:boolean)=>{activationFailure=value;},counts:()=>({opened,closed,plans,applies,reconciles,activations})};
}

test('no eligible coin exposes only the public funding address and submits nothing',async()=>{
 const h=harness({coins:[coin('1'.repeat(64),500)]});await h.controller.step();
 assert.equal(h.controller.status().phase,'waiting-funds');assert.equal(h.controller.status().fundingAddress,'tark1public-address');assert.equal(h.controller.status().message,undefined);assert.equal(h.counts().plans,0);assert.equal(JSON.stringify(h.controller.status()).includes('never-public mnemonic'),false);assert.equal(h.counts().closed,1);
});

test('selects the smallest eligible coin and persists its exact outpoint before planning',async()=>{
 const h=harness({coins:[coin('3'.repeat(64),1000),coin('2'.repeat(64),660),coin('1'.repeat(64),330)]});await h.controller.step();
 assert.equal((h.writes.at(-2) as StockInstallationRecord).outpoint,`${'1'.repeat(64)}:0`);assert.equal(h.counts().plans,1);assert.equal(h.counts().applies,1);assert.equal(h.controller.status().phase,'ready');assert.equal((h.writes.at(-1) as StockInstallationRecord).initialized,true);
});

test('unresolved submit reconciles once and never submits or picks another coin',async()=>{
 const h=harness({coins:[coin('1'.repeat(64),660)],phase:'unknown-submit',reconcile:{resolved:false,phase:'unknown-submit'}});await h.controller.step();
 assert.equal(h.controller.status().phase,'recovering');assert.equal(h.counts().reconciles,1);assert.equal(h.counts().applies,0);assert.equal(h.counts().plans,1);assert.equal((h.writes.at(-1) as StockInstallationRecord).outpoint,`${'1'.repeat(64)}:0`);
});

test('initialized installation retries activation without opening bootstrap context',async()=>{
 const saved={...base(),pin,outpoint:`${'1'.repeat(64)}:0`,releaseFingerprint:'a'.repeat(64),initialized:true};
 const h=harness({saved,activationFailure:true});await assert.rejects(h.controller.step(),/private activation details/);assert.equal(h.controller.status().phase,'blocked');assert.equal(h.counts().opened,0);assert.equal((h.saved as StockInstallationRecord).initialized,true);assert.equal((h.saved as StockInstallationRecord).serviceInitialized,undefined);
 h.setActivationFailure(false);await h.controller.step();assert.equal(h.counts().opened,0);assert.equal(h.counts().activations,2);assert.equal((h.saved as StockInstallationRecord).serviceInitialized,true);
});

test('pin drift blocks bootstrap and closes the context',async()=>{
 const old={...pin,serverKey:'old'};const saved={...base(),pin:old};
 const h=harness({saved,pinOverride:pin,coins:[coin('1'.repeat(64),660)]});await assert.rejects(h.controller.step(),/Persisted verifier or network pin changed/);
 assert.equal(h.controller.status().phase,'blocked');assert.equal(h.counts().plans,0);assert.equal(h.counts().closed,1);
});

test('concurrent step calls share one operation',async()=>{
 const h=harness({coins:[coin('1'.repeat(64),660)]});const a=h.controller.step(),b=h.controller.step();assert.equal(a,b);await Promise.all([a,b]);assert.equal(h.counts().opened,1);assert.equal(h.counts().plans,1);
});

test('record persistence failure prevents opening providers or planning',async()=>{
 let opened=0;const controller=createStockInstallation({store:{load:()=>undefined,save:()=>{throw Error('disk error');}},record:base(),openContext:async()=>{opened++;throw Error('must not run');},qualify:async()=>({} as any),activate:async()=>undefined});
 await assert.rejects(controller.step(),/disk error/);assert.equal(controller.status().phase,'blocked');assert.equal(opened,0);
});

test('release fingerprint must persist before bootstrap apply',async()=>{
 const h=harness({coins:[coin('1'.repeat(64),660)],failSaveAt:4});await assert.rejects(h.controller.step(),/disk error/);
 assert.equal(h.counts().plans,1);assert.equal(h.counts().applies,0);assert.equal(h.controller.status().phase,'blocked');
});

test('missing bootstrap journal after saving its release fingerprint fails closed',async()=>{
 const saved={...base(),pin,outpoint:`${'1'.repeat(64)}:0`,releaseFingerprint:'a'.repeat(64)};
 const h=harness({saved,phase:'empty',coins:[coin('1'.repeat(64),660)]});await assert.rejects(h.controller.step(),/Persisted bootstrap journal is missing/);
 assert.equal(h.counts().plans,0);assert.equal(h.counts().applies,0);assert.equal(h.controller.status().phase,'blocked');
});

test('indexed release publication failure retries before initialization',async()=>{
 const h=harness({coins:[coin('1'.repeat(64),660)],failReconcileAt:1});await assert.rejects(h.controller.step(),/release publication failure/);
 assert.equal(h.controller.status().phase,'blocked');assert.notEqual((h.writes.at(-1) as StockInstallationRecord).initialized,true);assert.equal(h.counts().activations,0);
 await h.controller.step();assert.equal(h.controller.status().phase,'ready');assert.equal(h.counts().activations,1);assert.equal((h.writes.at(-1) as StockInstallationRecord).initialized,true);
});

test('encrypted installation record resumes the same accepted bootstrap after restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'shielded-stock-install-')),key='f'.repeat(64),outpoint=`${'1'.repeat(64)}:0`;
 const external:{phase:string;planOutpoint?:string;submits:number;lookups:number;published:number}={phase:'empty',submits:0,lookups:0,published:0};
 const createContext=(coins:ReturnType<typeof coin>[])=>({pin,fundingAddress:'tark1public-address',coins,close(){},makeBootstrap:async()=>({
  status:()=>({phase:external.phase,blocked:external.phase==='unknown-submit'}),
  plan:async(exact:string)=>{if(external.planOutpoint)assert.equal(exact,external.planOutpoint);else{external.planOutpoint=exact;external.phase='planned';}return {outpoint:exact,releaseFingerprint:'a'.repeat(64)};},
  apply:async()=>{assert.equal(external.phase,'planned');external.submits++;external.phase='unknown-submit';throw new Error('simulated lost submit response');},
  reconcile:async()=>{if(external.phase==='unknown-submit'){external.lookups++;assert.equal(external.planOutpoint,outpoint);external.phase='indexed';return {resolved:true,phase:'indexed'};}if(external.phase==='indexed'){external.published++;return {resolved:true,phase:'indexed'};}return {resolved:false,phase:external.phase};},
 }) as any});
 let firstStore:EngineStore|undefined,secondStore:EngineStore|undefined;
 try{
  firstStore=EngineStore.open(directory,key);
  const first=createStockInstallation({store:firstStore,record:base(),openContext:async()=>createContext([coin('1'.repeat(64),660)]) as StockInstallationContext,qualify:async()=>({} as any),activate:async()=>undefined});
  await assert.rejects(first.step(),/simulated lost submit response/);assert.equal(first.status().phase,'blocked');assert.equal(external.submits,1);
  firstStore.close();firstStore=undefined;
  secondStore=EngineStore.open(directory,key);
  const second=createStockInstallation({store:secondStore,record:base(),openContext:async()=>createContext([coin('2'.repeat(64),900)]) as StockInstallationContext,qualify:async()=>({} as any),activate:async(record)=>{assert.equal(record.initialized,true);}});
  await second.step();
  const saved=secondStore.load<StockInstallationRecord>()!;
  assert.equal(saved.outpoint,outpoint);assert.equal(saved.initialized,true);assert.equal(saved.serviceInitialized,true);assert.equal(second.status().phase,'ready');
  assert.equal(external.submits,1);assert.equal(external.lookups,1);assert.ok(external.published>0);
 }finally{firstStore?.close();secondStore?.close();rmSync(directory,{recursive:true,force:true});}
});

test('an unavailable selected coin never prevents exact-identity recovery',async()=>{
 for(const phase of ['unknown-submit','response-verified','finalized','indexed']){
  const saved={...base(),pin,outpoint:`${'1'.repeat(64)}:0`,releaseFingerprint:'a'.repeat(64)};
  const h=harness({saved,phase,reconcile:{resolved:false,phase},coins:[]});await h.controller.step();
  assert.equal(h.counts().plans,1,phase);assert.equal((h.saved as StockInstallationRecord).outpoint,`${'1'.repeat(64)}:0`,phase);
  if(phase==='unknown-submit'){assert.equal(h.controller.status().phase,'recovering');assert.equal(h.counts().applies,0);}
  else assert.equal(h.controller.status().phase,'ready',phase);
 }
});

test('a later coin cannot replace the journaled outpoint',async()=>{
 const saved={...base(),pin,outpoint:`${'1'.repeat(64)}:0`};
 const h=harness({saved,phase:'planned',coins:[coin('2'.repeat(64),660)]});await h.controller.step();
 assert.equal(h.controller.status().phase,'recovering');assert.equal(h.counts().applies,0);assert.equal((h.saved as StockInstallationRecord).outpoint,`${'1'.repeat(64)}:0`);
 h.setCoins([coin('1'.repeat(64),660),coin('2'.repeat(64),660)]);await h.controller.step();assert.equal(h.controller.status().phase,'ready');assert.equal((h.saved as StockInstallationRecord).outpoint,`${'1'.repeat(64)}:0`);
});
