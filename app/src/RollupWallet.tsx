import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {InMemoryContractRepository,InMemoryWalletRepository,RestArkProvider,RestIndexerProvider,SingleKey,arkTarget,isValidArkAddress,type Activity,type PaymentHandle,type PaymentRequest,type Wallet} from '@arkade-os/sdk';
import type {Outcome} from '@arkade-os/swap';
import {acceptsDepositFee,type DepositFeeSchedule} from '../../packages/protocol/src/rollup/deposit-fee.ts';
import {assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {deriveWalletKeyMaterial,recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {IndexedDBShieldedNoteRepository} from '../../src/shielded/repository.ts';
import type {StepState} from '../../src/shielded/handle.ts';
import {LNURL_BASE} from '../../src/shielded/lightning.ts';
import {IndexedDbLightningRepository} from '../../src/shielded/lightning-repository.ts';
import {createLightningWallet,createPrivateLightning,lightningOwner} from '../../src/shielded/lightning-wallet.ts';
import {METHODS_NOT_WITHDRAWN,METHODS_REFUSED,createLnurlReceive,type LnurlReceiver,type PrivateReceiveState} from '../../src/shielded/lnurl-receive.ts';
import {RECOVERY_LINE} from '../../src/shielded/epoch-recovery.ts';
import {epochIdle} from '../../src/shielded/epoch-sync.ts';
import {SHIELD_FLOOR_MS,ShieldedWallet,shieldedKeysOf} from '../../src/shielded/wallet.ts';
import {DUST,bornAtFor,depositFeeFor,poolApiOf,rollupApi,type ArkCoin,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import {epochBirthCheckpoint} from '../../src/shielded/epoch-checkpoint.ts';
import {ACCEPT_FEE,PAUSED_LINE,PAUSED_TITLE,arkAssetHoldings,claimTokenError,claimUrl,depositFeeAmountLine,depositFeeBanner,depositFeeLine,depositFeeOutsideLine,holdingsText,invoiceBounds,invoiceCarriesAmount,invoiceFeeClause,invoiceInRange,invoiceLimitsLine,invoiceQr,isInvoice,lightningMinimumLine,lightningShieldFeeOf,listedAssetLine,listingBlocked,noSwapErrorText,payTarget,privateReceiveView,routeCopy,satsText,shieldFeeOfTx,shortValue,type InvoiceBounds} from './rollup-client.ts';
import {browserProver,prefetchProvingKeys} from './shielded-prover.ts';
import {BORN,CREATED,SECRET,activityReceived,createPageWallet,disposeAfterPageReads,historyDirection,errorText,importLegacySent,openPageWallet,pageActions,pageActivityHistory,pageCache,pageClose,pageRefresh,pageQuoteFunds,pageQuoteRoute,pageQuotes,pageSheet,renewPageCoins,restorePageWallet,retryPageRead,startPageLightning,type PageLightning} from './shielded-page.ts';
import WalletOnboarding from './WalletOnboarding.tsx';
import WalletEntrance from './WalletEntrance.tsx';
import WalletSyncStatus from './WalletSyncStatus.tsx';
import {AppUpdateNotice} from './AppUpdates.tsx';
import {CopyButton,Icon} from './components.tsx';
import {QrCode,Scanner} from './wallet-qr.tsx';
import {ReceivePortal,amountQrValue,receiveAmount,invoiceRequestAmount,type ReceiveMode} from './wallet-receive.tsx';
import {LightningRecoveryQuote} from './lightning-recovery.tsx';
import {Soundbar,soundbarItem,useMedia} from './wallet-soundbar.tsx';
import {GlassRefraction} from './wallet-glass-surface.tsx';
import {bindSheetGesture,bindSwipeGesture} from './wallet-gestures.ts';
import {isNativeHost,nativeClaimFetch,nativeLnurlFetch,nativeSessionFetch,nativeSwapConfig,nativeWalletProviders} from '../../src/native/index.ts';
import {pendingPoolNullifiers,pendingPoolOutpoints,reconcileNativeMutations} from '../../src/native/mutations.ts';

const NATIVE=isNativeHost();
const POOL_ORIGIN=NATIVE?(globalThis as typeof globalThis&{__SHIELDED_NATIVE__:{poolOrigin:string}}).__SHIELDED_NATIVE__.poolOrigin:'';

const BACKED_UP='shielded-rollup-wallet-backed-up-v1';
const EXPLORER='https://explorer.mutinynet.arkade.sh';
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unknown';
const canShare=typeof navigator!=='undefined'&&typeof navigator.share==='function';
/** A value to copy; with `qr` it can also show that payload as a QR code and hand the value to the system share sheet. */
function Copyable({value,qr,label}:{value:string;qr?:string;label?:string}){
 const [shown,setShown]=useState(false),[whole,setWhole]=useState(false),compact=shortValue(value);
 return <><div className="stock-copy">{compact===value?<code>{value}</code>:<button type="button" className="stock-code" aria-expanded={whole} title={whole?'Show less':'Show all of it'} onClick={()=>setWhole(w=>!w)}><code>{whole?value:compact}</code></button>}<CopyButton value={value}/>
  {qr!==undefined&&<button type="button" className="icon-button" aria-label={shown?'Hide the QR code':'Show a QR code'} aria-expanded={shown} onClick={()=>setShown(s=>!s)}><Icon name="qr" size={16}/></button>}
  {qr!==undefined&&canShare&&<button type="button" className="icon-button" aria-label="Share" onClick={()=>void navigator.share(/^https?:/.test(value)?{url:value}:{text:value}).catch(()=>{})}><Icon name="share" size={16}/></button>}</div>
  {shown&&qr!==undefined&&<QrCode value={qr} label={label??'QR code'}/>}</>;
}
const TxLink=({txid,path='tx'}:{txid:string;path?:string})=><a className="stock-txlink" href={`${EXPLORER}/${path}/${txid}`} target="_blank" rel="noreferrer">{short(txid)} ↗</a>;
// The resolver's kinds, mapped onto the swatches the history list already has.
const SWATCH:Record<string,string>={shield:'shield',unshield:'withdraw','onchain-exit':'withdraw','shielded-send':'send','shielded-receive':'receive','lightning-receive':'receive',merge:'merge',list:'arkade','claim-link':'send'};
const LIGHTNING_STATUS:Record<string,string>={received:'Received; waiting to shield',shielding:'Received; shielding',shielded:'Shielded in the pool',retrying:'Received; shielding will retry','below-minimum':'Received outside the pool; below the shielding minimum','onchain-recovery':'Onchain recovery; shielding paused','onchain-recovered':'Recovered onchain'};
const WHERE:Record<string,string>={
 shield:'From your Arkade coins into the pool; the amount is public.',
 unshield:'Out of the pool to an Arkade address; the amount is public.',
 'onchain-exit':'Out of the pool through a fresh single-use key, then a batch swap to the Bitcoin chain; the amount and the destination are public.',
 'shielded-send':'Inside the pool; amount and parties stay private.',
 'shielded-receive':'Inside the pool; amount and sender stay private.',
 'lightning-receive':'The payout is public until it enters the pool.',
 'claim-link':'Inside the pool: into a claim link. Whoever claims it gets the amount, privately.',
 merge:'Inside the pool: your own notes, merged into one. Nothing left the wallet.',
 list:'To the pool, listing this asset so anyone can shield it.',
};
const whereOf=(kind:string|undefined,received:boolean)=>(kind?WHERE[kind]:undefined)??(received?'Into your Arkade address, outside the pool.':'From your Arkade address, outside the pool.');
type Invoice={id:string;bolt11:string;outcome:Outcome;pays:bigint;fee:bigint;failure?:string};
type LnurlService=ReturnType<typeof createLnurlReceive>;
const INVOICE:Partial<Record<Outcome,string>>={funding:'Paid. Claiming the sats.',funded:'Paid. Claiming the sats.',claimed:'Received. The sats move into the pool shortly.',lapsed:'It expired unpaid.'};
const invoiceLine=(i:Invoice,fee:DepositFeeSchedule|undefined)=>i.outcome==='accepted'||i.outcome==='open'?`Waiting for a payment of ${sats(i.pays)} sats, of which the swap keeps ${sats(i.fee)}${invoiceFeeClause(fee,i.pays,i.fee)}.`
 :INVOICE[i.outcome]??`The swap ${i.outcome==='needs_recovery'?'needs recovery':'failed'}${i.failure?`: ${i.failure}`:'.'}`;
const LINK_STATE={unclaimed:'Unclaimed',claimed:'Claimed','taken-back':'Taken back'} as const;
type ClaimView={notes:{asset:bigint;amount:bigint}[];mine:boolean}|{error:string};
const NOT_PRIVATE:PrivateReceiveState={on:false,pending:false,refused:false,withdrawing:false,listed:null};
const methodsFailure=(error:unknown)=>[METHODS_REFUSED,METHODS_NOT_WITHDRAWN].includes(errorText(error));
// Stable, so React focuses it once on mount; an inline ref would take focus back on every render.
const focusOnMount=(el:HTMLElement|null)=>{el?.focus();};
export default function RollupWallet({storage=globalThis.localStorage,reload=()=>location.reload(),onShutdown,onReady,onStartupFailure,animateEntrance=true,suspended=false,viewActive=true,hidden=false}:{storage?:Storage;reload?:()=>void;onShutdown?:(shutdown:(()=>Promise<void>)|undefined)=>void;onReady?:()=>void;onStartupFailure?:(message:string)=>void;animateEntrance?:boolean;suspended?:boolean;viewActive?:boolean;hidden?:boolean}={}){
 const [sessionFetch]=useState(()=>NATIVE?nativeSessionFetch():undefined);
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [nativePending,setNativePending]=useState(false);
 const [startupError,setStartupError]=useState(''),[startupFailure,setStartupFailure]=useState(''),[refreshError,setRefreshError]=useState(''),[feeNotice,setFeeNotice]=useState(''),[feeConfirmed,setFeeConfirmed]=useState(false);
 const [initialPool,setInitialPool]=useState<RollupPoolStatus>();
 const [secret,setSecret]=useState(()=>storage.getItem(SECRET)??''),[early,setEarly]=useState<{secret:string;address:string;ark?:string}>(),[backedUp,setBackedUp]=useState(()=>storage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [wallet,setWallet]=useState<ShieldedWallet>(),[tick,setTick]=useState(0);
 const [coins,setCoins]=useState<ArkCoin[]>([]),[arkAvailable,setArkAvailable]=useState<number>(),[arkAddress,setArkAddress]=useState(''),[rows,setRows]=useState<Activity[]>([]);
 const [sheet,setSheet]=useState<StepState>(),[busy,setBusy]=useState(false),[revealed,setRevealed]=useState<Record<string,string>>({});
 const [tab,setTab]=useState<'home'|'receive'|'send'|'activity'>('home'),[receiveMode,setReceiveMode]=useState<ReceiveMode>('unified'),[requestOpen,setRequestOpen]=useState(false),[assetId,setAssetId]=useState(''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[withSats,setWithSats]=useState('');
 const [sheetOpen,setSheetOpen]=useState(false),narrow=useMedia('(max-width:760px)'),[scanning,setScanning]=useState(false),[codeError,setCodeError]=useState('');
 const panelNode=useRef<HTMLElement>(null),panelGrip=useRef<HTMLDivElement>(null),dockNode=useRef<HTMLElement>(null),mainTabsNode=useRef<HTMLElement>(null),panelTabsNode=useRef<HTMLDivElement>(null),recipientNode=useRef<HTMLInputElement>(null);
 const dockLens=useRef<HTMLSpanElement>(null),mainLens=useRef<HTMLSpanElement>(null),panelLens=useRef<HTMLSpanElement>(null);
 const [listed,setListed]=useState(''),[restoreError,setRestoreError]=useState(''),[showView,setShowView]=useState(false),[showFull,setShowFull]=useState(false),[securityView,setSecurityView]=useState<'phrase'|'viewing'|'restore'|null>(null),[restoreDate,setRestoreDate]=useState(''),[restoreStarted,setRestoreStarted]=useState(false);
 const [listingError,setListingError]=useState<{id:string;message:string}>();
 const [invoice,setInvoice]=useState<Invoice>(),[lnAmount,setLnAmount]=useState(''),[unifiedAddress,setUnifiedAddress]=useState(''),[lnAddress,setLnAddress]=useState(''),[lnBusy,setLnBusy]=useState(false),[lnError,setLnError]=useState(''),[lnBounds,setLnBounds]=useState<InvoiceBounds>();
 const [lnBoundsError,setLnBoundsError]=useState('');
 const [privateState,setPrivateState]=useState(NOT_PRIVATE);
 const [claim,setClaim]=useState(()=>location.pathname.replace(/\/+$/,'')==='/claim'?location.hash.slice(1):''),[claimView,setClaimView]=useState<ClaimView>(),[claimRead,setClaimRead]=useState(0),[minted,setMinted]=useState('');
 const lnurlRef=useRef<ReturnType<typeof createLnurlReceive>|undefined>(undefined),lnLimits=useRef<unknown>(undefined),lnLimitsRead=useRef(0),startingRef=useRef<Promise<unknown>|undefined>(undefined),securityRef=useRef<HTMLDetailsElement>(null);
 const [,setQuoteRevision]=useState(0);
 const quoteRef=useRef<ReturnType<typeof pageQuotes>|undefined>(undefined);
 const fundsRef=useRef<{wallet:ShieldedWallet;watch:ReturnType<typeof pageQuoteFunds>}|undefined>(undefined);
 if(!quoteRef.current)quoteRef.current=pageQuotes(()=>setQuoteRevision(v=>v+1));
 const quotes=quoteRef.current;
 const poolRef=useRef<RollupPoolStatus|undefined>(undefined);
 const busyRef=useRef(false),restoreRequested=useRef(false),restoring=useRef(false),mounted=useRef(false),createdHere=useRef(false);
 const cacheRef=useRef<ReturnType<typeof pageCache>|undefined>(undefined),sheetRef=useRef<ReturnType<typeof pageSheet>|undefined>(undefined);
 const sessions=useRef(new Set<()=>Promise<void>>());
 const refreshRef=useRef<{request:()=>void}|undefined>(undefined);
 const refreshFailed=useRef(false),handleBusy=useRef(false),unifiedRetry=useRef<Promise<void>|undefined>(undefined);
 const actions=useRef<ReturnType<typeof pageActions>|undefined>(undefined);
 actions.current??=pageActions(()=>{if(mounted.current)setTick(t=>t+1);});
 const refreshes=useRef(new WeakMap<object,{close:()=>Promise<void>}>());
 if(!cacheRef.current)cacheRef.current=pageCache(new IndexedDBShieldedNoteRepository());
 if(!sheetRef.current)sheetRef.current=pageSheet(setSheet);
 const sheetOwner=sheetRef.current;

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sheetOwner.stop();quotes.clear();};},[]);
 useEffect(()=>{if(suspended)setScanning(false);},[suspended]);
 useEffect(()=>{
  onShutdown?.(async()=>{restoring.current=true;mounted.current=false;await Promise.all([...sessions.current].map(close=>close()));await cacheRef.current!.drain();});
  return()=>onShutdown?.(undefined);
 },[onShutdown]);
 useEffect(()=>{
  if(restoring.current||(!onReady&&!onStartupFailure))return;
  const failure=startupFailure||poolError||(pool&&pool.phase!=='ready'?(pool.message||'The pool is not ready. Reconnect to try again.'):'');
  if(failure)onStartupFailure?.(failure);
  else if(pool?.phase==='ready'&&wallet)onReady?.();
 },[pool,wallet,startupFailure,poolError,onReady,onStartupFailure]);

 const createWallet=()=>{
  if(busyRef.current||secret)return;
  busyRef.current=true;setBusy(true);setRestoreError('');
  try{const fresh=createPageWallet(storage);createdHere.current=true;setSecret(fresh);}
  catch(error){setRestoreError(errorText(error));}
  finally{busyRef.current=false;setBusy(false);}
 };
 // The wallet needs the pool phase, network and token before creation.
 useEffect(()=>{
  const controller=new AbortController();
  void retryPageRead(()=>rollupApi<RollupPoolStatus>('/status',undefined,sessionFetch??fetch,1000,POOL_ORIGIN),controller.signal,{onError:error=>{if(!restoring.current)setStartupError(errorText(error));},onTerminal:error=>{if(!restoring.current)setStartupFailure(errorText(error));}})
   .then(status=>{if(status&&!controller.signal.aborted&&!restoring.current){poolRef.current=status;setPool(status);if(status.phase==='ready')setInitialPool(status);setStartupError('');}}).catch(()=>{});
  return()=>controller.abort();
 },[]);

 /** Any handle, shielded or plain, rendered through one sheet. */
 const run=async(start:()=>Promise<PaymentHandle|undefined>,title:string)=>{
  if(busyRef.current||restoring.current||!wallet)return false;
  busyRef.current=true;setBusy(true);
  let owner=sheetOwner.begin(title);
  try{
   let handle:PaymentHandle|undefined;
    handleBusy.current=true;
    try{handle=await start();}finally{if(!handle)handleBusy.current=false;}
   if(!handle)return false;
   if(!mounted.current||restoring.current){handleBusy.current=false;return false;}
   owner=sheetOwner.watch(handle,title);
   await handle.settled({timeoutMs:30*60_000}).finally(()=>{handleBusy.current=false;});
   if(mounted.current&&!restoring.current)setAmount('');
   return true;
  }catch(error){owner.fail(error);return false;}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);setTick(t=>t+1);}}
 };

 const listAsset=async(id:string)=>{
  if(busyRef.current||restoring.current||!wallet)return;
  busyRef.current=true;setBusy(true);setListingError(undefined);
  try{await wallet.listAsset(id);if(mounted.current&&!restoring.current)setListed(id);}
  catch(error){if(mounted.current&&!restoring.current)setListingError({id,message:errorText(error)});}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);setTick(t=>t+1);}}
 };

 const renew=async()=>{
  if(busyRef.current||restoring.current||!wallet)return;
  busyRef.current=true;setBusy(true);quotes.clear();
  try{const txid=await renewPageCoins(()=>wallet.renew(),sheetOwner);if(!txid&&mounted.current&&!restoring.current)setPoolError('Nothing needed renewing.');}
  catch{}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);fundsRef.current?.watch.update();setTick(t=>t+1);}}
 };

 const acceptFee=(target:ShieldedWallet,shown:DepositFeeSchedule)=>{
  setFeeNotice('');setFeeConfirmed(false);
  const settle=(held:boolean,notice='')=>{if(mounted.current&&!restoring.current){setFeeConfirmed(held);setFeeNotice(notice);}};
  void target.acceptDepositFee(shown).then(()=>settle(true),error=>{const held=acceptsDepositFee(shown,target.acceptedDepositFee);settle(held,held?'Accepted for this session, but this browser could not save it.':errorText(error));});
 };

 const lnFail=(error:unknown)=>{
  // A method failure shows from the service's saved state; the tick makes the effect below read it.
  if(methodsFailure(error))setTick(t=>t+1);else setLnError(noSwapErrorText(error)??errorText(error));
 };
 const receiveCurrent=(service:LnurlService|undefined)=>mounted.current&&!restoreRequested.current&&!restoring.current&&lnurlRef.current===service;
 const lightning=async(action:(service:LnurlService|undefined)=>Promise<void>)=>{
  if(!wallet?.swaps||restoreRequested.current||restoring.current)return;
  const service=lnurlRef.current;
  setLnBusy(true);setLnError('');
  try{await action(service);}catch(error){if(receiveCurrent(service))lnFail(error);}
  finally{if(mounted.current&&lnurlRef.current===service)setLnBusy(false);}
 };
 const createInvoice=()=>{
  const amount=invoiceRequestAmount(lnAmount,lnBounds);
  if(amount===undefined||lnBusy||suspended||receiveBlocked)return;
  return lightning(async service=>{
   const r=await wallet!.swaps!.receive({via:'lightning',amount});
   if(mounted.current&&!restoring.current&&lnurlRef.current===service){setInvoice({id:r.id,bolt11:r.artifact.bolt11,outcome:r.outcome,pays:r.give.amount,fee:r.fee.amount});setRequestOpen(true);}
  });
 };
 const showReceiver=(service:LnurlService,receiver:LnurlReceiver)=>{if(receiveCurrent(service)){setUnifiedAddress(receiver.lnurl);setLnAddress(receiver.lightningAddress??'');}};
 // claim and recover reject with a method error only after their bind has landed, so the address exists and is shown.
 const bound=async(service:LnurlService|undefined,action:(service:LnurlService)=>Promise<void>)=>{
  if(!service)throw new Error('The wallet is still loading.');
  try{await action(service);}
  catch(error){
   if(methodsFailure(error)&&receiveCurrent(service)){const owned=await service.current();if(owned)showReceiver(service,owned);}
   throw error;
  }
 };
 const claimAddress=()=>lightning(service=>bound(service,async service=>{
  showReceiver(service,await service.claimName());
 }));
 const retryUnified=()=>lightning(service=>bound(service,async service=>{
  showReceiver(service,await service.ensureUnified());
 }));
 const recoverAddress=()=>lightning(service=>bound(service,async service=>{
  const receivers=await service.recover(),receiver=receivers[0];
  if(receiver)showReceiver(service,receiver);else if(receiveCurrent(service))setLnError('No Lightning address was found for this recovery phrase.');
 }));
 const setPrivate=(on:boolean)=>lightning(async service=>{
  if(!service)throw new Error('The wallet is still loading.');
  await service.setPrivateReceive(on);
 });

 const restoreWallet=async()=>{
  if(busyRef.current||restoreRequested.current||restoring.current)return;
  restoreRequested.current=true;setRestoreStarted(true);
  try{
   const at=restoreDate?Date.parse(restoreDate):NaN,token=poolRef.current?.pool?.token;
   const born=Number.isFinite(at)&&token?{token,at,batches:await epochBirthCheckpoint(poolApiOf(POOL_ORIGIN),at)}:undefined;
   await restorePageWallet(restore,{cache:cacheRef.current!,storage:storage,reload,...(born?{born}:{}),stop:async()=>{
    restoring.current=true;busyRef.current=true;quotes.clear();setBusy(true);setRestoreError('');sheetOwner.stop();
    await Promise.all([...sessions.current].map(close=>close()));setWallet(undefined);setEarly(undefined);
   }});
  }catch(error){if(mounted.current)setRestoreError(errorText(error));}
  finally{
   if(!restoring.current){
    restoreRequested.current=false;
    const service=lnurlRef.current;
    if(service)void service.current().then(owned=>{if(owned)showReceiver(service,owned);}).catch(error=>{if(receiveCurrent(service))lnFail(error);});
   }
   if(mounted.current){busyRef.current=false;setBusy(false);setRestoreStarted(false);}
  }
 };

 useEffect(()=>{
  if(!initialPool||!secret||restoring.current)return;
  setUnifiedAddress('');setLnAddress('');setPrivateState(NOT_PRIVATE);setLnError('');setInvoice(undefined);setRequestOpen(false);setListingError(undefined);
  const status=initialPool,network=status.network;
  let journal:IndexedDbLightningRepository;
  let nativeOpened=false;
  let companion:Wallet|undefined,lnurl:ReturnType<typeof createLnurlReceive>|undefined;
  let starting:Promise<PageLightning<Wallet,Awaited<ReturnType<typeof createPrivateLightning>>,ReturnType<typeof createLnurlReceive>>|undefined>|undefined;
  const dispose=(created:ShieldedWallet)=>disposeAfterPageReads(created,refreshes.current,async()=>{
   try{await lnurl?.dispose();}finally{
    if(lnurlRef.current===lnurl)lnurlRef.current=undefined;
    try{await created.dispose();}finally{try{await companion?.dispose();}finally{await journal[Symbol.asyncDispose]();}}
   }
  });
  const session=openPageWallet(async()=>{
   const {buildPoseidon}=await import('circomlibjs'),poseidon=await buildPoseidon(),hash:Hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
   if(mounted.current&&!restoring.current)setEarly({secret,address:shieldedKeysOf(hash,secret).address});
   return hash;
  },async hash=>{
   journal=new IndexedDbLightningRepository();companion=undefined;lnurl=undefined;
   let created:ShieldedWallet|undefined;
   const privateFetch=NATIVE?nativeSessionFetch():undefined,lnurlFetch=NATIVE?nativeSessionFetch(nativeLnurlFetch):undefined,claimFetch=NATIVE?nativeSessionFetch(nativeClaimFetch):undefined;
   const providers=NATIVE?nativeWalletProviders(network.arkUrl,network.indexerUrl??network.arkUrl):{arkProvider:new RestArkProvider(network.arkUrl),indexerProvider:new RestIndexerProvider(network.indexerUrl??network.arkUrl)};
   const pairing=createLightningWallet(secret,{...providers,...(NATIVE?{lazyInitialization:true}:{})});pairing.catch(()=>{});
   try{
    if(privateFetch)await reconcileNativeMutations(privateFetch,POOL_ORIGIN);
    const bornAt=bornAtFor(storage,BORN,{token:status.pool!.token,batches:status.pool!.batches});
    created=await ShieldedWallet.create({
     identity:SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret),
     ...providers,
     storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
     settlementConfig:false,walletMode:'static',
     pool:{origin:POOL_ORIGIN,status},secret,hash,prover:browserProver(()=>poolRef.current??status,privateFetch),
     ...(NATIVE?{networkPrivacy:true,fetcher:privateFetch,lnurlFetch,claimFetch,pendingNullifiers:()=>new Set(pendingPoolNullifiers(POOL_ORIGIN)),pendingOutpoints:()=>new Set(pendingPoolOutpoints(POOL_ORIGIN))}:{}),
     shieldedRepository:cacheRef.current!.repository,bornAt,lightningSpendStore:journal,
     onArkAddress:ark=>{if(mounted.current&&!restoring.current)setEarly(e=>e?.secret===secret?{...e,ark}:e);},
    });
    nativeOpened=true;
    void created.started.catch(error=>{if(session.active()&&!restoring.current&&mounted.current)setPoolError(errorText(error));});
    const reportLightning=(error:unknown)=>{if(session.active()&&!restoring.current&&mounted.current)setLnError(errorText(error));};
    starting=startPageLightning({
     pairing,
     swaps:paired=>createPrivateLightning({wallet:created!,companion:paired,journal,onError:reportLightning,...(NATIVE?nativeSwapConfig():{})}),
     lnurl:async(paired,swaps)=>createLnurlReceive({identity:created!.identity,companion:paired,journal,owner:await lightningOwner(paired),pool:status.pool!.token,baseUrl:LNURL_BASE,...(lnurlFetch?{fetch:lnurlFetch}:{}),onPayouts:payouts=>swaps.registerPayouts(payouts),shieldedAddress:()=>created!.shieldedAddress()}),
     active:()=>session.active(),handOver:parts=>{companion=parts.companion;lnurl=parts.lnurl;created!.swaps=parts.swaps;},report:reportLightning,
    });
    startingRef.current=starting;void starting.then(()=>{if(startingRef.current===starting)startingRef.current=undefined;});
    return created;
   }catch(error){
    void pairing.then(c=>c.dispose()).catch(()=>{});
    try{if(created)await dispose(created);else await journal[Symbol.asyncDispose]();}
    catch(cleanup){throw new Error('The previous wallet could not be closed. Reload before trying again.',{cause:cleanup});}
    throw error;
   }
  },dispose,{shouldRetry:()=>!nativeOpened,onError:error=>{if(session.active()&&!restoring.current&&mounted.current)setStartupError(errorText(error));},onTerminal:error=>{if(session.active()&&!restoring.current&&mounted.current)setStartupFailure(errorText(error));}});
  let legacy=Promise.resolve();
  const unwatch:(()=>void)[]=[],current=()=>session.active()&&!restoring.current&&mounted.current;
  const finishClose=pageClose(async(closed:ReturnType<typeof session.close>)=>{const owned=await closed;await legacy;if(owned)await epochIdle(owned.account,()=>undefined);sessions.current.delete(close);});
  const close=()=>{
   const closed=session.close();for(const off of unwatch.splice(0))off();sheetOwner.stop();
   return finishClose(closed);
  };
  sessions.current.add(close);
  void session.ready.then(async created=>{
   if(!created||!current())return;
   setStartupError('');setStartupFailure('');
   // A wallet made here was only ever shown with this status's fee, so it accepts that one, never a newer one. A failed save shows as the saved-notes error.
   const shown=createdHere.current&&created.depositFeePaused?depositFeeFor(status):undefined;if(shown)void created.acceptDepositFee(shown).catch(()=>{});
   const funds=pageQuoteFunds(()=>({token:created.pool.status.pool?.token,notes:created.mergeableAssets().flatMap(asset=>created.shieldedNotes(asset)),inFlight:created.inFlight}),()=>{quotes.clear();setQuoteRevision(v=>v+1);});
   fundsRef.current={wallet:created,watch:funds};
   unwatch.push(created.onShieldedChange(()=>{if(current()){funds.update();setTick(t=>t+1);}}));
   unwatch.push(created.onAction(handle=>{if(current()){actions.current!.track(handle);funds.update();quotes.clear();sheetOwner.watch(handle,handle.title);}}));
   legacy=importLegacySent(created,storage,current).catch(error=>{if(current())setPoolError(errorText(error));});
   if(created.repositoryError)setPoolError(`Your saved notes: ${created.repositoryError}`);
   setWallet(created);
   const parts=await starting;
   if(!parts||!current())return;
   unwatch.push(parts.swaps.onUpdate(({swap,outcome})=>{if(current()&&lnurlRef.current===parts.lnurl)setInvoice(i=>i?.id===swap.id?{...i,outcome,...(swap.failure?{failure:swap.failure}:{})}:i);}));
   lnurlRef.current=parts.lnurl;
   void parts.lnurl.ensureUnified().then(owned=>{if(current())showReceiver(parts.lnurl,owned);}).catch(async error=>{
    if(methodsFailure(error)&&receiveCurrent(parts.lnurl)){const owned=await parts.lnurl.current().catch(()=>undefined);if(owned&&current())showReceiver(parts.lnurl,owned);}
    if(current()&&receiveCurrent(parts.lnurl))lnFail(error);
   });
   parts.lnurl.start(error=>{if(current()&&receiveCurrent(parts.lnurl))lnFail(error);});
   setTick(t=>t+1);
  }).catch(error=>{if(current()){setStartupError(errorText(error));setStartupFailure(errorText(error));}});
  return()=>{void close().catch(()=>{});};
 },[initialPool,secret]);

 // No page timer: the wallet's watcher stream and its 60 s watchdog are what move `tick`.
 useEffect(()=>{
  if(!wallet)return;
  const refresh=pageRefresh({coins:()=>wallet.coins(),balance:()=>wallet.getBalance(),address:()=>wallet.getAddress(),history:()=>wallet.getActivityHistory(),lightningHistory:async()=>wallet.swaps?.getActivityHistory()??[]},(data,errors)=>{
   if(restoring.current||!mounted.current)return;
   if(fundsRef.current?.wallet===wallet)fundsRef.current.watch.update(data.coins);
   if(data.coins)setCoins(data.coins);if(data.balance)setArkAvailable(data.balance.available);if(data.address!==undefined)setArkAddress(data.address);
   if(data.history||data.lightningHistory)setRows(pageActivityHistory(data.history??[],data.lightningHistory??[]));
   if(NATIVE)refreshFailed.current=!!errors.coins&&!!errors.balance&&!!errors.history;
   else refreshFailed.current=false;
    setRefreshError([...new Set(Object.values(errors))].join(' '));setPool(wallet.pool.status);poolRef.current=wallet.pool.status;
   setPoolError(e=>wallet.repositoryError?`Your saved notes: ${wallet.repositoryError}`:e.startsWith('Your saved notes: ')?'':e);
  },{retry:NATIVE});
  const close=async()=>{await refresh.close();sessions.current.delete(close);};
  refreshes.current.set(wallet,refresh);refreshRef.current=refresh;sessions.current.add(close);
  return()=>{if(refreshRef.current===refresh)refreshRef.current=undefined;void close();};
 },[wallet]);
 useEffect(()=>{refreshRef.current?.request();},[wallet,tick]);
 useEffect(()=>{
  if(!NATIVE||!wallet)return;
  try{setNativePending(pendingPoolNullifiers(POOL_ORIGIN).length>0||pendingPoolOutpoints(POOL_ORIGIN).length>0);}
  catch(error){setPoolError(errorText(error));}
 },[wallet,tick]);
 // Local reads of the receive state: after every Lightning action, on a new receiver, and on each tick.
 useEffect(()=>{
  const service=lnurlRef.current;if(!wallet||!unifiedAddress||lnBusy||!service||!receiveCurrent(service))return;
  let stop=false;
  void service.privateReceiveState().then(next=>{if(!stop&&receiveCurrent(service))setPrivateState(next);},error=>{if(!stop&&receiveCurrent(service))setLnError(errorText(error));});
  return()=>{stop=true;};
 },[wallet,tick,unifiedAddress,lnBusy,restoreStarted]);
 useEffect(()=>{lnLimits.current=wallet?.swaps;lnLimitsRead.current++;setLnBounds(undefined);setLnBoundsError('');},[wallet,wallet?.swaps]);
 // markets() must load the snapshot before resolve() reads it.
 const readLnBounds=()=>{
  const swaps=wallet?.swaps;if(!swaps)return;
  const revision=++lnLimitsRead.current,current=()=>mounted.current&&lnLimits.current===swaps&&lnLimitsRead.current===revision;
  setLnBounds(undefined);setLnBoundsError('');
  void (async()=>{
   const markets=await swaps.markets(),route=await swaps.resolve({via:'lightning'}),bounds=invoiceBounds(markets,route);
   if(!bounds)throw new Error('No Lightning invoice limits are available.');
   if(current())setLnBounds(bounds);
  })().catch(error=>{if(current())setLnBoundsError(noSwapErrorText(error)??errorText(error));});
 };
 useEffect(()=>{if(requestOpen&&!suspended)readLnBounds();},[requestOpen,wallet,wallet?.swaps,suspended]);

 useEffect(()=>{if(tab==='send'&&pool)prefetchProvingKeys(pool,'spend','',sessionFetch);},[tab,pool,sessionFetch]);
 const docked=narrow&&pool?.phase==='ready';
 useEffect(()=>{if(!docked)setSheetOpen(false);},[docked]);
 useEffect(()=>{const panel=panelNode.current;if(!viewActive||suspended||!sheetOpen||!docked||!panel)return;
  // Everything behind the open sheet goes inert, for Tab and for a screen reader's cursor; the backdrop still closes it and the bar keeps reporting.
  const behind:Element[]=[];let el:Element=panel;
   const skip=tab==='activity'?'.stock-backdrop,.stock-soundbar,.stock-scan,.stock-dock,[inert]':'.stock-backdrop,.stock-soundbar,.stock-scan,[inert]';
   while(el.parentElement&&!el.classList.contains('stock-page')){const up=el.parentElement;for(const other of Array.from(up.children))if(other!==el&&!other.matches(skip))behind.push(other);el=up;}
  for(const other of behind)other.setAttribute('inert','');
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setSheetOpen(false);};
  addEventListener('keydown',key);const root=document.documentElement,was=root.style.overflow,back=document.activeElement as HTMLElement|null;root.style.overflow='hidden';panel.querySelector<HTMLElement>('.stock-panel-head button')?.focus();
   return()=>{removeEventListener('keydown',key);root.style.overflow=was;for(const other of behind)other.removeAttribute('inert');if(!document.activeElement?.closest('.stock-dock'))back?.focus();};},[sheetOpen,docked,tab,viewActive,suspended]);
 useEffect(()=>{if(!viewActive||suspended||!securityRef.current?.open)return;securityRef.current.querySelector<HTMLElement>(securityView?'.stock-security-subview h3':'.stock-security-menu button')?.focus();},[securityView,viewActive,suspended]);
 // A finished action leaves the bar after a moment; a failure stays until it is dismissed.
 useEffect(()=>{if(!sheet?.done)return;const timer=setTimeout(()=>sheetOwner.clear(),5000);return()=>clearTimeout(timer);},[sheet]);
 const arkAssetRecipient=!!assetId&&isValidArkAddress(arkTarget(to.trim())??''),carrier=arkAssetRecipient?withSats:'';
 const requestKey=JSON.stringify([tab,to,amount,assetId,carrier]);
 const quoteContext={wallet:wallet??quotes,revision:wallet&&fundsRef.current?.wallet===wallet?fundsRef.current.watch.revision:0,key:requestKey};
 const {quote,error:quoteError,pending:quoting}=quotes.read(quoteContext);
 useEffect(()=>{
  quotes.invalidate(quoteContext);
 },[wallet,requestKey,quoteContext.revision]);
 const getQuote=()=>{
  if(!wallet||tab!=='send'||!to.trim()||(!amount&&!isInvoice(to))||busyRef.current||restoring.current||quoting)return;
  const funds=fundsRef.current;if(funds?.wallet!==wallet)return;
  quotes.load({...quoteContext,revision:funds.watch.update()},()=>{
   const request:PaymentRequest={raw:to.trim(),...(assetId?{amount:Number(carrier||DUST),assets:[{assetId,amount:BigInt(amount)}]}:amount&&!invoiceCarriesAmount(to)?{amount:Number(amount)}:{})};
   return pageQuoteRoute(()=>wallet.router().route(request),()=>startingRef.current);
  });
 };
 // Each read builds the bearer key's account, so it runs when the link or wallet changes, not on every tick.
 useEffect(()=>{
  setClaimView(undefined);
  if(!wallet||!claim||claimTokenError(claim))return;
  let stop=false;
  void wallet.inspectLink(claim).then(view=>{if(!stop)setClaimView(view);},error=>{if(!stop)setClaimView({error:errorText(error)});});
  return()=>{stop=true;};
 },[wallet,claim,claimRead]);
 // Opening another link in this tab changes only the hash, so the page does not reload.
 useEffect(()=>{
  const changed=()=>{if(location.pathname.replace(/\/+$/,'')==='/claim')setClaim(location.hash.slice(1));};
  addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);
 },[]);
 const leaveClaim=()=>{setClaim('');history.replaceState(null,'','/wallet');};
 const claimNow=async()=>{if(await run(()=>wallet!.claimLink(claim),claimView&&'mine' in claimView&&claimView.mine?'Taking back a link':'Claiming a link'))leaveClaim();else setClaimRead(n=>n+1);};
 const mintLink=async()=>{
  const before=new Set(wallet?.links().map(l=>l.key));
  if(await run(()=>wallet!.mintLink(BigInt(amount),assetId||undefined),'Creating a claim link'))setMinted(wallet!.links().find(l=>!before.has(l.key))?.token??'');
 };
 const links=wallet?.links()??[],mintedLink=links.find(l=>l.token===minted),claimProblem=claim?claimTokenError(claim):'';

 const receiveBlocked=restoreRequested.current||restoring.current||restoreStarted;
 const reserves=Object.keys(pool?.pool?.reserves??{}),address=receiveBlocked?'':wallet?.shieldedAddress()??(early?.secret===secret?early.address:''),funding=receiveBlocked?'':arkAddress||(early?.secret===secret?early.ark??'':''),listingFull=listingBlocked(pool?.pool);
 const synced=!!wallet,balance=wallet?.shieldedBalance()??0n;
 const assetUnits=(id:string)=>wallet?.shieldedBalance(assetFieldOfId(id))??0n;
 const paidOut=coins.filter(c=>wallet?.isPoolPayout(c)&&!c.assets?.length),paidOutSats=paidOut.reduce((sum,c)=>sum+c.value,0);
 const expiring=coins.filter(c=>!wallet?.isPoolPayout(c)&&!c.assets?.length&&c.expiresAt!==undefined&&c.expiresAt-Date.now()<=SHIELD_FLOOR_MS).reduce((sum,c)=>sum+c.value,0);
 // The funding address shows before the wallet opens, so until then the fee comes from the pool's own status.
 const fee=wallet?wallet.depositFee:depositFeeFor(pool),feeLine=depositFeeLine(fee),nextPlan=fee?wallet?.planFor(coins):undefined;
 // The banner renders and accepts this one value, so a fee raised after this render stays paused.
 const feePaused=wallet?.depositFeePaused,payoutFee=fee?` A single payout moves back into the pool without the deposit fee, and two or more together would pay it, so Shield again moves one payout at a time.${feePaused?' Accept the new fee above to move payouts back.':''}`:'';
 const fundingFee=fee?[feeLine,feePaused&&PAUSED_LINE,wallet&&nextPlan?.kind==='btc'?depositFeeAmountLine(wallet.depositFeeOnPlan(nextPlan),nextPlan.amount):'',depositFeeOutsideLine(coins.filter(c=>!wallet?.isPoolPayout(c)),fee,Date.now(),SHIELD_FLOOR_MS)].filter(Boolean).join(' '):'';
 useEffect(()=>{if(feePaused)setFeeConfirmed(false);},[!!feePaused]);
 const requestedAmount=receiveAmount(lnAmount),invoiceAmount=invoiceRequestAmount(lnAmount,lnBounds);
 const ready=pool?.phase==='ready'&&!!secret,unit=assetId?'units':'sats',lnOutside=requestedAmount!==undefined&&!!lnBounds&&!invoiceInRange(lnBounds,requestedAmount);
 const settled=!!pool||!!startupError||!!poolError;
 const maxSend=wallet?wallet.maxPrivatePayment(assetId?assetFieldOfId(assetId):0n):0n;
 const needsRecovery=new Set(wallet?.recovering.map(note=>note.nullifier)),recovering=new Set(wallet?.recoveryInFlight.map(note=>note.nullifier));
 const inFlight=!!wallet&&[...wallet.shieldedNotes(),...reserves.flatMap(id=>wallet.shieldedNotes(assetFieldOfId(id)))].some(note=>wallet.inFlight.has(note.nullifier)&&!recovering.has(note.nullifier));
 const phrase=secret?recoveryPhraseOf(secret):'',created=Number(storage.getItem(CREATED))||0;
 const assetName=(id:string)=>`asset ${short(id)}`;
 const revealFor=(item:Activity)=>{
  const link=wallet?.revealLinkOfActivity(item);
  if(!link)return null;
  return <><dt>Reveal</dt><dd>{revealed[item.id]
   ?<><Copyable value={revealed[item.id]!}/><p className="stock-muted">Anyone with this link can check this payment&apos;s amount and recipient against the pool, and learns nothing else.</p></>
   :<button type="button" className="stock-ghost stock-mini" onClick={()=>setRevealed(r=>({...r,[item.id]:link}))}>Create a reveal link</button>}</dd></>;
 };

 const submit=()=>{if(quote){setSheetOpen(false);void run(async()=>{
  const funds=fundsRef.current;if(!funds||funds.wallet!==wallet)throw new Error('The wallet changed. Review its route again.');
  const currentCoins=await wallet!.coins();
  if(!mounted.current||restoring.current||fundsRef.current!==funds)throw new Error('The wallet changed. Review its route again.');
  return quotes.send({...quoteContext,revision:funds.watch.update(currentCoins)},quote);
 },routeCopy(quote.railId).title);}else getQuote();};

 const fill=(code:string)=>{
  let target:ReturnType<typeof payTarget>;try{target=payTarget(code);}catch(error){setCodeError(errorText(error));return;}
  setCodeError('');setTo(target.to);
  // A link's amount is in sats, so it switches an asset send back to Bitcoin; a fixed-amount invoice's own amount wins.
  if(invoiceCarriesAmount(target.to))setAmount('');
  else if(target.amount!==undefined){setAssetId('');setAmount(String(target.amount));}
 };
 const paste=async()=>{try{fill(await navigator.clipboard.readText());}catch{recipientNode.current?.focus();}};
 const selectTab=(name:'home'|'activity'|'receive'|'send')=>{if(name!==tab){if((name==='receive'||name==='send')&&(tab==='receive'||tab==='send'))setTo('');setTab(name);}if(name!=='home'){setSecurityView(null);setReveal(false);setShowView(false);setShowFull(false);}};
 const openPanel=(name:'activity'|'receive'|'send')=>{selectTab(name);setSheetOpen(true);};
 const navigation=useRef({tab,sheetOpen,selectTab,openPanel});navigation.current={tab,sheetOpen,selectTab,openPanel};
 const paymentTabs=docked&&(tab==='receive'||tab==='send');
 useEffect(()=>{
  if(!ready)return;
  const node=docked?dockNode.current:mainTabsNode.current;if(!node)return;
  return bindSwipeGesture(node,direction=>{
   const view=navigation.current,names=['home','activity','receive','send'] as const,index=names.indexOf(docked&&!view.sheetOpen?'home':view.tab),next=names[index+(direction==='next'?1:-1)];
   if(!next)return;
   if(docked){if(next==='home')setSheetOpen(false);else view.openPanel(next);}else view.selectTab(next);
  },{allowButtons:true});
 },[ready,docked]);
 useEffect(()=>{
  if(!ready||!docked||!sheetOpen||!panelGrip.current||!panelNode.current)return;
  return bindSheetGesture(panelGrip.current,panelNode.current,()=>setSheetOpen(false));
 },[ready,docked,sheetOpen]);
 useEffect(()=>{
  if(!ready||!paymentTabs||!panelTabsNode.current)return;
  return bindSwipeGesture(panelTabsNode.current,direction=>{
   const view=navigation.current;if(direction==='next'&&view.tab==='receive')view.selectTab('send');else if(direction==='previous'&&view.tab==='send')view.selectTab('receive');
  },{allowButtons:true});
 },[ready,paymentTabs]);
 const openSecurity=(view:'phrase'|'viewing'|'restore')=>{setReveal(false);setShowView(false);setShowFull(false);setSecurityView(view);};
 const leaveSecurity=()=>{setSecurityView(null);setReveal(false);setShowView(false);setShowFull(false);};
 const activity=soundbarItem({sheet,recovering:recovering.size>0,inFlight,recoveryLine:RECOVERY_LINE});
 const {checked:privateChecked,notice:privateNotice}=privateReceiveView(privateState);
 const privateListed=privateState.on&&privateState.listed==='own'&&!privateState.pending&&!privateState.refused&&!privateState.withdrawing;
 const privateDescription=privateListed?'This QR also offers private pool payments.'
  :privateNotice==='foreign'?'A different private address is listed here. Review below.'
  :privateNotice==='own'?'Your private address is still listed. Review below.'
  :privateNotice==='pending'?'A private address may still be listed. Review below.'
  :privateNotice==='confirming'?'Adding your private address. Review below.'
  :privateNotice==='refused'?'Receive with this QR. Private receive is unavailable.'
  :'One QR for supported ways to pay you. Add private payments below.';
 const turnOff=(label='Turn off')=><button type="button" className="stock-ghost stock-mini" disabled={lnBusy||!wallet} onClick={()=>void setPrivate(false)}>{label}</button>;
 const liveInvoice=invoice&&(invoice.outcome==='open'||invoice.outcome==='accepted')?invoice:undefined;
 const receivePayload=receiveMode;
 const receiveValue=receiveBlocked?'':receivePayload==='arkade'?funding:receivePayload==='shielded'?address:unifiedAddress;
 const receivePaymentValue=lnAmount?amountQrValue(receiveMode,receiveValue,lnAmount):undefined;
 const receiveDescription=receiveBlocked?'Receive is unavailable while the wallet is being restored.':receivePayload==='arkade'?feePaused?'New deposits are paused until you accept the updated fee.':'Eligible deposits move into your private balance while this wallet is open.'
  :receivePayload==='unified'?privateDescription
  :'Share this for direct private payments inside the pool.';
 const receiveLoading=receiveBlocked?'Restoring wallet…':receivePayload==='arkade'?'Preparing your Arkade address…':receivePayload==='shielded'?'Preparing your shielded address…':lnError?'Unified address unavailable':'Activating your unified address…';
 const historyItems=rows.map(item=>{
  const kind=item.intent?.kind,received=activityReceived(item),direction=historyDirection(item),newest=item.txs[item.txs.length-1]!;
  const label=item.intent?.label??(received?'Arkade funding':'Arkade payment');
  const status=kind==='lightning-receive'?LIGHTNING_STATUS[item.intent?.outcome??'received']:kind==='unshield'&&item.intent?.outcome==='paid'?'Paid':item.settled?'Settled':'Preconfirmed';
  const id=newest.key.arkTxid||newest.key.commitmentTxid,asset=newest.assets?.[0];
  const feePaid=wallet&&kind==='shield'?shieldFeeOfTx(wallet.shieldedHistory(),item.intent?.metadata?.txid):wallet&&kind==='lightning-receive'?lightningShieldFeeOf(wallet.shieldedHistory(),item.intent?.metadata?.shieldTxid,item.amount):undefined;
  return <li key={item.id}><details><summary><span className={'stock-kind '+(kind?SWATCH[kind]??'arkade':'arkade')}>{label}{kind==='lightning-receive'&&<> · {status}</>}</span>
    <b className={direction==='own'?undefined:direction}>{direction==='in'?'+':direction==='out'?'−':''}{asset?`${(asset.amount<0n?-asset.amount:asset.amount).toLocaleString('en-US')} units of ${assetName(asset.assetId)}`:`${sats(Math.abs(item.amount))} sats`}</b><time>{when(item.createdAt)}</time></summary>
   <dl>
    <dt>Where</dt><dd>{whereOf(kind,received)}</dd>
    {typeof item.intent?.metadata?.batch==='number'&&<><dt>Batch</dt><dd>#{String(item.intent.metadata.batch)}</dd></>}
    {id&&<><dt>Transaction</dt><dd><TxLink txid={id} path={newest.key.arkTxid?'tx':'commitment-tx'}/></dd></>}
    {feePaid!==undefined&&feePaid>0n&&<><dt>Deposit fee</dt><dd>{satsText(feePaid)}</dd></>}
    {kind==='onchain-exit'&&typeof item.intent?.metadata?.onchainTxid==='string'&&<><dt>To</dt><dd><Copyable value={String(item.intent.metadata.to)}/></dd>
     {typeof item.intent.metadata.onchainSats==='number'&&<><dt>On-chain</dt><dd>{sats(item.intent.metadata.onchainSats)} sats, after a {sats(Math.abs(item.amount)-item.intent.metadata.onchainSats)}-sat fee</dd></>}
     <dt>Bitcoin transaction</dt><dd><TxLink txid={item.intent.metadata.onchainTxid} path="commitment-tx"/></dd></>}
    <dt>Status</dt><dd>{status}</dd>
    {kind==='lightning-receive'&&item.intent?.outcome!=='shielded'&&wallet?.swaps&&typeof item.intent?.metadata?.outpoint==='string'&&<LightningRecoveryQuote service={wallet.swaps} outpoint={item.intent.metadata.outpoint} disabled={busy||restoring.current}/>}
    {revealFor(item)}
   </dl></details></li>;
 });
 const historyContent=(items:typeof historyItems)=>!rows.length?<p className="stock-muted">{synced?'No activity yet.':'Reading the pool…'}</p>:<ul>{items}</ul>;
  const shownAssets=reserves.filter(id=>assetUnits(id)>0n),unshielded=arkAvailable??0;
  const balanceCard=()=> <section className="stock-card stock-balance">
   <div className="stock-balance-main"><small>Your private balance</small><strong>{sats(balance)} <em>sats</em></strong><WalletSyncStatus privateReady={synced} arkReady={arkAvailable!==undefined} error={startupError||refreshError} onRetry={startupError||refreshFailed.current?(busy||handleBusy.current||actions.current!.busy?undefined:()=>{if(!busyRef.current&&!handleBusy.current&&!actions.current!.busy)reload();}):()=>refreshRef.current?.request()}/></div>
   {(unshielded>0||shownAssets.length>0)&&<div className="stock-balance-side">{unshielded>0&&<div><small>Unshielded</small><b>{sats(unshielded)} sats</b></div>}
   {shownAssets.map(id=><div key={id}><small>ASSET {short(id)}</small><b>{assetUnits(id).toLocaleString('en-US')} units</b></div>)}</div>}
  </section>;
  const recentPreview=<section className="stock-card stock-history stock-history-preview"><div className="stock-recent-head"><h2>Recent activity</h2><button type="button" onClick={()=>docked?openPanel('activity'):selectTab('activity')}>See all</button></div>{historyContent(historyItems.slice(0,3))}</section>;

  if(!secret)return <WalletOnboarding transport="browser" setup={!restoring.current} busy={busy||restoreStarted} phase={restoring.current?'Reload to continue restoring your wallet.':'Create or restore your wallet'} error={restoreError} phrase={restore} onPhraseChange={setRestore} onCreate={createWallet} onRestore={()=>void restoreWallet()} onReconnect={reload}/>;

  return <WalletEntrance enabled={animateEntrance}><div hidden={hidden} style={hidden?{display:'none'}:undefined} inert={suspended||!viewActive} className={'stock-page'+(docked?' has-dock':'')+(docked&&sheetOpen?' has-sheet':'')+(docked&&sheetOpen&&tab==='activity'?' has-activity':'')}><div className="wallet-glass-field" aria-hidden="true"><svg viewBox="0 0 640 900" preserveAspectRatio="xMidYMid slice"><defs><pattern id="wallet-contours" width="96" height="96" patternUnits="userSpaceOnUse"><path d="M-24 48Q24 0 72 48T168 48M-24 64Q24 16 72 64T168 64M-24 80Q24 32 72 80T168 80M-24 96Q24 48 72 96T168 96" fill="none" stroke="currentColor" strokeWidth=".6"/></pattern></defs><path d="M320 76Q442 130 542 130V394Q542 610 320 752Q98 610 98 394V130Q198 130 320 76Z" fill="url(#wallet-contours)" stroke="currentColor"/></svg></div><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>wallet</span></a><div className="app-header-status">{!NATIVE&&<AppUpdateNotice/>}<a className="stock-home" href="/">About</a></div></header>
   {nativePending&&<section className="stock-warning" role="status">Some payments have unresolved outcomes. Their inputs remain reserved; a dropped status alone does not prove that they cannot be included later.</section>}
   <details className="stock-warning stock-network"><summary><strong>Mutinynet</strong><span>Test funds only.</span></summary><p>The proving keys come from a small testnet ceremony: one contribution per circuit, sealed by a Bitcoin beacon. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</p></details>
  {pool?.pool?.notice&&<section className="stock-warning"><strong>The pool is waiting</strong><span>{pool.pool.notice}</span></section>}
  {wallet?.operatorDown&&<section className="stock-warning" role="alert"><strong>Pool status is delayed</strong><span>We haven't refreshed the pool status recently. Checks retry automatically. If the operator stops renewing the pool, its head and payouts expire {wallet.operatorDown.headExpiresAt?`on the last observed deadline, ${when(wallet.operatorDown.headExpiresAt)}`:'within a week of its last renewal'}. To withdraw without the operator, see <a href="https://github.com/arkade-os/shielded#if-the-operator-stops">If the operator stops</a>.</span></section>}
  {wallet&&feePaused&&<section className="stock-warning" role="alert"><strong>{PAUSED_TITLE}</strong><span>{depositFeeBanner(feePaused,wallet.acceptedDepositFee)}</span><p><button type="button" className="stock-ghost stock-mini" onClick={()=>acceptFee(wallet,feePaused)}>{ACCEPT_FEE}</button></p></section>}
  {feeConfirmed&&!feePaused&&<section className="stock-message" role="status" tabIndex={-1} ref={viewActive&&!suspended?focusOnMount:undefined}>New fee accepted.</section>}
   {ready&&poolError&&<p className="stock-blocked">{poolError}</p>}
   {ready&&feeNotice&&<p className="stock-blocked" role="alert">{feeNotice}</p>}
   {ready&&startupError&&<p className="stock-blocked">{startupError}</p>}
   {ready&&refreshError&&<p className="stock-blocked">{refreshError}</p>}
  {!ready&&<section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><div><h2>{pool?pool.phase==='blocked'?'The pool is stopped':'The pool is being set up':'Connecting to the pool'}</h2><p className="stock-muted">{startupError||poolError||pool?.message}</p></div></section>}
  {ready&&<>
   {claim&&<section className="stock-card"><h2>{claimView&&'mine' in claimView&&claimView.mine?'Your claim link':'A claim link for you'}</h2>
    {claimProblem?<p className="stock-blocked">{claimProblem}</p>
     :!claimView?<p className="stock-muted">Reading the link…</p>
     :'error' in claimView?<p className="stock-blocked">{claimView.error}</p>
     :!claimView.notes.length?<p className="stock-muted">This link is empty or already claimed.</p>
     :<><p><b>{holdingsText(claimView.notes,field=>wallet?.assetIdOf(field))}</b></p>
      <p className="stock-muted">{claimView.mine?'You created this link and nobody has claimed it yet. Taking it back returns it to your shielded balance.':'Claiming moves it privately into this wallet. Onlookers see neither the amount nor who claimed it; whoever made the link sees only that it was claimed.'}</p>
      <button className="stock-primary" disabled={busy||restoring.current||!wallet} onClick={()=>void claimNow()}>{claimView.mine?'Take back':'Claim'}</button></>}
    <button className="stock-ghost stock-mini" onClick={leaveClaim}>Dismiss</button></section>}
    {!docked&&<nav ref={mainTabsNode} className="stock-tabs stock-main-tabs wallet-glass-track" style={{'--glass-index':['home','activity','receive','send'].indexOf(tab),'--glass-count':4} as CSSProperties} role="tablist" aria-label="Wallet sections"><span ref={mainLens} className="wallet-glass-lens" aria-hidden="true"/>{(['home','activity','receive','send'] as const).map(name=><button key={name} type="button" role="tab" aria-selected={tab===name} aria-controls="stock-panel" className={tab===name?'selected':''} onClick={()=>selectTab(name)}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</nav>}
    <div className="stock-grid"><div className="stock-col">
     {docked&&<>{balanceCard()}{recentPreview}</>}
    <section ref={panelNode} id="stock-panel" className={'stock-card stock-panel'+(docked&&sheetOpen?' is-open':'')+(docked&&tab==='activity'?' is-activity':'')} {...(docked?{role:'dialog','aria-modal':sheetOpen&&tab!=='activity','aria-label':tab==='activity'?'Activity':tab==='receive'?'Receive':tab==='send'?'Send':'Home',inert:!sheetOpen}:{})}>
    {docked&&<div ref={panelGrip} className="stock-panel-head"><span className="stock-grabber" aria-hidden="true"/><button type="button" className="stock-ghost stock-mini" onClick={()=>setSheetOpen(false)}>Close</button></div>}
    {docked&&sheetOpen&&activity&&<div className="stock-sheet-status" role="status" aria-live="polite"><span className={'stock-sheet-status-dot is-'+activity.state} aria-hidden="true"/><span><b>{activity.title}</b>{activity.line&&<> · {activity.line}</>}</span>{activity.state!=='active'&&<button type="button" onClick={()=>sheetOwner.clear()} aria-label="Dismiss wallet status">×</button>}</div>}
     {paymentTabs&&<div ref={panelTabsNode} className="stock-tabs wallet-glass-track" style={{'--glass-index':tab==='send'?1:0,'--glass-count':2} as CSSProperties} role="tablist" aria-label="Payment direction"><span ref={panelLens} className="wallet-glass-lens" aria-hidden="true"/>{(['receive','send'] as const).map(name=><button key={name} role="tab" aria-selected={tab===name} className={tab===name?'selected':''} onClick={()=>selectTab(name)}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</div>}
     {tab==='home'?(!docked?<div className="stock-home-view">{balanceCard()}{recentPreview}</div>:null):tab==='activity'?<section className="stock-card stock-history stock-history-full"><h2>Activity</h2>{historyContent(historyItems)}{synced&&!rows.length&&<button type="button" className="stock-primary" onClick={()=>docked?openPanel('receive'):selectTab('receive')}>Receive your first payment</button>}</section>:<>
     {tab==='receive'?<div className="stock-receive">
       <ReceivePortal active={viewActive&&!suspended&&(!docked||sheetOpen)} mode={receiveMode} payload={receivePayload} onModeChange={setReceiveMode} value={receivePaymentValue??receiveValue} qrValue={receivePaymentValue} amount={lnAmount} onAmount={setLnAmount} loading={receiveLoading} description={receiveDescription} action={!receiveBlocked&&receiveMode==='unified'&&unifiedAddress?(lnAddress?<div className="stock-unified-name"><span>Lightning address</span><strong>{lnAddress}</strong><CopyButton value={lnAddress} label="Copy Lightning address"/></div>:<button type="button" className="stock-ghost stock-mini" disabled={lnBusy||!wallet?.swaps||!lnurlRef.current} onClick={()=>void claimAddress()}>Claim Lightning address</button>):undefined}>
        {receivePaymentValue&&requestedAmount!==undefined&&<p className="stock-muted" role="status">Requested {satsText(requestedAmount)}. <CopyButton value={receivePaymentValue} label="Copy payment link"/></p>}
        {!receiveBlocked&&receiveMode==='unified'&&<>
         {!unifiedAddress&&<button type="button" className="stock-ghost stock-mini" disabled={lnBusy||busy||actions.current.busy||!(wallet?.swaps&&lnurlRef.current||((startupError||lnError)&&!handleBusy.current))} onClick={()=>{if(actions.current!.busy)return;if(wallet?.swaps&&lnurlRef.current){unifiedRetry.current??=retryUnified().finally(()=>{unifiedRetry.current=undefined;});void unifiedRetry.current;}else if((startupError||lnError)&&!busy&&!handleBusy.current)reload();}}>Retry unified address</button>}
         <details className="stock-more"><summary>Had an address before?</summary><button type="button" className="stock-ghost stock-mini" disabled={lnBusy||!wallet?.swaps||!lnurlRef.current} onClick={()=>void recoverAddress()}>Recover it</button></details>
         {unifiedAddress&&<><label className="stock-check">Include private payments<input type="checkbox" role="switch" checked={privateChecked} disabled={lnBusy} aria-describedby="stock-private-hint" onChange={e=>void setPrivate(e.target.checked)}/></label>
          <p id="stock-private-hint" className="stock-muted">Turning this on asks the service to add your shielded address. Anyone looking up your unified address can see that you use the pool.</p>
         <div role="status">
          {privateNotice==='foreign'&&<p className="stock-blocked">This unified address lists a shielded address that is not this wallet&apos;s. A payer who uses it pays that address, not yours. Turn off asks the service to remove every shielded address listed there, this wallet&apos;s included.</p>}
          {privateNotice==='confirming'&&<p className="stock-blocked">Private receive is on, but the service has not confirmed that it lists your shielded address yet. This wallet asks again while this page is open.</p>}
          {privateNotice==='own'&&<p className="stock-blocked">This unified address lists your shielded address, but private receive is off on this device. Keep it on, or turn it off to remove it from the service.</p>}
         </div>
         {privateNotice==='pending'&&<p className="stock-blocked" role="alert">Not withdrawn yet: the service still lists a shielded address on this unified address, so payers may still be offered it. This wallet asks the service to remove it again while this page is open.</p>}
         {privateNotice==='refused'&&<p className="stock-blocked" role="alert">This Lightning address service does not support private receive yet, so your shielded address is not listed, and this wallet has stopped sending it. Switch private receive on to try again.</p>}
         {(privateNotice==='foreign'||privateNotice==='own'||privateNotice==='refused')&&<div className="stock-actions">{privateNotice==='own'&&<button type="button" className="stock-ghost stock-mini" disabled={lnBusy||!wallet} onClick={()=>void setPrivate(true)}>Keep it on</button>}{turnOff(privateNotice==='refused'?'Dismiss':'Turn off')}</div>}
         <details className="stock-more"><summary>How private receive works</summary><p className="stock-muted">Payments to your shielded address stay private inside the pool. Turning this on lists that address on your unified receiver: anyone who looks it up learns that you use the pool and gets your shielded address, the same one every payer gets, and it never changes. The address service learns it too. Turning it off asks the service to remove it; if the service keeps it, this wallet says so and asks again while this page is open. The choice is saved on this device only: another device with your recovery phrase decides for itself, and one that has it on lists the address again.</p></details></>}
        {lnError&&<p className="stock-blocked" role="alert">{lnError}</p>}
         <details className="stock-more" open={requestOpen} onToggle={e=>setRequestOpen(e.currentTarget.open)}><summary>Invoice amount</summary>{lnBounds?<p id="stock-ln-limits" className={lnOutside?'stock-blocked':'stock-muted'}>{invoiceLimitsLine(lnBounds)}</p>:lnBoundsError?<><p className="stock-blocked" role="alert">{lnBoundsError}</p><button type="button" className="stock-ghost stock-mini" onClick={readLnBounds}>Retry invoice limits</button></>:<p className="stock-muted" role="status">Checking invoice limits…</p>}<button type="button" className="stock-ghost stock-mini" disabled={lnBusy||!wallet?.swaps||invoiceAmount===undefined} onClick={()=>void createInvoice()}>Create invoice</button>
          {invoice&&<div className="stock-invoice-result"><strong>Lightning invoice · {sats(invoice.pays)} sats</strong>{liveInvoice&&<Copyable key={invoice.id} value={invoice.bolt11} qr={invoiceQr(invoice.bolt11)} label="QR code for this Lightning invoice"/>}<p className="stock-muted" role="status">{invoiceLine(invoice,fee)}</p></div>}
         </details>
        <details className="stock-more"><summary>Receive details</summary>{feeLine&&<p className="stock-muted">{feeLine}{feePaused&&` ${PAUSED_LINE}`}</p>}<p className="stock-muted">This unified address pays one Arkade payout address at a time, which this wallet derives and replaces after a payment or once a day. {lightningMinimumLine(fee)} The unified address stays the same and accepts payments while closed. Its service sees each payout address it serves and can link them to this receiver; payers before the next replacement share one address.</p></details>
       </>}
        {!receiveBlocked&&receiveMode==='arkade'&&<><details className="stock-more"><summary>Fees & test funds</summary><p className="stock-muted">{fundingFee||'Sats sent here move into the pool while this wallet is open.'}{expiring>0&&` ${sats(expiring)} sats expire within a day, so the pool will not take them.`}</p><p className="stock-muted">Need test sats? Use the <a href="https://faucet.mutinynet.com" target="_blank" rel="noreferrer">Mutinynet faucet</a> after a GitHub sign-in.</p></details>{expiring>0&&<button type="button" className="stock-ghost stock-mini" disabled={busy||restoring.current||!wallet} onClick={()=>void renew()}>Renew expiring sats</button>}</>}
      </ReceivePortal>
     {!receiveBlocked&&paidOutSats>=DUST&&<div className="stock-address"><small>BACK ON ARKADE FROM THE POOL</small><b>{sats(paidOutSats)} sats</b><p className="stock-muted">Withdrawals stay on Arkade until you move them back.{payoutFee}</p><button className="stock-ghost stock-mini" disabled={busy||!!feePaused} onClick={()=>void run(()=>wallet!.shield(paidOut),'Shielding again')}>Shield again</button></div>}
     {!receiveBlocked&&arkAssetHoldings(coins,c=>!!wallet?.isPoolPayout(c)).map(a=><div key={a.assetId+':'+a.payout} className="stock-address"><small>{a.payout?'BACK ON ARKADE FROM THE POOL':'ARKADE ASSET'} {short(a.assetId)}</small><b>{sats(a.units)} units</b>
      {a.payout?<><p className="stock-muted">Withdrawals stay on Arkade until you move them back.{payoutFee}</p><button className="stock-ghost stock-mini" disabled={busy||!!feePaused} onClick={()=>void run(()=>wallet!.shield(a.coins),'Shielding again')}>Shield again</button></>
       :reserves.includes(a.assetId)?<p className="stock-muted">{(fee&&listedAssetLine(a.coins,fee,new Set(reserves),Date.now(),SHIELD_FLOOR_MS,!!feePaused))||'Listed in the pool, so it moves in on its own.'}</p>
       :listingFull?<p className="stock-blocked">{listingFull}</p>
       :listed===a.assetId?<p className="stock-muted">Listing sent; the pool registers it within a minute.</p>
       :<><p className="stock-muted">Not in the pool yet. Listing it sends 1 unit and {DUST} sats to the pool, after which anyone can shield it.</p><button className="stock-ghost stock-mini" disabled={busy||restoring.current||!wallet} onClick={()=>void listAsset(a.assetId)}>List in the pool</button></>}{!a.payout&&listingError?.id===a.assetId&&<p className="stock-blocked" role="alert">{listingError.message}</p>}</div>)}
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();submit();}}>
     {reserves.length>0&&<label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">Bitcoin</option>{reserves.map(id=><option key={id} value={id}>Asset {short(id)}</option>)}</select></label>}
     <div className="stock-to"><label>To<input ref={recipientNode} id="stock-to" value={to} onChange={e=>{setTo(e.target.value);setCodeError('');}} placeholder="shrol21…, tark1…, a Lightning invoice or address" autoComplete="off" spellCheck={false}/></label>
      <button type="button" className="icon-button" aria-label="Scan a payment code" disabled={suspended} onClick={()=>{if(!suspended)setScanning(true);}}><Icon name="scan"/></button><button type="button" className="icon-button" aria-label="Paste" onClick={()=>void paste()}><Icon name="paste"/></button></div>
     {codeError&&<p className="stock-blocked" role="alert">{codeError}</p>}
     <label>Amount ({unit})<input inputMode="numeric" value={amount} placeholder={invoiceCarriesAmount(to)?'From the invoice':undefined} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     {arkAssetRecipient&&<label>Sats with it<input inputMode="numeric" value={withSats} placeholder={String(DUST)} onChange={e=>setWithSats(e.target.value.replace(/\D/g,''))}/></label>}
      <p className="stock-muted">{synced?`Up to ${sats(maxSend)} ${unit} available privately.`:'Syncing your wallet…'}</p>
     <details className="stock-more"><summary>Where each kind of payment goes</summary><p className="stock-muted">A shielded address pays privately inside the pool. An Arkade address leaves the pool, and the amount and destination become public. A Bitcoin address leaves the pool through a fresh key used only for that payment, so it is not linked to your deposit address. Lightning funds its swap directly from one pool note. A claim link pays whoever opens it first.</p>{to.trim()&&<p className="stock-muted">Get quote contacts the payment service for Lightning invoices and addresses. It shares the invoice or address and amount; payment happens after you confirm the quote.</p>}</details>
     {quote&&<div className="stock-route"><b>{routeCopy(quote.railId).title}</b><span className="stock-muted">{routeCopy(quote.railId).detail}</span>
      {quote.fee>0&&<small>Fee {sats(quote.fee)} sats · total {sats(quote.total)} sats</small>}</div>}
     {quoteError&&<p className="stock-blocked">{quoteError}</p>}
     <button className="stock-primary" disabled={busy||restoring.current||!synced||quoting||!to.trim()||(!amount&&!isInvoice(to))}>{busy?'Working…':quoting?'Getting quote…':quote?routeCopy(quote.railId).title:'Get quote'}</button>
     {!to.trim()&&<button type="button" className="stock-ghost" disabled={busy||restoring.current||!synced||!amount} onClick={()=>void mintLink()}>Create a claim link</button>}
     {mintedLink?.state==='unclaimed'&&<div className="stock-address"><small>CLAIM LINK</small><Copyable value={claimUrl(POOL_ORIGIN||location.origin,minted)} qr={claimUrl(POOL_ORIGIN||location.origin,minted)} label="QR code of the claim link"/>
      <p className="stock-muted">Anyone with this link can claim it until it is claimed; you can take it back before then.</p></div>}
     </form>}</>}
    </section></div>
    {(docked||tab==='home')&&links.length>0&&<div className="stock-col"><section className="stock-card"><h2>Your claim links</h2><div className="stock-notes">
    {links.map(link=><div key={link.key}><span>{holdingsText([{asset:BigInt(link.asset),amount:BigInt(link.amount)}],field=>wallet?.assetIdOf(field))}</span><span className={link.state==='unclaimed'?'wait':'ok'}>{LINK_STATE[link.state]}</span>
     {link.state==='unclaimed'&&<div className="stock-actions"><CopyButton value={claimUrl(POOL_ORIGIN||location.origin,link.token)} label="Copy link"/><button className="stock-ghost stock-mini" disabled={busy||restoring.current} onClick={()=>void run(()=>wallet!.claimLink(link.token),'Taking back a link').then(()=>setClaimRead(n=>n+1))}>Take back</button></div>}</div>)}
    </div></section></div>}</div>
  </>}
    {(!ready||docked||tab==='home')&&settled&&!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery phrase</h2><p className="stock-muted">These 24 words restore your pool notes and Arkade keys. Anyone with them can spend your funds.</p><details className="stock-more"><summary>Before you switch devices</summary><p className="stock-muted">Keep this browser&apos;s data until pending Lightning swaps and their payouts have finished. The phrase alone does not restore every outstanding swap.</p></details>{reveal&&<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show phrase</button>}<button className="stock-ghost" onClick={()=>{storage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
    {(!ready||docked||tab==='home')&&settled&&<details ref={securityRef} className="stock-card stock-advanced stock-security" onToggle={e=>{if(!e.currentTarget.open)leaveSecurity();}}><summary>Security &amp; recovery</summary>
    {!securityView?<div className="stock-security-menu">
     {(backedUp||!secret)&&<button type="button" className="stock-security-choice" onClick={()=>openSecurity('phrase')}><strong>Recovery phrase</strong><small>Back up or reveal your words</small><span aria-hidden="true">›</span></button>}
     <button type="button" className="stock-security-choice" onClick={()=>openSecurity('viewing')}><strong>Viewing access</strong><small>Share read-only wallet history</small><span aria-hidden="true">›</span></button>
     <button type="button" className="stock-security-choice" onClick={()=>openSecurity('restore')}><strong>Restore wallet</strong><small>Use a phrase from another device</small><span aria-hidden="true">›</span></button>
    </div>:<div className="stock-security-subview"><button type="button" className="stock-security-back" onClick={leaveSecurity}>← Back</button><h3 tabIndex={-1}>{securityView==='phrase'?'Recovery phrase':securityView==='viewing'?'Viewing access':'Restore wallet'}</h3>
     {securityView==='phrase'&&<><p className="stock-muted">These 24 words restore your pool notes and Arkade keys. Anyone with them can spend your funds. Keep this browser&apos;s data while Lightning swaps or payouts are pending: the phrase alone does not restore every outstanding swap. A fresh browser recovers a Lightning alias through Recover a Lightning address; direct swaps also need their stored recovery records.</p>
      {secret?(reveal?<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>:<button type="button" className="stock-ghost" onClick={()=>setReveal(true)}>Show recovery phrase</button>):<p className="stock-muted">No recovery phrase is available in this browser.</p>}
      {secret&&created&&<p className="stock-muted">Created {new Date(created).toLocaleDateString()}. Keep the date with the words: a restore that has it skips the pool&apos;s older history.</p>}</>}
     {securityView==='viewing'&&<>{wallet?<><section className="stock-security-key"><h4>View key · read only</h4>{showView?<><Copyable value={wallet.viewKey()}/><p className="stock-muted">Shows every payment this wallet receives, for an auditor or a second device. It cannot spend and cannot see which notes were spent. <a className="stock-txlink" href={`/watch#${wallet.viewKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowView(true)}>Show view key</button>}</section>
       <section className="stock-security-key"><h4>Full viewing key · sees spends</h4>{showFull?<><Copyable value={wallet.fullViewingKey()}/><p className="stock-muted">Shows every note this wallet received and which ones it spent, so also how much each payment out sent, forever. It cannot spend and cannot freeze your notes. <a className="stock-txlink" href={`/watch#${wallet.fullViewingKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowFull(true)}>Show full viewing key</button>}</section></>:<p className="stock-muted">Viewing access is available when the wallet is ready.</p>}</>}
     {securityView==='restore'&&<><p className="stock-muted">Keep this browser&apos;s data while Lightning swaps or payouts are pending. A fresh browser recovers a Lightning alias through Recover a Lightning address; direct swaps also need their stored recovery records. The phrase alone does not restore every outstanding swap.</p>
      <label>Restore from a recovery phrase<textarea rows={3} value={restore} onChange={e=>setRestore(e.target.value)} autoComplete="off" spellCheck={false} placeholder="24 words (older wallets: 64 hex characters)"/></label>
      <label>Created on, if you know it (any earlier date also works)<input type="date" value={restoreDate} onChange={e=>setRestoreDate(e.target.value)}/></label>
      <button disabled={busy||receiveBlocked||!restore.trim()} onClick={()=>void restoreWallet()}>Restore wallet</button>
      {restoreError&&<p className="stock-blocked">{restoreError}</p>}
      {restoreError&&restoring.current&&<button type="button" className="stock-ghost stock-mini" onClick={()=>location.reload()}>Reload wallet</button>}</>}
    </div>}
   </details>}
    {(docked||tab==='home')&&ready&&<details className="stock-card stock-advanced stock-technical"><summary>Wallet details</summary><p className="stock-muted">Pool activity: {wallet?.batchCount()??0} batches</p>
    {((wallet?.shieldedNotes().length??0)>0||reserves.some(id=>assetUnits(id)>0n))&&<div className="stock-notes">
     {(wallet?.shieldedNotes()??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span>{recovering.has(n.nullifier)?<span className="wait">Recovering</span>:needsRecovery.has(n.nullifier)?<span className="wait">Needs recovery</span>:wallet!.inFlight.has(n.nullifier)?<span className="wait">In flight</span>:<span className="ok">Spendable</span>}</div>)}
     {reserves.flatMap(id=>(wallet?.shieldedNotes(assetFieldOfId(id))??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} units</span><span className={wallet!.inFlight.has(n.nullifier)||needsRecovery.has(n.nullifier)?'wait':'ok'}>{recovering.has(n.nullifier)?'Recovering':needsRecovery.has(n.nullifier)?'Needs recovery':wallet!.inFlight.has(n.nullifier)?'In flight':`Asset ${short(id)}`}</span></div>))}
    </div>}
   </details>}
 </main>
 {docked&&<>{sheetOpen&&<div className="stock-backdrop" aria-hidden="true" onClick={()=>setSheetOpen(false)}/>}
   <nav ref={dockNode} className="stock-dock wallet-glass-track" style={{'--glass-index':['home','activity','receive','send'].indexOf(sheetOpen?tab:'home'),'--glass-count':4} as CSSProperties} aria-label="Wallet navigation"><span ref={dockLens} className="wallet-glass-lens" aria-hidden="true"/>{(['home','activity','receive','send'] as const).map(name=><button key={name} type="button" aria-current={name==='home'&&!sheetOpen?'page':undefined} aria-controls={name==='home'?undefined:'stock-panel'} aria-expanded={name==='home'?undefined:sheetOpen&&tab===name} className={(sheetOpen?tab===name:name==='home')?'selected':''} onClick={()=>name==='home'?setSheetOpen(false):openPanel(name)}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</nav></>}
 {ready&&viewActive&&!suspended&&<><GlassRefraction target={panelNode} active={docked&&sheetOpen} radius={30} bezel={24} strength={36}/><GlassRefraction target={dockLens} active={docked&&(!sheetOpen||tab==='activity')} radius={999} bezel={10} strength={18}/><GlassRefraction target={mainLens} active={!docked} radius={999} bezel={10} strength={18}/><GlassRefraction target={panelLens} active={sheetOpen&&paymentTabs} radius={999} bezel={9} strength={14}/></>}
 {ready&&<Soundbar item={activity} onDismiss={()=>sheetOwner.clear()}/>}
 {scanning&&!suspended&&viewActive&&<Scanner onResult={code=>{setScanning(false);if(!suspended&&viewActive)fill(code);}} onClose={()=>setScanning(false)}/>}
 </div></WalletEntrance>;
}
