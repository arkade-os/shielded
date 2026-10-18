import {OnchainWallet,Transaction,UnilateralExit,deserializeExitPackage,serializeExitPackage,timelockToSequence,type ExecutorEvent,type ExitOptions,type ExitPackage,type ExitQuote,type OnchainProvider,type Wallet} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import type {LightningRepository} from './lightning-repository.ts';

export interface LightningRecovery {
 v:1;outpoint:string;pool:string;createdAt:number;state:'preparing'|'ready'|'paused'|'complete'|'shielded';quote:ExitQuote;package?:ExitPackage;event?:ExecutorEvent;error?:string;running?:boolean;
}
export const recoveryLock=(owner:string,outpoint:string)=>`shielded-lightning-${owner}-payout-${outpoint}`;
const storagePool='onchain-recovery',storageKey='active-exit';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const terminal=(record:LightningRecovery)=>record.state==='complete'||record.state==='shielded';

function checkPackage(pkg:ExitPackage,outpoint:string,quote:ExitQuote,onchain:OnchainWallet){
 const info=pkg.vtxos[0],expected=quote.vtxos[0],fail=()=>{throw new Error('The saved recovery package does not match this payout, wallet or quoted budget.');};
 if(pkg.version!==1||pkg.mode!=='funded'||pkg.network!=='mutinynet'||pkg.sweepAddress!==onchain.address||pkg.feeRate!==quote.feeRate||pkg.vtxos.length!==1||info?.outpoint!==outpoint||info.skipped||info.value!==expected?.value||JSON.stringify(info.delay)!==JSON.stringify(expected.delay))fail();
 for(const key of ['txCount','totalFeeSats','fundingRequiredSats','recoveredSats'] as const)if(!Number.isSafeInteger(pkg.totals[key])||pkg.totals[key]<0)fail();
 if(pkg.totals.totalFeeSats>quote.totals.totalFeeSats||pkg.totals.fundingRequiredSats>quote.totals.fundingRequiredSats||pkg.totals.recoveredSats<quote.totals.recoveredSats||pkg.totals.recoveredSats<=0)fail();
 const sweeps=pkg.steps.filter(s=>s.kind==='sweep'),funding=pkg.steps.filter(s=>s.kind==='broadcast'),parents=pkg.steps.filter(s=>s.kind==='package');
 if(sweeps.length!==1||funding.length!==(parents.length?1:0)||funding.length&&pkg.steps[0]!==funding[0]||pkg.steps.length!==sweeps.length+funding.length+parents.length||pkg.totals.txCount!==funding.length+parents.length*2+1)fail();
 const sameOutput=(tx:Transaction)=>{for(let i=0;i<tx.outputsLength;i++)if(hex.encode(tx.getOutput(i).script!)!==hex.encode(onchain.onchainP2TR.script))fail();};
 for(const step of pkg.steps){
  if(step.kind==='bump')fail();
  else if(step.kind==='package'){
   const parent=Transaction.fromRaw(hex.decode(step.parentHex)),child=Transaction.fromRaw(hex.decode(step.childHex));
   if(parent.id!==step.parentTxid||child.id!==step.childTxid||step.forVtxos.length!==1||step.forVtxos[0]!==outpoint)fail();sameOutput(child);
  }else{
   const tx=Transaction.fromRaw(hex.decode(step.hex));if(tx.id!==step.txid)fail();sameOutput(tx);
   if(step.kind==='sweep'){
    const input=tx.getInput(0),delay=expected.delay;
    if(!delay||step.vtxo!==outpoint||step.dependsOnTxid!==outpoint.split(':')[0]||JSON.stringify(step.delay)!==JSON.stringify(delay)||tx.inputsLength!==1||`${hex.encode(input.txid!)}:${input.index}`!==outpoint||input.sequence!==timelockToSequence({type:delay.type,value:BigInt(delay.value)})||tx.outputsLength!==1||tx.getOutput(0).amount!==BigInt(pkg.totals.recoveredSats))fail();
   }
  }
 }
}

export function createLightningRecovery(o:{owner:string;pool:string;companion:Wallet;journal:LightningRepository;acquireSession:(name:string)=>Promise<()=>Promise<void>>;options:(outpoint:string)=>Promise<ExitOptions>;stopShielding:(outpoint:string)=>Promise<void>;reconcileShielding:(outpoint:string)=>Promise<void>;changed:()=>void;report:(error:unknown)=>void}){
 const quotes=new Map<string,{quote:ExitQuote;at:number}>();let closed=false,preparing:Promise<LightningRecovery>|undefined,job:Promise<void>|undefined,controller:AbortController|undefined;
 const assertOpen=()=>{if(closed)throw new Error('Private Lightning service is closed');};
 const onchain=()=>OnchainWallet.create(o.companion.identity,'mutinynet',o.companion.onchainProvider);
 const load=async()=>{
  const records=await o.journal.getReceiveState<Record<string,LightningRecovery>>(o.owner,storagePool,storageKey)??{};
  if(!records||typeof records!=='object'||Array.isArray(records))throw new Error('Unreadable onchain recovery; shielding remains paused.');
  for(const [key,record] of Object.entries(records)){
   if(!record||record.v!==1||key!==record.outpoint||!/^([0-9a-f]{64}):(0|[1-9]\d*)$/.test(record.outpoint)||!record.pool||!Number.isSafeInteger(record.createdAt)||!['preparing','ready','paused','complete','shielded'].includes(record.state)||!record.quote||!['preparing','shielded'].includes(record.state)&&!record.package)throw new Error('Unreadable onchain recovery; shielding remains paused.');
   if(record.package)checkPackage(deserializeExitPackage(serializeExitPackage(record.package)),record.outpoint,record.quote,await onchain());
  }
  return records;
 };
 const save=async(record:LightningRecovery)=>{const records=await load();records[record.outpoint]=record;await o.journal.saveReceiveState(o.owner,storagePool,storageKey,records);o.changed();};
 const get=async(outpoint:string)=>{const record=(await load())[outpoint];return record?{...record,running:!!job&&!terminal(record)}:undefined;};
 const held=async(outpoint:string)=>!!(await load())[outpoint];
 const remember=(outpoint:string,quote:ExitQuote)=>{quotes.set(outpoint,{quote,at:Date.now()});};
 const prepareInner=async(outpoint:string,quote:ExitQuote)=>{
  assertOpen();const release=await o.acquireSession(`shielded-lightning-${o.owner}-onchain-exit`);let releasePayout:(()=>Promise<void>)|undefined,record:LightningRecovery|undefined;
  try{
   const records=await load(),old=records[outpoint];if(old?.package)return {...old,running:!!job};
   if(old?.outpoint===outpoint&&old.pool!==o.pool)throw new Error('Resume shielding reconciliation in the original pool before preparing recovery.');
   if(Object.values(records).some(r=>r.outpoint!==outpoint&&!terminal(r)))throw new Error('Another payout already has an onchain recovery; finish it first.');
   const consent=quotes.get(outpoint);
   if(consent?.quote!==quote||Date.now()-consent.at>300_000)throw new Error('Refresh this payout recovery quote before preparing it.');
   if(quote.shortfallSats>0)throw new Error('Fund the onchain wallet and refresh the recovery quote first.');
   record={v:1,outpoint,pool:o.pool,createdAt:Date.now(),state:'preparing',quote};assertOpen();await save(record);
   await o.stopShielding(outpoint);releasePayout=await o.acquireSession(recoveryLock(o.owner,outpoint));
   await o.reconcileShielding(outpoint);const options=await o.options(outpoint);assertOpen();
   let splitter:string|undefined;
   // Stage the SDK's prepare-time broadcast so the complete package is durable before funds move.
   const provider=new Proxy(o.companion.onchainProvider,{get(target,key){
    if(key==='broadcastTransaction')return async(raw:string,...extra:string[])=>{assertOpen();if(splitter||extra.length)throw new Error('Unexpected recovery preparation broadcast');splitter=raw;return Transaction.fromRaw(hex.decode(raw)).id;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }});
   const staged=await OnchainWallet.create(o.companion.identity,'mutinynet',provider);
   const pkg=await UnilateralExit.prepare({...options,onchainWallet:staged,feeRate:quote.feeRate,mode:'funded'});assertOpen();checkPackage(pkg,outpoint,quote,staged);
   const broadcast=pkg.steps.find(s=>s.kind==='broadcast');if(splitter!==broadcast?.hex)throw new Error('The staged funding transaction changed.');
   record.package=pkg;record.state='ready';await save(record);return (await get(outpoint))!;
  }catch(error){
   if(record&&!record.package&&(error as {code?:string})?.code==='lightning-payout-shielded'){record.state='shielded';await save(record);}
   throw error;
  }finally{await releasePayout?.();await release();}
 };
 const prepare=(outpoint:string,quote:ExitQuote)=>{
  if(preparing)return Promise.reject(new Error('A recovery package is already being prepared.'));
  const task=prepareInner(outpoint,quote);preparing=task;void task.finally(()=>{if(preparing===task)preparing=undefined;}).catch(()=>{});return task;
 };
 const start=async(outpoint:string)=>{
  assertOpen();if(job)throw new Error('Onchain recovery is already running.');
  const release=await o.acquireSession(`shielded-lightning-${o.owner}-onchain-exit`);let releasePayout:(()=>Promise<void>)|undefined;
  try{
   const record=(await load())[outpoint];assertOpen();if(!record?.package)throw new Error('Prepare and save this payout recovery first.');
   if(record.state==='complete'){await release();return;}
   await o.stopShielding(outpoint);releasePayout=await o.acquireSession(recoveryLock(o.owner,outpoint));assertOpen();
   controller=new AbortController();const signal=controller.signal,pkg=record.package;
   const provider:OnchainProvider=new Proxy(o.companion.onchainProvider,{get(target,key){
    if(key==='broadcastTransaction')return async(...args:Parameters<OnchainProvider['broadcastTransaction']>)=>{assertOpen();signal.throwIfAborted();return target.broadcastTransaction(...args);};
    if(key==='getTxStatus')return async(txid:string)=>{
     const status=await target.getTxStatus(txid),step=pkg.steps.find(s=>s.kind==='package'&&s.parentTxid===txid);
     if(!status.confirmed&&step?.kind==='package'){try{await target.getTxStatus(step.childTxid);}catch{throw new Error('Resubmit the saved parent and fee child together');}}
     return status;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }});
   record.state='paused';delete record.error;await save(record);
   const executor=await UnilateralExit.execute(o.companion,pkg,{provider,signal});
   const run=(async()=>{
    try{
     for await(const event of executor){
      record.event=event;if(event.status==='failed')throw new Error(event.reason??'Onchain recovery failed; the saved package is retained.');
      const sweep=pkg.steps.find(s=>s.kind==='sweep');
      if(event.kind==='sweep'&&event.status==='confirmed'&&sweep?.kind==='sweep'&&event.txid===sweep.txid)record.state='complete';
      await save(record);
     }
     if(record.state!=='complete')throw new Error('Recovery stopped before the sweep confirmed.');
    }catch(error){if(record.state!=='complete'){record.state='paused';if(!signal.aborted)record.error=message(error);await save(record).catch(o.report);}}
    finally{await releasePayout?.();await release();job=undefined;controller=undefined;o.changed();}
   })();job=run;void run.catch(o.report);o.changed();
  }catch(error){await releasePayout?.();await release();throw error;}
 };
 const pause=async()=>{controller?.abort();await job;};
 return {get,list:async()=>Object.values(await load()),held,remember,prepare,start,pause,async dispose(){closed=true;await pause();await preparing?.catch(()=>{});}};
}
