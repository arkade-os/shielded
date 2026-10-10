import {Wallet,type WalletConfig} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {fullViewKeyOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import {akOf,assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2} from '../../packages/protocol/src/wallet-keys.ts';
import {walletIntentLeafScriptHex} from '../stock/ark-wallet.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from './handle.ts';
import {poolApiOf,shieldPlan,type ArkCoin,type Groth16Proof,type PoolApi,type RollupPoolStatus,type ShieldPlan,type SpendStatus} from './pool.ts';
import type {SentRecord,ShieldedNoteRepository} from './repository.ts';
import {submitAll,type SubmitDeps,type SubmitMember} from './submit.ts';
import {WATCHDOG_MS,catchUp} from './sync.ts';

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
 private sent:Record<string,SentRecord>={};
 private readonly listings=new Set<string>();
 private readonly changeListeners=new Set<()=>void>();
 private readonly used=new Set<string>();
 private readonly actionListeners=new Set<(h:ShieldedPaymentHandle)=>void>();
 private unwatch:(()=>void)[]=[];
 private timer?:ReturnType<typeof setTimeout>;
 private retryAt=0;
 private stopped=false;

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher);wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;wallet.repository=config.shieldedRepository;wallet.token=config.pool.status.pool!.token;
   const loaded=await loadAccount(config.hash,wallet.derived.keys,{repository:config.shieldedRepository,token:wallet.token,bornAt:config.bornAt??0});
   wallet.account=loaded.account;wallet.sent=loaded.sent;wallet.resumed=loaded.resumed;wallet.repositoryError=loaded.error;
   for(const txid of loaded.listings)wallet.listings.add(txid);
   await wallet.start();
   return wallet;
  }catch(error){await wallet.dispose().catch(()=>{});throw error;}
 }

 get inFlight():ReadonlySet<bigint>{return this.notes.inFlight;}
 shieldedBalance(asset=BTC_ASSET):bigint{return this.account.balance(asset);}
 shieldedNotes(asset=BTC_ASSET):OwnedNote[]{return this.account.notes(asset);}
 shieldedHistory():readonly HistoryEntry[]{return this.account.history;}
 shieldedAddress():string{return this.derived.address;}
 viewKey():string{return this.derived.viewKey;}
 fullViewingKey():string{return this.derived.fullViewingKey;}
 batchCount():number{return this.account.batchCount;}
 assetIdOf(field:bigint):string|undefined{return Object.keys(this.pool.status.pool?.reserves??{}).find(id=>assetFieldOfId(id)===field);}
 onShieldedChange(cb:()=>void):()=>void{this.changeListeners.add(cb);return()=>{this.changeListeners.delete(cb);};}
 /** Every handle the wallet starts on its own — auto-shield, a background merge — so one sheet shows them all. */
 onAction(cb:(handle:ShieldedPaymentHandle)=>void):()=>void{this.actionListeners.add(cb);return()=>{this.actionListeners.delete(cb);};}
 changed(){for(const cb of [...this.changeListeners])try{cb();}catch{/* a listener's fault is not the wallet's */}}
 private announce(handle:ShieldedPaymentHandle){for(const cb of [...this.actionListeners])cb(handle);return handle;}
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
 recordSent(entries:[bigint,SentRecord][]){for(const [nullifier,record] of entries)this.sent[String(nullifier)]=record;}
 async start():Promise<void>{
  await this.sync();
  const manager=await this.getContractManager();
  await manager.watchScript?.(this.pool.status.pool!.script,{label:'shielded pool'});
  this.unwatch.push(manager.onContractEvent(event=>{
   // A watch-only event carries no contract, which is the point: the pool script is not ours. Any movement on it
   // means the head moved, and `connection_reset` means an event may have been missed.
   if(event.type==='vtxo_received'||event.type==='vtxo_spent'||event.type==='connection_reset')void this.sync().catch(()=>{});
  }));
  this.unwatch.push(await this.notifyIncomingFunds(()=>{this.changed();void this.autoShield().catch(()=>{});}));
  this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
 }
 /** The safety net behind the stream: refresh the pool, catch up, then start anything waiting. Never awaits a batch. */
 private async tick():Promise<void>{
  if(this.stopped)return;
  try{this.pool={...this.pool,status:await this.api('/status')};await this.sync();}catch{/* the next tick retries */}
  void this.autoShield().catch(()=>{});
  this.changed();
  if(!this.stopped)this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
 }
 async sync():Promise<void>{
  const applied=await catchUp(this.account,this.api,()=>this.save());
  if(applied)this.changed();
 }

 async coins():Promise<ArkCoin[]>{
  return (await this.getSpendableVtxos()).map(v=>({txid:v.txid,vout:v.vout,value:v.value,...(v.expiresAt instanceof Date?{expiresAt:v.expiresAt.getTime()}:{}),...(v.assets?.length?{assets:v.assets.map(a=>({assetId:a.assetId,amount:BigInt(a.amount)}))}:{})}));
 }
 isPoolPayout(coin:{txid:string}){return this.account.txids.has(coin.txid);}
 /** `skipPayouts` is what auto-shield wants and the "Shield again" button does not: a payout is only shielded on request. */
 planFor(coins:readonly ArkCoin[],skipPayouts=true){
  return nextShieldPlan(coins,{skip:c=>skipPayouts&&this.isPoolPayout(c),used:this.used,listed:new Set(Object.keys(this.pool.status.pool?.reserves??{})),now:Date.now(),floorMs:SHIELD_FLOOR_MS});
 }
 private deps():SubmitDeps{return {api:this.api,prover:this.prover,identity:this.identity,poolScript:this.pool.status.pool!.script};}
 private submit(members:SubmitMember[],step:(n:number)=>void,deadlineMs?:number){
  return submitAll(members,{...this.deps(),step,first:1,...(deadlineMs===undefined?{}:{deadlineMs})}).then(final=>this.finish(final));
 }
 /** One place where a dropped spend becomes an error and a landed one triggers sync. */
 private async finish(final:SpendStatus){
  if(final.status==='dropped')throw new Error(final.reason??'The pool dropped this spend.');
  await this.sync();
  return {...(final.txid?{txid:final.txid}:{})};
 }
 private hold(nullifiers:readonly bigint[],handle:ShieldedPaymentHandle,onFail?:()=>void){
  void handle.settled({timeoutMs:30*60_000}).catch(()=>onFail?.()).finally(()=>{this.notes.release(nullifiers);this.changed();});
 }

 async shield(coins?:readonly ArkCoin[]):Promise<ShieldedPaymentHandle|undefined>{
  const plan=this.planFor(coins??await this.coins(),!coins);
  if(!plan)return undefined;
  const taken=(plan.kind==='btc'?plan.coins:[plan.coin]).map(c=>`${c.txid}:${c.vout}`);
  for(const outpoint of taken)this.used.add(outpoint);
  const handle=shieldedHandle({title:shieldTitle(plan),steps:shieldedSteps.shield,railId:'shielded-deposit'},async step=>{
   step(0);
   if(plan.kind==='asset'){
    const coin=await this.depositCoin(plan.coin.txid,plan.coin.value,{assetId:plan.assetId,amount:plan.units});
    const [assetSlot,btcSlot]=await this.account.depositAsset(assetFieldOfId(plan.assetId),plan.units,BigInt(coin.value),this.self);
    return this.submit([{built:assetSlot,extra:{coin,asset:plan.assetId},coin},{built:btcSlot}],step);
   }
   const single=plan.coins.length===1?plan.coins[0]!:undefined;
   const coin=single?await this.depositCoin(single.txid,single.value):await this.depositCoin(await this.send({recipients:[{address:await this.getAddress(),amount:plan.amount}]}),plan.amount);
   this.used.add(`${coin.txid}:${coin.vout}`);
   return this.submit([{built:await this.account.spend({deposit:BigInt(plan.amount)},this.self),extra:{coin},coin}],step);
  });
  // A failed attempt hands its coins back so the retry can use them; a landed one keeps them out while the indexer catches up.
  void handle.settled({timeoutMs:30*60_000}).catch(()=>{for(const outpoint of taken)this.used.delete(outpoint);this.retryAt=Date.now()+RETRY_MS;});
  return this.announce(handle);
 }
 private async autoShield(){
  if(this.stopped||Date.now()<this.retryAt)return;
  await this.shield();
 }
 /** The pool refuses coins near expiry; a batch swap renews them, after which auto-shield picks them up. */
 async renew():Promise<string|undefined>{
  if(!needsRenewal(await this.coins(),Date.now(),SHIELD_FLOOR_MS))return undefined;
  const txid=await this.settle();
  this.retryAt=0;await this.sync();this.changed();
  return txid;
 }
 /** Waits for the coin a deposit needs with its value and asset, and returns how to spend it. */
 private async depositCoin(txid:string,value:number,asset?:{assetId:string;amount:bigint}){
  for(let i=0;i<30;i++){
   await new Promise(r=>setTimeout(r,1000));
   const found=(await this.getSpendableVtxos()).find(v=>v.txid===txid&&v.value===value&&(asset?v.assets?.length===1&&v.assets[0]!.assetId===asset.assetId&&BigInt(v.assets[0]!.amount)===asset.amount:!v.assets?.length));
   if(found?.tapTree&&found.intentTapLeafScript)return {txid:found.txid,vout:found.vout,value:found.value,tapTree:hex.encode(found.tapTree instanceof Uint8Array?found.tapTree:hex.decode(String(found.tapTree))),leaf:walletIntentLeafScriptHex(found.intentTapLeafScript)};
  }
  throw new Error('The deposit coin did not appear in your Arkade wallet.');
 }
 override async dispose():Promise<void>{
  this.stopped=true;
  if(this.timer)clearTimeout(this.timer);
  this.timer=undefined;
  for(const off of this.unwatch)try{off();}catch{/* a torn-down manager is already stopped */}
  this.unwatch=[];this.changeListeners.clear();this.actionListeners.clear();
  await super.dispose();
 }
}
