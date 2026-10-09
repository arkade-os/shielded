import {useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {ArkAddress,SingleKey,TxType,type ArkTransaction} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {hex} from '@scure/base';
import {akOf,assetFieldOfId,destinationFieldOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {encodeDisclosure,fullViewKeyOf,sentNoteOf,viewKeyOf,type DisclosedNote} from '../../packages/protocol/src/rollup/disclosure.ts';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2,deriveWalletKeyMaterial,parseMasterSecret,recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {openCustomerArkWallet,walletIntentLeafScriptHex,withArkWallet} from '../../src/stock/ark-wallet.ts';
import {arkAssetHoldings,bornAtFor,checkSigningRequest,DUST,pickNote,provingUrls,rollupApi,sheetLine,shieldPlan,signDeposit,syncAccount,transferBody,waitForSpend,type ArkCoin,type RollupPoolStatus,type ShieldPlan,type SpendStatus} from './rollup-client.ts';
import {CopyButton} from './components.tsx';

const SECRET='shielded-rollup-wallet-secret-v1',BACKED_UP='shielded-rollup-wallet-backed-up-v1',SENT='shielded-rollup-sent-v1',BORN='shielded-rollup-wallet-born-v1';
// Set once this device has proved a join, so its artifacts are cached and a payment may use one.
const JOIN_READY='shielded-rollup-join-ready-v1';
const EXPLORER='https://explorer.mutinynet.arkade.sh';
// The pool refuses deposit coins that expire within 24 hours; the extra hour covers the batch wait.
const SHIELD_FLOOR_MS=25*3600_000,RETRY_MS=60_000,MERGE_WAIT_MS=10*60_000;
type Tab='receive'|'send'|'withdraw';
type Activity={title:string;steps:string[];current:number;done?:boolean;error?:string};
type Ark={address:string;available:number;coins:ArkCoin[];history:ArkTransaction[]};
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const amountOf=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('Enter a whole number.');return BigInt(n);};
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unknown';
// Keyed by the spent nullifier: where it went and, for a private payment, the recipient's note so it can be revealed later.
type Sent={to:string;note?:{amount:string;asset:string;rho:string}};
const sentLog=():Record<string,Sent>=>{try{return Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(SENT)??'{}') as Record<string,Sent|string>).map(([k,v])=>[k,typeof v==='string'?{to:v}:v]));}catch{return {};}};
const logSent=(entries:[string,Sent][])=>localStorage.setItem(SENT,JSON.stringify({...sentLog(),...Object.fromEntries(entries)}));
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
// Key URLs carry their hashes, so a browser cache can only ever hold the keys this pool proves with.
// A background merge can overlap a payment; snarkjs races when two first proofs build its curve at once, so proofs queue.
let proving:Promise<unknown>=Promise.resolve();
const prove=(built:BuiltSpend,keys:NonNullable<RollupPoolStatus['proving']>)=>{
 const next=proving.then(async()=>{
  const urls=provingUrls(built,keys),{proof}=await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),urls.wasm,urls.zkey,undefined,undefined,{singleThread:true});
  if(built.witness.slot.nullifiers.length===2)localStorage.setItem(JOIN_READY,'1');
  return proof;
 });
 proving=next.catch(()=>{});return next;
};
const TxLink=({txid,path='tx'}:{txid:string;path?:string})=><a className="stock-txlink" href={`${EXPLORER}/${path}/${txid}`} target="_blank" rel="noreferrer">{short(txid)} ↗</a>;

export default function RollupWallet(){
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [secret,setSecret]=useState(()=>localStorage.getItem(SECRET)??''),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [notes,setNotes]=useState<OwnedNote[]>([]),[assetNotes,setAssetNotes]=useState<Record<string,OwnedNote[]>>({}),[history,setHistory]=useState<HistoryEntry[]>([]),[synced,setSynced]=useState(false);
 const [ark,setArk]=useState<Ark>(),[listed,setListed]=useState(''),[restoreError,setRestoreError]=useState(''),[revealed,setRevealed]=useState<Record<string,string>>({}),[showView,setShowView]=useState(false),[showFull,setShowFull]=useState(false),[merge,setMerge]=useState(false);
 const [tab,setTab]=useState<Tab>('receive'),[assetId,setAssetId]=useState(''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[withSats,setWithSats]=useState(''),[activity,setActivity]=useState<Activity>(),[busy,setBusy]=useState(false);
 const account=useRef<RollupAccount|undefined>(undefined),self=useRef<RollupRecipient|undefined>(undefined),busyRef=useRef(false),hashRef=useRef<Hash|undefined>(undefined);
 const poolRef=useRef<RollupPoolStatus|undefined>(undefined),arkRef=useRef<Ark|undefined>(undefined),retryAt=useRef(0),used=useRef(new Set<string>());
 // The notes a background merge is spending; payments leave them alone until it lands or gives up.
 const merging=useRef(new Set<bigint>()),mergeRetryAt=useRef(0);

 useEffect(()=>{if(!secret){const fresh=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));localStorage.setItem(SECRET,fresh);localStorage.setItem(BORN,'new');setSecret(fresh);}},[secret]);
 useEffect(()=>{
  let stop=false;
  // Keeps polling after the wallet opens: listings and the batch count change while the page stays up.
  const poll=async()=>{try{const status=await rollupApi<RollupPoolStatus>('/status');if(!stop){poolRef.current=status;setPool(status);setPoolError('');}}catch(error){if(!stop)setPoolError((error as Error).message);}if(!stop)setTimeout(poll,10_000);};
  void poll();return()=>{stop=true;};
 },[]);
 const native=()=>SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret);
 const withArk=<T,>(use:(wallet:Awaited<ReturnType<typeof openCustomerArkWallet>>)=>Promise<T>)=>withArkWallet(()=>openCustomerArkWallet(native(),poolRef.current!.network),use);
 const refreshArk=async()=>{
  if(!poolRef.current?.network)return;
  await withArk(async wallet=>{
   const [balance,vtxos,txs]=await Promise.all([wallet.wallet.getBalance(),wallet.wallet.getSpendableVtxos(),wallet.wallet.getTransactionHistory().catch(()=>[] as ArkTransaction[])]);
   const coins=vtxos.map(v=>({txid:v.txid,vout:v.vout,value:v.value,...(v.expiresAt instanceof Date?{expiresAt:v.expiresAt.getTime()}:{}),...(v.assets?.length?{assets:v.assets.map(a=>({assetId:a.assetId,amount:BigInt(a.amount)}))}:{})}));
   const next={address:wallet.address,available:balance.available,coins,history:txs};
   arkRef.current=next;setArk(next);
  });
 };
 const sync=async()=>{
  const current=account.current;if(!current)return;await syncAccount(current);setNotes(current.notes());setHistory([...current.history]);
  setAssetNotes(Object.fromEntries(Object.keys(poolRef.current?.pool?.reserves??{}).map(id=>[id,current.notes(assetFieldOfId(id))])));setSynced(true);
 };
 /** Coins the pool paid out, from a withdrawal, stay on Arkade until the user shields them again. */
 const payout=(c:ArkCoin)=>!!account.current?.txids.has(c.txid);
 const outpoint=(c:ArkCoin)=>`${c.txid}:${c.vout}`;

 /** Runs one action end to end with visible steps; resolves whether it landed. */
 const run=async(title:string,steps:string[],work:(step:(n:number)=>void)=>Promise<SpendStatus>)=>{
  if(busyRef.current)return false;busyRef.current=true;setBusy(true);
  const step=(current:number)=>setActivity({title,steps,current});
  try{
   const final=await work(step);
   if(final.status==='dropped')throw new Error(final.reason??'The pool dropped this spend.');
   step(steps.length-1);await sync();setActivity({title,steps,current:steps.length,done:true});setAmount('');void refreshArk();return true;
  }catch(error){setActivity(a=>({...(a??{title,steps,current:0}),error:(error as Error).message}));return false;}
  finally{busyRef.current=false;setBusy(false);}
 };
 type Member={built:BuiltSpend;extra?:Parameters<typeof transferBody>[3];coin?:{txid:string;vout:number}};
 /** Proves every member, submits them in the order a group id commits to, and waits for all; only a coin's member signs. */
 const submitAll=async(members:Member[],step:(n:number)=>void,first:number)=>{
  step(first);const proofs=[];for(const m of members)proofs.push(await prove(m.built,poolRef.current!.proving!));
  step(first+1);const ids:string[]=[];
  for(const [i,m] of members.entries()){const id=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));await rollupApi('/spends',transferBody(id,m.built,proofs[i]!,m.extra));ids.push(id);}
  step(first+2);
  const finals=await Promise.all(ids.map((id,i)=>waitForSpend(id,async request=>{
   const coin=members[i]!.coin;if(!coin)throw new Error('The pool asked to sign a spend with no deposit coin.');
   checkSigningRequest(request,coin,poolRef.current!.pool!.script);step(first+3);
   await rollupApi(`/spends/${id}/sign`,await signDeposit(native(),request));
  })));
  return finals.find(f=>f.status==='dropped')??finals[0]!;
 };
 /** Waits for a coin with the value and asset holding a deposit needs, and returns how to spend it. */
 const depositCoin=(txid:string,value:number,asset?:{assetId:string;amount:bigint})=>withArk(async wallet=>{
  for(let i=0;i<30;i++){
   await new Promise(r=>setTimeout(r,1000));
   const found=(await wallet.wallet.getSpendableVtxos()).find(v=>v.txid===txid&&v.value===value&&(asset?v.assets?.length===1&&v.assets[0]!.assetId===asset.assetId&&BigInt(v.assets[0]!.amount)===asset.amount:!v.assets?.length));
   if(found?.tapTree&&found.intentTapLeafScript)return {txid:found.txid,vout:found.vout,value:found.value,tapTree:hex.encode(found.tapTree instanceof Uint8Array?found.tapTree:hex.decode(String(found.tapTree))),leaf:walletIntentLeafScriptHex(found.intentTapLeafScript)};
  }
  throw new Error('The deposit coin did not appear in your Arkade wallet.');
 });
 const shieldWith=(plan:ShieldPlan)=>{
  const taken=(plan.kind==='btc'?plan.coins:[plan.coin]).map(outpoint);taken.forEach(o=>used.current.add(o));
  const title=plan.kind==='btc'?`Shielding ${sats(plan.amount)} sats`:`Shielding ${sats(plan.units)} units of asset ${short(plan.assetId)}`;
  // A failed attempt hands its coins back, so the retry can use them; a landed one keeps them out while the indexer catches up.
  return run(title,['Prepare the deposit coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],async step=>{
   step(0);
   if(plan.kind==='asset'){
    // One asset coin funds a group: its units in the asset slot, its sats in a BTC slot.
    const coin=await depositCoin(plan.coin.txid,plan.coin.value,{assetId:plan.assetId,amount:plan.units});
    const [assetSlot,btcSlot]=await account.current!.depositAsset(assetFieldOfId(plan.assetId),plan.units,BigInt(coin.value),self.current!);
    return submitAll([{built:assetSlot,extra:{coin,asset:plan.assetId},coin},{built:btcSlot}],step,1);
   }
   const single=plan.coins.length===1?plan.coins[0]!:undefined;
   const coin=single?await depositCoin(single.txid,single.value):await depositCoin(await withArk(wallet=>wallet.wallet.send({recipients:[{address:wallet.address,amount:plan.amount}]})),plan.amount);
   taken.push(outpoint(coin));used.current.add(outpoint(coin));
   return submitAll([{built:await account.current!.spend({deposit:BigInt(plan.amount)},self.current!),extra:{coin},coin}],step,1);
  }).then(ok=>{if(!ok)taken.forEach(o=>used.current.delete(o));return ok;});
 };
 const planFor=(coins:ArkCoin[])=>shieldPlan(coins.filter(c=>!used.current.has(outpoint(c))),new Set(Object.keys(poolRef.current?.pool?.reserves??{})),Date.now(),SHIELD_FLOOR_MS);
 const autoShield=async()=>{
  if(busyRef.current||Date.now()<retryAt.current||!arkRef.current||!account.current)return;
  const plan=planFor(arkRef.current.coins.filter(c=>!payout(c)));
  if(plan&&!await shieldWith(plan))retryAt.current=Date.now()+RETRY_MS;
 };
 /** Above eight notes of an asset, merges the two smallest without holding the wallet, one merge at a time. */
 const tidy=async()=>{
  if(busyRef.current||merging.current.size||Date.now()<mergeRetryAt.current||!account.current||!self.current)return;
  for(const field of [0n,...Object.keys(poolRef.current?.pool?.reserves??{}).map(assetFieldOfId)]){
   const plan=await account.current.consolidate(self.current,field);
   if(!plan)continue;
   plan.inputs.forEach(n=>merging.current.add(n.nullifier));setMerge(true);
   void (async()=>{
    try{
     const proof=await prove(plan.built,poolRef.current!.proving!),id=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
     await rollupApi('/spends',transferBody(id,plan.built,proof));
     const final=await waitForSpend(id,async()=>{throw new Error('A merge has no deposit to sign.');},rollupApi,1000,MERGE_WAIT_MS);
     if(final.status==='dropped')throw new Error(final.reason??'The pool dropped the merge.');
    }catch{mergeRetryAt.current=Date.now()+RETRY_MS;}
    finally{merging.current.clear();setMerge(false);}
   })();
   return;
  }
 };

 useEffect(()=>{
  if(pool?.phase!=='ready'||!secret)return;
  let stop=false,timer:ReturnType<typeof setTimeout>|undefined,arkAt=0;
  void (async()=>{
   const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v))),keys=deriveRollupKeys2(secret,'mutinynet');
   const bornAt=bornAtFor(localStorage,BORN,{token:poolRef.current!.pool!.token,batches:poolRef.current!.pool!.batches});
   hashRef.current=hash;account.current=RollupAccount.owning(hash,keys,{frontier:true,bornAt});self.current=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
   const loop=async()=>{
    if(stop)return;
    try{
     if(!busyRef.current){
      await sync();
      if(Date.now()-arkAt>15_000){arkAt=Date.now();await refreshArk();}
      await autoShield();
      await tidy();
     }
    }catch(error){setPoolError((error as Error).message);}
    timer=setTimeout(loop,5000);
   };
   await loop();
  })();
  return()=>{stop=true;if(timer)clearTimeout(timer);account.current=undefined;};
 },[pool?.phase,secret]);

 const send=()=>void run('Sending privately',['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const recipient=to.trim(),{spends}=await account.current!.pay(parseRollupAddress(recipient),amountOf(amount),self.current!,merging.current,assetId?assetFieldOfId(assetId):0n,{join:localStorage.getItem(JOIN_READY)==='1'});
  logSent(spends.map(s=>{const note=sentNoteOf(hashRef.current!,s);return [String(s.witness.slot.nullifiers[0]),{to:recipient,note:{amount:String(note.amount),asset:String(note.asset),rho:String(note.rho)}}];}));
  return submitAll(spends.map(built=>({built})),step,1);
 });
 const withdraw=()=>void run('Withdrawing',['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const value=amountOf(amount),address=to.trim()||ark!.address,program=ArkAddress.decode(address).pkScript.subarray(2);
  const remember=(spends:BuiltSpend[])=>logSent(spends.map(s=>[String(s.witness.slot.nullifiers[0]),{to:address}]));
  if(assetId){const [payout,carrier]=await account.current!.withdrawAsset(assetFieldOfId(assetId),value,program,self.current!,merging.current,withSats?amountOf(withSats):BigInt(DUST));remember([payout,carrier]);return submitAll([{built:payout,extra:{program,asset:assetId}},{built:carrier,extra:{program}}],step,1);}
  if(value<BigInt(DUST))throw new Error(`Withdraw at least ${DUST} sats.`);
  const input=pickNote(account.current!.notes(),value,merging.current);if(!input)throw new Error('No single note covers this amount.');
  const built=await account.current!.spend({input,withdraw:value,program},self.current!);remember([built]);
  return submitAll([{built,extra:{program}}],step,1);
 }).then(ok=>{if(ok)setTab('receive');});
 const list=async(id:string)=>{try{await withArk(wallet=>wallet.wallet.send({recipients:[{address:poolRef.current!.pool!.address,amount:DUST,assets:[{assetId:id,amount:1n}]}]}));setListed(id);void refreshArk();}catch(error){setPoolError((error as Error).message);}};

 const reserves=Object.keys(pool?.pool?.reserves??{}),address=self.current?rollupAddressOf(self.current):'';
 const shown=assetId?assetNotes[assetId]??[]:notes,balance=notes.reduce((sum,n)=>sum+n.amount,0n);
 const maxSend=[...shown].sort((a,b)=>a.amount<b.amount?1:-1).slice(0,3).reduce((sum,n)=>sum+n.amount,0n);
 const ready=pool?.phase==='ready',unit=assetId?'units':'sats';
 const paidOut=(ark?.coins??[]).filter(c=>payout(c)&&!c.assets?.length),paidOutSats=paidOut.reduce((sum,c)=>sum+c.value,0);
 const expiring=(ark?.coins??[]).filter(c=>!payout(c)&&!c.assets?.length&&c.expiresAt!==undefined&&c.expiresAt-Date.now()<=SHIELD_FLOOR_MS).reduce((sum,c)=>sum+c.value,0);
 const ownField=ark?destinationFieldOf(ArkAddress.decode(ark.address).pkScript.subarray(2)):undefined,sent=sentLog();
 const assetName=(field:bigint)=>{const id=reserves.find(r=>assetFieldOfId(r)===field);return id?`asset ${short(id)}`:'an asset';};
 const amountText=(amounts:{asset:bigint;amount:bigint}[])=>amounts.map(a=>a.asset===0n?`${sats(a.amount)} sats`:`${sats(a.amount)} units of ${assetName(a.asset)}`).join(' + ');
 const kinds={shield:'Shielded',receive:'Received privately',send:'Sent privately',withdraw:'Withdrew',merge:'Merged notes'} as const;
 const timeline=[
  ...history.map(e=>({key:`r${e.batch}-${e.spent[0]??e.created[0]?.nullifier}`,at:e.at??0,rollup:e})),
  ...(ark?.history??[]).filter(t=>t.amount>0&&!account.current?.txids.has(t.key.arkTxid)).map(t=>({key:`a${t.key.arkTxid||t.key.commitmentTxid||t.key.boardingTxid}-${t.type}`,at:t.createdAt,arkade:t})),
 ].sort((a,b)=>b.at-a.at);
 const phrase=secret?recoveryPhraseOf(secret):'',keys2=secret&&self.current&&(showView||showFull)?deriveRollupKeys2(secret,'mutinynet'):undefined;
 const viewKey=showView&&keys2?viewKeyOf(self.current!.owner,keys2.viewSecret):'',fullKey=showFull&&keys2&&hashRef.current?fullViewKeyOf(akOf(hashRef.current,keys2.ask),keys2.nk,keys2.viewSecret):'';
 /** A link that opens one entry's notes, for whoever needs to see that one payment and nothing else. */
 const revealEntry=(key:string,e:HistoryEntry)=>{
  let to:string=rollupAddressOf(self.current!),notes:DisclosedNote[];
  if(e.kind==='send'){
   // A payment's note for the recipient is output 0 of the slot that spent ours.
   const parts=e.spent.map((nf,i)=>({sent:sent[String(nf)],index:e.batch*32+2*e.slots[i]!})).filter(p=>p.sent?.note);if(!parts.length)return;
   to=parts[0]!.sent!.to;
   notes=parts.map(({sent:p,index})=>({index,amount:BigInt(p!.note!.amount),asset:BigInt(p!.note!.asset),rho:BigInt(p!.note!.rho)}));
  }else notes=e.created.map(n=>({index:n.index,amount:n.amount,asset:n.asset,rho:n.rho}));
  if(notes.length)setRevealed(r=>({...r,[key]:`${location.origin}/verify#${encodeDisclosure({v:1,to,notes})}`}));
 };
 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>Wallet</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test pool</strong><span>Test funds only, with proving keys from a small testnet ceremony. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</span></section>
  {pool?.pool?.notice&&<section className="stock-warning"><strong>The pool is waiting</strong><span>{pool.pool.notice}</span></section>}
  {!ready&&<section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><div><h2>{pool?pool.phase==='blocked'?'The pool is stopped':'The pool is being set up':'Connecting to the pool'}</h2><p className="stock-muted">{poolError||pool?.message}</p></div></section>}
  {ready&&<>
   <section className="stock-card stock-balance">
    <div><small>SHIELDED BALANCE{!synced&&' · SYNCING'}</small><strong>{sats(balance)} <em>sats</em></strong></div>
    <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{ark?`${sats(ark.available)} sats`:'Loading…'}</b></div><div><small>POOL</small><b>{pool!.pool!.batches} batches</b></div>
     {reserves.filter(id=>(assetNotes[id]??[]).length).map(id=><div key={id}><small>ASSET {short(id)}</small><b>{sats((assetNotes[id]??[]).reduce((sum,n)=>sum+n.amount,0n))} units</b></div>)}</div>
    {merge&&<p className="stock-muted">Merging two small notes in the background; they come back as one spendable note once it lands.</p>}
   </section>
   {activity&&<section className={'stock-card stock-activity'+(activity.done?' finished':activity.error?' failed':'')}><div className="stock-activity-head"><h2>{activity.title}</h2></div>
    <ol className="stock-steps">{activity.steps.map((label,i)=><li key={label} className={activity.error&&i===activity.current?'error':i<activity.current||activity.done?'done':i===activity.current?'active':''}><i/>{label}</li>)}</ol>
    {activity.error&&<p className="stock-blocked">{activity.error}{activity.title.startsWith('Shielding')&&' It tries again in a minute.'}</p>}
   </section>}
   {(activity||merge)&&<div className={'stock-sheet'+(activity?.error?' failed':activity?.done&&!merge?' finished':'')} role="status" aria-live="polite" aria-atomic="true">
    {activity&&<><b>{activity.title}</b><span>{sheetLine(activity)}</span>
     {!activity.done&&!activity.error&&<div className="stock-progress"><div><span style={{width:`${Math.round(100*(activity.current+1)/activity.steps.length)}%`}}/></div></div>}
     {activity.error&&<button className="stock-ghost stock-mini" onClick={()=>setActivity(undefined)}>Dismiss</button>}</>}
    {merge&&<small>Merging two notes in the background.</small>}
   </div>}
   <section className="stock-card stock-panel">
    <div className="stock-tabs" role="tablist" style={{gridTemplateColumns:'repeat(3,1fr)'}}>{(['receive','send','withdraw'] as const).map(name=><button key={name} role="tab" aria-selected={tab===name} className={tab===name?'selected':''} onClick={()=>{setTab(name);setTo('');}}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</div>
    {tab==='receive'?<div className="stock-receive">
     <div className="stock-address"><small>SHIELDED ADDRESS</small>{address?<Copyable value={address}/>:<code>Deriving…</code>}<p className="stock-muted">Share this to receive private payments inside the pool.</p></div>
     <div className="stock-address"><small>ARKADE ADDRESS · FUNDING</small>{ark?<Copyable value={ark.address}/>:<code>Loading…</code>}<p className="stock-muted">Sats sent here move into the pool on their own; keep this page open until they do.{expiring>0&&` ${sats(expiring)} sats expire within a day, so the pool will not take them.`} Need test sats? The <a href="https://faucet.mutinynet.com" target="_blank" rel="noreferrer">Mutinynet faucet</a> sends Arkade sats to this address after a GitHub sign-in.</p></div>
     {paidOutSats>=DUST&&<div className="stock-address"><small>BACK ON ARKADE FROM THE POOL</small><b>{sats(paidOutSats)} sats</b><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>{const plan=planFor(paidOut);if(plan)void shieldWith(plan);}}>Shield again</button></div>}
     {arkAssetHoldings(ark?.coins??[],payout).map(a=><div key={a.assetId+':'+a.payout} className="stock-address"><small>{a.payout?'BACK ON ARKADE FROM THE POOL':'ARKADE ASSET'} {short(a.assetId)}</small><b>{sats(a.units)} units</b>
      {a.payout?<><p className="stock-muted">Withdrawals stay on Arkade until you move them back.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>{const plan=planFor(a.coins);if(plan)void shieldWith(plan);}}>Shield again</button></>:reserves.includes(a.assetId)?<p className="stock-muted">Listed in the pool, so it moves in on its own.</p>:listed===a.assetId?<p className="stock-muted">Listing sent; the pool registers it within a minute.</p>:<><p className="stock-muted">Not in the pool yet. Listing it sends 1 unit and {DUST} sats to the pool, after which anyone can shield it.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void list(a.assetId)}>List in the pool</button></>}</div>)}
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();(tab==='send'?send:withdraw)();}}>
     {reserves.length>0&&<label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">Bitcoin</option>{reserves.map(id=><option key={id} value={id}>Asset {short(id)}</option>)}</select></label>}
     <label>To<input value={to} onChange={e=>setTo(e.target.value)} placeholder={tab==='send'?'shrol21…':'Your Arkade address, or another tark1…'} autoComplete="off" spellCheck={false}/></label>
     <label>Amount ({unit})<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     {tab==='withdraw'&&assetId&&<label>Sats with it<input inputMode="numeric" value={withSats} placeholder={String(DUST)} onChange={e=>setWithSats(e.target.value.replace(/\D/g,''))}/></label>}
     <p className="stock-muted">{tab==='send'?`Pays from up to three of your notes at once, up to ${sats(maxSend)} ${unit}; the amount and both parties stay private.`:assetId?`Pays the units and the sats out together, in one Arkade coin; both amounts are public. At least ${DUST} sats.`:`Pays out to an Arkade address; the amount is public. At least ${DUST} sats.`}</p>
     <button className="stock-primary" disabled={busy||!synced||!amount||(tab==='send'&&!to.trim())}>{busy?'Working…':tab==='send'?'Send':'Withdraw'}</button>
    </form>}
   </section>
   <section className="stock-card stock-history"><h2>History</h2>
    {!timeline.length?<p className="stock-muted">{synced?'Nothing yet. Fund your Arkade address and it shows up here.':'Reading the pool…'}</p>:<ul>{timeline.map(item=>{
     if('rollup' in item){const e=item.rollup,recipient=e.spent.map(nf=>sent[String(nf)]?.to).find(Boolean),incoming=e.kind==='shield'||e.kind==='receive';
      return <li key={item.key}><details><summary><span className={'stock-kind '+e.kind}>{kinds[e.kind]}</span>{e.kind==='merge'?<b>{e.spent.length} notes into {e.created.length}</b>:<b className={incoming?'in':'out'}>{incoming?'+':'−'}{amountText(e.amounts)}</b>}<time>{when(e.at)}</time></summary>
       <dl>
        <dt>Where</dt><dd>{e.kind==='shield'?'From your Arkade coins into the pool; the amount is public.':e.kind==='withdraw'?(recipient?`To ${recipient}`:e.destination===ownField?'To your Arkade address':'To another Arkade address')+'; the amount is public.':e.kind==='send'?`Inside the pool${recipient?` to ${recipient}`:''}; amount and parties stay private.`:e.kind==='merge'?'Inside the pool: your own notes, merged into one. Nothing left the wallet.':'Inside the pool; amount and sender stay private.'}</dd>
        <dt>Batch</dt><dd>#{e.batch}{e.txid&&<> · <TxLink txid={e.txid}/></>}</dd>
        {e.spent.length>0&&<><dt>Notes spent</dt><dd>{e.spent.length}</dd></>}
        {e.created.length>0&&<><dt>{e.kind==='merge'?'Merged into':incoming?'Notes received':'Change'}</dt><dd>{e.created.map(n=>n.asset===0n?`${sats(n.amount)} sats`:`${sats(n.amount)} units`).join(', ')}</dd></>}
        {e.txid&&<><dt>Transaction</dt><dd><Copyable value={e.txid}/></dd></>}
        {e.kind!=='withdraw'&&e.kind!=='merge'&&(e.kind!=='send'||e.spent.some(nf=>sent[String(nf)]?.note))&&<><dt>Reveal</dt><dd>{revealed[item.key]?<><Copyable value={revealed[item.key]!}/><p className="stock-muted">Anyone with this link can check this payment's amount and recipient against the pool, and learns nothing else.</p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>revealEntry(item.key,e)}>Create a reveal link</button>}</dd></>}
       </dl></details></li>;}
     const t=item.arkade,id=t.key.arkTxid||t.key.commitmentTxid,received=t.type===TxType.TxReceived;
     return <li key={item.key}><details><summary><span className="stock-kind arkade">{received?'Arkade funding':'Arkade payment'}</span><b className={received?'in':'out'}>{received?'+':'−'}{sats(t.amount)} sats</b><time>{when(t.createdAt)}</time></summary>
      <dl><dt>Where</dt><dd>{received?'Into your Arkade address, outside the pool.':'From your Arkade address, outside the pool.'}</dd>
       {id&&<><dt>Transaction</dt><dd><TxLink txid={id} path={t.key.arkTxid?'tx':'commitment-tx'}/></dd></>}
       <dt>Status</dt><dd>{t.settled?'Settled':'Preconfirmed'}</dd></dl></details></li>;
    })}</ul>}
   </section>
   {(notes.length>0||Object.values(assetNotes).some(list=>list.length))&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">
    {notes.map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span>{merging.current.has(n.nullifier)?<span className="wait">Merging</span>:<span className="ok">Spendable</span>}</div>)}
    {Object.entries(assetNotes).flatMap(([id,list])=>list.map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} units</span><span className={merging.current.has(n.nullifier)?'wait':'ok'}>{merging.current.has(n.nullifier)?'Merging':`Asset ${short(id)}`}</span></div>))}
   </div></section>}
  </>}
  {!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery phrase</h2><p className="stock-muted">These 24 words restore this wallet and its Arkade balance in any browser. Anyone who has them can spend your funds.</p>{reveal&&<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show phrase</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <details className="stock-card stock-advanced"><summary>Recovery phrase and restore</summary>
   {backedUp&&secret&&(reveal?<><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>:<button className="stock-ghost" onClick={()=>setReveal(true)}>Show recovery phrase</button>)}
   {secret&&self.current&&<div className="stock-address"><small>VIEW KEY · READ ONLY</small>{viewKey?<><Copyable value={viewKey}/><p className="stock-muted">Shows every payment this wallet receives, for an auditor or a second device. It cannot spend and cannot see which notes were spent. <a className="stock-txlink" href={`/watch#${viewKey}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowView(true)}>Show view key</button>}</div>}
   {secret&&self.current&&<div className="stock-address"><small>FULL VIEWING KEY · SEES SPENDS</small>{fullKey?<><Copyable value={fullKey}/><p className="stock-muted">Shows every note this wallet received and which ones it spent, so also how much each payment out sent, forever. It cannot spend and cannot freeze your notes. <a className="stock-txlink" href={`/watch#${fullKey}`} target="_blank" rel="noreferrer">Open the read-only view ↗</a></p></>:<button type="button" className="stock-ghost stock-mini" onClick={()=>setShowFull(true)}>Show full viewing key</button>}</div>}
   <label>Restore from a recovery phrase<textarea rows={3} value={restore} onChange={e=>setRestore(e.target.value)} autoComplete="off" spellCheck={false} placeholder="24 words (older wallets: 64 hex characters)"/></label>
   <button disabled={busy||!restore.trim()} onClick={()=>{try{localStorage.setItem(SECRET,bytesToHex(parseMasterSecret(restore)));for(const k of Object.keys(localStorage))if(k.startsWith(BORN))localStorage.removeItem(k);location.reload();}catch(error){setRestoreError((error as Error).message);}}}>Restore wallet</button>
   {restoreError&&<p className="stock-blocked">{restoreError}</p>}
  </details>
 </main></div>;
}
