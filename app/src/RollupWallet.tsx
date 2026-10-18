import {useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import {InMemoryContractRepository,InMemoryWalletRepository,RestArkProvider,RestIndexerProvider,SingleKey,type Activity,type PaymentHandle,type PaymentRequest,type Wallet} from '@arkade-os/sdk';
import type {Outcome} from '@arkade-os/swap';
import {bytesToHex} from '@noble/hashes/utils.js';
import {assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {deriveWalletKeyMaterial,recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {IndexedDBShieldedNoteRepository} from '../../src/shielded/repository.ts';
import type {StepState} from '../../src/shielded/handle.ts';
import {LNURL_BASE} from '../../src/shielded/lightning.ts';
import {IndexedDbLightningRepository} from '../../src/shielded/lightning-repository.ts';
import {createLightningWallet,createPrivateLightning,lightningOwner} from '../../src/shielded/lightning-wallet.ts';
import {createHdLnurl} from '../../src/shielded/lnurl-hd.ts';
import {idle} from '../../src/shielded/sync.ts';
import {SHIELD_FLOOR_MS,ShieldedWallet} from '../../src/shielded/wallet.ts';
import {DUST,bornAtFor,poolApiOf,rollupApi,type ArkCoin,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import {birthCheckpoint} from '../../src/shielded/checkpoint.ts';
import {arkAssetHoldings,claimTokenError,claimUrl,holdingsText,invoiceCarriesAmount,isInvoice,listingBlocked,routeCopy,sheetLine} from './rollup-client.ts';
import {browserProver,prefetchProvingKeys} from './shielded-prover.ts';
import {BORN,CREATED,SECRET,activityReceived,disposeAfterPageReads,errorText,importLegacySent,openPageWallet,pageCache,pageRefresh,pageQuoteFunds,pageQuotes,pageSheet,renewPageCoins,restorePageWallet,retryPageRead} from './shielded-page.ts';
import {CopyButton} from './components.tsx';
import {LightningRecoveryQuote} from './lightning-recovery.tsx';

const BACKED_UP='shielded-rollup-wallet-backed-up-v1';
const EXPLORER='https://explorer.mutinynet.arkade.sh';
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unknown';
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
const TxLink=({txid,path='tx'}:{txid:string;path?:string})=><a className="stock-txlink" href={`${EXPLORER}/${path}/${txid}`} target="_blank" rel="noreferrer">{short(txid)} ↗</a>;
// The resolver's kinds, mapped onto the swatches the history list already has.
const SWATCH:Record<string,string>={shield:'shield',unshield:'withdraw','shielded-send':'send','shielded-receive':'receive','lightning-receive':'receive',merge:'merge',list:'arkade','claim-link':'send'};
const LIGHTNING_STATUS:Record<string,string>={received:'Received; waiting to shield',shielding:'Received; shielding',shielded:'Shielded in the pool',retrying:'Received; shielding will retry','below-minimum':'Received outside the pool; below the shielding minimum','onchain-recovery':'Onchain recovery; shielding paused','onchain-recovered':'Recovered onchain'};
const WHERE:Record<string,string>={
 shield:'From your Arkade coins into the pool; the amount is public.',
 unshield:'Out of the pool to an Arkade address; the amount is public.',
 'shielded-send':'Inside the pool; amount and parties stay private.',
 'shielded-receive':'Inside the pool; amount and sender stay private.',
 'lightning-receive':'The Lightning payout is public until it enters the pool.',
 'claim-link':'Inside the pool: into a claim link. Whoever claims it gets the amount, privately.',
 merge:'Inside the pool: your own notes, merged into one. Nothing left the wallet.',
 list:'To the pool, listing this asset so anyone can shield it.',
};
const whereOf=(kind:string|undefined,received:boolean)=>(kind?WHERE[kind]:undefined)??(received?'Into your Arkade address, outside the pool.':'From your Arkade address, outside the pool.');
type Invoice={id:string;bolt11:string;outcome:Outcome;pays:bigint;fee:bigint;failure?:string};
const INVOICE:Partial<Record<Outcome,string>>={funding:'Paid. Claiming the sats.',funded:'Paid. Claiming the sats.',claimed:'Received. The sats move into the pool shortly.',lapsed:'It expired unpaid.'};
const invoiceLine=(i:Invoice)=>i.outcome==='accepted'||i.outcome==='open'?`Waiting for a payment of ${sats(i.pays)} sats, of which the swap keeps ${sats(i.fee)}.`
 :INVOICE[i.outcome]??`The swap ${i.outcome==='needs_recovery'?'needs recovery':'failed'}${i.failure?`: ${i.failure}`:'.'}`;
const LINK_STATE={unclaimed:'Unclaimed',claimed:'Claimed','taken-back':'Taken back'} as const;
type ClaimView={notes:{asset:bigint;amount:bigint}[];mine:boolean}|{error:string};
export default function RollupWallet(){
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [startupError,setStartupError]=useState(''),[refreshError,setRefreshError]=useState('');
 const [initialPool,setInitialPool]=useState<RollupPoolStatus>();
 const [secret,setSecret]=useState(()=>localStorage.getItem(SECRET)??''),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [wallet,setWallet]=useState<ShieldedWallet>(),[tick,setTick]=useState(0);
 const [coins,setCoins]=useState<ArkCoin[]>([]),[arkAvailable,setArkAvailable]=useState<number>(),[arkAddress,setArkAddress]=useState(''),[rows,setRows]=useState<Activity[]>([]);
 const [sheet,setSheet]=useState<StepState>(),[busy,setBusy]=useState(false),[revealed,setRevealed]=useState<Record<string,string>>({});
 const [tab,setTab]=useState<'receive'|'send'>('receive'),[assetId,setAssetId]=useState(''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[withSats,setWithSats]=useState('');
 const [listed,setListed]=useState(''),[restoreError,setRestoreError]=useState(''),[showView,setShowView]=useState(false),[showFull,setShowFull]=useState(false),[restoreDate,setRestoreDate]=useState('');
 const [invoice,setInvoice]=useState<Invoice>(),[lnAmount,setLnAmount]=useState(''),[lnAddress,setLnAddress]=useState(''),[lnBusy,setLnBusy]=useState(false),[lnError,setLnError]=useState('');
 const [claim,setClaim]=useState(()=>location.pathname.replace(/\/+$/,'')==='/claim'?location.hash.slice(1):''),[claimView,setClaimView]=useState<ClaimView>(),[claimRead,setClaimRead]=useState(0),[minted,setMinted]=useState('');
 const lnurlRef=useRef<ReturnType<typeof createHdLnurl>|undefined>(undefined);
 const [,setQuoteRevision]=useState(0);
 const quoteRef=useRef<ReturnType<typeof pageQuotes>|undefined>(undefined);
 const fundsRef=useRef<{wallet:ShieldedWallet;watch:ReturnType<typeof pageQuoteFunds>}|undefined>(undefined);
 if(!quoteRef.current)quoteRef.current=pageQuotes(()=>setQuoteRevision(v=>v+1));
 const quotes=quoteRef.current;
 const poolRef=useRef<RollupPoolStatus|undefined>(undefined);
 const busyRef=useRef(false),restoring=useRef(false),mounted=useRef(false);
 const cacheRef=useRef<ReturnType<typeof pageCache>|undefined>(undefined),sheetRef=useRef<ReturnType<typeof pageSheet>|undefined>(undefined);
 const sessions=useRef(new Set<()=>Promise<void>>());
 const refreshRef=useRef<{request:()=>void}|undefined>(undefined);
 const refreshes=useRef(new WeakMap<object,{close:()=>Promise<void>}>());
 if(!cacheRef.current)cacheRef.current=pageCache(new IndexedDBShieldedNoteRepository());
 if(!sheetRef.current)sheetRef.current=pageSheet(setSheet);
 const sheetOwner=sheetRef.current;

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sheetOwner.stop();quotes.clear();};},[]);

 useEffect(()=>{if(!secret){const fresh=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));localStorage.setItem(SECRET,fresh);localStorage.setItem(BORN,'new');localStorage.setItem(CREATED,String(Date.now()));setSecret(fresh);}},[secret]);
 // The wallet needs the pool phase, network and token before creation.
 useEffect(()=>{
  const controller=new AbortController();
  void retryPageRead(()=>rollupApi<RollupPoolStatus>('/status'),controller.signal,{onError:error=>{if(!restoring.current)setStartupError(errorText(error));}})
   .then(status=>{if(status&&!controller.signal.aborted&&!restoring.current){poolRef.current=status;setPool(status);if(status.phase==='ready')setInitialPool(status);setStartupError('');}}).catch(()=>{});
  return()=>controller.abort();
 },[]);

 /** Any handle, shielded or plain, rendered through one sheet. */
 const run=async(start:()=>Promise<PaymentHandle|undefined>,title:string)=>{
  if(busyRef.current||restoring.current||!wallet)return false;
  busyRef.current=true;setBusy(true);
  let owner=sheetOwner.begin(title);
  try{
   const handle=await start();
   if(!handle)return false;
   if(!mounted.current||restoring.current)return false;
   owner=sheetOwner.watch(handle,title);
   await handle.settled({timeoutMs:30*60_000});
   if(mounted.current&&!restoring.current)setAmount('');
   return true;
  }catch(error){owner.fail(error);return false;}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);setTick(t=>t+1);}}
 };

 const listAsset=async(id:string)=>{
  if(busyRef.current||restoring.current||!wallet)return;
  busyRef.current=true;setBusy(true);
  try{await wallet.listAsset(id);if(mounted.current&&!restoring.current)setListed(id);}
  catch(error){if(mounted.current&&!restoring.current)setPoolError(errorText(error));}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);setTick(t=>t+1);}}
 };

 const renew=async()=>{
  if(busyRef.current||restoring.current||!wallet)return;
  busyRef.current=true;setBusy(true);quotes.clear();
  try{const txid=await renewPageCoins(()=>wallet.renew(),sheetOwner);if(!txid&&mounted.current&&!restoring.current)setPoolError('Nothing needed renewing.');}
  catch{}
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);fundsRef.current?.watch.update();setTick(t=>t+1);}}
 };

 const lightning=async(action:()=>Promise<void>)=>{
  if(!wallet?.swaps)return;
  setLnBusy(true);setLnError('');
  try{await action();}catch(error){if(mounted.current)setLnError(errorText(error));}
  finally{if(mounted.current)setLnBusy(false);}
 };
 const createInvoice=()=>lightning(async()=>{
  const r=await wallet!.swaps!.receive({via:'lightning',amount:BigInt(lnAmount)});
  if(mounted.current)setInvoice({id:r.id,bolt11:r.artifact.bolt11,outcome:r.outcome,pays:r.give.amount,fee:r.fee.amount});
 });
 const claimAddress=()=>lightning(async()=>{
  if(!lnurlRef.current)throw new Error('The wallet is still loading.');
  const r=await lnurlRef.current.claim();
  if(mounted.current)setLnAddress(r.lightningAddress??r.lnurl);
 });
 const recoverAddress=()=>lightning(async()=>{
  if(!lnurlRef.current)throw new Error('The wallet is still loading.');
  const receivers=await lnurlRef.current.recover({explicit:true}),receiver=receivers[0];
  if(mounted.current){setLnAddress(receiver?.lightningAddress??receiver?.lnurl??'');if(!receiver)setLnError('No Lightning address was found for this recovery phrase.');}
 });

 const restoreWallet=async()=>{
  if(busyRef.current)return;
  try{
   const at=restoreDate?Date.parse(restoreDate):NaN,token=poolRef.current?.pool?.token;
   const born=Number.isFinite(at)&&token?{token,at,batches:await birthCheckpoint(poolApiOf(''),at)}:undefined;
   await restorePageWallet(restore,{cache:cacheRef.current!,storage:localStorage,reload:()=>location.reload(),...(born?{born}:{}),stop:async()=>{
    restoring.current=true;busyRef.current=true;quotes.clear();setBusy(true);setRestoreError('');sheetOwner.stop();
    await Promise.all([...sessions.current].map(close=>close()));setWallet(undefined);
   }});
  }catch(error){if(mounted.current)setRestoreError(errorText(error));}
  finally{if(mounted.current){busyRef.current=false;setBusy(false);}}
 };

 useEffect(()=>{
  if(!initialPool||!secret||restoring.current)return;
  const status=initialPool,network=status.network;
  let journal:IndexedDbLightningRepository;
  let nativeOpened=false;
  let companion:Wallet|undefined,lnurl:ReturnType<typeof createHdLnurl>|undefined;
  const dispose=(created:ShieldedWallet)=>disposeAfterPageReads(created,refreshes.current,async()=>{
   try{await lnurl?.dispose();}finally{
    if(lnurlRef.current===lnurl)lnurlRef.current=undefined;
    try{await created.dispose();}finally{try{await companion?.dispose();}finally{await journal[Symbol.asyncDispose]();}}
   }
  });
  const session=openPageWallet(async()=>{
   const poseidon=await buildPoseidon(),hash:Hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
   return hash;
  },async hash=>{
   journal=new IndexedDbLightningRepository();companion=undefined;lnurl=undefined;
   let created:ShieldedWallet|undefined;
   try{
    const bornAt=bornAtFor(localStorage,BORN,{token:status.pool!.token,batches:status.pool!.batches});
    created=await ShieldedWallet.create({
     identity:SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret),
     arkProvider:new RestArkProvider(network.arkUrl),indexerProvider:new RestIndexerProvider(network.indexerUrl??network.arkUrl),
     storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
     settlementConfig:false,walletMode:'static',
     pool:{origin:'',status},secret,hash,prover:browserProver(()=>poolRef.current??status),
     shieldedRepository:cacheRef.current!.repository,bornAt,lightningSpendStore:journal,
    });
    nativeOpened=true;
    companion=await createLightningWallet(secret,{arkProvider:created.arkProvider,indexerProvider:created.indexerProvider,onchainProvider:created.onchainProvider});
    const swaps=await createPrivateLightning({wallet:created,companion,journal,onError:error=>{if(session.active()&&!restoring.current&&mounted.current)setLnError(errorText(error));}});created.swaps=swaps;
    lnurl=createHdLnurl({identity:created.identity,companion,journal,owner:await lightningOwner(companion),pool:status.pool!.token,baseUrl:LNURL_BASE,onAllocation:payout=>swaps.registerPayouts([payout])});
    return created;
   }catch(error){
    try{if(created)await dispose(created);else await journal[Symbol.asyncDispose]();}
    catch(cleanup){throw new Error('The previous wallet could not be closed. Reload before trying again.',{cause:cleanup});}
    throw error;
   }
  },dispose,{shouldRetry:()=>!nativeOpened,onError:error=>{if(session.active()&&!restoring.current&&mounted.current)setStartupError(errorText(error));}});
  let legacy=Promise.resolve(),closing:Promise<void>|undefined;
  const unwatch:(()=>void)[]=[],current=()=>session.active()&&!restoring.current&&mounted.current;
  const close=()=>{
   const closed=session.close();for(const off of unwatch.splice(0))off();sheetOwner.stop();
   return closing??=(async()=>{const owned=await closed;await legacy;if(owned)await idle(owned.account,()=>undefined);sessions.current.delete(close);})();
  };
  sessions.current.add(close);
  void session.ready.then(created=>{
   if(!created||!current())return;
   setStartupError('');
   const funds=pageQuoteFunds(()=>({token:created.pool.status.pool?.token,notes:created.mergeableAssets().flatMap(asset=>created.shieldedNotes(asset)),inFlight:created.inFlight}),()=>{quotes.clear();setQuoteRevision(v=>v+1);});
   fundsRef.current={wallet:created,watch:funds};
   unwatch.push(created.onShieldedChange(()=>{if(current()){funds.update();setTick(t=>t+1);}}));
   unwatch.push(created.onAction(handle=>{if(current()){funds.update();quotes.clear();sheetOwner.watch(handle,handle.title);}}));
   legacy=importLegacySent(created,localStorage,current).catch(error=>{if(current())setPoolError(errorText(error));});
   if(created.repositoryError)setPoolError(`Your saved notes could not be read, so the wallet is reading the pool again: ${created.repositoryError}`);
   unwatch.push(created.swaps!.onUpdate(({swap,outcome})=>{if(current())setInvoice(i=>i?.id===swap.id?{...i,outcome,...(swap.failure?{failure:swap.failure}:{})}:i);}));
   lnurlRef.current=lnurl;
   void lnurl!.current().then(owned=>{if(owned&&current())setLnAddress(owned.lightningAddress??owned.lnurl);}).catch(error=>{if(current())setLnError(errorText(error));});
   lnurl!.start(error=>{if(current())setLnError(errorText(error));});
   setWallet(created);
  }).catch(error=>{if(current())setStartupError(errorText(error));});
  return()=>{void close().catch(()=>{});};
 },[initialPool,secret]);

 // No page timer: the wallet's watcher stream and its 60 s watchdog are what move `tick`.
 useEffect(()=>{
  if(!wallet)return;
  const refresh=pageRefresh({coins:()=>wallet.coins(),balance:()=>wallet.getBalance(),address:()=>wallet.getAddress(),history:()=>wallet.getActivityHistory(),lightningHistory:async()=>wallet.swaps?.getActivityHistory()??[]},(data,errors)=>{
   if(restoring.current||!mounted.current)return;
   if(fundsRef.current?.wallet===wallet)fundsRef.current.watch.update(data.coins);
   if(data.coins)setCoins(data.coins);if(data.balance)setArkAvailable(data.balance.available);if(data.address!==undefined)setArkAddress(data.address);
   if(data.history||data.lightningHistory)setRows([...(data.history??[]),...(data.lightningHistory??[])].sort((a,b)=>b.createdAt-a.createdAt));
   setRefreshError(Object.values(errors).join(' '));setPool(wallet.pool.status);poolRef.current=wallet.pool.status;
   if(wallet.repositoryError)setPoolError(`Your saved notes could not be read or saved: ${wallet.repositoryError}`);
  });
  const close=async()=>{await refresh.close();sessions.current.delete(close);};
  refreshes.current.set(wallet,refresh);refreshRef.current=refresh;sessions.current.add(close);
  return()=>{if(refreshRef.current===refresh)refreshRef.current=undefined;void close();};
 },[wallet]);
 useEffect(()=>{refreshRef.current?.request();},[wallet,tick]);

 useEffect(()=>{if(tab==='send'&&pool)prefetchProvingKeys(pool);},[tab,pool]);
 const requestKey=JSON.stringify([tab,to,amount,assetId,withSats]);
 const quoteContext={wallet:wallet??quotes,revision:wallet&&fundsRef.current?.wallet===wallet?fundsRef.current.watch.revision:0,key:requestKey};
 const {quote,error:quoteError,pending:quoting}=quotes.read(quoteContext);
 useEffect(()=>{
  quotes.invalidate(quoteContext);
 },[wallet,requestKey,quoteContext.revision]);
 const getQuote=()=>{
  if(!wallet||tab!=='send'||!to.trim()||(!amount&&!isInvoice(to))||busyRef.current||restoring.current||quoting)return;
  const funds=fundsRef.current;if(funds?.wallet!==wallet)return;
  quotes.load({...quoteContext,revision:funds.watch.update()},()=>{
   const request:PaymentRequest={raw:to.trim(),...(assetId?{amount:Number(withSats||DUST),assets:[{assetId,amount:BigInt(amount)}]}:amount&&!invoiceCarriesAmount(to)?{amount:Number(amount)}:{})};
   return wallet.router().route(request);
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

 const reserves=Object.keys(pool?.pool?.reserves??{}),address=wallet?.shieldedAddress()??'',listingFull=listingBlocked(pool?.pool);
 const synced=!!wallet,balance=wallet?.shieldedBalance()??0n;
 const assetUnits=(id:string)=>wallet?.shieldedBalance(assetFieldOfId(id))??0n;
 const paidOut=coins.filter(c=>wallet?.isPoolPayout(c)&&!c.assets?.length),paidOutSats=paidOut.reduce((sum,c)=>sum+c.value,0);
 const expiring=coins.filter(c=>!wallet?.isPoolPayout(c)&&!c.assets?.length&&c.expiresAt!==undefined&&c.expiresAt-Date.now()<=SHIELD_FLOOR_MS).reduce((sum,c)=>sum+c.value,0);
 const ready=pool?.phase==='ready',unit=assetId?'units':'sats';
 const maxSend=wallet?wallet.maxPrivatePayment(assetId?assetFieldOfId(assetId):0n):0n;
 const inFlight=!!wallet&&[...wallet.shieldedNotes(),...reserves.flatMap(id=>wallet.shieldedNotes(assetFieldOfId(id)))].some(note=>wallet.inFlight.has(note.nullifier));
 const phrase=secret?recoveryPhraseOf(secret):'',created=Number(localStorage.getItem(CREATED))||0;
 const assetName=(id:string)=>`asset ${short(id)}`;
 const revealFor=(item:Activity)=>{
  const link=wallet?.revealLinkOfActivity(item);
  if(!link)return null;
  return <><dt>Reveal</dt><dd>{revealed[item.id]
   ?<><Copyable value={revealed[item.id]!}/><p className="stock-muted">Anyone with this link can check this payment&apos;s amount and recipient against the pool, and learns nothing else.</p></>
   :<button type="button" className="stock-ghost stock-mini" onClick={()=>setRevealed(r=>({...r,[item.id]:link}))}>Create a reveal link</button>}</dd></>;
 };

 const submit=()=>{if(quote)void run(async()=>{
  const funds=fundsRef.current;if(!funds||funds.wallet!==wallet)throw new Error('The wallet changed. Review its route again.');
  const currentCoins=await wallet!.coins();
  if(!mounted.current||restoring.current||fundsRef.current!==funds)throw new Error('The wallet changed. Review its route again.');
  return quotes.send({...quoteContext,revision:funds.watch.update(currentCoins)},quote);
 },routeCopy(quote.railId).title);else getQuote();};

 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>Wallet</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test pool</strong><span>Test funds only, with development-only proving keys. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</span></section>
  {pool?.pool?.notice&&<section className="stock-warning"><strong>The pool is waiting</strong><span>{pool.pool.notice}</span></section>}
  {wallet?.operatorDown&&<section className="stock-warning" role="alert"><strong>The pool operator is not answering</strong><span>Your notes are safe, but only the operator renews the pool. If it stays down, the pool head and every payout from it expire {wallet.operatorDown.headExpiresAt?`on ${when(wallet.operatorDown.headExpiresAt)}`:'within a week of its last renewal'}. To withdraw without the operator, see <a href="https://github.com/arkade-os/shielded#if-the-operator-stops">If the operator stops</a>.</span></section>}
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
   <section className="stock-card stock-balance">
    <div><small>SHIELDED BALANCE{!synced&&' · SYNCING'}</small><strong>{sats(balance)} <em>sats</em></strong></div>
    <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{arkAvailable===undefined?'Loading…':`${sats(arkAvailable)} sats`}</b></div><div><small>POOL</small><b>{wallet?.batchCount()??0} batches</b></div>
     {reserves.filter(id=>assetUnits(id)>0n).map(id=><div key={id}><small>ASSET {short(id)}</small><b>{sats(assetUnits(id))} units</b></div>)}</div>
    {inFlight&&<p className="stock-muted">Notes are in flight; they come back as spendable notes once the batch lands.</p>}
    {poolError&&<p className="stock-blocked">{poolError}</p>}
    {startupError&&<p className="stock-blocked">{startupError}</p>}
    {refreshError&&<p className="stock-blocked">{refreshError}</p>}
   </section>
   {sheet&&<section className={'stock-card stock-activity'+(sheet.done?' finished':sheet.error?' failed':'')}><div className="stock-activity-head"><h2>{sheet.title}</h2></div>
    <ol className="stock-steps">{sheet.steps.map((label,i)=><li key={label} className={sheet.error&&i===sheet.current?'error':i<sheet.current||sheet.done?'done':i===sheet.current?'active':''}><i/>{label}</li>)}</ol>
    {sheet.error&&<p className="stock-blocked">{sheet.error}{sheet.title.startsWith('Shielding')&&' It tries again in a minute.'}</p>}
   </section>}
   {sheet&&<div className={'stock-sheet'+(sheet.error?' failed':sheet.done?' finished':'')} role="status" aria-live="polite" aria-atomic="true">
    <b>{sheet.title}</b><span>{sheetLine(sheet)}</span>
    {!sheet.done&&!sheet.error&&<div className="stock-progress"><div><span style={{width:`${Math.round(100*(sheet.current+1)/sheet.steps.length)}%`}}/></div></div>}
    {(sheet.error||sheet.done)&&<button className="stock-ghost stock-mini" onClick={()=>sheetOwner.clear()}>Dismiss</button>}
   </div>}
   <section className="stock-card stock-panel">
    <div className="stock-tabs" role="tablist">{(['receive','send'] as const).map(name=><button key={name} role="tab" aria-selected={tab===name} className={tab===name?'selected':''} onClick={()=>{setTab(name);setTo('');}}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</div>
    {tab==='receive'?<div className="stock-receive">
     <div className="stock-address"><small>SHIELDED ADDRESS</small>{address?<Copyable value={address}/>:<code>Deriving…</code>}<p className="stock-muted">Share this to receive private payments inside the pool.</p></div>
     <div className="stock-address"><small>ARKADE ADDRESS · FUNDING</small>{arkAddress?<Copyable value={arkAddress}/>:<code>Loading…</code>}<p className="stock-muted">Sats sent here move into the pool on their own; keep this page open until they do.{expiring>0&&` ${sats(expiring)} sats expire within a day, so the pool will not take them.`} Need test sats? The <a href="https://faucet.mutinynet.com" target="_blank" rel="noreferrer">Mutinynet faucet</a> sends Arkade sats to this address after a GitHub sign-in.</p>{expiring>0&&<button className="stock-ghost stock-mini" disabled={busy||restoring.current||!wallet} onClick={()=>void renew()}>Renew</button>}</div>
     <div className="stock-address"><small>LIGHTNING</small>
      {lnAddress?<Copyable value={lnAddress}/>:<div className="stock-actions"><button className="stock-ghost stock-mini" disabled={lnBusy||!wallet} onClick={()=>void claimAddress()}>Get a Lightning address</button><button className="stock-ghost stock-mini" disabled={lnBusy||!wallet} onClick={()=>void recoverAddress()}>Recover a Lightning address</button></div>}
      <form className="stock-amount" onSubmit={e=>{e.preventDefault();void createInvoice();}}><input inputMode="numeric" aria-label="Invoice amount in sats" placeholder="Sats" value={lnAmount} onChange={e=>setLnAmount(e.target.value.replace(/\D/g,''))}/><button className="stock-ghost stock-mini" disabled={lnBusy||!wallet||!lnAmount}>Create invoice</button></form>
      {invoice&&<><Copyable value={invoice.bolt11}/><p className="stock-muted">{invoiceLine(invoice)}</p></>}
      {lnError&&<p className="stock-blocked">{lnError}</p>}
      <p className="stock-muted">Each Lightning payment uses a fresh Arkade payout address. Payouts of at least {DUST} sats move into the pool while this page is open; smaller payouts stay outside and are never combined automatically. Your Lightning address stays the same and accepts payments while closed. Its service knows which payouts belong to the alias; payers see a fresh address for each request.</p></div>
     {paidOutSats>=DUST&&<div className="stock-address"><small>BACK ON ARKADE FROM THE POOL</small><b>{sats(paidOutSats)} sats</b><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void run(()=>wallet!.shield(paidOut),'Shielding again')}>Shield again</button></div>}
     {arkAssetHoldings(coins,c=>!!wallet?.isPoolPayout(c)).map(a=><div key={a.assetId+':'+a.payout} className="stock-address"><small>{a.payout?'BACK ON ARKADE FROM THE POOL':'ARKADE ASSET'} {short(a.assetId)}</small><b>{sats(a.units)} units</b>
      {a.payout?<><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void run(()=>wallet!.shield(a.coins),'Shielding again')}>Shield again</button></>
       :reserves.includes(a.assetId)?<p className="stock-muted">Listed in the pool, so it moves in on its own.</p>
       :listingFull?<p className="stock-blocked">{listingFull}</p>
       :listed===a.assetId?<p className="stock-muted">Listing sent; the pool registers it within a minute.</p>
       :<><p className="stock-muted">Not in the pool yet. Listing it sends 1 unit and {DUST} sats to the pool, after which anyone can shield it.</p><button className="stock-ghost stock-mini" disabled={busy||restoring.current||!wallet} onClick={()=>void listAsset(a.assetId)}>List in the pool</button></>}</div>)}
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();submit();}}>
     {reserves.length>0&&<label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">Bitcoin</option>{reserves.map(id=><option key={id} value={id}>Asset {short(id)}</option>)}</select></label>}
     <label>To<input value={to} onChange={e=>setTo(e.target.value)} placeholder="shrol21…, tark1…, a Lightning invoice or address" autoComplete="off" spellCheck={false}/></label>
     <label>Amount ({unit})<input inputMode="numeric" value={amount} placeholder={invoiceCarriesAmount(to)?'From the invoice':undefined} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     {assetId&&to.trim()&&<label>Sats with it<input inputMode="numeric" value={withSats} placeholder={String(DUST)} onChange={e=>setWithSats(e.target.value.replace(/\D/g,''))}/></label>}
     <p className="stock-muted">A shielded address pays privately from up to three of your notes, up to {sats(maxSend)} {unit}. An Arkade address leaves the pool, and the amount and destination become public. Lightning funds its swap directly from one pool note. Leave To empty to create a claim link instead: whoever opens it first gets the amount.</p>
     {to.trim()&&<p className="stock-muted">Get quote contacts the payment service for Lightning invoices and addresses. It shares the invoice or address and amount; payment happens after you confirm the quote.</p>}
     {quote&&<div className="stock-route"><b>{routeCopy(quote.railId).title}</b><span className="stock-muted">{routeCopy(quote.railId).detail}</span>
      {quote.fee>0&&<small>Fee {sats(quote.fee)} sats · total {sats(quote.total)} sats</small>}</div>}
     {quoteError&&<p className="stock-blocked">{quoteError}</p>}
     <button className="stock-primary" disabled={busy||restoring.current||!synced||quoting||!to.trim()||(!amount&&!isInvoice(to))}>{busy?'Working…':quoting?'Getting quote…':quote?routeCopy(quote.railId).title:'Get quote'}</button>
     {!to.trim()&&<button type="button" className="stock-ghost" disabled={busy||restoring.current||!synced||!amount} onClick={()=>void mintLink()}>Create a claim link</button>}
     {mintedLink?.state==='unclaimed'&&<div className="stock-address"><small>CLAIM LINK</small><Copyable value={claimUrl(location.origin,minted)}/>
      {typeof navigator.share==='function'&&<button type="button" className="stock-ghost stock-mini" onClick={()=>void navigator.share({url:claimUrl(location.origin,minted)}).catch(()=>{})}>Share</button>}
      <p className="stock-muted">Anyone with this link can claim it until it is claimed; you can take it back before then.</p></div>}
    </form>}
   </section>
   <section className="stock-card stock-history"><h2>History</h2>
    {!rows.length?<p className="stock-muted">{synced?'Nothing yet. Fund your Arkade address and it shows up here.':'Reading the pool…'}</p>:<ul>{rows.map(item=>{
     const kind=item.intent?.kind,received=activityReceived(item),newest=item.txs[item.txs.length-1]!;
     const label=item.intent?.label??(received?'Arkade funding':'Arkade payment');
     const status=kind==='lightning-receive'?LIGHTNING_STATUS[item.intent?.outcome??'received']:item.settled?'Settled':'Preconfirmed';
     const id=newest.key.arkTxid||newest.key.commitmentTxid,asset=newest.assets?.[0];
     return <li key={item.id}><details><summary><span className={'stock-kind '+(kind?SWATCH[kind]??'arkade':'arkade')}>{label}{kind==='lightning-receive'&&<> · {status}</>}</span>
       <b className={received?'in':'out'}>{received?'+':'−'}{asset?`${sats(asset.amount)} units of ${assetName(asset.assetId)}`:`${sats(Math.abs(item.amount))} sats`}</b><time>{when(item.createdAt)}</time></summary>
      <dl>
       <dt>Where</dt><dd>{whereOf(kind,received)}</dd>
       {typeof item.intent?.metadata?.batch==='number'&&<><dt>Batch</dt><dd>#{String(item.intent.metadata.batch)}</dd></>}
       {id&&<><dt>Transaction</dt><dd><TxLink txid={id} path={newest.key.arkTxid?'tx':'commitment-tx'}/></dd></>}
       <dt>Status</dt><dd>{status}</dd>
       {kind==='lightning-receive'&&item.intent?.outcome!=='shielded'&&wallet?.swaps&&typeof item.intent?.metadata?.outpoint==='string'&&<LightningRecoveryQuote service={wallet.swaps} outpoint={item.intent.metadata.outpoint} disabled={busy||restoring.current}/>}
       {revealFor(item)}
      </dl></details></li>;
    })}</ul>}
   </section>
   {links.length>0&&<section className="stock-card"><h2>Your claim links</h2><div className="stock-notes">
    {links.map(link=><div key={link.key}><span>{holdingsText([{asset:BigInt(link.asset),amount:BigInt(link.amount)}],field=>wallet?.assetIdOf(field))}</span><span className={link.state==='unclaimed'?'wait':'ok'}>{LINK_STATE[link.state]}</span>
     {link.state==='unclaimed'&&<div className="stock-actions"><CopyButton value={claimUrl(location.origin,link.token)} label="Copy link"/><button className="stock-ghost stock-mini" disabled={busy||restoring.current} onClick={()=>void run(()=>wallet!.claimLink(link.token),'Taking back a link').then(()=>setClaimRead(n=>n+1))}>Take back</button></div>}</div>)}
   </div></section>}
   {((wallet?.shieldedNotes().length??0)>0||reserves.some(id=>assetUnits(id)>0n))&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">
    {(wallet?.shieldedNotes()??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span>{wallet!.inFlight.has(n.nullifier)?<span className="wait">In flight</span>:<span className="ok">Spendable</span>}</div>)}
    {reserves.flatMap(id=>(wallet?.shieldedNotes(assetFieldOfId(id))??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} units</span><span className={wallet!.inFlight.has(n.nullifier)?'wait':'ok'}>{wallet!.inFlight.has(n.nullifier)?'In flight':`Asset ${short(id)}`}</span></div>))}
   </div></section>}
  </>}
  {!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery phrase</h2><p className="stock-muted">These 24 words restore your pool notes and derive your Arkade keys. Anyone who has them can spend your funds. Keep this browser&apos;s data until pending Lightning swaps and their payouts have finished: the phrase alone does not restore every outstanding swap.</p>{reveal&&<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show phrase</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <details className="stock-card stock-advanced"><summary>Recovery phrase and restore</summary>
   <p className="stock-muted">Keep this browser&apos;s data while Lightning swaps or payouts are pending. A fresh browser recovers a Lightning alias through Recover a Lightning address; direct swaps also need their stored recovery records.</p>
   {backedUp&&secret&&(reveal?<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>:<button className="stock-ghost" onClick={()=>setReveal(true)}>Show recovery phrase</button>)}
   {wallet&&<div className="stock-address"><small>VIEW KEY · READ ONLY</small>{showView?<><Copyable value={wallet.viewKey()}/><p className="stock-muted">Shows every payment this wallet receives, for an auditor or a second device. It cannot spend and cannot see which notes were spent. <a className="stock-txlink" href={`/watch#${wallet.viewKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowView(true)}>Show view key</button>}</div>}
   {wallet&&<div className="stock-address"><small>FULL VIEWING KEY · SEES SPENDS</small>{showFull?<><Copyable value={wallet.fullViewingKey()}/><p className="stock-muted">Shows every note this wallet received and which ones it spent, so also how much each payment out sent, forever. It cannot spend and cannot freeze your notes. <a className="stock-txlink" href={`/watch#${wallet.fullViewingKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowFull(true)}>Show full viewing key</button>}</div>}
   {secret&&created&&<p className="stock-muted">Created {new Date(created).toLocaleDateString()}. Keep the date with the words: a restore that has it skips the pool's older history.</p>}
   <label>Restore from a recovery phrase<textarea rows={3} value={restore} onChange={e=>setRestore(e.target.value)} autoComplete="off" spellCheck={false} placeholder="24 words (older wallets: 64 hex characters)"/></label>
   <label>Created on, if you know it (any earlier date also works)<input type="date" value={restoreDate} onChange={e=>setRestoreDate(e.target.value)}/></label>
   <button disabled={busy||!restore.trim()} onClick={()=>void restoreWallet()}>Restore wallet</button>
   {restoreError&&<p className="stock-blocked">{restoreError}</p>}
   {restoreError&&restoring.current&&<button type="button" className="stock-ghost stock-mini" onClick={()=>location.reload()}>Reload wallet</button>}
  </details>
 </main></div>;
}
