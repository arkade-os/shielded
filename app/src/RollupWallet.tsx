import {useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import {InMemoryContractRepository,InMemoryWalletRepository,RestArkProvider,RestIndexerProvider,SingleKey,type Activity,type PaymentHandle,type PaymentRequest} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {deriveWalletKeyMaterial,recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {IndexedDBShieldedNoteRepository} from '../../src/shielded/repository.ts';
import type {StepState} from '../../src/shielded/handle.ts';
import {idle} from '../../src/shielded/sync.ts';
import {SHIELD_FLOOR_MS,ShieldedWallet} from '../../src/shielded/wallet.ts';
import {DUST,bornAtFor,rollupApi,type ArkCoin,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import {arkAssetHoldings,routeCopy,sheetLine} from './rollup-client.ts';
import {browserProver} from './shielded-prover.ts';
import {BORN,SECRET,activityReceived,errorText,importLegacySent,openPageWallet,pageCache,pageQuotes,pageSheet,renewPageCoins,restorePageWallet} from './shielded-page.ts';
import {CopyButton} from './components.tsx';

const BACKED_UP='shielded-rollup-wallet-backed-up-v1';
const EXPLORER='https://explorer.mutinynet.arkade.sh';
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unknown';
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
const TxLink=({txid,path='tx'}:{txid:string;path?:string})=><a className="stock-txlink" href={`${EXPLORER}/${path}/${txid}`} target="_blank" rel="noreferrer">{short(txid)} ↗</a>;
// The resolver's kinds, mapped onto the swatches the history list already has.
const SWATCH:Record<string,string>={shield:'shield',unshield:'withdraw','shielded-send':'send','shielded-receive':'receive',merge:'merge',list:'arkade'};
const WHERE:Record<string,string>={
 shield:'From your Arkade coins into the pool; the amount is public.',
 unshield:'Out of the pool to an Arkade address; the amount is public.',
 'shielded-send':'Inside the pool; amount and parties stay private.',
 'shielded-receive':'Inside the pool; amount and sender stay private.',
 merge:'Inside the pool: your own notes, merged into one. Nothing left the wallet.',
 list:'To the pool, listing this asset so anyone can shield it.',
};
const whereOf=(kind:string|undefined,received:boolean)=>(kind?WHERE[kind]:undefined)??(received?'Into your Arkade address, outside the pool.':'From your Arkade address, outside the pool.');
export default function RollupWallet(){
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [initialPool,setInitialPool]=useState<RollupPoolStatus>();
 const [secret,setSecret]=useState(()=>localStorage.getItem(SECRET)??''),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [wallet,setWallet]=useState<ShieldedWallet>(),[tick,setTick]=useState(0);
 const [coins,setCoins]=useState<ArkCoin[]>([]),[arkAvailable,setArkAvailable]=useState<number>(),[arkAddress,setArkAddress]=useState(''),[rows,setRows]=useState<Activity[]>([]);
 const [sheet,setSheet]=useState<StepState>(),[busy,setBusy]=useState(false);
 const [tab,setTab]=useState<'receive'|'send'>('receive'),[assetId,setAssetId]=useState(''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[withSats,setWithSats]=useState('');
 const [listed,setListed]=useState(''),[restoreError,setRestoreError]=useState(''),[showView,setShowView]=useState(false),[showFull,setShowFull]=useState(false);
 const [,setQuoteRevision]=useState(0);
 const quoteRef=useRef<ReturnType<typeof pageQuotes>|undefined>(undefined),fundsRevision=useRef(0);
 if(!quoteRef.current)quoteRef.current=pageQuotes(()=>setQuoteRevision(v=>v+1));
 const quotes=quoteRef.current;
 const poolRef=useRef<RollupPoolStatus|undefined>(undefined);
 const busyRef=useRef(false),restoring=useRef(false),mounted=useRef(false);
 const cacheRef=useRef<ReturnType<typeof pageCache>|undefined>(undefined),sheetRef=useRef<ReturnType<typeof pageSheet>|undefined>(undefined);
 const sessions=useRef(new Set<()=>Promise<void>>());
 if(!cacheRef.current)cacheRef.current=pageCache(new IndexedDBShieldedNoteRepository());
 if(!sheetRef.current)sheetRef.current=pageSheet(setSheet);
 const sheetOwner=sheetRef.current;

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sheetOwner.stop();quotes.clear();};},[]);

 useEffect(()=>{if(!secret){const fresh=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));localStorage.setItem(SECRET,fresh);localStorage.setItem(BORN,'new');setSecret(fresh);}},[secret]);
 // One read before the wallet exists: it needs the pool phase, network and token to be created at all.
 useEffect(()=>{
  let stop=false;
  void (async()=>{try{const status=await rollupApi<RollupPoolStatus>('/status');if(!stop&&!restoring.current){poolRef.current=status;setPool(status);if(status.phase==='ready')setInitialPool(status);setPoolError('');}}catch(error){if(!stop)setPoolError(errorText(error));}})();
  return()=>{stop=true;};
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
  finally{if(mounted.current&&!restoring.current){busyRef.current=false;setBusy(false);fundsRevision.current++;setTick(t=>t+1);}}
 };

 const restoreWallet=async()=>{
  if(busyRef.current)return;
  try{
   await restorePageWallet(restore,{cache:cacheRef.current!,storage:localStorage,reload:()=>location.reload(),stop:async()=>{
    restoring.current=true;busyRef.current=true;quotes.clear();setBusy(true);setRestoreError('');sheetOwner.stop();
    await Promise.all([...sessions.current].map(close=>close()));setWallet(undefined);
   }});
  }catch(error){if(mounted.current)setRestoreError(errorText(error));}
  finally{if(mounted.current){busyRef.current=false;setBusy(false);}}
 };

 useEffect(()=>{
  if(!initialPool||!secret||restoring.current)return;
  const status=initialPool,network=status.network;
  const session=openPageWallet(async()=>{
   const poseidon=await buildPoseidon(),hash:Hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
   return hash;
  },async hash=>{
   const bornAt=bornAtFor(localStorage,BORN,{token:status.pool!.token,batches:status.pool!.batches});
   return ShieldedWallet.create({
    identity:SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret),
    arkProvider:new RestArkProvider(network.arkUrl),indexerProvider:new RestIndexerProvider(network.indexerUrl??network.arkUrl),
    storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
    settlementConfig:false,walletMode:'static',
    pool:{origin:'',status},secret,hash,prover:browserProver(()=>poolRef.current??status),
    shieldedRepository:cacheRef.current!.repository,bornAt,
   });
  });
  let legacy=Promise.resolve(),closing:Promise<void>|undefined;
  const unwatch:(()=>void)[]=[],current=()=>session.active()&&!restoring.current&&mounted.current;
  const close=()=>{
   const closed=session.close();for(const off of unwatch.splice(0))off();sheetOwner.stop();
   return closing??=(async()=>{const owned=await closed;await legacy;if(owned)await idle(owned.account,()=>undefined);sessions.current.delete(close);})();
  };
  sessions.current.add(close);
  void session.ready.then(created=>{
   if(!created||!current())return;
   unwatch.push(created.onShieldedChange(()=>{if(current()){fundsRevision.current++;quotes.clear();setTick(t=>t+1);}}));
   unwatch.push(created.onAction(handle=>{if(current())sheetOwner.watch(handle,handle.title);}));
   legacy=importLegacySent(created,localStorage,current).catch(error=>{if(current())setPoolError(errorText(error));});
   if(created.repositoryError)setPoolError(`Your saved notes could not be read, so the wallet is reading the pool again: ${created.repositoryError}`);
   setWallet(created);
  }).catch(error=>{if(current())setPoolError(errorText(error));});
  return()=>{void close().catch(()=>{});};
 },[initialPool,secret]);

 // No page timer: the wallet's watcher stream and its 60 s watchdog are what move `tick`.
 useEffect(()=>{
  if(!wallet)return;
  let stop=false;
  void (async()=>{
   try{
    const [list,balance,address,history]=await Promise.all([wallet.coins(),wallet.getBalance(),wallet.getAddress(),wallet.getActivityHistory()]);
    if(!stop&&!restoring.current){setCoins(list);setArkAvailable(balance.available);setArkAddress(address);setRows(history);setPool(wallet.pool.status);poolRef.current=wallet.pool.status;
     if(wallet.repositoryError)setPoolError(`Your saved notes could not be read or saved: ${wallet.repositoryError}`);}
   }catch(error){if(!stop&&!restoring.current)setPoolError(errorText(error));}
  })();
  return()=>{stop=true;};
 },[wallet,tick]);

 const requestKey=JSON.stringify([tab,to,amount,assetId,withSats,tick]);
 const quoteContext={wallet:wallet??quotes,revision:fundsRevision.current,key:requestKey};
 const {quote,error:quoteError}=quotes.read(quoteContext);
 useEffect(()=>{
  if(!wallet||tab!=='send'||!to.trim()||!amount||busyRef.current||restoring.current){quotes.clear();return;}
  return quotes.load(quoteContext,()=>{
   const request:PaymentRequest={raw:to.trim(),amount:assetId?Number(withSats||DUST):Number(amount),...(assetId?{assets:[{assetId,amount:BigInt(amount)}]}:{})};
   return wallet.router().route(request);
  });
 },[wallet,requestKey,tick,busy]);

 const reserves=Object.keys(pool?.pool?.reserves??{}),address=wallet?.shieldedAddress()??'';
 const synced=!!wallet,balance=wallet?.shieldedBalance()??0n;
 const assetUnits=(id:string)=>wallet?.shieldedBalance(assetFieldOfId(id))??0n;
 const paidOut=coins.filter(c=>wallet?.isPoolPayout(c)&&!c.assets?.length),paidOutSats=paidOut.reduce((sum,c)=>sum+c.value,0);
 const expiring=coins.filter(c=>!wallet?.isPoolPayout(c)&&!c.assets?.length&&c.expiresAt!==undefined&&c.expiresAt-Date.now()<=SHIELD_FLOOR_MS).reduce((sum,c)=>sum+c.value,0);
 const ready=pool?.phase==='ready',unit=assetId?'units':'sats';
 const maxSend=wallet?wallet.maxPrivatePayment(assetId?assetFieldOfId(assetId):0n):0n;
 const inFlight=(wallet?.inFlight.size??0)>0;
 const phrase=secret?recoveryPhraseOf(secret):'';
 const assetName=(id:string)=>`asset ${short(id)}`;

 const submit=()=>{if(quote)void run(()=>quotes.send({...quoteContext,revision:fundsRevision.current},quote),routeCopy(quote.railId).title);};

 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>Wallet</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test pool</strong><span>Test funds only, with proving keys from a small testnet ceremony. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</span></section>
  {pool?.pool?.notice&&<section className="stock-warning"><strong>The pool is waiting</strong><span>{pool.pool.notice}</span></section>}
  {!ready&&<section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><div><h2>{pool?pool.phase==='blocked'?'The pool is stopped':'The pool is being set up':'Connecting to the pool'}</h2><p className="stock-muted">{poolError||pool?.message}</p></div></section>}
  {ready&&<>
   <section className="stock-card stock-balance">
    <div><small>SHIELDED BALANCE{!synced&&' · SYNCING'}</small><strong>{sats(balance)} <em>sats</em></strong></div>
    <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{arkAvailable===undefined?'Loading…':`${sats(arkAvailable)} sats`}</b></div><div><small>POOL</small><b>{wallet?.batchCount()??0} batches</b></div>
     {reserves.filter(id=>assetUnits(id)>0n).map(id=><div key={id}><small>ASSET {short(id)}</small><b>{sats(assetUnits(id))} units</b></div>)}</div>
    {inFlight&&<p className="stock-muted">Notes are in flight; they come back as spendable notes once the batch lands.</p>}
    {poolError&&<p className="stock-blocked">{poolError}</p>}
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
     {paidOutSats>=DUST&&<div className="stock-address"><small>BACK ON ARKADE FROM THE POOL</small><b>{sats(paidOutSats)} sats</b><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void run(()=>wallet!.shield(paidOut),'Shielding again')}>Shield again</button></div>}
     {arkAssetHoldings(coins,c=>!!wallet?.isPoolPayout(c)).map(a=><div key={a.assetId+':'+a.payout} className="stock-address"><small>{a.payout?'BACK ON ARKADE FROM THE POOL':'ARKADE ASSET'} {short(a.assetId)}</small><b>{sats(a.units)} units</b>
      {a.payout?<><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void run(()=>wallet!.shield(a.coins),'Shielding again')}>Shield again</button></>
       :reserves.includes(a.assetId)?<p className="stock-muted">Listed in the pool, so it moves in on its own.</p>
       :listed===a.assetId?<p className="stock-muted">Listing sent; the pool registers it within a minute.</p>
       :<><p className="stock-muted">Not in the pool yet. Listing it sends 1 unit and {DUST} sats to the pool, after which anyone can shield it.</p><button className="stock-ghost stock-mini" disabled={busy||restoring.current||!wallet} onClick={()=>void listAsset(a.assetId)}>List in the pool</button></>}</div>)}
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();submit();}}>
     {reserves.length>0&&<label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">Bitcoin</option>{reserves.map(id=><option key={id} value={id}>Asset {short(id)}</option>)}</select></label>}
     <label>To<input value={to} onChange={e=>setTo(e.target.value)} placeholder="shrol21… or tark1…" autoComplete="off" spellCheck={false}/></label>
     <label>Amount ({unit})<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     {assetId&&<label>Sats with it<input inputMode="numeric" value={withSats} placeholder={String(DUST)} onChange={e=>setWithSats(e.target.value.replace(/\D/g,''))}/></label>}
     <p className="stock-muted">A shielded address pays privately from up to three of your notes, up to {sats(maxSend)} {unit}. An Arkade address leaves the pool, and the amount and destination become public.</p>
     {quote&&<div className="stock-route"><b>{routeCopy(quote.railId).title}</b><span className="stock-muted">{routeCopy(quote.railId).detail}</span>
      {quote.fee>0&&<small>Fee {sats(quote.fee)} sats · total {sats(quote.total)} sats</small>}</div>}
     {quoteError&&<p className="stock-blocked">{quoteError}</p>}
     <button className="stock-primary" disabled={busy||restoring.current||!synced||!quote}>{busy?'Working…':quote?routeCopy(quote.railId).title:'Send'}</button>
    </form>}
   </section>
   <section className="stock-card stock-history"><h2>History</h2>
    {!rows.length?<p className="stock-muted">{synced?'Nothing yet. Fund your Arkade address and it shows up here.':'Reading the pool…'}</p>:<ul>{rows.map(item=>{
     const kind=item.intent?.kind,received=activityReceived(item),newest=item.txs[item.txs.length-1]!;
     const label=item.intent?.label??(received?'Arkade funding':'Arkade payment');
     const id=newest.key.arkTxid||newest.key.commitmentTxid,asset=newest.assets?.[0];
     return <li key={item.id}><details><summary><span className={'stock-kind '+(kind?SWATCH[kind]??'arkade':'arkade')}>{label}</span>
       <b className={received?'in':'out'}>{received?'+':'−'}{asset?`${sats(asset.amount)} units of ${assetName(asset.assetId)}`:`${sats(Math.abs(item.amount))} sats`}</b><time>{when(item.createdAt)}</time></summary>
      <dl>
       <dt>Where</dt><dd>{whereOf(kind,received)}</dd>
       {typeof item.intent?.metadata?.batch==='number'&&<><dt>Batch</dt><dd>#{String(item.intent.metadata.batch)}</dd></>}
       {id&&<><dt>Transaction</dt><dd><TxLink txid={id} path={newest.key.arkTxid?'tx':'commitment-tx'}/></dd></>}
       <dt>Status</dt><dd>{item.settled?'Settled':'Preconfirmed'}</dd>
      </dl></details></li>;
    })}</ul>}
   </section>
   {((wallet?.shieldedNotes().length??0)>0||reserves.some(id=>assetUnits(id)>0n))&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">
    {(wallet?.shieldedNotes()??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span>{wallet!.inFlight.has(n.nullifier)?<span className="wait">In flight</span>:<span className="ok">Spendable</span>}</div>)}
    {reserves.flatMap(id=>(wallet?.shieldedNotes(assetFieldOfId(id))??[]).map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} units</span><span className={wallet!.inFlight.has(n.nullifier)?'wait':'ok'}>{wallet!.inFlight.has(n.nullifier)?'In flight':`Asset ${short(id)}`}</span></div>))}
   </div></section>}
  </>}
  {!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery phrase</h2><p className="stock-muted">These 24 words restore this wallet and its Arkade balance in any browser. Anyone who has them can spend your funds.</p>{reveal&&<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show phrase</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <details className="stock-card stock-advanced"><summary>Recovery phrase and restore</summary>
   {backedUp&&secret&&(reveal?<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>:<button className="stock-ghost" onClick={()=>setReveal(true)}>Show recovery phrase</button>)}
   {wallet&&<div className="stock-address"><small>VIEW KEY · READ ONLY</small>{showView?<><Copyable value={wallet.viewKey()}/><p className="stock-muted">Shows every payment this wallet receives, for an auditor or a second device. It cannot spend and cannot see which notes were spent. <a className="stock-txlink" href={`/watch#${wallet.viewKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowView(true)}>Show view key</button>}</div>}
   {wallet&&<div className="stock-address"><small>FULL VIEWING KEY · SEES SPENDS</small>{showFull?<><Copyable value={wallet.fullViewingKey()}/><p className="stock-muted">Shows every note this wallet received and which ones it spent, so also how much each payment out sent, forever. It cannot spend and cannot freeze your notes. <a className="stock-txlink" href={`/watch#${wallet.fullViewingKey()}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowFull(true)}>Show full viewing key</button>}</div>}
   <label>Restore from a recovery phrase<textarea rows={3} value={restore} onChange={e=>setRestore(e.target.value)} autoComplete="off" spellCheck={false} placeholder="24 words (older wallets: 64 hex characters)"/></label>
   <button disabled={busy||!restore.trim()} onClick={()=>void restoreWallet()}>Restore wallet</button>
   {restoreError&&<p className="stock-blocked">{restoreError}</p>}
  </details>
 </main></div>;
}
