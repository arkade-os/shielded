import {lightningSpendConflict,sameLightningSpendRequest,validateLightningSpend,type LightningSpendRecord,type LightningSpendStore} from './lightning-spend.ts';

export interface LightningPayout {id:string;descriptor:string;address:string;script:string}
export interface LightningArtifact {
 id:string;index:number;kind:'send'|'receive'|'exit';state:'allocated'|'quoted'|'accepted'|'ended';createdAt:number;
 descriptor?:string;address?:string;script?:string;serverPubKey?:string;csvTimelock?:string;quoteId?:string;expiresAt?:number;
}
interface JournalState {v:1;next:number;artifacts:LightningArtifact[];payouts:LightningPayout[];spends:LightningSpendRecord[];receive:Record<string,unknown>}
interface JournalCounter {next:number;payments:{hash:string;pool:string;id:string;state:LightningSpendRecord['state']}[]}
function counterOf(value:JournalCounter|undefined,state:JournalState):JournalCounter{
 const counter=value??{next:0,payments:[]};counter.payments??=[];
 if(!Number.isSafeInteger(counter.next)||counter.next<state.next||counter.next>0x80000000||!Array.isArray(counter.payments))throw new Error('Lightning allocation counter moved backwards');
 return counter;
}
export interface LightningRepository extends LightningSpendStore,AsyncDisposable {
 allocateArtifact(owner:string,pool:string,kind:LightningArtifact['kind']):Promise<LightningArtifact>;
 artifacts(owner:string,pool:string):Promise<LightningArtifact[]>;
 updateArtifact(owner:string,pool:string,artifact:LightningArtifact):Promise<void>;
 payouts(owner:string,pool:string):Promise<LightningPayout[]>;
 savePayouts(owner:string,pool:string,payouts:LightningPayout[]):Promise<void>;
 getReceiveState<T>(owner:string,pool:string,key:string):Promise<T|undefined>;
 saveReceiveState(owner:string,pool:string,key:string,state:unknown):Promise<void>;
 payoutSpends(owner:string,outpoint:string):Promise<LightningSpendRecord[]>;
}
const copy=<T>(value:T):T=>structuredClone(value);
function stateOf(value:JournalState|undefined,owner:string,pool:string):JournalState{
 if(value===undefined)return {v:1,next:0,artifacts:[],payouts:[],spends:[],receive:{}};
 if(value.v!==1||!Number.isSafeInteger(value.next)||value.next<0||value.next>0x80000000||!Array.isArray(value.artifacts)||!Array.isArray(value.payouts)||!Array.isArray(value.spends)||!value.receive)throw new Error('Unreadable Lightning journal');
 const indices=new Set<number>();
 for(const a of value.artifacts){if(!Number.isSafeInteger(a.index)||a.index<0||a.index>=value.next||indices.has(a.index)||a.id!==`lightning-${a.index}`)throw new Error('Invalid Lightning artifact allocation');indices.add(a.index);}
 for(const record of value.spends)validateLightningSpend(record,owner,pool);
 return value;
}
abstract class Journal implements LightningRepository {
 protected abstract run<T>(owner:string,pool:string,write:boolean,work:(state:JournalState,counter:JournalCounter)=>T):Promise<T>;
 abstract [Symbol.asyncDispose]():Promise<void>;
 abstract payoutSpends(owner:string,outpoint:string):Promise<LightningSpendRecord[]>;
 allocateArtifact(owner:string,pool:string,kind:LightningArtifact['kind']){return this.run(owner,pool,true,(state,counter)=>{
  if(counter.next>=0x80000000)throw new Error('Lightning HD branch exhausted');
  const index=counter.next++,artifact:LightningArtifact={id:`lightning-${index}`,index,kind,state:'allocated',createdAt:Date.now()};state.next=index+1;
  state.artifacts.push(artifact);return copy(artifact);
 });}
 artifacts(owner:string,pool:string){return this.run(owner,pool,false,state=>copy(state.artifacts));}
 updateArtifact(owner:string,pool:string,artifact:LightningArtifact){return this.run(owner,pool,true,state=>{
  const position=state.artifacts.findIndex(a=>a.id===artifact.id),old=state.artifacts[position];
  if(!old||old.index!==artifact.index||old.kind!==artifact.kind||old.createdAt!==artifact.createdAt)throw new Error('Unknown Lightning artifact');
  for(const key of ['descriptor','address','script','serverPubKey','csvTimelock','quoteId','expiresAt'] as const)if(old[key]!==undefined&&old[key]!==artifact[key])throw new Error('Lightning artifact changed');
  if(old.state==='ended'&&artifact.state!=='ended')throw new Error('Lightning artifact already ended');
  state.artifacts[position]=copy(artifact);
 });}
 payouts(owner:string,pool:string){return this.run(owner,pool,false,state=>copy(state.payouts));}
 savePayouts(owner:string,pool:string,payouts:LightningPayout[]){return this.run(owner,pool,true,state=>{
  for(const payout of payouts){
   if(!payout.id||!payout.descriptor||!payout.address||!/^5120[0-9a-f]{64}$/.test(payout.script))throw new Error('Invalid Lightning payout');
   const existing=state.payouts.find(p=>p.id===payout.id||p.script===payout.script);
   if(existing){if(existing.descriptor!==payout.descriptor||existing.address!==payout.address||existing.script!==payout.script)throw new Error('Lightning payout changed');}
   else state.payouts.push(copy(payout));
  }
 });}
 get(owner:string,pool:string,id:string){return this.run(owner,pool,false,state=>copy(state.spends.find(r=>r.id===id)));}
 list(owner:string,pool:string){return this.run(owner,pool,false,state=>copy(state.spends));}
 create(record:LightningSpendRecord){return this.run(record.owner,record.pool,true,(state,counter)=>{
  validateLightningSpend(record,record.owner,record.pool);
  const old=state.spends.find(r=>r.id===record.id);
  if(old){if(!sameLightningSpendRequest(old,record))throw new Error('Lightning spend identity changed');return copy(old);}
  if(state.spends.some(r=>lightningSpendConflict(r,record)))throw new Error('Lightning spend is already reserved');
  if(record.paymentHash){
   const existing=counter.payments.find(p=>p.hash===record.paymentHash&&p.state!=='dropped');
   if(existing&&(existing.pool!==record.pool||existing.id!==record.id))throw new Error('This Lightning invoice is already reserved or paid');
   counter.payments.push({hash:record.paymentHash,pool:record.pool,id:record.id,state:record.state});
  }
  state.spends.push(copy(record));return copy(record);
 });}
 finish(owner:string,pool:string,id:string,result:{state:'included'|'dropped';txid?:string;reason?:string}){return this.run(owner,pool,true,(state,counter)=>{
  const record=state.spends.find(r=>r.id===id);if(!record)throw new Error('Unknown Lightning spend');
  if(record.state!=='prepared'&&record.state!==result.state)throw new Error('Lightning spend already reconciled');
  if(record.txid&&record.txid!==result.txid)throw new Error('Lightning spend transaction changed');
  validateLightningSpend({...record,...result},owner,pool);Object.assign(record,result);
  for(const claim of counter.payments)if(claim.pool===pool&&claim.id===id)claim.state=result.state;
 });}
 getReceiveState<T>(owner:string,pool:string,key:string){return this.run(owner,pool,false,state=>copy(state.receive[key]) as T|undefined);}
 saveReceiveState(owner:string,pool:string,key:string,value:unknown){return this.run(owner,pool,true,state=>{state.receive[key]=JSON.parse(JSON.stringify(value));});}
}

export class InMemoryLightningRepository extends Journal {
 private rows=new Map<string,JournalState>();
 private counters=new Map<string,JournalCounter>();
 async payoutSpends(owner:string,outpoint:string){
  const records:LightningSpendRecord[]=[];
  for(const [key,value] of this.rows){const [storedOwner,pool]=JSON.parse(key);if(storedOwner===owner)records.push(...stateOf(copy(value),owner,pool).spends.filter(r=>r.kind==='shield'&&r.reference===outpoint));}
  return records;
 }
 protected async run<T>(owner:string,pool:string,write:boolean,work:(state:JournalState,counter:JournalCounter)=>T):Promise<T>{
  const key=JSON.stringify([owner,pool]),state=stateOf(copy(this.rows.get(key)),owner,pool),counter=counterOf(copy(this.counters.get(owner)),state);
  const result=work(state,counter);
  if(write){this.rows.set(key,state);this.counters.set(owner,counter);}return result;
 }
 async [Symbol.asyncDispose](){}
}

export class IndexedDbLightningRepository extends Journal {
 private db?:Promise<IDBDatabase>;
 constructor(private readonly name='shielded-lightning'){super();}
 private open(){return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open(this.name,1);
  request.onupgradeneeded=()=>request.result.createObjectStore('journal');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });}
 async payoutSpends(owner:string,outpoint:string){
  const db=await this.open();return new Promise<LightningSpendRecord[]>((resolve,reject)=>{
   const tx=db.transaction('journal','readonly'),request=tx.objectStore('journal').openCursor(),records:LightningSpendRecord[]=[];let error:unknown;
   request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;try{
    const [storedOwner,pool]=JSON.parse(String(cursor.key));
    if(storedOwner===owner&&pool!=='hd-allocation-counter')records.push(...stateOf(cursor.value,owner,pool).spends.filter(r=>r.kind==='shield'&&r.reference===outpoint));
    cursor.continue();
   }catch(cause){error=cause;tx.abort();}};
   tx.oncomplete=()=>resolve(copy(records));tx.onabort=()=>reject(error??tx.error);tx.onerror=()=>reject(error??tx.error);
  });
 }
 protected async run<T>(owner:string,pool:string,write:boolean,work:(state:JournalState,counter:JournalCounter)=>T):Promise<T>{
  const db=await this.open(),key=JSON.stringify([owner,pool]);
  return new Promise<T>((resolve,reject)=>{
   const tx=db.transaction('journal',write?'readwrite':'readonly'),store=tx.objectStore('journal'),request=store.get(key);
   let result:T,error:unknown;
   request.onsuccess=()=>{
    const counterKey=JSON.stringify([owner,'hd-allocation-counter']),counterRequest=store.get(counterKey);
    counterRequest.onsuccess=()=>{try{
     const state=stateOf(request.result,owner,pool),counter=counterOf(counterRequest.result,state);
     result=work(state,counter);if(write){store.put(state,key);store.put(counter,counterKey);}
    }catch(cause){error=cause;tx.abort();}};
   };
   tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(error??tx.error??new Error('Lightning journal aborted'));tx.onerror=()=>reject(error??tx.error);
  });
 }
 async [Symbol.asyncDispose](){const db=this.db;this.db=undefined;if(db)(await db).close();}
}
