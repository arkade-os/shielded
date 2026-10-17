import {ArkAddress,PaymentRouter,ReadonlyWallet,VtxoScript,Wallet,arkAssetRail,arkRail,onchainRail,walletFeeSource,type Activity,type ArkTransaction,type ExtendedVirtualCoin,type Identity,type PaymentHandle,type WalletConfig} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {Script} from '@scure/btc-signer';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote,type PublishedBatch} from '../../packages/protocol/src/rollup/account.ts';
import {decodeClaimToken,encodeClaimToken} from '../../packages/protocol/src/rollup/bearer.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {fullViewKeyOf,sentNoteOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import {akOf,assetFieldOfId,destinationFieldOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2,parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {walletIntentLeafScriptHex} from '../stock/ark-wallet.ts';
import {entryForActivity,revealLinkOf,shieldedActivityResolver,shieldedRows,type ShieldedRowIndex} from './activity.ts';
import {bearerAccount,bearerKeysOf,bearerOf,claimSpends,linkOf,type LinkRecord} from './bearer.ts';
import {freshAccount} from './checkpoint.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from './handle.ts';
import type {PrivateLightningService} from './lightning-wallet.ts';
import {lightningRails} from './lightning.ts';
import {sameLightningSpendRequest,submitLightningSpend,validateLightningSpend,type LightningSpendRecord,type LightningSpendStore} from './lightning-spend.ts';
import {DUST,pickNote,poolApiOf,shieldPlan,transferBody,type ArkCoin,type Groth16Proof,type PoolApi,type RollupPoolStatus,type ShieldPlan,type SpendStatus} from './pool.ts';
import {SHIELDED_PRIORITY,shieldedRail,shieldedWithdrawRail} from './rails.ts';
import type {SentRecord,ShieldedNoteRepository} from './repository.ts';
import {randomSubmissionId,submitAll,type SubmitDeps,type SubmitMember} from './submit.ts';
import {WATCHDOG_MS,catchUp,catchUpAfterEvent,idle,type OnBatch} from './sync.ts';

export interface ShieldedPoolConfig {origin:string;status:RollupPoolStatus}
export interface ShieldedProver {prove(built:BuiltSpend,circuit:'spend'|'join'):Promise<Groth16Proof>;joinReady?():boolean}
export type ShieldedWalletConfig=WalletConfig&{pool:ShieldedPoolConfig;secret:string;hash:Hash;prover:ShieldedProver;shieldedRepository?:ShieldedNoteRepository;lightningSpendStore?:LightningSpendStore;bornAt?:number;fetcher?:typeof fetch};

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
 constructor(private readonly beforePick?:()=>Promise<void>){}
 pick<T>(choose:()=>Promise<T>,nullifiersOf:(chosen:T)=>bigint[]):Promise<T>{
  const next=this.queue.then(async()=>{await this.beforePick?.();const chosen=await choose();for(const n of nullifiersOf(chosen))this.inFlight.add(n);return chosen;});
  this.queue=next.then(()=>undefined,()=>undefined);
  return next;
 }
 release(nullifiers:readonly bigint[]){for(const n of nullifiers)this.inFlight.delete(n);}
}

export interface LoadedAccount {account:RollupAccount;sent:Record<string,SentRecord>;listings:string[];links:LinkRecord[];resumed:boolean;error?:string}
export type LinkState='unclaimed'|'claimed'|'taken-back';
export interface ClaimLink extends LinkRecord {token:string;state:LinkState}
const reasonOf=(error:unknown)=>(error instanceof Error?error.message:String(error))||'unreadable';
/** Never throws: a cache that cannot be read is a full sync, reported once, not a wallet that will not open. */
export async function loadAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},o:{repository?:ShieldedNoteRepository;token:string;bornAt:number;api?:PoolApi;onBatch?:OnBatch;watched?:()=>Iterable<bigint>}):Promise<LoadedAccount>{
 const fresh=async(error?:string):Promise<LoadedAccount>=>({account:o.api?await freshAccount(hash,keys,o.bornAt,o.api,o.onBatch,o.watched):RollupAccount.owning(hash,keys,{frontier:true,bornAt:o.bornAt}),sent:{},listings:[],links:[],resumed:false,...(error?{error}:{})});
 if(!o.repository)return fresh();
 try{
  const stored=await o.repository.getAccount(o.token);
  if(!stored)return await fresh();
  if(stored.v!==1)return await fresh(`Ignoring a version ${String(stored.v)} shielded snapshot; syncing from the pool.`);
  if(stored.token!==o.token)return await fresh('Ignoring a snapshot from another pool; syncing from the pool.');
  // An older client saves no `links`, and its cursor is past the mints; replaying finds them again.
  if(stored.links===undefined&&stored.account.history.some(e=>e.kind==='send'))return await fresh();
  return {account:RollupAccount.fromSnapshot(hash,keys,stored.account),sent:{...stored.sent},listings:[...(stored.listings??[])],links:[...(stored.links??[])],resumed:true};
 }catch(error){return fresh(reasonOf(error));}
}

export const SHIELD_FLOOR_MS=25*3600_000,RETRY_MS=60_000,MERGE_WAIT_MS=10*60_000;
export const shieldedSteps={
 shield:['Prepare the deposit coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],
 send:['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],
 withdraw:['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],
 merge:['Pick two notes','Prove the merge on this device','Submit to the pool','Wait for the next batch','Included'],
 topUp:['Withdraw the missing sats from the pool','Wait for them on your Arkade balance','Pay','Wait for the payment','Done'],
 link:['Pick notes','Prove the link on this device','Submit to the pool','Wait for the next batch','Ready to share'],
 claim:['Read the link','Prove the claim on this device','Submit to the pool','Wait for the next batch','Received'],
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
const rejected=(error:unknown,code:string):boolean=>typeof error==='object'&&error!==null&&((error as {code?:unknown}).code===code||rejected((error as {cause?:unknown}).cause,code));

export class ShieldedWallet extends Wallet {
 pool!:ShieldedPoolConfig;
 api!:PoolApi;
 hash!:Hash;
 prover!:ShieldedProver;
 account!:RollupAccount;
 self!:RollupRecipient;
 readonly notes=new NoteReservation(()=>this.restoreLightningSpends());
 repository?:ShieldedNoteRepository;
 /** Set by the page once the wallet exists (the client needs it); adds the Lightning rails, and is disposed first. */
 swaps?:PrivateLightningService;
 private lightningStore?:LightningSpendStore;
 private readonly lightningSubmissions=new Map<string,Promise<string>>();
 resumed=false;
 repositoryError?:string;
 private derived!:ReturnType<typeof shieldedKeysOf>;
 private token!:string;
 private poolScript!:string;
 private ownPoolAddress!:string;
 private rows!:ShieldedRowIndex;
 private sent:Record<string,SentRecord>={};
 private readonly listings=new Set<string>();
 private master!:Uint8Array;
 private readonly linkRecords=new Map<string,LinkRecord>();
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
 private statusAt=Date.now();
 /** undefined = not looked up this outage; null = looked up but unavailable (head gone); number = the expiry. */
 private headExpiry?:number|null;

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher);wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;wallet.repository=config.shieldedRepository;wallet.token=config.pool.status.pool!.token;
   wallet.poolScript=config.pool.status.pool!.script;wallet.ownPoolAddress=config.pool.status.pool!.address;wallet.master=parseMasterSecret(config.secret);
   // A checkpoint start catches up before sync() runs; if the pool refutes it, the genesis replay re-detects the same links.
   const loaded=await loadAccount(config.hash,wallet.derived.keys,{repository:config.shieldedRepository,token:wallet.token,bornAt:config.bornAt??0,api:wallet.api,onBatch:(cursor,batch,account)=>wallet.watchLinks(cursor-1,batch,account),watched:()=>wallet.openLinkNullifiers()});
   wallet.account=loaded.account;wallet.sent=loaded.sent;wallet.resumed=loaded.resumed;wallet.repositoryError=loaded.error;
   await wallet.restoreLightningSpends(config.lightningSpendStore);
   for(const txid of loaded.listings)wallet.listings.add(txid);
   for(const link of loaded.links)wallet.linkRecords.set(link.key,link);
   wallet.rows=shieldedRows(()=>wallet.account.history,field=>wallet.assetIdOf(field),destinationFieldOf(programOf(await wallet.getAddress())));
   wallet.activity.use(shieldedActivityResolver({index:wallet.rows,entries:()=>wallet.account.history,isPoolBatch:txid=>wallet.account.txids.has(txid),isListing:txid=>wallet.listings.has(txid),isLink:e=>wallet.linkRecords.has(String(e.spent[0]))}));
   await wallet.start();
   return wallet;
  }catch(error){await wallet.dispose().catch(()=>{});throw error;}
 }

 get inFlight():ReadonlySet<bigint>{return this.notes.inFlight;}
 get poolAddress():string{return this.ownPoolAddress;}
 router():PaymentRouter{
  const router=new PaymentRouter({wallet:this,prefs:{priority:SHIELDED_PRIORITY}})
   .use(shieldedRail(this)).use(shieldedWithdrawRail(this))
   .use(arkRail()).use(arkAssetRail()).use(onchainRail({feeInfo:walletFeeSource(this)}));
  for(const rail of this.swaps?lightningRails(this,this.swaps):[])router.use(rail);
  return router;
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
   const account=this.account.snapshot(),found=await this.repository.getAccount(token);
   // A row another key wrote (a tab restored to another phrase) is replaced, never merged in.
   const stored=found?.account.owner===account.owner?found:undefined;
   // ponytail: read-merge-write keeps other tabs' entries but is not atomic; merge inside saveAccount's transaction if tabs ever race.
   this.sent={...stored?.sent,...this.sent};for(const txid of stored?.listings??[])this.listings.add(txid);
   // Spends are final, so what either tab has seen spent or taken back holds for both.
   for(const link of stored?.links??[]){const mine=this.linkRecords.get(link.key);if(!mine){this.linkRecords.set(link.key,link);continue;}mine.open=mine.open.filter(nf=>link.open.includes(nf));if(link.tookBack)mine.tookBack=true;}
   await this.repository.saveAccount(token,{v:1,token,account,sent:this.sent,listings:[...this.listings],links:[...this.linkRecords.values()]});
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
   if(event.type==='vtxo_received'||event.type==='vtxo_spent'||event.type==='connection_reset')void catchUpAfterEvent(()=>this.sync(),()=>this.stopped).catch(()=>{});
  }));
  this.unwatch.push(await this.notifyIncomingFunds(()=>{this.changed();void this.autoShield().catch(()=>{});}));
  this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
  await this.autoShield().catch(()=>{});
 }
 /** Set once the pool has missed two refreshes. Only the operator renews the head, so its expiry is the deadline to exit. */
 get operatorDown():{since:number;headExpiresAt?:number}|undefined{
  return Date.now()-this.statusAt>=2*WATCHDOG_MS?{since:this.statusAt,headExpiresAt:this.headExpiry??undefined}:undefined;
 }
 private async fetchHeadExpiry(){
  const {vtxos}=await this.indexerProvider.getVtxos({scripts:[this.poolScript],spendableOnly:true});
  return vtxos.find(v=>v.assets?.some(a=>a.assetId===this.token))?.expiresAt?.getTime();
 }
 /** The safety net behind the stream: refresh the pool, catch up, then start anything waiting. Never awaits a batch. */
 private async tick():Promise<void>{
  if(this.stopped)return;
  try{this.pool={...this.pool,status:await this.api('/status')};this.statusAt=Date.now();this.headExpiry=undefined;await this.sync();}
  // Once per outage: null on an unavailable head stops the retry, and it stalls the two below by one RTT only on that tick.
  catch{if(this.operatorDown&&this.headExpiry===undefined)this.headExpiry=await this.fetchHeadExpiry().catch(()=>undefined)??null;}
  void this.autoShield().catch(()=>{});
  void this.merge().catch(()=>{});
  this.changed();
  if(!this.stopped)this.timer=setTimeout(()=>void this.tick().catch(()=>{}),WATCHDOG_MS);
 }
 async sync():Promise<number>{
  const applied=await catchUp(this.account,this.api,(cursor,batch,account)=>this.watchLinks(cursor-1,batch,account),()=>this.save(),()=>this.openLinkNullifiers());
  if(applied)this.changed();
  return applied;
 }
 private openLinkNullifiers(){return [...this.linkRecords.values()].flatMap(link=>link.open.map(BigInt));}
 /** Finds the links a batch minted and marks those it claimed; replaying the pool rebuilds them, so a restore needs nothing else. */
 private async watchLinks(number:number,batch:PublishedBatch,account:RollupAccount){
  const history=account.history,entries:HistoryEntry[]=[];
  for(let i=history.length-1;i>=0&&history[i]!.batch===number;i--)entries.push(history[i]!);
  for(const [index,slot] of batch.slots.entries())for(const link of this.linkRecords.values()){
   if(!slot.nullifiers.some(nf=>link.open.includes(nf)))continue;
   link.open=link.open.filter(nf=>!slot.nullifiers.includes(nf));
   if(entries.some(e=>e.kind==='receive'&&e.slots.includes(index)))link.tookBack=true;
  }
  for(const entry of entries){const link=await linkOf(this.hash,this.master,entry,batch);if(link)this.linkRecords.set(link.key,link);}
 }
 /** The claim links this wallet minted, newest first. */
 links():ClaimLink[]{
  return [...this.linkRecords.values()].sort((a,b)=>b.batch-a.batch).map(link=>({...link,
   token:encodeClaimToken({secret:bearerOf(this.master,BigInt(link.key)),batch:link.batch}),
   state:link.open.length?'unclaimed':link.tookBack?'taken-back':'claimed'}));
 }
 private mine(token:string){const decoded=decodeClaimToken(token),normal=encodeClaimToken(decoded);return {decoded,mine:this.links().some(l=>l.token===normal)};}
 /** Pays privately to a bearer key derived from the first note it spends; the link shows in `links()` once its batch lands. */
 async mintLink(amount:bigint,asset?:string):Promise<ShieldedPaymentHandle>{
  const held:bigint[]=[];
  const handle=shieldedHandle({title:'Creating a claim link',steps:shieldedSteps.link,railId:'shielded-link'},async step=>{
   step(0);this.assertOpen();
   if(amount<=0n)throw new Error('A claim link needs an amount above zero.');
   const bearer=(nullifier:bigint)=>{const keys=bearerKeysOf(bearerOf(this.master,nullifier));return rollupRecipientOf(this.hash,keys.ask,keys.nk,keys.viewSecret);};
   const {spends}=await this.notes.pick(()=>this.account.pay(bearer,amount,this.self,this.notes.inFlight,asset?assetFieldOfId(asset):BTC_ASSET,{join:this.prover.joinReady?.()??false}),
    chosen=>chosen.spends.flatMap(s=>s.witness.slot.nullifiers));
   held.push(...spends.flatMap(s=>s.witness.slot.nullifiers));this.assertOpen();
   return this.submit(spends.map(built=>({built})),step);
  });
  this.hold(held,handle);
  return this.announce(handle);
 }
 /** What a link holds now, and whether this wallet minted it; a malformed token throws before anything is fetched. */
 async inspectLink(token:string):Promise<{notes:{asset:bigint;amount:bigint}[];mine:boolean}>{
  const {decoded,mine}=this.mine(token);
  const {notes}=await bearerAccount(this.hash,decoded,this.api,this.mergeableAssets());
  return {notes:notes.map(n=>({asset:n.asset,amount:n.amount})),mine};
 }
 /** Claims everything a link holds into this wallet; on one of its own links, that takes it back. */
 async claimLink(token:string):Promise<ShieldedPaymentHandle>{
  const {decoded,mine}=this.mine(token);
  const handle=shieldedHandle({title:mine?'Taking back a link':'Claiming a link',steps:shieldedSteps.claim,railId:'shielded-claim'},async step=>{
   step(0);this.assertOpen();
   const link=await bearerAccount(this.hash,decoded,this.api,this.mergeableAssets());
   if(!link.notes.length)throw new Error('This link is empty or already claimed.');
   const spends=await claimSpends(this.hash,link,this.self);this.assertOpen();
   try{return await this.submit(spends.map(built=>({built})),step);}
   // A racing claim of the same notes carries the same group id, so the pool may refuse it as a full group instead.
   catch(error){throw rejected(error,'double-spend')||rejected(error,'group-invalid')?new Error('Someone claimed this link first, or an earlier claim of it is still pending.'):error;}
  });
  return this.announce(handle);
 }

 async coins():Promise<ArkCoin[]>{
  this.assertOpen();
  return (await this.getSpendableVtxos()).map(v=>({txid:v.txid,vout:v.vout,value:v.value,...(v.expiresAt instanceof Date?{expiresAt:v.expiresAt.getTime()}:{}),...(v.assets?.length?{assets:v.assets.map(a=>({assetId:a.assetId,amount:BigInt(a.amount)}))}:{})}));
 }
 isPoolPayout(coin:{txid:string}){return this.account.txids.has(coin.txid);}
 async restoreLightningSpends(store?:LightningSpendStore):Promise<void>{
  if(store){if(this.lightningStore&&this.lightningStore!==store)throw new Error('Lightning funding must use the wallet\'s durable journal.');this.lightningStore=store;}
  if(!this.account||!this.lightningStore)return;
  const owner=String(this.self.owner),pool=this.token;
  const records=(await this.lightningStore.list(owner,pool)).map(r=>validateLightningSpend(r,owner,pool));
  for(const record of records){
   if(record.state==='dropped')continue;
   for(const nullifier of record.nullifiers)this.notes.inFlight.add(BigInt(nullifier));
   if(record.coin)this.used.add(`${record.coin.txid}:${record.coin.vout}`);
  }
 }
 private async prepareLightning(request:Pick<LightningSpendRecord,'id'|'reference'|'kind'|'amount'>&Partial<Pick<LightningSpendRecord,'paymentHash'|'destination'|'coin'|'expiresAt'>>,store:LightningSpendStore,build:()=>Promise<{built:BuiltSpend;extra?:SubmitMember['extra']}>){
  this.assertOpen();await this.restoreLightningSpends(store);
  const owner=String(this.self.owner),pool=this.token;
  return this.notes.pick(async()=>{
   this.assertOpen();
   const existing=await store.get(owner,pool,request.id);
   if(existing){
    validateLightningSpend(existing,owner,pool);
    if(!sameLightningSpendRequest(existing,{...existing,...request,coin:request.coin,expiresAt:request.expiresAt}))throw new Error('This Lightning artifact belongs to a different funding request.');
    return existing;
   }
   const prior=await store.list(owner,pool);
   if(prior.some(r=>r.state!=='dropped'&&(r.reference===request.reference||!!request.paymentHash&&r.paymentHash===request.paymentHash||!!request.coin&&r.coin?.txid===request.coin.txid&&r.coin?.vout===request.coin.vout)))throw new Error('A Lightning payment or payout is already funded or reserved.');
   const {built,extra}=await build(),proof=await this.prover.prove(built,'spend');this.assertOpen();
   const candidate:LightningSpendRecord={v:1,...request,owner,pool,nullifiers:built.witness.slot.nullifiers.map(String),body:transferBody(randomSubmissionId(),built,proof,extra),state:'prepared'};
   validateLightningSpend(candidate,owner,pool);
   const saved=validateLightningSpend(await store.create(candidate),owner,pool);
   if(!sameLightningSpendRequest(saved,candidate))throw new Error('The Lightning journal returned a different funding request.');
   return saved;
  },record=>{if(record.coin&&record.state!=='dropped')this.used.add(`${record.coin.txid}:${record.coin.vout}`);return record.state==='dropped'?[]:record.nullifiers.map(BigInt);});
 }
 private async runLightning(record:LightningSpendRecord,identity:Identity,store:LightningSpendStore,step?:(n:number)=>void,signal?:AbortSignal){
  const existing=this.lightningSubmissions.get(record.id);if(existing)return existing;
  const run=(async()=>{
   const api:PoolApi=async<T,>(path:string,body?:unknown,beforeRequest?:()=>void)=>{const guard=()=>{this.assertOpen();signal?.throwIfAborted();beforeRequest?.();};guard();return this.api<T>(path,body,guard);};
   const final=await submitLightningSpend(record,store,{api,identity,poolScript:this.poolScript,step});
   if(final.status==='dropped'){
    this.notes.release(record.nullifiers.map(BigInt));if(record.coin)this.used.delete(`${record.coin.txid}:${record.coin.vout}`);
    await this.restoreLightningSpends();this.changed();throw new Error(final.reason??'The pool dropped this Lightning spend.');
   }
   await this.finish(final);this.changed();return final.txid!;
  })();
  this.lightningSubmissions.set(record.id,run);
  try{return await run;}finally{if(this.lightningSubmissions.get(record.id)===run)this.lightningSubmissions.delete(record.id);}
 }
 async fundLightning(id:string,paymentHash:string,verifiedHTLCaddress:string,amount:bigint,store:LightningSpendStore,signal?:AbortSignal,expiresAt?:number):Promise<string>{
  this.assertOpen();signal?.throwIfAborted();
  if(!id||!/^[0-9a-f]{64}$/.test(paymentHash)||amount<BigInt(DUST)||expiresAt!==undefined&&(!Number.isSafeInteger(expiresAt)||expiresAt<=0))throw new Error('A Lightning funding request needs its artifact, payment hash, full amount, and valid deadline.');
  const address=ArkAddress.decode(verifiedHTLCaddress),pool=ArkAddress.decode(this.ownPoolAddress);
  if(address.hrp!==pool.hrp||hex.encode(address.serverPubKey)!==hex.encode(pool.serverPubKey))throw new Error('The Lightning HTLC belongs to another Arkade server.');
  const destination=address.encode(),program=address.pkScript.subarray(2);
  const record=await this.prepareLightning({id,reference:paymentHash,kind:'fund',paymentHash,destination,amount:String(amount),...(expiresAt!==undefined?{expiresAt}:{})},store,async()=>{
   const input=pickNote(this.account.notes(),amount,this.notes.inFlight);
   if(!input)throw new Error('No single pool note covers the full Lightning payment.');
   return {built:await this.account.spend({input,withdraw:amount,program},this.self),extra:{program}};
  });
  return this.runLightning(record,this.identity,store,undefined,signal);
 }
 async shieldLightning(singleVirtualCoin:ExtendedVirtualCoin,descriptorSigner:Identity,store:LightningSpendStore,request:{id:string;reference:string;signal?:AbortSignal}):Promise<ShieldedPaymentHandle>{
  this.assertOpen();request.signal?.throwIfAborted();const input=singleVirtualCoin;
  if(!request.id||!/^[0-9a-f]{64}$/i.test(input.txid)||!Number.isSafeInteger(input.vout)||input.vout<0||!Number.isSafeInteger(input.value)||input.value<DUST||input.assets?.length||input.isSpent||input.spentBy||input.isSwept||input.isUnrolled||!input.tapTree||!input.intentTapLeafScript)throw new Error('Shield one spendable plain Lightning payout at a time.');
  const coin={txid:input.txid.toLowerCase(),vout:input.vout,value:input.value,tapTree:hex.encode(input.tapTree),leaf:walletIntentLeafScriptHex(input.intentTapLeafScript)};
  if(request.reference!==`${coin.txid}:${coin.vout}`)throw new Error('The Lightning payout reference must identify its outpoint.');
  const tree=VtxoScript.decode(input.tapTree);tree.findLeaf(coin.leaf);
  const key=hex.encode(await descriptorSigner.xOnlyPublicKey()),ops=Script.decode(hex.decode(coin.leaf));
  const signs=ops.some((op,i)=>op instanceof Uint8Array&&op.length===32&&hex.encode(op)===key&&(ops[i+1]==='CHECKSIG'||ops[i+1]==='CHECKSIGVERIFY'));
  if(hex.encode(tree.pkScript)!==input.script.toLowerCase()||!signs)throw new Error('The Lightning payout script does not match its child signer.');
  const handle=shieldedHandle({id:request.id,title:`Shielding ${sats(input.value)} Lightning sats`,steps:shieldedSteps.shield,railId:'shielded-lightning-deposit'},async step=>{
   step(0);
   const record=await this.prepareLightning({id:request.id,reference:request.reference,kind:'shield',destination:input.script.toLowerCase(),amount:String(input.value),coin},store,async()=>({built:await this.account.spend({deposit:BigInt(input.value)},this.self),extra:{coin:{txid:coin.txid,vout:coin.vout,tapTree:coin.tapTree,leaf:coin.leaf}}}));
   return {txid:await this.runLightning(record,descriptorSigner,store,step,request.signal)};
  });
  return this.announce(handle);
 }
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
  this.nativeOperations++;
  try{await this.restoreLightningSpends();this.assertOpen();if(inputs?.some(coin=>this.reserved(coin)))throw new Error('A selected coin is reserved for shielding.');return await run();}finally{this.nativeOperations--;}
 }
 override async getSpendableVtxos(...args:Parameters<Wallet['getSpendableVtxos']>){
  await this.restoreLightningSpends();
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
  if(this.lightningStore){await this.restoreLightningSpends();this.assertOpen();}
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
 async withdraw(to:string,amount:bigint,opts:{asset?:string;sats?:bigint}={}):Promise<ShieldedPaymentHandle>{return this.announce(this.withdrawal(to,amount,opts));}
 private withdrawal(to:string,amount:bigint,opts:{asset?:string;sats?:bigint}={}):ShieldedPaymentHandle{
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
  return handle;
 }
 /** Sats a swap can fund from: never more than the SDK's `available`, which leaves out recoverable coins and asset carriers. */
 async arkadeSats():Promise<number>{
  return (await this.getSpendableVtxos({genericallySpendableOnly:true,withRecoverable:false})).filter(v=>!v.assets?.length).reduce((sum,v)=>sum+v.value,0);
 }
 /** Pays `need` sats from the Arkade balance, first withdrawing what it lacks (at least the dust) to this wallet's own address. */
 topUp(need:number,title:string,pay:()=>Promise<PaymentHandle>):ShieldedPaymentHandle{
  return this.announce(shieldedHandle({title,steps:shieldedSteps.topUp,railId:'shielded-topup'},async step=>{
   this.assertOpen();
   // Holds auto-shield and renewal off, which would otherwise spend the coins this payment is counting on.
   this.nativeOperations++;
   try{
    step(0);
    const lacking=need-await this.arkadeSats();
    if(lacking>0){
     await this.withdrawal(await this.getAddress(),BigInt(Math.max(lacking,DUST))).settled();
     step(1);
     for(let i=0;await this.arkadeSats()<need;i++){
      if(i>=60)throw new Error('The withdrawn sats did not reach your Arkade balance.');
      this.assertOpen();await new Promise(r=>setTimeout(r,1000));
     }
    }
    step(2);const paid=await pay();
    step(3);const result=await paid.settled();
    return result.txid?{txid:result.txid}:{};
   }finally{this.nativeOperations--;}
  }));
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
  const swaps=this.swaps;this.swaps=undefined;
  await swaps?.[Symbol.asyncDispose]().catch(()=>{});
  for(const off of this.unwatch)try{off();}catch{/* a torn-down manager is already stopped */}
  this.unwatch=[];this.changeListeners.clear();this.actionListeners.clear();this.latestAction=undefined;
  await super.dispose();
 }
}
