import {ArkAddress,PaymentRouter,ReadonlyWallet,VtxoScript,Wallet,arkAssetRail,arkRail,isVtxoSpent,onchainRail,walletFeeSource,type Activity,type ArkTransaction,type ExtendedVirtualCoin,type IWallet,type Identity,type NormalizedExtendedVirtualCoin,type PaymentHandle,type WalletConfig} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {Script} from '@scure/btc-signer';
import {EpochAccount,type EpochAnchorPlan,type EpochHistoryEntry,type EpochOwnedNote,type EpochSpendRequest} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {decodeClaimToken,encodeClaimToken} from '../../packages/protocol/src/rollup/bearer.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {acceptsDepositFee,maxDepositFeeOf,parseDepositFeeSchedule,type DepositFee,type DepositFeeSchedule} from '../../packages/protocol/src/rollup/deposit-fee.ts';
import {fullViewKeyOf,sentNoteOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import type {RollupEpochRecord} from '../../packages/protocol/src/rollup/epoch-record.ts';
import {akOf,assetFieldOfId,destinationFieldOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2,parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {walletIntentLeafScriptHex} from '../stock/ark-wallet.ts';
import {entryForActivity,shieldedActivityResolver,shieldedRows,type ShieldedRowIndex} from './activity.ts';
import {bearerAccount,bearerKeysOf,bearerOf,linkOf,type LinkRecord} from './bearer.ts';
import {epochConfirmed,epochFreshAccount,epochMatchesPool,knownEpochPool} from './epoch-checkpoint.ts';
import {epochRevealLinkOf} from './epoch-disclosure.ts';
import {epochTransferBody} from './epoch-pool.ts';
import {claimRecovery,needsRecovery} from './epoch-recovery.ts';
import {EVENT_RETRY_MS,WATCHDOG_MS,catchUpAfterEvent,epochCatchUp,epochIdle,type EpochOnBatch} from './epoch-sync.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from './handle.ts';
import type {ExitPayout,PrivateLightningService} from './lightning-wallet.ts';
import type {LightningRepository} from './lightning-repository.ts';
import {lightningRails} from './lightning.ts';
import {feeRefused,sameLightningSpendRequest,submitLightningSpend,validateLightningSpend,type LightningSpendRecord,type LightningSpendStore} from './lightning-spend.ts';
import {DUST,depositFeeFor,pickNote,planFeeOf,poolApiOf,rejected,shieldPlan,shieldableWithFee,type ArkCoin,type Groth16Proof,type PoolApi,type RollupPoolStatus,type ShieldPlan,type SpendStatus} from './pool.ts';
import {SHIELDED_PRIORITY,poolFundedExit,shieldedRail,shieldedWithdrawRail} from './rails.ts';
import type {SentRecord,ShieldedNoteRepository,ShieldedSnapshot} from './repository.ts';
import {randomSubmissionId,submitAll,type SubmitDeps,type SubmitMember} from './submit.ts';
import {PRIVATE_SUBMIT_JITTER_MS,cacheVtxoSync,isPrivatePoolApi,isSealedFetch,markPrivatePoolApi,markPrivatePoolPage,privateInterval,privatePoolPage} from './network-privacy.ts';
import type {SyncProgressObserver} from './sync-progress.ts';
export type {ShieldedSyncProgress,SyncProgressObserver} from './sync-progress.ts';

export interface ShieldedPoolConfig {origin:string;status:RollupPoolStatus}
export interface ShieldedProver {prove(built:EpochBuiltSpend,circuit:'spend'|'join'):Promise<Groth16Proof>;joinReady?():boolean}
export type ShieldedWalletConfig=WalletConfig&{pool:ShieldedPoolConfig;secret:string;hash:Hash;prover:ShieldedProver;shieldedRepository?:ShieldedNoteRepository;lightningSpendStore?:LightningSpendStore;bornAt?:number;maxDepositFee?:DepositFeeSchedule;fetcher?:typeof fetch;networkPrivacy?:boolean;poolPage?:number;batchSwaps?:boolean;maxShieldCoins?:number;pendingNullifiers?:()=>ReadonlySet<bigint>;pendingOutpoints?:()=>ReadonlySet<string>;lnurlFetch?:typeof fetch;claimFetch?:typeof fetch;onSyncProgress?:SyncProgressObserver;
 /** Called once with the Arkade address, synchronously and before the pool sync; a throw aborts create. */
 onArkAddress?:(address:string)=>void};

export function shieldedKeysOf(hash:Hash,secret:string){
 const keys=deriveRollupKeys2(secret,MUTINYNET_KEY_NETWORK),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 return {keys,self,address:rollupAddressOf(self),viewKey:viewKeyOf(self.owner,keys.viewSecret),fullViewingKey:fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret)};
}

/**
 * Note selection and reservation in one critical section. `EpochAccount.pay`/`consolidate` read the unspent set
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

export interface LoadedAccount {account:EpochAccount;sent:Record<string,SentRecord>;listings:string[];links:LinkRecord[];resumed:boolean;storedBatch?:number;feeAccepted?:DepositFeeSchedule;error?:string;offline?:true}
export type LinkState='unclaimed'|'claimed'|'taken-back';
export interface ClaimLink extends LinkRecord {token:string;state:LinkState}
const reasonOf=(error:unknown)=>(error instanceof Error?error.message:String(error))||'unreadable';
/**
 * An unreadable cache or an unreachable pool still opens, reported once. Throws when the pool contradicts a saved epoch's root, or
 * names no epoch length to open with. `links` receives the saved links before the pool check replays batches through the hooks.
 */
export async function loadAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},o:{repository?:ShieldedNoteRepository;token:string;epochLen?:number;bornAt:number;api?:PoolApi;onBatch?:EpochOnBatch;watched?:()=>Iterable<bigint>;links?:Map<string,LinkRecord>;status?:RollupPoolStatus;onSyncProgress?:SyncProgressObserver}):Promise<LoadedAccount>{
 const known=knownEpochPool(o.status,o.token);
 const opened=(account:EpochAccount,error?:string,kept?:ShieldedSnapshot,offline=false):LoadedAccount=>({account,sent:{...kept?.sent},listings:[...(kept?.listings??[])],links:[...(kept?.links??[])],resumed:!!kept,...(kept?{storedBatch:kept.account.batch}:{}),feeAccepted:parseDepositFeeSchedule(kept?.feeAccepted),...(error?{error}:{}),...(offline?{offline:true as const}:{})});
 const unsynced=(cause:unknown)=>{if(!o.epochLen)throw cause;return EpochAccount.owning(hash,keys,{epochLen:o.epochLen,bornAt:o.bornAt});};
 const unchecked=(cause:unknown)=>`Opened without the pool, so the saved notes are unchecked: ${reasonOf(cause)}`;
 const fresh=async(error?:string):Promise<LoadedAccount>=>{
  if(!o.api)return opened(unsynced(new Error('That pool is not an open epoch pool.')),error);
  try{return opened(await epochFreshAccount(hash,keys,o.bornAt,o.api,o.onBatch,o.watched,o.onSyncProgress,known),error);}
  catch(cause){return opened(unsynced(cause),`Opened without the pool, so the wallet is empty until it syncs: ${reasonOf(cause)}`,undefined,true);}
 };
 if(!o.repository)return fresh();
 let stored:ShieldedSnapshot,account:EpochAccount,offline:string|undefined,pool:RollupPoolStatus['pool'];
 try{
  const found=await o.repository.getAccount(o.token);
  if(!found)return await fresh();
  if(found.v!==2)return await fresh(`Ignoring a version ${String(found.v)} shielded snapshot; syncing from the pool.`);
  if(found.token!==o.token)return await fresh('Ignoring a snapshot from another pool; syncing from the pool.');
  // An older client saves no `links`, and its cursor is past the mints; replaying finds them again.
  if(found.links===undefined&&found.account.history.some(e=>e.kind==='send'))return await fresh();
  let epochLen=o.epochLen;
  if(o.api)try{pool=known&&known.epochLen===found.account.epochLen&&known.batches>=found.account.batch?known:(await o.api<RollupPoolStatus>('/status')).pool;epochLen=pool?.epochLen;if(!epochLen)throw new Error('That pool is not an open epoch pool.');}
  catch(cause){epochLen=found.account.epochLen;offline=unchecked(cause);}
  account=EpochAccount.fromSnapshot(hash,keys,found.account,epochLen??0);stored=found;
 }catch(error){return fresh(reasonOf(error));}
 for(const link of stored.links??[])o.links?.set(link.key,link);
 // loadEpochAccount's check: a previous-epoch root the pool contradicts throws, where a quiet replay would hide the drift.
 let matches=true;
 if(o.api&&!offline)try{matches=await epochMatchesPool(account,o.api,undefined,o.onBatch,o.watched,pool,o.onSyncProgress);}
 catch(cause){if(rejected(cause,'root-drift'))throw cause;offline=unchecked(cause);}
 if(!matches){o.links?.clear();return fresh('The saved wallet does not match the pool; syncing from the pool.');}
 return opened(account,offline,stored,!!offline);
}

export const SHIELD_FLOOR_MS=25*3600_000,RETRY_MS=60_000,MERGE_WAIT_MS=10*60_000;
export const shieldedSteps={
 shield:['Prepare the deposit coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],
 send:['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],
 withdraw:['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],
 merge:['Pick two notes','Prove the merge on this device','Submit to the pool','Wait for the next batch','Included'],
 exit:['Withdraw the sats from the pool','Wait for them on a fresh single-use key','Send them to the Bitcoin chain','Wait for the batch swap','Done'],
 link:['Pick notes','Prove the link on this device','Submit to the pool','Wait for the next batch','Ready to share'],
 claim:['Read the link','Prove the claim on this device','Submit to the pool','Wait for the next batch','Received'],
} as const;
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
/** `fee` is what the plan pays (depositFeeOnPlan), not the schedule, so an exempt payout names none. */
export const shieldTitle=(plan:ShieldPlan,fee=0n)=>(plan.kind==='btc'?`Shielding ${sats(plan.amount)} sats`:`Shielding ${sats(plan.units)} units of asset ${short(plan.assetId)}`)+(fee>0n?` with a ${sats(fee)}-sat deposit fee`:'');
const feePaused=(fee:DepositFeeSchedule)=>`Deposits are paused: this pool now charges a deposit fee of ${sats(fee.fixedSats)} sats or ${fee.bps} bps of the deposit, whichever is more, which is above what this wallet has accepted. Once it is shown, accept it with acceptDepositFee({fixedSats:${fee.fixedSats},bps:${fee.bps}}), or pass maxDepositFee of at least that.`;
const validSchedule=(value:unknown,name:string)=>{const schedule=parseDepositFeeSchedule(value);if(!schedule)throw new Error(`${name} must be {fixedSats,bps}: whole, non-negative numbers, with bps at most 10000.`);return schedule;};
export const nextShieldPlan=(coins:readonly ArkCoin[],o:{skip:(c:ArkCoin)=>boolean;used:ReadonlySet<string>;listed:ReadonlySet<string>;now:number;floorMs:number;fee?:Parameters<typeof shieldPlan>[4];maxCoins?:number})=>
 shieldPlan(coins.filter(c=>!o.skip(c)&&!o.used.has(`${c.txid}:${c.vout}`)),o.listed,o.now,o.floorMs,o.fee,o.maxCoins);
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
 account!:EpochAccount;
 self!:RollupRecipient;
 // Unchecked notes may anchor on a stale or drifted root, so nothing is built from them until tick() checks the wallet.
 readonly notes=new NoteReservation(async()=>{if(this.offline)throw new Error(this.repositoryError??'The pool has not checked this wallet yet.');await this.restoreLightningSpends();});
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
 private claimApi?:PoolApi;
 private readonly changeListeners=new Set<()=>void>();
 private readonly used=new Set<string>();
 private readonly usedTxids=new Set<string>();
 private readonly actionListeners=new Set<(h:ShieldedPaymentHandle)=>void>();
 private latestAction?:ShieldedPaymentHandle;
 private unwatch:(()=>void)[]=[];
 private startup=Promise.resolve();
 private timer?:ReturnType<typeof setTimeout>;
 private statusTimer?:ReturnType<typeof setTimeout>;
 private statusRead?:Promise<boolean>;
 private statusRevision=0;
 private retryAt=0;
 private mergeRetryAt=0;
 private renewing=false;
 private stopped=false;
 private offline=false;
 private bornAt=0;
 private maxDepositFee?:DepositFeeSchedule;
 private feeAccepted?:DepositFeeSchedule;
 private selfSending=false;
 private nativeOperations=0;
 private statusAt=Date.now();
 private statusReadAt=0;
 private networkPrivacy=false;
 private sealedTransport=false;
 private batchSwaps?:boolean;
 private maxShieldCoins?:number;
 private pendingNullifiers?:()=>ReadonlySet<bigint>;
 private pendingOutpoints?:()=>ReadonlySet<string>;
 private lnurlFetch?:typeof fetch;
 private onSyncProgress?:SyncProgressObserver;
 /** undefined = not looked up this outage; null = looked up but unavailable (head gone); number = the expiry. */
 private headExpiry?:number|null;
 /** Read while the pool answered: a sealed wallet reaches the indexer through the pool server, so an outage read cannot. */
 private lastHeadExpiry?:number;
 private lastHead?:string;
 private headRead?:Promise<void>;
 /** When the last read began, for lastHead, until one found a deadline still ahead or the pool named another head; the next waits ten watchdog rounds from it. */
 private headReadAt?:number;

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const maxDepositFee=config.maxDepositFee===undefined?undefined:validSchedule(config.maxDepositFee,'maxDepositFee');
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   // The manager starts up against the indexer while load() reads the pool; start() awaits this same start-up.
   void wallet.getContractManager().catch(()=>{});
   config.onArkAddress?.(await wallet.getAddress());
   const observer=config.onSyncProgress;wallet.onSyncProgress=observer?(progress=>{if(!wallet.stopped)return observer(progress);}):undefined;
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher,config.poolPage,wallet.onSyncProgress);wallet.claimApi=config.claimFetch?poolApiOf(config.pool.origin,config.claimFetch,config.poolPage):undefined;wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.networkPrivacy=config.networkPrivacy??isPrivatePoolApi(wallet.api);wallet.sealedTransport=isSealedFetch(config.fetcher);wallet.batchSwaps=config.batchSwaps;wallet.maxShieldCoins=config.maxShieldCoins;
   if(wallet.networkPrivacy){
    const live=(api:PoolApi):PoolApi=>markPrivatePoolPage(markPrivatePoolApi(async<T,>(path:string,body?:unknown,beforeRequest?:()=>void)=>{
     wallet.assertOpen();
     const result=await api<T>(path,body,()=>{wallet.assertOpen();beforeRequest?.();});
     wallet.assertOpen();return result;
    }),privatePoolPage(api));
    wallet.api=live(wallet.api);if(wallet.claimApi)wallet.claimApi=live(wallet.claimApi);
   }
   wallet.pendingNullifiers=config.pendingNullifiers;wallet.pendingOutpoints=config.pendingOutpoints;wallet.lnurlFetch=config.lnurlFetch;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;wallet.repository=config.shieldedRepository;wallet.token=config.pool.status.pool!.token;
   wallet.poolScript=config.pool.status.pool!.script;wallet.ownPoolAddress=config.pool.status.pool!.address;wallet.master=parseMasterSecret(config.secret);wallet.bornAt=config.bornAt??0;wallet.maxDepositFee=maxDepositFee;
   await wallet.load(wallet.networkPrivacy?config.pool.status:undefined);
   await wallet.restoreLightningSpends(config.lightningSpendStore);
   wallet.rows=shieldedRows(()=>wallet.account.history,field=>wallet.assetIdOf(field),destinationFieldOf(programOf(await wallet.getAddress())));
   wallet.activity.use(shieldedActivityResolver({index:wallet.rows,entries:()=>wallet.account.history,isPoolBatch:txid=>wallet.account.txids.has(txid),isListing:txid=>wallet.listings.has(txid),isLink:e=>wallet.linkRecords.has(String(e.spent[0])),
    exitOf:e=>{const sent=wallet.sentOf(e.spent[0]!);return sent?.onchainTxid?{to:sent.to,txid:sent.onchainTxid,...(sent.onchainSats===undefined?{}:{sats:sent.onchainSats})}:undefined;}}));
   await wallet.start();
   return wallet;
  }catch(error){await wallet.dispose().catch(()=>{});throw error;}
 }

 get inFlight():ReadonlySet<bigint>{return this.pendingNullifiers?new Set([...this.notes.inFlight,...this.pendingNullifiers()]):this.notes.inFlight;}
 get poolAddress():string{return this.ownPoolAddress;}
 get depositFee():DepositFee|undefined{return depositFeeFor(this.pool.status);}
 get acceptedDepositFee():DepositFeeSchedule|undefined{return maxDepositFeeOf(this.maxDepositFee,this.feeAccepted);}
 get depositFeePaused():DepositFee|undefined{const fee=this.depositFee;return acceptsDepositFee(fee,this.acceptedDepositFee)?undefined:fee;}
 /** Raises the accepted schedule to `shown`, the one the user saw, and saves it for this pool. Never the advertised one: a fee raised since stays paused. */
 async acceptDepositFee(shown:DepositFeeSchedule):Promise<void>{
  this.assertOpen();this.feeAccepted=maxDepositFeeOf(this.feeAccepted,validSchedule(shown,'The accepted schedule'));this.retryAt=0;
  try{await this.persist(true);}finally{this.changed();void this.autoShield().catch(()=>{});}
 }
 depositFeeOnPlan(plan:ShieldPlan):bigint{return planFeeOf(plan,this.depositFee,c=>this.isPoolPayout(c));}
 private assertFeeAccepted(){const paused=this.depositFeePaused;if(paused)throw Object.assign(new Error(feePaused(paused)),{code:'fee-paused'});}
 /** The fee note for depositing exactly `plan`, read as it is built, since the schedule moves; `charged` once the pool has refused the exemption. */
 private depositFeeTo(plan:ShieldPlan,charged=false):EpochSpendRequest['to']{
  this.assertFeeAccepted();
  const fee=this.depositFee,exempt=charged?undefined:(c:ArkCoin)=>this.isPoolPayout(c),owed=planFeeOf(plan,fee,exempt);
  if(!shieldableWithFee(plan,fee,exempt))throw new Error(`This deposit would keep less than the ${DUST}-sat minimum after its ${owed}-sat deposit fee, so it stays outside the pool.`);
  return owed>0n?{recipient:parseRollupAddress(fee!.address),amount:owed}:undefined;
 }
 router():PaymentRouter{
  const feeInfo=walletFeeSource(this);
  const router=new PaymentRouter({wallet:this,prefs:{priority:SHIELDED_PRIORITY}})
   .use(shieldedRail(this)).use(shieldedWithdrawRail(this))
   .use(arkRail()).use(arkAssetRail()).use(poolFundedExit(this,onchainRail({feeInfo}),feeInfo));
  for(const rail of this.swaps?lightningRails(this,this.swaps,this.lnurlFetch):[])router.use(rail);
  return router;
 }
 shieldedBalance(asset=BTC_ASSET):bigint{return this.account.balance(asset);}
 shieldedNotes(asset=BTC_ASSET):EpochOwnedNote[]{return this.account.notes(asset);}
 /** Held notes that only a recovery reaches: in the balance, never spendable. None until the account can anchor. */
 get recovering():EpochOwnedNote[]{
  let plan:EpochAnchorPlan;
  try{plan=this.account.anchorPlan();}catch{return [];}
  return this.mergeableAssets().flatMap(asset=>this.account.notes(asset)).filter(n=>needsRecovery(n,plan));
 }
 get recoveryInFlight():EpochOwnedNote[]{return this.recovering.filter(n=>this.inFlight.has(n.nullifier));}
 shieldedHistory():readonly EpochHistoryEntry[]{return this.account.history;}
 override async getTransactionHistory():Promise<ArkTransaction[]>{
  const sdk=await super.getTransactionHistory();
  return [...sdk,...this.rows.rows()].sort((a,b)=>b.createdAt-a.createdAt);
 }
 private origin(){return this.pool.origin||globalThis.location?.origin||'';}
 revealLink(payment:EpochHistoryEntry):string|undefined{
  return epochRevealLinkOf(this.origin(),payment,{self:this.shieldedAddress(),sentOf:n=>this.sentOf(n)});
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
 async save(strict=false):Promise<void>{
  if(!this.repository)return;
  const {token}=this;
  try{
   const account=this.account.snapshot(),found=await this.repository.getAccount(token);
   // A row another key wrote (a tab restored to another phrase) is replaced, never merged in.
   const stored=found?.account.owner===account.owner?found:undefined;
   // ponytail: read-merge-write keeps other tabs' entries but is not atomic; merge inside saveAccount's transaction if tabs ever race.
   this.sent={...stored?.sent,...this.sent};for(const txid of stored?.listings??[])this.listings.add(txid);
   // A settled exit is taken whole: this tab's record for the same note may be a losing spend to another destination.
   for(const [key,record] of Object.entries(stored?.sent??{}))if(record.onchainTxid&&!this.sent[key]!.onchainTxid)this.sent[key]=record;
   // Spends are final, so what either tab has seen spent or taken back holds for both.
   for(const link of stored?.links??[]){const mine=this.linkRecords.get(link.key);if(!mine){this.linkRecords.set(link.key,link);continue;}mine.open=mine.open.filter(nf=>link.open.includes(nf));if(link.tookBack)mine.tookBack=true;}
   this.feeAccepted=maxDepositFeeOf(this.feeAccepted,parseDepositFeeSchedule(stored?.feeAccepted));
   await this.repository.saveAccount(token,{v:2,token,account,sent:this.sent,listings:[...this.listings],links:[...this.linkRecords.values()],...(this.feeAccepted?{feeAccepted:this.feeAccepted}:{})});
  }catch(error){this.repositoryError??=reasonOf(error);if(strict)throw error;}
 }
 sentOf(nullifier:bigint):SentRecord|undefined{return this.sent[String(nullifier)];}
 private persist(strict=false){return epochIdle(this.account,()=>{this.assertOpen();return this.save(strict);});}
 recordSent(entries:[bigint,SentRecord][]){for(const [nullifier,record] of entries)this.sent[String(nullifier)]=record;}
 /** Opens the account, checked when the pool answers. tick() runs it again after an offline open and swallows its throw, so a drift is reported here. */
 private async load(status?:RollupPoolStatus){
  let loaded:LoadedAccount;
  // A checkpoint start catches up before sync() runs; if the pool refutes it, the genesis replay re-detects the same links.
  try{loaded=await loadAccount(this.hash,this.derived.keys,{repository:this.repository,token:this.token,epochLen:this.pool.status.pool?.epochLen??this.account?.epochLen,bornAt:this.bornAt,api:this.api,onBatch:(cursor,batch,account)=>this.watchLinks(cursor-1,batch,account),watched:()=>this.openLinkNullifiers(),links:this.linkRecords,status,onSyncProgress:this.onSyncProgress});}
  catch(error){this.repositoryError=reasonOf(error);throw error;}
  this.account=loaded.account;this.sent={...loaded.sent,...this.sent};this.resumed=loaded.resumed;this.repositoryError=loaded.error;this.offline=!!loaded.offline;this.feeAccepted=maxDepositFeeOf(this.feeAccepted,loaded.feeAccepted);
  for(const txid of loaded.listings)this.listings.add(txid);
  for(const link of loaded.links)this.linkRecords.set(link.key,link);
  // start() skips sync() for a confirmed account, so this is the only save before the first tick; an unconfirmed catch-up is never kept.
  if(epochConfirmed(this.account)&&this.account.batchCount!==loaded.storedBatch)await this.save();
 }
 /** The watch registration, the incoming-funds watch and the first auto-shield, which run behind `create()`; rejects with the watch setup's first error. */
 get started():Promise<void>{return this.startup;}
 /** Only the sealed browser transport re-draws its timers; native is private too but keeps its fixed ones. */
 private pace(ms:number){return this.sealedTransport?privateInterval(ms):ms;}
 async start():Promise<void>{
  // A confirmed account is already at the pool's count; autoShield's sync below runs once the watches are up, so nothing lands unseen.
  if(!epochConfirmed(this.account))await this.sync();
  if(this.stopped)return;
  // Armed before the watch setup, so the tick runs even when that setup fails or stalls on a POST with no deadline.
  this.timer=setTimeout(()=>void this.tick().catch(()=>{}),this.pace(WATCHDOG_MS));
  this.statusTimer=setTimeout(()=>void this.statusTick(),this.pace(WATCHDOG_MS));
  this.startup=this.finishStart();
  // A caller that never reads `started` must not turn its rejection into an unhandled one.
  this.startup.catch(()=>{});
 }
 private async finishStart():Promise<void>{
  const manager=await this.getContractManager();
  if(this.stopped)return;
  if(!this.networkPrivacy)await manager.watchScript?.(this.poolScript,{label:'shielded pool'});
  if(this.stopped)return;
  this.unwatch.push(manager.onContractEvent(event=>{
   // A watch-only event carries no contract, which is the point: the pool script is not ours. Any movement on it
   // means the head moved, and `connection_reset` means an event may have been missed.
   if(event.type==='vtxo_received'||event.type==='vtxo_spent'||event.type==='connection_reset')void catchUpAfterEvent(()=>this.sync(),()=>this.stopped,EVENT_RETRY_MS.map(ms=>this.pace(ms))).catch(()=>{});
  }));
  const off=await this.notifyIncomingFunds(()=>{this.changed();void this.autoShield().catch(()=>{});});
  // dispose() has already drained `unwatch`, so a watch that arrives after it is stopped here rather than kept.
  if(this.stopped){off();return;}
  this.unwatch.push(off);
  await this.autoShield().catch(()=>{});
 }
 /** Set once the pool has missed two refreshes. Only the operator renews the head, so its expiry is the deadline to exit. */
 get operatorDown():{since:number;headExpiresAt?:number}|undefined{
  return Date.now()-this.statusAt>=2*WATCHDOG_MS?{since:this.statusAt,headExpiresAt:this.headExpiry??this.lastHeadExpiry}:undefined;
 }
 private async fetchHeadExpiry(){
  const {vtxos}=await this.indexerProvider.getVtxos({scripts:[this.poolScript],spendableOnly:true});
  return vtxos.find(v=>v.assets?.some(a=>a.assetId===this.token))?.expiresAt?.getTime();
 }
 private poolHead(){const head=this.pool.status.pool?.head;return head&&`${head.txid}:${head.vout}`;}
 private rememberHeadExpiry(){
  const head=this.poolHead();if(head!==undefined&&head!==this.lastHead){this.lastHeadExpiry=undefined;this.headReadAt=undefined;}
  const now=Date.now(),ahead=this.lastHeadExpiry!==undefined&&this.lastHeadExpiry>now,backingOff=this.headReadAt!==undefined&&now-this.headReadAt<10*WATCHDOG_MS;
  if(!this.sealedTransport||this.headRead||ahead||backingOff)return;
  this.headReadAt=now;this.lastHead=head;
  this.headRead=this.fetchHeadExpiry().then(expiry=>{
   if(this.stopped||expiry===undefined||!Number.isFinite(expiry))return;
   // A read begun for a head the pool has since replaced says nothing of the new head's deadline, nor that reads should back off.
   if(head!==this.poolHead()){this.headReadAt=undefined;return;}
   this.lastHeadExpiry=expiry;
   if(expiry>Date.now())this.headReadAt=undefined;
  },()=>{}).then(()=>{this.headRead=undefined;});
 }
 private refreshPoolStatus():Promise<boolean>{
  if(this.stopped)return Promise.resolve(false);
  if(this.statusRead)return this.statusRead;
  const run:Promise<boolean>=(async()=>{
   const status=await this.api<RollupPoolStatus>('/status');
   if(this.stopped)return false;
   const recovered=!!this.operatorDown,was=this.depositFeePaused;
   this.pool={...this.pool,status};this.statusAt=this.statusReadAt=Date.now();this.headExpiry=undefined;this.statusRevision++;
   this.rememberHeadExpiry();
   const now=this.depositFeePaused;
   return recovered||was?.fixedSats!==now?.fixedSats||was?.bps!==now?.bps;
  })().finally(()=>{if(this.statusRead===run)this.statusRead=undefined;});
  this.statusRead=run;
  return run;
 }
 private async statusTick():Promise<void>{
  if(this.stopped)return;
  try{await this.refreshPoolStatus();}catch{}
  if(this.stopped)return;
  this.changed();
  if(!this.stopped)this.statusTimer=setTimeout(()=>void this.statusTick(),this.pace(WATCHDOG_MS));
 }
 /** The safety net behind the stream: refresh the pool, catch up, then start anything waiting. Never awaits a batch. */
 private async tick():Promise<void>{
  if(this.stopped)return;
  let atHead=false;
  // Only a tick has just read the status; finish(), renew() and catchUpAfterEvent sync without one, so the skip is not in sync().
  // Sealed browser transport only: a native wallet is private but not sealed, and reads every tick.
  try{await this.refreshPoolStatus();if(this.stopped)return;if(this.offline){await this.load();this.assertOpen();}if(!this.sealedTransport||this.pool.status.pool?.batches!==this.account.batchCount)await this.sync();if(this.stopped)return;atHead=!this.offline;}
  // Once per outage: null on an unavailable head stops the retry, and it stalls the two below by one RTT only on that tick.
  catch{if(!this.stopped&&this.operatorDown&&this.headExpiry===undefined){
   const revision=this.statusRevision,expiry=await this.fetchHeadExpiry().catch(()=>undefined)??null;
   if(!this.stopped&&revision===this.statusRevision)this.headExpiry=expiry;
  }}
  if(this.stopped)return;
  void this.autoShield(this.sealedTransport&&atHead).catch(()=>{});
  void this.merge().catch(()=>{});
  // Renewal targets are drawn against the batch count, so behind the head they would land in the wrong window.
  if(atHead){void this.renewNotes().catch(()=>{});void this.recoverNotes().catch(()=>{});}
  this.changed();
  if(!this.stopped)this.timer=setTimeout(()=>void this.tick().catch(()=>{}),this.pace(WATCHDOG_MS));
 }
 /** One renewal plan at a time, over every held asset; epochIdle keeps a replay from moving the window the targets are drawn in. */
 private async renewNotes(){
  const chosen=await this.notes.pick(async()=>{
   for(const asset of this.mergeableAssets()){
    const plan=await epochIdle(this.account,()=>this.account.renewalDue({inFlight:this.inFlight,asset}));
    if(plan&&!this.renewing){const built=await this.account.renew(plan,this.self);this.renewing=true;return {nullifiers:plan.due.map(n=>n.nullifier),built};}
   }
   return undefined;
  },chosen=>chosen?.nullifiers??[]);
  if(chosen){const done=()=>{this.renewing=false;};void this.upkeep(chosen.nullifiers,chosen.built).then(done,done);}
 }
 private async recoverNotes(){
  const chosen=await this.notes.pick(async()=>{
   const note=this.recovering.find(n=>!this.inFlight.has(n.nullifier));
   return note&&{nullifiers:[note.nullifier],built:await this.account.recover(note,this.self)};
  },chosen=>chosen?.nullifiers??[]);
  if(chosen)this.upkeep(chosen.nullifiers,chosen.built);
 }
 /** Not announced: its notes show in flight, and a recovery shows as the one recovering line. */
 private upkeep(nullifiers:bigint[],built:EpochBuiltSpend){const run=this.submit([{built}],()=>{},MERGE_WAIT_MS);this.hold(nullifiers,{settled:()=>run});this.changed();return run;}
 /** Offline, only tick()'s checked load() moves the account, so a first-run open never replays from batch 0. */
 async sync():Promise<number>{
  if(this.offline)return 0;
  const applied=await epochCatchUp(this.account,this.api,(cursor,batch,account)=>this.watchLinks(cursor-1,batch,account),()=>this.save(),()=>this.openLinkNullifiers(),this.onSyncProgress);
  if(applied)this.changed();
  return applied;
 }
 private openLinkNullifiers(){return [...this.linkRecords.values()].flatMap(link=>link.open.map(BigInt));}
 /** Finds the links a batch minted and marks those it claimed; replaying the pool rebuilds them, so a restore needs nothing else. */
 private async watchLinks(number:number,batch:RollupEpochRecord,account:EpochAccount){
  const history=account.history,entries:EpochHistoryEntry[]=[];
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
   const field=asset?assetFieldOfId(asset):BTC_ASSET,legs=(inFlight:ReadonlySet<bigint>)=>this.account.pay(bearer,amount,this.self,inFlight,field,{join:this.prover.joinReady?.()??false});
   const {spends}=await this.notes.pick(()=>legs(this.inFlight),chosen=>chosen.spends.flatMap(s=>s.witness.slot.nullifiers));
   held.push(...spends.flatMap(s=>s.witness.slot.nullifiers));this.assertOpen();
   return this.submit(spends.map(built=>({built})),step,undefined,async()=>(await legs(this.others(held,[field]))).spends.map(built=>({built})));
  });
  this.hold(held,handle);
  return this.announce(handle);
 }
 /** What a link holds now, and whether this wallet minted it; a malformed token throws before anything is fetched. */
 async inspectLink(token:string):Promise<{notes:{asset:bigint;amount:bigint}[];mine:boolean}>{
  const {decoded,mine}=this.mine(token);
  const {notes}=await bearerAccount(this.hash,decoded,this.claimApi??this.api,this.mergeableAssets());
  return {notes:notes.map(n=>({asset:n.asset,amount:n.amount})),mine};
 }
 /** Claims everything a link holds into this wallet; on one of its own links, that takes it back. */
 async claimLink(token:string):Promise<ShieldedPaymentHandle>{
  const {decoded,mine}=this.mine(token);
  const handle=shieldedHandle({title:mine?'Taking back a link':'Claiming a link',steps:shieldedSteps.claim,railId:'shielded-claim'},async step=>{
   step(0);this.assertOpen();
   const claim=async()=>{
    const link=await bearerAccount(this.hash,decoded,this.claimApi??this.api,this.mergeableAssets());
    if(!link.notes.length)throw new Error('This link is empty or already claimed.');
    const spends=await claimRecovery(this.hash,link,this.self);this.assertOpen();
    return spends.map(built=>({built}));
   };
   const members=await claim();
   try{return await this.submit(members,step,undefined,claim);}
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
 async reconcileLightningPayout(outpoint:string,store:LightningRepository):Promise<void>{
  this.assertOpen();const owner=String(this.self.owner),pool=this.token;
  for(const record of await store.payoutSpends(owner,outpoint)){
   if(record.kind!=='shield'||record.reference!==outpoint||record.state==='dropped')continue;
   validateLightningSpend(record,owner,record.pool);
   if(record.state==='included')throw Object.assign(new Error('This Lightning payout is already shielded.'),{code:'lightning-payout-shielded'});
   if(record.pool!==pool)throw new Error('The previous shielding attempt in its original pool is unresolved; its reservation is retained.');
   const status=await this.api<SpendStatus>(`/spends/${record.body.id}`);
   if(status.status==='included')throw Object.assign(new Error('This Lightning payout is already shielded.'),{code:'lightning-payout-shielded'});
   if(status.status!=='dropped')throw new Error('The previous shielding attempt is unresolved; its reservation is retained.');
   await store.finish(owner,pool,record.id,{state:'dropped',reason:status.reason});
   this.notes.release(record.nullifiers.map(BigInt));if(record.coin)this.used.delete(`${record.coin.txid}:${record.coin.vout}`);
  }
  await this.restoreLightningSpends(store);this.changed();
 }
 private async prepareLightning(request:Pick<LightningSpendRecord,'id'|'reference'|'kind'|'amount'>&Partial<Pick<LightningSpendRecord,'paymentHash'|'destination'|'coin'|'expiresAt'>>,store:LightningSpendStore,build:()=>Promise<{built:EpochBuiltSpend;extra?:SubmitMember['extra']}>){
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
   const candidate:LightningSpendRecord={v:1,...request,owner,pool,nullifiers:built.witness.slot.nullifiers.map(String),body:epochTransferBody(randomSubmissionId(),built,proof,extra),state:'prepared'};
   validateLightningSpend(candidate,owner,pool);
   const saved=validateLightningSpend(await store.create(candidate),owner,pool);
   if(!sameLightningSpendRequest(saved,candidate))throw new Error('The Lightning journal returned a different funding request.');
   return saved;
  },record=>{if(record.coin&&record.state!=='dropped')this.used.add(`${record.coin.txid}:${record.coin.vout}`);return record.state==='dropped'?[]:record.nullifiers.map(BigInt);});
 }
 private landedCopy(record:LightningSpendRecord):string|false|undefined{
  const nullifier=BigInt(record.nullifiers[0]!),landed=this.account.history.find(entry=>entry.spent.includes(nullifier));
  if(landed)return landed.txid;
  // A spent note can have no history row (a zero-net group records none), so a note neither held nor listed stays reserved for good.
  return this.account.notes().some(note=>note.nullifier===nullifier)?false:undefined;
 }
 /** Its batch spends the deposit coin through a checkpoint, so `arkTxId` names the batch; swept, unrolled or spent by anything else says nothing. */
 private async landedDeposit(coin:{txid:string;vout:number}):Promise<string|false|undefined>{
  const vtxos=await this.indexerProvider.getVtxos({outpoints:[{txid:coin.txid,vout:coin.vout}]}).then(found=>found.vtxos,()=>undefined);
  const one=vtxos?.length===1?vtxos[0]!:undefined;
  if(!one||one.txid!==coin.txid||one.vout!==coin.vout||one.isSwept||one.isUnrolled)return undefined;
  if(!isVtxoSpent(one))return false;
  return one.arkTxId&&this.account.txids.has(one.arkTxId)?one.arkTxId:undefined;
 }
 /**
  * A window-tag or fee refusal, or a lapsed deadline, can never be submitted, so the pool decides it: a txid landed, false landed nothing, undefined cannot
  * tell and keeps the reservation. A deposit spends no note of ours, so only its coin answers; sync() is a silent no-op while the account is unchecked.
  */
 private async settleUnsubmittable(record:LightningSpendRecord,store:LightningSpendStore,error:unknown):Promise<SpendStatus>{
  const code=(['window-tag','fee-missing','deadline-expired'] as const).find(c=>rejected(error,c));
  if(this.offline||!code)throw error;
  // A POST sent just before the deadline can still be admitting, untracked by /spends; ten minutes on, a 404 is final. window-tag and fee-missing need no wait: a queued copy answers double-spend first.
  if(code==='deadline-expired'&&Date.now()/1000<record.expiresAt!+600)throw error;
  try{await this.sync();}catch{throw error;}
  const landed=record.coin?await this.landedDeposit(record.coin):this.landedCopy(record);
  // An unreadable txid would fail validateLightningSpend on the next open and block the wallet, so it stays reserved instead.
  if(landed===undefined||landed&&!/^[0-9a-f]{64}$/.test(landed))throw error;
  const final:SpendStatus=landed?{status:'included',txid:landed}:{status:'dropped',reason:`${reasonOf(error)} No batch of this pool carried it, so the funds never moved.`};
  await store.finish(record.owner,record.pool,record.id,{state:final.status as 'included'|'dropped',...(final.txid?{txid:final.txid}:{}),...(final.reason?{reason:final.reason,code}:{})});
  // The next attempt is then built, or paused, at the fee charged now; a failed read leaves that to the next tick, and the drop stands.
  if(!landed&&code==='fee-missing')await this.refreshStatus().catch(()=>{});
  return final;
 }
 /** The page's pause banner reads depositFeePaused, so a refresh that moves it says so now rather than at the next tick. */
 private async refreshStatus(){
  this.assertOpen();
  // A read begun before the fee refusal cannot refresh that refusal's fee schedule.
  await this.statusRead?.catch(()=>{});
  this.assertOpen();
  const changed=await this.refreshPoolStatus();
  this.assertOpen();
  if(changed)this.changed();
 }
 private async runLightning(record:LightningSpendRecord,identity:Identity,store:LightningSpendStore,step?:(n:number)=>void,signal?:AbortSignal){
  const existing=this.lightningSubmissions.get(record.id);if(existing)return existing;
  const run=(async()=>{
   const api:PoolApi=async<T,>(path:string,body?:unknown,beforeRequest?:()=>void)=>{const guard=()=>{this.assertOpen();signal?.throwIfAborted();beforeRequest?.();};guard();return this.api<T>(path,body,guard);};
   const final=await submitLightningSpend(record,store,{api,identity,poolScript:this.poolScript,step}).catch(error=>this.settleUnsubmittable(record,store,error));
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
   const input=pickNote(this.account.spendableNotes(),amount,this.inFlight);
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
  // A saved attempt is resent whatever the fee is now, since only the pool's verdict frees its payout.
  const prior=await store.list(String(this.self.owner),this.token),charged=feeRefused(prior,request.reference),plan:ShieldPlan={kind:'btc',coins:[coin],amount:input.value};
  if(!prior.some(r=>r.id===request.id))this.depositFeeTo(plan,charged);
  const handle=shieldedHandle({id:request.id,title:`Shielding ${sats(input.value)} Lightning sats`,steps:shieldedSteps.shield,railId:'shielded-lightning-deposit'},async step=>{
   step(0);
   const record=await this.prepareLightning({id:request.id,reference:request.reference,kind:'shield',destination:input.script.toLowerCase(),amount:String(input.value),coin},store,async()=>{
    const to=this.depositFeeTo(plan,charged);
    return {built:await this.account.spend({deposit:BigInt(input.value),...(to?{to}:{})},this.self),extra:{coin:{txid:coin.txid,vout:coin.vout,tapTree:coin.tapTree,leaf:coin.leaf}}};
   });
   return {txid:await this.runLightning(record,descriptorSigner,store,step,request.signal)};
  });
  return this.announce(handle);
 }
 /** `skipPayouts` is what auto-shield wants and the "Shield again" button does not: a payout is only shielded on request. */
 planFor(coins:readonly ArkCoin[],skipPayouts=true){
  const pending=this.pendingOutpoints?.(),used=pending?new Set([...this.used,...pending]):this.used;
  return nextShieldPlan(coins,{skip:c=>this.usedTxids.has(c.txid)||(skipPayouts&&this.isPoolPayout(c)),used,listed:new Set(Object.keys(this.pool.status.pool?.reserves??{})),now:Date.now(),floorMs:SHIELD_FLOOR_MS,fee:{schedule:this.depositFee,exempt:c=>this.isPoolPayout(c)},maxCoins:this.maxShieldCoins});
 }
 /** Sealed only, like pace(): native is private too but keeps the 1 s id poll and posts at once. */
 private deps():SubmitDeps{
  // Nothing new can land while the count holds; a failed catch-up, as in tick(), is looked at again next round.
  const landedBy=async(nullifiers:readonly bigint[])=>{await this.refreshPoolStatus().catch(()=>{});if(this.pool.status.pool?.batches!==this.account.batchCount)await this.sync().catch(()=>{});this.assertOpen();return this.landedSpend(nullifiers);};
  return {api:this.api,prover:this.prover,identity:this.identity,poolScript:this.poolScript,...(this.sealedTransport?{jitterMs:PRIVATE_SUBMIT_JITTER_MS,landedBy}:{})};
 }
 /** A deposit spends no note of ours, so no history row ever carries its nullifiers and only its coin can say; the indexer holds that, past any stalled operator. */
 async settledDeposit(outpoint:string):Promise<boolean|undefined>{
  const parts=outpoint.split(':');
  if(parts.length!==2||!/^[0-9a-f]{64}$/.test(parts[0]!)||!/^\d{1,10}$/.test(parts[1]!)||Number(parts[1])>0xffffffff)return undefined;
  const landed=await this.landedDeposit({txid:parts[0]!,vout:Number(parts[1])});
  return landed===undefined?undefined:!!landed;
 }
 /** undefined unless a status read this session, under two watchdog rounds old, shows the account at the pool's count: otherwise it has not looked, so the journal must not age an entry out on its word. */
 settledNullifiers(nullifiers:readonly bigint[]):boolean|undefined{return !this.offline&&Date.now()-this.statusReadAt<2*WATCHDOG_MS&&this.pool.status.pool?.batches===this.account.batchCount?!!this.landedSpend(nullifiers):undefined;}
 private landedSpend(nullifiers:readonly bigint[]):SpendStatus|undefined{
  const entry=this.account.history.find(e=>nullifiers.every(n=>e.spent.includes(n)));
  return entry&&{status:'included',batch:entry.batch,...(entry.txid?{txid:entry.txid}:{})};
 }
 /** Every held note of `assets` but `mine`, as an in-flight set: a rebuild can then choose only the notes its action already holds. */
 private others(mine:readonly bigint[],assets:readonly bigint[]){return new Set(assets.flatMap(asset=>this.account.notes(asset)).map(n=>n.nullifier).filter(nf=>!mine.includes(nf)));}
 private async submit(members:SubmitMember[],step:(n:number)=>void,deadlineMs=30*60_000,rebuild?:(cause:unknown)=>Promise<SubmitMember[]>){
  const unresolved=new Set<string>();
  const api:PoolApi=async<T,>(path:string,body?:unknown)=>{
   const id=path==='/spends'?(body as {id:string}).id:undefined;
   if(id!==undefined){this.assertOpen();unresolved.add(id);}
   // The pool refuses a stale anchor before admitting the spend, so it holds nothing; a fee refusal comes on a unit's last member and drops the whole unit.
   const result=await this.api<T>(path,body).catch((error:unknown)=>{if(id!==undefined&&rejected(error,'stale-anchor'))unresolved.delete(id);if(id!==undefined&&rejected(error,'fee-missing'))unresolved.clear();throw error;});
   if(body===undefined&&path.startsWith('/spends/')&&(result as SpendStatus).status==='dropped')unresolved.delete(path.slice('/spends/'.length));
   return result;
  };
  try{
   for(;;)try{return await this.finish(await submitAll(members,{...this.deps(),api,step,first:1,deadlineMs}));}
   catch(error){
    // Nothing was admitted. Legs built across a sync hold two anchors, so all are rebuilt, once; re-signing one would loop.
    const fee=rejected(error,'fee-missing');
    if(!rebuild||unresolved.size||!fee&&!rejected(error,'stale-anchor'))throw error;
    const again=rebuild;rebuild=undefined;
    if(fee)await this.refreshStatus();
    await this.sync();members=await again(error);
   }
  }catch(error){throw new ReservationFailure(error,unresolved.size===0);}
 }
 /** One place where a dropped spend becomes an error and a landed one triggers sync. */
 private async finish(final:SpendStatus){
  if(final.status==='dropped')throw new Error(final.reason??'The pool dropped this spend.');
  // A sealed landedBy has just synced; an id poll (a deposit, a verdict) reads no status, so a matching count can predate the spend's batch.
  if(!(this.sealedTransport&&this.pool.status.pool?.batches===this.account.batchCount&&(final.batch??Infinity)<this.account.batchCount))await this.sync();
  return {...(final.txid?{txid:final.txid}:{})};
 }
 private hold(nullifiers:readonly bigint[],handle:{settled():Promise<unknown>},onFail?:()=>void){
  const release=()=>{this.notes.release(nullifiers);this.changed();};
  void handle.settled().then(release,error=>{if(canRelease(error))release();try{onFail?.();}catch{}});
 }
 private assertOpen(){if(this.stopped)throw new Error('The wallet was closed.');}
 assertBatchSwaps(){if(this.batchSwaps===false)throw new Error('Renewal and on-chain exits need Arkade\'s live batch stream, which this private transport cannot carry.');}
 private reserved(coin:{txid:string;vout:number},pending=this.pendingOutpoints?.()){const outpoint=`${coin.txid}:${coin.vout}`;return this.used.has(outpoint)||this.usedTxids.has(coin.txid)||pending?.has(outpoint)===true;}
 private async nativeSpend(inputs:readonly {txid:string;vout:number}[]|undefined,run:()=>Promise<string>){
  this.assertOpen();
  if(this.selfSending)throw new Error('A shield deposit coin is being prepared. Try again when it is ready.');
  this.nativeOperations++;
  try{await this.restoreLightningSpends();this.assertOpen();const pending=this.pendingOutpoints?.();if(inputs?.some(coin=>this.reserved(coin,pending)))throw new Error('A selected coin is reserved for shielding.');return await run();}finally{this.nativeOperations--;}
 }
 override async getSpendableVtxos(...args:Parameters<Wallet['getSpendableVtxos']>){
  await this.restoreLightningSpends();
  const coins=await super.getSpendableVtxos(...args);
  const pending=this.pendingOutpoints?.();
  return args[0]?.genericallySpendableOnly?coins.filter(coin=>!this.reserved(coin,pending)):coins;
 }
 override send(...args:Parameters<Wallet['send']>){
  return this.nativeSpend('recipients' in args[0]?args[0].selectedVtxos:undefined,()=>super.send(...args));
 }
 override async settle(...args:Parameters<Wallet['settle']>){this.assertBatchSwaps();return this.nativeSpend(args[0]?.inputs,()=>super.settle(...args));}
 override async sendSelectedVtxosToSelf(...args:Parameters<Wallet['sendSelectedVtxosToSelf']>){return this.nativeSpend(args[0],()=>super.sendSelectedVtxosToSelf(...args));}
 override async getContractManager(){
  this.assertOpen();
  const manager=cacheVtxoSync(await super.getContractManager());
  // Full Wallet disposal can await restore work that is itself waiting for this manager.
  if(this.stopped){manager.dispose();await ReadonlyWallet.prototype.dispose.call(this);this.assertOpen();}
  return manager;
 }

 async shield(coins?:readonly ArkCoin[]):Promise<ShieldedPaymentHandle|undefined>{
  this.assertOpen();this.assertFeeAccepted();
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
  const handle=shieldedHandle({title:shieldTitle(plan,this.depositFeeOnPlan(plan)),steps:shieldedSteps.shield,railId:'shielded-deposit'},async step=>{
   step(0);
   if(plan.kind==='asset'){
    const coin=await this.depositCoin(plan.coin.txid,plan.coin.value,{assetId:plan.assetId,amount:plan.units},plan.coin.vout);
    const legs=async(cause?:unknown)=>{const [assetSlot,btcSlot]=await this.account.depositAsset(assetFieldOfId(plan.assetId),plan.units,BigInt(coin.value),this.self,this.depositFeeTo(plan,rejected(cause,'fee-missing')));return [{built:assetSlot,extra:{coin,asset:plan.assetId},coin},{built:btcSlot}];};
    return this.submit(await legs(),step,undefined,legs);
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
   const deposit=async(cause?:unknown)=>{
    const to=this.depositFeeTo({kind:'btc',coins:[coin],amount:plan.amount},rejected(cause,'fee-missing'));
    return [{built:await this.account.spend({deposit:BigInt(plan.amount),...(to?{to}:{})},this.self),extra:{coin},coin}];
   };
   return this.submit(await deposit(),step,undefined,deposit);
  });
  void handle.settled().catch(error=>{
   if(canRelease(error)){for(const outpoint of taken)this.used.delete(outpoint);for(const txid of sentTxids)this.usedTxids.delete(txid);}
   this.retryAt=Date.now()+RETRY_MS;
  });
  return this.announce(handle);
 }
 /** `current`: tick() has just shown the account at the pool's count. Every other caller syncs first, for planFor's payout skip. */
 private async autoShield(current=false){
  if(this.stopped||this.offline||Date.now()<this.retryAt)return;
  if(!current)await this.sync();
  if(this.stopped||Date.now()<this.retryAt||this.depositFeePaused)return;
  await this.shield();
 }
 mergeableAssets(){return mergeAssetFields(this.pool.status.pool?.reserves);}
 async merge(asset?:bigint,above?:number):Promise<ShieldedPaymentHandle|undefined>{
  if(this.stopped||Date.now()<this.mergeRetryAt)return undefined;
  for(const field of asset===undefined?this.mergeableAssets():[asset]){
   const plan=await this.notes.pick(()=>this.account.consolidate(this.self,field,this.inFlight,above),chosen=>chosen?chosen.inputs.map(n=>n.nullifier):[]);
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
 maxPrivatePayment(asset=BTC_ASSET){try{return topThree(this.account.spendableNotes(asset,this.inFlight));}catch{return 0n;}}
 canWithdraw(amount:bigint,opts:{asset?:string;sats?:bigint}={}){
  try{
   const field=opts.asset?assetFieldOfId(opts.asset):BTC_ASSET;
   return coversWithdrawal(this.account.spendableNotes(field),this.account.spendableNotes(BTC_ASSET),amount,this.inFlight,!!opts.asset,opts.sats??BigInt(DUST));
  }catch{return false;}
 }
 async pay(to:string,amount:bigint,asset?:string):Promise<ShieldedPaymentHandle>{
  const held:bigint[]=[];
  const handle=shieldedHandle({title:'Sending privately',steps:shieldedSteps.send,railId:'shielded'},async step=>{
   step(0);this.assertOpen();
   const recipient=parseRollupAddress(to),field=asset?assetFieldOfId(asset):BTC_ASSET;
   const legs=(inFlight:ReadonlySet<bigint>)=>this.account.pay(recipient,amount,this.self,inFlight,field,{join:this.prover.joinReady?.()??false});
   // A rebuilt leg pays with a new rho, so its sent record is written again.
   const recorded=async({spends}:{spends:EpochBuiltSpend[]})=>{
    this.recordSent(spends.map(s=>{const note=sentNoteOf(this.hash,s);return [s.witness.slot.nullifiers[0]!,{to,note:{amount:String(note.amount),asset:String(note.asset),rho:String(note.rho)}}] as [bigint,SentRecord];}));
    await this.persist();
    return spends.map(built=>({built}));
   };
   const chosen=await this.notes.pick(()=>legs(this.inFlight),chosen=>chosen.spends.flatMap(s=>s.witness.slot.nullifiers));
   held.push(...chosen.spends.flatMap(s=>s.witness.slot.nullifiers));this.assertOpen();
   return this.submit(await recorded(chosen),step,undefined,async()=>recorded(await legs(this.others(held,[field]))));
  });
  this.hold(held,handle);
  return this.announce(handle);
 }
 async withdraw(to:string,amount:bigint,opts:{asset?:string;sats?:bigint}={}):Promise<ShieldedPaymentHandle>{return this.announce(this.withdrawal(to,amount,opts));}
 private withdrawal(to:string,amount:bigint,opts:{asset?:string;sats?:bigint;record?:SentRecord}={}):ShieldedPaymentHandle{
  const held:bigint[]=[];
  const handle=shieldedHandle({title:'Withdrawing',steps:shieldedSteps.withdraw,railId:'shielded-withdraw'},async step=>{
   step(0);this.assertOpen();
   const program=programOf(to);
   const legs=async(inFlight:ReadonlySet<bigint>)=>{
    if(opts.asset){
     const [payout,carrier]=await this.account.withdrawAsset(assetFieldOfId(opts.asset),amount,program,this.self,inFlight,opts.sats??BigInt(DUST));
     return [{built:payout,extra:{program,asset:opts.asset}},{built:carrier,extra:{program}}] as SubmitMember[];
    }
    if(amount<BigInt(DUST))throw new Error(`Withdraw at least ${DUST} sats.`);
    const input=pickNote(this.account.spendableNotes(),amount,inFlight);
    if(!input)throw new Error('No single note covers this amount.');
    return [{built:await this.account.spend({input,withdraw:amount,program},this.self),extra:{program}}] as SubmitMember[];
   };
   const members=await this.notes.pick(()=>legs(this.inFlight),chosen=>chosen.flatMap(m=>m.built.witness.slot.nullifiers));
   held.push(...members.flatMap(m=>m.built.witness.slot.nullifiers));this.assertOpen();
   this.recordSent(members.map(m=>[m.built.witness.slot.nullifiers[0]!,opts.record??{to}] as [bigint,SentRecord]));
   await this.persist();
   return this.submit(members,step,undefined,()=>legs(this.others(held,opts.asset?[assetFieldOfId(opts.asset),BTC_ASSET]:[BTC_ASSET])));
  });
  this.hold(held,handle);
  return handle;
 }
 /** Whether a pool-funded exit can pay a fresh single-use key; without the companion there is no private payout, and no fallback. */
 canExitPrivately():boolean{return typeof this.swaps?.exitPayout==='function';}
 /** Withdraws `amount` to a fresh never-reused key, saved and watched before the withdrawal, so an interrupted exit still finds the payout. */
 exitFromPool(amount:number,title:string,exit:(coin:NormalizedExtendedVirtualCoin,payout:IWallet)=>Promise<PaymentHandle>,dest:{to:string;sats:number}):ShieldedPaymentHandle{
  // Its batch swap runs on the companion's settle, so the guard on this wallet's would come after the pool paid the fresh key.
  this.assertBatchSwaps();
  return this.announce(shieldedHandle({title,steps:shieldedSteps.exit,railId:'shielded-exit'},async step=>{
   this.assertOpen();
   const reserve=this.swaps?.exitPayout;
   if(!reserve)throw new Error('A private on-chain exit needs the recoverable companion wallet, which is not open. Reload and try again.');
   // Holds auto-shield and renewal off, which would otherwise spend the coin this exit is counting on.
   this.nativeOperations++;
   let payout:ExitPayout|undefined,spent=false;
   try{
    step(0);
    payout=await reserve(this.ownPoolAddress);
    const key=ArkAddress.decode(payout.address),pool=ArkAddress.decode(this.ownPoolAddress);
    if(key.hrp!==pool.hrp||hex.encode(key.serverPubKey)!==hex.encode(pool.serverPubKey))throw new Error('The exit payout key belongs to another Arkade server.');
    const record:SentRecord={to:dest.to,onchainSats:dest.sats};
    await this.withdrawal(payout.address,BigInt(amount),{record}).settled();
    step(1);
    let coin:NormalizedExtendedVirtualCoin|undefined;
    for(let i=0;!(coin=await payout.coin(amount));i++){
     if(i>=60)throw new Error(`The pool paid ${sats(amount)} sats to a fresh single-use key that has not arrived yet. It stays saved, and shields back into the pool on its own.`);
     this.assertOpen();await new Promise(r=>setTimeout(r,1000));
    }
    step(2);
    try{
     const paid=await exit(coin,payout.wallet);step(3);const result=await paid.settled();spent=true;
     if(result.txid){record.onchainTxid=result.txid;void this.persist().catch(()=>{});}
     return result.txid?{txid:result.txid}:{};
    }
    catch(error){throw new Error(`The exit failed after the pool paid ${sats(amount)} sats to a fresh single-use key: ${reasonOf(error)}. Those sats stay saved under that key and shield back into the pool on their own.`,{cause:error});}
   }finally{this.nativeOperations--;await payout?.release({spent}).catch(()=>{});}
  }));
 }
 /** The pool refuses coins near expiry; a batch swap renews them, after which auto-shield picks them up. */
 async renew():Promise<string|undefined>{
  if(this.nativeOperations||this.selfSending)return undefined;
  const pending=this.pendingOutpoints?.(),coins=(await this.coins()).filter(coin=>!pending?.has(`${coin.txid}:${coin.vout}`));
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
  this.stopped=true;this.onSyncProgress=undefined;
  if(this.timer)clearTimeout(this.timer);
  this.timer=undefined;
  if(this.statusTimer)clearTimeout(this.statusTimer);
  this.statusTimer=undefined;
  const swaps=this.swaps;this.swaps=undefined;
  await swaps?.[Symbol.asyncDispose]().catch(()=>{});
  for(const off of this.unwatch)try{off();}catch{/* a torn-down manager is already stopped */}
  this.unwatch=[];this.changeListeners.clear();this.actionListeners.clear();this.latestAction=undefined;
  await super.dispose();
 }
}
