import {createHash} from 'node:crypto';
import {EngineStore} from '../storage.ts';

export interface StockReleasePin {
 version:1;
 network:'mutinynet'|'local-stock';
 descriptorProfileId:string;
 programsHash:string;
 artifactsHash:string;
 checkpointHash:string;
 genesisTxid:string;
 serverKey:string;
 emulatorKey:string;
}
export interface StockJournalReceipt {txid:string;checkpointTxids:string[]}
interface Pending<P,R> {id:string;fingerprint:string;plan:P;stage:'submitted'|'accepted';receipt?:R}
interface Saved<A,P,R> {version:1;pin:StockReleasePin;archive:A;accepted:Record<string,{fingerprint:string;receipt:R}>;pending?:Pending<P,R>}
export interface StockJournalHooks<A,P,R extends StockJournalReceipt> {
 validateArchive(archive:A):Promise<void>|void;
 validatePlan(plan:P,archive:A):Promise<void>|void;
 verifyReceipt(plan:P,receipt:R):Promise<void>|void;
 transmit(plan:P):Promise<R>;
 lookup(plan:P):Promise<R|undefined>;
 apply(archive:A,plan:P,receipt:R):Promise<A>|A;
 /** True only when the network proves a submitted plan can never be accepted; reconcile then drops it. */
 abandoned?(plan:P):Promise<boolean>|boolean;
}
function canonical(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 }
 throw new Error('Stock journal values must contain only canonical public JSON data.');
}
export const stockJournalFingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function validatePin(pin:StockReleasePin):void {
 if(!pin||pin.version!==1||!['mutinynet','local-stock'].includes(pin.network))throw new Error('Unsupported stock release pin.');
 for(const name of ['descriptorProfileId','programsHash','artifactsHash','checkpointHash','genesisTxid','serverKey','emulatorKey'] as const)if(!/^[0-9a-f]{64}$/.test(pin[name]))throw new Error('Invalid stock release '+name+'.');
 if(pin.serverKey===pin.emulatorKey)throw new Error('The platform signer keys must be distinct.');
}

export async function openStockJournal<A,P,R extends StockJournalReceipt>(directory:string,pin:StockReleasePin,initialArchive:A,hooks:StockJournalHooks<A,P,R>){
 validatePin(pin);
 const store=EngineStore.open(directory);
 let saved:Saved<A,P,R>,busy=false,closed=false;
 try{
  const previous=store.load<Saved<A,P,R>>();
  if(previous&&(previous.version!==1||stockJournalFingerprint(previous.pin)!==stockJournalFingerprint(pin)))throw new Error('Persisted stock genesis, verifier, artifacts, network, or signer keys changed.');
  saved=previous??{version:1,pin:structuredClone(pin),archive:structuredClone(initialArchive),accepted:{}};
  if(!saved.accepted||typeof saved.accepted!=='object'||Array.isArray(saved.accepted))throw new Error('Invalid stock acceptance journal.');
  await hooks.validateArchive(structuredClone(saved.archive));
  if(saved.pending){
   const pending=saved.pending;
   if(!/^[A-Za-z0-9._:-]{1,128}$/.test(pending.id)||!['submitted','accepted'].includes(pending.stage)||pending.fingerprint!==stockJournalFingerprint(pending.plan)||(pending.stage==='accepted'&&!pending.receipt))throw new Error('Invalid pending stock outcome.');
   await hooks.validatePlan(structuredClone(pending.plan),structuredClone(saved.archive));
   if(pending.receipt)await hooks.verifyReceipt(structuredClone(pending.plan),structuredClone(pending.receipt));
  }
  if(!previous)store.save(saved);
 }catch(error){store.close();throw error;}
 const persist=(next:Saved<A,P,R>)=>{store.save(next);saved=next;};
 const ensure=()=>{if(closed)throw new Error('Stock journal is closed.');if(busy)throw new Error('Another stock operation is in flight.');};
 const finish=async(receipt:R)=>{
  const pending=saved.pending!;
  await hooks.verifyReceipt(structuredClone(pending.plan),structuredClone(receipt));
  if(pending.stage!=='accepted')persist({...saved,pending:{...pending,stage:'accepted',receipt:structuredClone(receipt)}});
  const archive=await hooks.apply(structuredClone(saved.archive),structuredClone(pending.plan),structuredClone(receipt));
  await hooks.validateArchive(structuredClone(archive));
  const next:Saved<A,P,R>={...saved,archive,accepted:{...saved.accepted,[pending.id]:{fingerprint:pending.fingerprint,receipt:structuredClone(receipt)}}};
  delete next.pending;persist(next);
  return {receipt:structuredClone(receipt),archive:structuredClone(archive),replay:false};
 };
 return {
  status:()=>({pin:structuredClone(saved.pin),archive:structuredClone(saved.archive),pending:saved.pending?{id:saved.pending.id,stage:saved.pending.stage}:undefined,blocked:!!saved.pending}),
  updateArchive:async(transform:(archive:A)=>Promise<A>|A)=>{
   ensure();if(saved.pending)throw new Error('Public archive updates are blocked while a stock outcome is unresolved.');
   busy=true;try{const archive=await transform(structuredClone(saved.archive));await hooks.validateArchive(structuredClone(archive));persist({...saved,archive});return structuredClone(archive);}finally{busy=false;}
  },
  submit:async(id:string,plan:P)=>{
   ensure();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(id)||['__proto__','constructor','prototype'].includes(id))throw new Error('Invalid stock request identity.');
   const serialized=canonical(plan);if(Buffer.byteLength(serialized)>8*1024*1024)throw new Error('Stock public plan exceeds the archive limit.');
   const fingerprint=stockJournalFingerprint(plan),known=Object.hasOwn(saved.accepted,id)?saved.accepted[id]:undefined;
   if(known){if(known.fingerprint!==fingerprint)throw new Error('Accepted stock request identity was reused for different transaction facts.');return {receipt:structuredClone(known.receipt),archive:structuredClone(saved.archive),replay:true};}
   if(saved.pending)throw new Error('A stock signing outcome is unresolved; reconcile the exact journaled transaction before any new submission.');
   busy=true;
   try{
    await hooks.validatePlan(structuredClone(plan),structuredClone(saved.archive));
    persist({...saved,pending:{id,fingerprint,plan:structuredClone(plan),stage:'submitted'}});
    return await finish(await hooks.transmit(structuredClone(plan)));
   }finally{busy=false;}
  },
  reconcile:async()=>{
   ensure();if(!saved.pending)return {resolved:true,archive:structuredClone(saved.archive)};
   busy=true;try{
    const pending=saved.pending,receipt=pending.stage==='accepted'?pending.receipt:await hooks.lookup(structuredClone(pending.plan));
    if(!receipt){
     if(pending.stage!=='submitted'||!await hooks.abandoned?.(structuredClone(pending.plan)))return {resolved:false,archive:structuredClone(saved.archive)};
     const next={...saved};delete next.pending;persist(next);
     return {resolved:true,abandoned:true,archive:structuredClone(saved.archive)};
    }
    const result=await finish(receipt);return {resolved:true,...result};
   }finally{busy=false;}
  },
  close:()=>{if(busy)throw new Error('Cannot close the stock journal while an operation is in flight.');if(!closed){closed=true;store.close();}},
 };
}
