import type {EngineStore} from '../storage.ts';
import {createStockBootstrap,type StockBootstrapInput,type StockBootstrapPin,type StockProfileWeightEvidence} from './bootstrap.ts';
import type {StockProgramManifest} from './sdk.ts';
import type {StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import {stockJournalFingerprint} from './journal.ts';

export interface StockInstallationRecord {
 version:1;
 network:{name:'mutinynet';arkUrl:string;emulatorUrl:string;indexerUrl:string;dataDirectory:string};
 funding:{kind:'mnemonic'|'single-key';secret:string;publicKey:string};
 manifest:StockArtifactManifest;
 programs:StockProgramManifest;
 pin?:StockBootstrapPin;
 outpoint?:string;
 releaseFingerprint?:string;
 initialized?:boolean;
 serviceInitialized?:boolean;
}

export interface StockSetupStatus {
 version:1;
 phase:'starting'|'qualifying'|'waiting-funds'|'bootstrapping'|'recovering'|'ready'|'blocked';
 network:'mutinynet';
 fundingAddress?:string;
 minimumFundingSats:660;
 releaseFingerprint?:string;
 message?:string;
}

export interface StockInstallationContext {
 pin:StockBootstrapPin;
 fundingAddress:string;
 coins:StockBootstrapInput[];
 makeBootstrap(evidence:StockProfileWeightEvidence,expectedReleaseFingerprint?:string):Promise<Awaited<ReturnType<typeof createStockBootstrap>>>;
 close():void;
}

export interface StockInstallationOptions {
 store:Pick<EngineStore,'load'|'save'>;
 record:StockInstallationRecord;
 openContext:(record:StockInstallationRecord)=>Promise<StockInstallationContext>;
 qualify:(pin:StockBootstrapPin)=>Promise<StockProfileWeightEvidence>;
 activate:(record:StockInstallationRecord)=>Promise<void>;
}

const same=(a:unknown,b:unknown)=>stockJournalFingerprint(a)===stockJournalFingerprint(b);
const fundingIdentity=(record:StockInstallationRecord)=>({version:record.version,network:record.network,funding:record.funding,manifest:record.manifest,programs:record.programs});
const phases=new Set(['submit-started','unknown-submit','finalize-started','unknown-finalize']);
type BootstrapPhase=ReturnType<Awaited<ReturnType<typeof createStockBootstrap>>['status']>['phase'];

export function createStockInstallation(options:StockInstallationOptions){
 let record=structuredClone(options.record),current:StockSetupStatus={version:1,phase:'starting',network:'mutinynet',minimumFundingSats:660};
 let running:Promise<void>|undefined;
 const save=()=>options.store.save(structuredClone(record));
 const status=()=>structuredClone(current);
 const set=(phase:StockSetupStatus['phase'],message?:string,fundingAddress?:string)=>{
  current={version:1,phase,network:'mutinynet',minimumFundingSats:660,...(fundingAddress?{fundingAddress}:{}),...(record.releaseFingerprint?{releaseFingerprint:record.releaseFingerprint}:{}),...(message?{message}:{})};
 };
 const run=async()=>{
  let context:StockInstallationContext|undefined;
  try{
   set('starting');
   const saved=options.store.load<StockInstallationRecord>();
   if(saved){
    if(saved.version!==1||!same(fundingIdentity(saved),fundingIdentity(record)))throw new Error('Stored installation does not match configured network, wallet, or verifier.');
    record=structuredClone(saved);
   }else save();
   if(record.initialized){await options.activate(structuredClone(record));record.serviceInitialized=true;save();set('ready');return;}
   context=await options.openContext(structuredClone(record));
   if(context.pin.network!=='mutinynet'||context.pin.networkInfo.arkUrl!==record.network.arkUrl||context.pin.networkInfo.emulatorUrl!==record.network.emulatorUrl||context.pin.networkInfo.indexerUrl!==record.network.indexerUrl)throw new Error('Network pin differs from installation configuration.');
   if(record.pin&&!same(record.pin,context.pin))throw new Error('Persisted verifier or network pin changed.');
   if(!record.pin){record.pin=structuredClone(context.pin);save();}
   set('qualifying',undefined,context.fundingAddress);
   const evidence=await options.qualify(context.pin);
   const eligible=context.coins.filter(coin=>coin.value===330||coin.value>=660).sort((a,b)=>a.value-b.value||a.txid.localeCompare(b.txid)||a.vout-b.vout);
   if(!record.outpoint){
    if(!eligible.length){set('waiting-funds',undefined,context.fundingAddress);return;}
    record.outpoint=`${eligible[0]!.txid.toLowerCase()}:${eligible[0]!.vout}`;save();
   }
   const first=await context.makeBootstrap(evidence,record.releaseFingerprint);
   const initial=first.status();
   if(record.releaseFingerprint&&initial.phase==='empty')throw new Error('Persisted bootstrap journal is missing; refusing to recreate genesis.');
   const selected=context.coins.find(coin=>`${coin.txid.toLowerCase()}:${coin.vout}`===record.outpoint);
   if(!selected&&(initial.phase==='empty'||initial.phase==='planned')){
    set('recovering','The journaled funding coin is unavailable; setup is waiting for that exact coin.',context.fundingAddress);return;
   }
   const plan=await first.plan(record.outpoint);
   if(record.releaseFingerprint&&record.releaseFingerprint!==plan.releaseFingerprint)throw new Error('Bootstrap release fingerprint changed.');
   if(!record.releaseFingerprint){record.releaseFingerprint=plan.releaseFingerprint;save();}
   const engine=await context.makeBootstrap(evidence,record.releaseFingerprint);
   const before=engine.status();
   set(phases.has(before.phase)?'recovering':'bootstrapping',undefined,context.fundingAddress);
   let phase:BootstrapPhase=before.phase;
   if(phases.has(before.phase)){
    const reconciled=await engine.reconcile();
    if(reconciled.phase!=='indexed'&&reconciled.phase!=='response-verified'){
     set('recovering','A previous transaction outcome is unresolved; no new transaction was submitted.',context.fundingAddress);return;
    }
    phase=reconciled.phase;
   }
   if(phase!=='indexed'){
    const applied=await engine.apply(record.outpoint);
    if(applied.phase!=='indexed'){
     set('recovering','The bootstrap transaction is awaiting indexing.',context.fundingAddress);return;
    }
   }
   const published=await engine.reconcile();
   if(!published.resolved||published.phase!=='indexed'){
    set('recovering','The indexed bootstrap release is not ready yet.',context.fundingAddress);return;
   }
   record.initialized=true;save();
   await options.activate(structuredClone(record));
   record.serviceInitialized=true;save();
   set('ready',undefined,context.fundingAddress);
  }catch(error){
   set('blocked','Setup stopped safely; check server logs.');
   throw error;
  }finally{context?.close();}
 };
 const step=()=>{
  if(running)return running;
  running=run().finally(()=>{running=undefined;});
  return running;
 };
 return {step,status};
}
