import {ArkAddress,PaymentRouter,ReadonlyWallet,Wallet,arkAssetRail,arkRail,onchainRail,walletFeeSource,type Activity,type ArkTransaction,type WalletConfig} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {fullViewKeyOf,sentNoteOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import {akOf,assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2} from '../../packages/protocol/src/wallet-keys.ts';
import {walletIntentLeafScriptHex} from '../stock/ark-wallet.ts';
import {entryForActivity,revealLinkOf,shieldedActivityResolver,shieldedRows,type ShieldedRowIndex} from './activity.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from './handle.ts';
import {DUST,pickNote,poolApiOf,shieldPlan,type ArkCoin,type Groth16Proof,type PoolApi,type RollupPoolStatus,type ShieldPlan,type SpendStatus} from './pool.ts';
import {SHIELDED_PRIORITY,shieldedRail,shieldedWithdrawRail} from './rails.ts';
import type {SentRecord,ShieldedNoteRepository} from './repository.ts';
import {submitAll,type SubmitDeps,type SubmitMember} from './submit.ts';
import {WATCHDOG_MS,catchUp,idle} from './sync.ts';

export interface ShieldedPoolConfig {origin:string;status:RollupPoolStatus}
export interface ShieldedProver {prove(built:BuiltSpend,circuit:'spend'|'join'):Promise<Groth16Proof>;joinReady?():boolean}
export type ShieldedWalletConfig=WalletConfig&{pool:ShieldedPoolConfig;secret:string;hash:Hash;prover:ShieldedProver;shieldedRepository?:ShieldedNoteRepository;bornAt?:number;fetcher?:typeof fetch};

export function shieldedKeysOf(hash:Hash,secret:string){
 const keys=deriveRollupKeys2(secret,MUTINYNET_KEY_NETWORK),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 return {keys,self,address:rollupAddressOf(self),viewKey:viewKeyOf(self.owner,keys.viewSecret),fullViewingKey:fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret)};
}

/**
 * Note selection and reservation in one critical section. `RollupAccount.pay`/`consolidate` read the unspent set
 * and resolve asynchronously, so without serialising the pick two actions choose the same note and the second
 * spend is a guaranteed double-spend the pool drops.
 */
export class NoteReservation {
 readonly inFlight=new Set<bigint>();
 private queue:Promise<unknown>=Promise.resolve();
 pick<T>(choose:()=>Promise<T>,nullifiersOf:(chosen:T)=>bigint[]):Promise<T>{
  const next=this.queue.then(async()=>{const chosen=await choose();for(const n of nullifiersOf(chosen))this.inFlight.add(n);return chosen;});
  this.queue=next.then(()=>undefined,()=>undefined);
  return next;
 }
 release(nullifiers:readonly bigint[]){for(const n of nullifiers)this.inFlight.delete(n);}
}

export interface LoadedAccount {account:RollupAccount;sent:Record<string,SentRecord>;listings:string[];resumed:boolean;error?:string}
const reasonOf=(error:unknown)=>(error instanceof Error?error.message:String(error))||'unreadable';
/** Never throws: a cache that cannot be read is a full sync, reported once, not a wallet that will not open. */
export async function loadAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},o:{repository?:ShieldedNoteRepository;token:string;bornAt:number}):Promise<LoadedAccount>{
 const fresh=(error?:string):LoadedAccount=>({account:RollupAccount.owning(hash,keys,{frontier:true,bornAt:o.bornAt}),sent:{},listings:[],resumed:false,...(error?{error}:{})});
 if(!o.repository)return fresh();
 try{
  const stored=await o.repository.getAccount(o.token);
  if(!stored)return fresh();
  if(stored.v!==1)return fresh(`Ignoring a version ${String(stored.v)} shielded snapshot; syncing from the pool.`);
  if(stored.token!==o.token)return fresh('Ignoring a snapshot from another pool; syncing from the pool.');
  return {account:RollupAccount.fromSnapshot(hash,keys,stored.account),sent:{...stored.sent},listings:[...(stored.listings??[])],resumed:true};
 }catch(error){return fresh(reasonOf(error));}
}

export const SHIELD_FLOOR_MS=25*3600_000,RETRY_MS=60_000,MERGE_WAIT_MS=10*60_000;
export const shieldedSteps={
 shield:['Prepare the deposit coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],
 send:['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],
 withdraw:['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],
 merge:['Pick two notes','Prove the merge on this device','Submit to the pool','Wait for the next batch','Included'],
} as const;
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
export const shieldTitle=(plan:ShieldPlan)=>plan.kind==='btc'?`Shielding ${sats(plan.amount)} sats`:`Shielding ${sats(plan.units)} units of asset ${short(plan.assetId)}`;
export const nextShieldPlan=(coins:readonly ArkCoin[],o:{skip:(c:ArkCoin)=>boolean;used:ReadonlySet<string>;listed:ReadonlySet<string>;now:number;floorMs:number})=>
 shieldPlan(coins.filter(c=>!o.skip(c)&&!o.used.has(`${c.txid}:${c.vout}`)),o.listed,o.now,o.floorMs);
export const needsRenewal=(coins:readonly ArkCoin[],now:number,floorMs:number)=>coins.some(c=>c.expiresAt!==undefined&&c.expiresAt-now<=floorMs);
export const mergeAssetFields=(reserves:Record<string,string>|undefined)=>[BTC_ASSET,...Object.keys(reserves??{}).map(assetFieldOfId)];
export const programOf=(address:string)=>ArkAddress.decode(address).pkScript.subarray(2);
export const topThree=(notes:{amount:bigint}[])=>[...notes].sort((a,b)=>a.amount<b.amount?1:a.amount>b.amount?-1:0).slice(0,3).reduce((sum,n)=>sum+n.amount,0n);
export const coversWithdrawal=(notes:{amount:bigint;nullifier:bigint}[],carriers:{amount:bigint;nullifier:bigint}[],amount:bigint,inFlight:ReadonlySet<bigint>,asset:boolean,sats_:bigint)=>{
 const has=(list:{amount:bigint;nullifier:bigint}[],least:bigint)=>list.some(n=>!inFlight.has(n.nullifier)&&n.amount>=least);
 if(amount<=0n)return false;
 return asset?sats_>=BigInt(DUST)&&has(notes,amount)&&has(carriers,sats_):amount>=BigInt(DUST)&&has(notes,amount);
};
class ReservationFailure extends Error {
 constructor(error:unknown,readonly release:boolean){super(reasonOf(error),{cause:error});}
}
const canRelease=(error:unknown)=>!(error instanceof ReservationFailure)||error.release;

export class ShieldedWallet extends Wallet {
 pool!:ShieldedPoolConfig;
 api!:PoolApi;
 hash!:Hash;
 prover!:ShieldedProver;
 account!:RollupAccount;
 self!:RollupRecipient;
 readonly notes=new NoteReservation();
 repository?:ShieldedNoteRepository;
 resumed=false;
 repositoryError?:string;
 private derived!:ReturnType<typeof shieldedKeysOf>;
 private token!:string;
 private poolScript!:string;
 private ownPoolAddress!:string;
 private rows!:ShieldedRowIndex;
 private sent:Record<string,SentRecord>={};
 private readonly listings=new Set<string>();
 private readonly changeListeners=new Set<()=>void>();
 private readonly used=new Set<string>();
 private readonly usedTxids=new Set<string>();
 private readonly actionListeners=new Set<(h:ShieldedPaymentHandle)=>void>();
 private latestAction?:ShieldedPaymentHandle;
 private unwatch:(()=>void)[]=[];
 private timer?:ReturnType<typeof setTimeout>;
 private retryAt=0;
 private mergeRetryAt=0;
 private stopped=false;
 private selfSending=false;
 private nativeOperations=0;

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher);wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;wallet.repository=config.shieldedRepository;wallet.token=config.pool.status.pool!.token;
   wallet.poolScript=config.pool.status.pool!.script;wallet.ownPoolAddress=config.pool.status.pool!.address;
   const loaded=await loadAccount(config.hash,wallet.derived.keys,{repository:config.shieldedRepository,token:wallet.token,bornAt:config.bornAt??0});
   wallet.account=loaded.account;wallet.sent=loaded.sent;wallet.resumed=loaded.resumed;wallet.repositoryError=loaded.error;
   for(const txid of loaded.listings)wallet.listings.add(txid);
   wallet.rows=shieldedRows(()=>wallet.account.history,field=>wallet.assetIdOf(field));
   wallet.activity.use(shieldedActivityResolver({index:wallet.rows,entries:()=>wallet.account.history,isPoolBatch:txid=>wallet.account.txids.has(txid),isListing:txid=>wallet.listings.has(txid)}));
   await wallet.start();
   return wallet;
  }catch(error){await wallet.dispose().catch(()=>{});throw error;}
 }

 get inFlight():ReadonlySet<bigint>{return this.notes.inFlight;}
 get poolAddress():string{return this.ownPoolAddress;}
 router():PaymentRouter{
  return new PaymentRouter({wallet:this,prefs:{priority:SHIELDED_PRIORITY}})
   .use(shieldedRail(this)).use(shieldedWithdrawRail(this))
   .use(arkRail()).use(arkAssetRail()).use(onchainRail({feeInfo:walletFeeSource(this)}));
 }
 shieldedBalance(asset=BTC_ASSET):bigint{return this.account.balance(asset);}
 shieldedNotes(asset=BTC_ASSET):OwnedNote[]{return this.account.notes(asset);}
 shieldedHistory():readonly HistoryEntry[]{return this.account.history;}
 override async getTransactionHistory():Promise<ArkTransaction[]>{
  const sdk=await super.getTransactionHistory();
  return [...sdk,...this.rows.rows()].sort((a,b)=>b.createdAt-a.createdAt);
 }
 private origin(){return typeof location==='undefined'?this.pool.origin:location.origin;}
 revealLink(payment:HistoryEntry):string|undefined{
  return revealLinkOf(this.origin(),payment,{self:this.shieldedAddress(),sentOf:n=>this.sentOf(n)});
 }
 revealLinkOfActivity(item:Activity):string|undefined{
  const entry=entryForActivity(item,{index:this.rows,entries:this.account.history});
  return entry&&this.revealLink(entry);
 }
 shieldedAddress():string{return this.derived.address;}
 viewKey():string{return this.derived.viewKey;}
 fullViewingKey():string{return this.derived.fullViewingKey;}
 batchCount():number{return this.account.batchCount;}
 assetIdOf(field:bigint):string|undefined{return Object.keys(this.pool.status.pool?.reserves??{}).find(id=>assetFieldOfId(id)===field);}
 onShieldedChange(cb:()=>void):()=>void{this.changeListeners.add(cb);return()=>{this.changeListeners.delete(cb);};}
 /** Every handle the wallet starts on its own — auto-shield, a background merge — so one sheet shows them all. */
 onAction(cb:(handle:ShieldedPaymentHandle)=>void):()=>void{this.actionListeners.add(cb);if(this.latestAction)try{cb(this.latestAction);}catch{}return()=>{this.actionListeners.delete(cb);};}
 changed(){for(const cb of [...this.changeListeners])try{cb();}catch{/* a listener's fault is not the wallet's */}}
 private announce(handle:ShieldedPaymentHandle){this.latestAction=handle;for(const cb of [...this.actionListeners])try{cb(handle);}catch{}return handle;}
 async save():Promise<void>{
  if(!this.repository)return;
  const {token}=this;
  try{
   const account=this.account.snapshot(),stored=await this.repository.getAccount(token);
   // ponytail: read-merge-write keeps other tabs' entries but is not atomic; merge inside saveAccount's transaction if tabs ever race.
   this.sent={...stored?.sent,...this.sent};for(const txid of stored?.listings??[])this.listings.add(txid);
   await this.repository.saveAccount(token,{v:1,token,account,sent:this.sent,listings:[...this.listings]});
  }catch(error){this.repositoryError??=reasonOf(error);}
 }
 sentOf(nullifier:bigint):SentRecord|undefined{return this.sent[String(nullifier)];}
 private persist(){return idle(this.account,()=>{this.assertOpen();return this.save();});}
 recordSent(entries:[bigint,SentRecord][]){for(const [nullifier,record] of entries)this.sent[String(nullifier)]=record;}
 async start():Promise<void>{
  await this.sync();
  const manager=await this.getContractManager();
  await manager.watchScript?.(this.poolScript,{label:'shielded pool'});
  this.unwatch.push(manager.onContractEvent(event=>{
   // A watch-only event carries no contract, which is the point: the pool script is not ours. Any movement on it
   // means the head moved, and `connection_reset` means an event may have been missed.
   if(event.type==='vtxo_received'||event.type==='vtxo_spent'||event.type==='connection_reset')void this.sync().catch(()=>{});
  }));
  this.unwatch.push(await this.notifyIncomingFunds(()=>{this.changed();void this.autoShield().catch(()=>{});}));
  this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
  await this.autoShield().catch(()=>{});
 }
 /** The safety net behind the stream: refresh the pool, catch up, then start anything waiting. Never awaits a batch. */
 private async tick():Promise<void>{
  if(this.stopped)return;
  try{this.pool={...this.pool,status:await this.api('/status')};await this.sync();}catch{/* the next tick retries */}
  void this.autoShield().catch(()=>{});
  void this.merge().catch(()=>{});
  this.changed();
  if(!this.stopped)this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
 }
 async sync():Promise<void>{
  const applied=await catchUp(this.account,this.api,undefined,()=>this.save());
  if(applied)this.changed();
 }

 async coins():Promise<ArkCoin[]>{
  this.assertOpen();
  return (await this.getSpendableVtxos()).map(v=>({txid:v.txid,vout:v.vout,value:v.value,...(v.expiresAt instanceof Date?{expiresAt:v.expiresAt.getTime()}:{}),...(v.assets?.length?{assets:v.assets.map(a=>({assetId:a.assetId,amount:BigInt(a.amount)}))}:{})}));
 }
 isPoolPayout(coin:{txid:string}){return this.account.txids.has(coin.txid);}
 /** `skipPayouts` is what auto-shield wants and the "Shield again" button does not: a payout is only shielded on request. */
 planFor(coins:readonly ArkCoin[],skipPayouts=true){
  return nextShieldPlan(coins,{skip:c=>this.usedTxids.has(c.txid)||(skipPayouts&&this.isPoolPayout(c)),used:this.used,listed:new Set(Object.keys(this.pool.status.pool?.reserves??{})),now:Date.now(),floorMs:SHIELD_FLOOR_MS});
 }
 private deps():SubmitDeps{return {api:this.api,prover:this.prover,identity:this.identity,poolScript:this.poolScript};}
 private async submit(members:SubmitMember[],step:(n:number)=>void,deadlineMs=30*60_000){
  const unresolved=new Set<string>();
  const api:PoolApi=async<T,>(path:string,body?:unknown)=>{
   if(path==='/spends'){this.assertOpen();unresolved.add((body as {id:string}).id);}
   const result=await this.api<T>(path,body);
   if(body===undefined&&path.startsWith('/spends/')&&(result as SpendStatus).status==='dropped')unresolved.delete(path.slice('/spends/'.length));
   return result;
  };
  try{return await this.finish(await submitAll(members,{...this.deps(),api,step,first:1,deadlineMs}));}
  catch(error){throw new ReservationFailure(error,unresolved.size===0);}
 }
 /** One place where a dropped spend becomes an error and a landed one triggers sync. */
 private async finish(final:SpendStatus){
  if(final.status==='dropped')throw new Error(final.reason??'The pool dropped this spend.');
  await this.sync();
  return {...(final.txid?{txid:final.txid}:{})};
 }
 private hold(nullifiers:readonly bigint[],handle:ShieldedPaymentHandle,onFail?:()=>void){
  const release=()=>{this.notes.release(nullifiers);this.changed();};
  void handle.settled().then(release,error=>{if(canRelease(error))release();try{onFail?.();}catch{}});
 }
 private assertOpen(){if(this.stopped)throw new Error('The wallet was closed.');}
 private reserved(coin:{txid:string;vout:number}){return this.used.has(`${coin.txid}:${coin.vout}`)||this.usedTxids.has(coin.txid);}
 private async nativeSpend(inputs:readonly {txid:string;vout:number}[]|undefined,run:()=>Promise<string>){
  this.assertOpen();
  if(this.selfSending)throw new Error('A shield deposit coin is being prepared. Try again when it is ready.');
  if(inputs?.some(coin=>this.reserved(coin)))throw new Error('A selected coin is reserved for shielding.');
  this.nativeOperations++;
  try{return await run();}finally{this.nativeOperations--;}
 }
 override async getSpendableVtxos(...args:Parameters<Wallet['getSpendableVtxos']>){
  const coins=await super.getSpendableVtxos(...args);
  return args[0]?.genericallySpendableOnly?coins.filter(coin=>!this.reserved(coin)):coins;
 }
 override send(...args:Parameters<Wallet['send']>){
  return this.nativeSpend('recipients' in args[0]?args[0].selectedVtxos:undefined,()=>super.send(...args));
 }
 override settle(...args:Parameters<Wallet['settle']>){return this.nativeSpend(args[0]?.inputs,()=>super.settle(...args));}
 override sendSelectedVtxosToSelf(...args:Parameters<Wallet['sendSelectedVtxosToSelf']>){return this.nativeSpend(args[0],()=>super.sendSelectedVtxosToSelf(...args));}
 override async getContractManager(){
  this.assertOpen();
  const manager=await super.getContractManager();
  // Full Wallet disposal can await restore work that is itself waiting for this manager.
  if(this.stopped){manager.dispose();await ReadonlyWallet.prototype.dispose.call(this);this.assertOpen();}
  return manager;
 }

 async shield(coins?:readonly ArkCoin[]):Promise<ShieldedPaymentHandle|undefined>{
  this.assertOpen();
  if(this.selfSending||this.nativeOperations)return undefined;
  const available=coins??await this.coins();
  this.assertOpen();
  if(this.selfSending||this.nativeOperations)return undefined;
  const plan=this.planFor(available,!coins);
  if(!plan)return undefined;
  const taken=(plan.kind==='btc'?plan.coins:[plan.coin]).map(c=>`${c.txid}:${c.vout}`);
  const sentTxids:string[]=[];
  for(const outpoint of taken)this.used.add(outpoint);
  const handle=shieldedHandle({title:shieldTitle(plan),steps:shieldedSteps.shield,railId:'shielded-deposit'},async step=>{
   step(0);
   if(plan.kind==='asset'){
    const coin=await this.depositCoin(plan.coin.txid,plan.coin.value,{assetId:plan.assetId,amount:plan.units},plan.coin.vout);
    const [assetSlot,btcSlot]=await this.account.depositAsset(assetFieldOfId(plan.assetId),plan.units,BigInt(coin.value),this.self);
    return this.submit([{built:assetSlot,extra:{coin,asset:plan.assetId},coin},{built:btcSlot}],step);
   }
   const single=plan.coins.length===1?plan.coins[0]!:undefined;
   let txid=single?.txid;
   if(!single){
    this.selfSending=true;
    try{
     this.assertOpen();
     const available=await this.getSpendableVtxos();
     const selectedVtxos=plan.coins.map(c=>available.find(v=>v.txid===c.txid&&v.vout===c.vout));
     if(selectedVtxos.some(v=>!v))throw new Error('A selected deposit coin is no longer spendable.');
     this.assertOpen();const address=await this.getAddress();this.assertOpen();
     try{txid=await super.send({recipients:[{address,amount:plan.amount}],selectedVtxos:selectedVtxos.map(v=>v!)});}
     catch(error){throw new ReservationFailure(error,false);}
     this.usedTxids.add(txid);sentTxids.push(txid);
    }finally{this.selfSending=false;}
   }
   const coin=await this.depositCoin(txid!,plan.amount,undefined,single?.vout);
   const outpoint=`${coin.txid}:${coin.vout}`;this.used.add(outpoint);taken.push(outpoint);
   return this.submit([{built:await this.account.spend({deposit:BigInt(plan.amount)},this.self),extra:{coin},coin}],step);
  });
  void handle.settled().catch(error=>{
   if(canRelease(error)){for(const outpoint of taken)this.used.delete(outpoint);for(const txid of sentTxids)this.usedTxids.delete(txid);}
   this.retryAt=Date.now()+RETRY_MS;
  });
  return this.announce(handle);
 }
 private async autoShield(){
  if(this.stopped||Date.now()<this.retryAt)return;
  await this.sync();
  if(this.stopped||Date.now()<this.retryAt)return;
  await this.shield();
 }
 mergeableAssets(){return mergeAssetFields(this.pool.status.pool?.reserves);}
 async merge(asset?:bigint):Promise<ShieldedPaymentHandle|undefined>{
  if(this.stopped||Date.now()<this.mergeRetryAt)return undefined;
  for(const field of asset===undefined?this.mergeableAssets():[asset]){
   const plan=await this.notes.pick(()=>this.account.consolidate(this.self,field,this.notes.inFlight),chosen=>chosen?chosen.inputs.map(n=>n.nullifier):[]);
   if(!plan)continue;
   const nullifiers=plan.inputs.map(n=>n.nullifier);
   const handle=shieldedHandle({title:'Merging two notes',steps:shieldedSteps.merge,railId:'shielded-merge'},step=>this.submit([{built:plan.built}],step,MERGE_WAIT_MS));
   this.hold(nullifiers,handle,()=>{this.mergeRetryAt=Date.now()+RETRY_MS;});
   return this.announce(handle);
  }
  return undefined;
 }
 async listAsset(assetId:string):Promise<string>{
  this.assertOpen();
  const pool=this.pool.status.pool;
  if(!pool)throw new Error('The pool is not available for asset listing.');
  const txid=await this.send({recipients:[{address:pool.address,amount:DUST,assets:[{assetId,amount:1n}]}]});
  this.listings.add(txid);await this.persist();this.changed();
  return txid;
 }
 maxPrivatePayment(asset=BTC_ASSET){return topThree(this.account.notes(asset).filter(n=>!this.notes.inFlight.has(n.nullifier)));}
 canWithdraw(amount:bigint,opts:{asset?:string;sats?:bigint}={}){
  try{
   const field=opts.asset?assetFieldOfId(opts.asset):BTC_ASSET;
   return coversWithdrawal(this.account.notes(field),this.account.notes(BTC_ASSET),amount,this.notes.inFlight,!!opts.asset,opts.sats??BigInt(DUST));
  }catch{return false;}
 }
 async pay(to:string,amount:bigint,asset?:string):Promise<ShieldedPaymentHandle>{
  const held:bigint[]=[];
  const handle=shieldedHandle({title:'Sending privately',steps:shieldedSteps.send,railId:'shielded'},async step=>{
   step(0);this.assertOpen();
   const recipient=parseRollupAddress(to),field=asset?assetFieldOfId(asset):BTC_ASSET;
   const {spends}=await this.notes.pick(()=>this.account.pay(recipient,amount,this.self,this.notes.inFlight,field,{join:this.prover.joinReady?.()??false}),
    chosen=>chosen.spends.flatMap(s=>s.witness.slot.nullifiers));
   held.push(...spends.flatMap(s=>s.witness.slot.nullifiers));this.assertOpen();
   this.recordSent(spends.map(s=>{const note=sentNoteOf(this.hash,s);return [s.witness.slot.nullifiers[0]!,{to,note:{amount:String(note.amount),asset:String(note.asset),rho:String(note.rho)}}] as [bigint,SentRecord];}));
   await this.persist();
   return this.submit(spends.map(built=>({built})),step);
  });
  this.hold(held,handle);
  return this.announce(handle);
 }
 async withdraw(to:string,amount:bigint,opts:{asset?:string;sats?:bigint}={}):Promise<ShieldedPaymentHandle>{
  const held:bigint[]=[];
  const handle=shieldedHandle({title:'Withdrawing',steps:shieldedSteps.withdraw,railId:'shielded-withdraw'},async step=>{
   step(0);this.assertOpen();
   const program=programOf(to);
   const members=await this.notes.pick(async()=>{
    if(opts.asset){
     const [payout,carrier]=await this.account.withdrawAsset(assetFieldOfId(opts.asset),amount,program,this.self,this.notes.inFlight,opts.sats??BigInt(DUST));
     return [{built:payout,extra:{program,asset:opts.asset}},{built:carrier,extra:{program}}] as SubmitMember[];
    }
    if(amount<BigInt(DUST))throw new Error(`Withdraw at least ${DUST} sats.`);
    const input=pickNote(this.account.notes(),amount,this.notes.inFlight);
    if(!input)throw new Error('No single note covers this amount.');
    return [{built:await this.account.spend({input,withdraw:amount,program},this.self),extra:{program}}] as SubmitMember[];
   },chosen=>chosen.flatMap(m=>m.built.witness.slot.nullifiers));
   held.push(...members.flatMap(m=>m.built.witness.slot.nullifiers));this.assertOpen();
   this.recordSent(members.map(m=>[m.built.witness.slot.nullifiers[0]!,{to}] as [bigint,SentRecord]));
   await this.persist();
   return this.submit(members,step);
  });
  this.hold(held,handle);
  return this.announce(handle);
 }
 /** The pool refuses coins near expiry; a batch swap renews them, after which auto-shield picks them up. */
 async renew():Promise<string|undefined>{
  if(this.nativeOperations||this.selfSending)return undefined;
  const coins=await this.coins();
  if(this.nativeOperations||this.selfSending||!needsRenewal(coins,Date.now(),SHIELD_FLOOR_MS))return undefined;
  const txid=await this.settle();
  this.retryAt=0;await this.sync();this.changed();
  return txid;
 }
 /** Waits for the coin a deposit needs with its value and asset, and returns how to spend it. */
 private async depositCoin(txid:string,value:number,asset?:{assetId:string;amount:bigint},vout?:number){
  for(let i=0;i<30;i++){
   this.assertOpen();
   await new Promise(r=>setTimeout(r,1000));
   this.assertOpen();
   const found=(await this.getSpendableVtxos()).find(v=>v.txid===txid&&(vout===undefined||v.vout===vout)&&v.value===value&&(asset?v.assets?.length===1&&v.assets[0]!.assetId===asset.assetId&&BigInt(v.assets[0]!.amount)===asset.amount:!v.assets?.length));
   if(found?.tapTree&&found.intentTapLeafScript)return {txid:found.txid,vout:found.vout,value:found.value,tapTree:hex.encode(found.tapTree instanceof Uint8Array?found.tapTree:hex.decode(String(found.tapTree))),leaf:walletIntentLeafScriptHex(found.intentTapLeafScript)};
  }
  throw new Error('The deposit coin did not appear in your Arkade wallet.');
 }
 override async dispose():Promise<void>{
  this.stopped=true;
  if(this.timer)clearTimeout(this.timer);
  this.timer=undefined;
  for(const off of this.unwatch)try{off();}catch{/* a torn-down manager is already stopped */}
  this.unwatch=[];this.changeListeners.clear();this.actionListeners.clear();this.latestAction=undefined;
  await super.dispose();
 }
}
