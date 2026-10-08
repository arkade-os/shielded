import {useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {ArkAddress,SingleKey} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {hex} from '@scure/base';
import {assetFieldOfId} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupAccount,type BuiltSpend,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeyMaterial,deriveWalletKeyMaterial,parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {openCustomerArkWallet,walletIntentLeafScriptHex} from '../../src/stock/ark-wallet.ts';
import {checkSigningRequest,DUST,pickNote,rollupApi,signDeposit,spendBody,syncAccount,waitForSpend,type RollupPoolStatus,type SpendStatus} from './rollup-client.ts';
import {CopyButton} from './components.tsx';

const SECRET='shielded-rollup-wallet-secret-v1',BACKED_UP='shielded-rollup-wallet-backed-up-v1';
type Tab='receive'|'shield'|'send'|'withdraw';
type Activity={title:string;steps:string[];current:number;done?:boolean;error?:string};
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const amountOf=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('Enter a whole number of sats.');return BigInt(n);};
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
// Key URLs carry their hashes, so a browser cache can only ever hold the keys this pool proves with.
const prove=async(built:BuiltSpend,keys:{wasm:string;zkey:string})=>(await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),`/api/rollup/proving/spend.wasm?v=${keys.wasm}`,`/api/rollup/proving/spend.zkey?v=${keys.zkey}`,undefined,undefined,{singleThread:true})).proof;

export default function RollupWallet(){
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [secret,setSecret]=useState(()=>localStorage.getItem(SECRET)??''),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [notes,setNotes]=useState<OwnedNote[]>([]),[assetNotes,setAssetNotes]=useState<Record<string,OwnedNote[]>>({}),[synced,setSynced]=useState(false);
 const [ark,setArk]=useState<{address:string;available:number;assets:{assetId:string;amount:bigint}[]}>(),[listed,setListed]=useState('');
 const [tab,setTab]=useState<Tab>('receive'),[assetId,setAssetId]=useState(''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[activity,setActivity]=useState<Activity>(),[busy,setBusy]=useState(false);
 const account=useRef<RollupAccount|undefined>(undefined),self=useRef<RollupRecipient|undefined>(undefined),busyRef=useRef(false);

 useEffect(()=>{if(!secret){const fresh=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));localStorage.setItem(SECRET,fresh);setSecret(fresh);}},[secret]);
 useEffect(()=>{
  let stop=false;
  // Keeps polling after the wallet opens: listings and the batch count change while the page stays up.
  const poll=async()=>{try{const status=await rollupApi<RollupPoolStatus>('/status');if(!stop){setPool(status);setPoolError('');}}catch(error){if(!stop)setPoolError((error as Error).message);}if(!stop)setTimeout(poll,10_000);};
  void poll();return()=>{stop=true;};
 },[]);
 const native=()=>SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret);
 const refreshArk=async()=>{
  if(!pool?.network)return;
  const wallet=await openCustomerArkWallet(native(),pool.network),balance=await wallet.wallet.getBalance();
  setArk({address:wallet.address,available:balance.available,assets:(balance.availableAssets??[]).map(a=>({assetId:a.assetId,amount:BigInt(a.amount)}))});return wallet;
 };
 const sync=async()=>{
  const current=account.current;if(!current)return;await syncAccount(current);setNotes(current.notes());
  setAssetNotes(Object.fromEntries(Object.keys(pool?.pool?.reserves??{}).map(id=>[id,current.notes(assetFieldOfId(id))])));setSynced(true);
 };
 useEffect(()=>{
  if(pool?.phase!=='ready'||!secret)return;
  let stop=false,timer:ReturnType<typeof setTimeout>|undefined;
  void (async()=>{
   const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v))),keys=deriveRollupKeyMaterial(secret,'mutinynet');
   account.current=new RollupAccount(hash,keys);self.current=rollupRecipientOf(hash,keys.spendSecret,keys.viewSecret);
   void refreshArk().catch(error=>setPoolError((error as Error).message));
   const loop=async()=>{if(stop)return;try{if(!busyRef.current)await sync();}catch(error){setPoolError((error as Error).message);}timer=setTimeout(loop,5000);};
   await loop();
  })();
  return()=>{stop=true;if(timer)clearTimeout(timer);account.current=undefined;};
 },[pool?.phase,secret]);

 /** Runs one spend end to end with visible steps; a depositor signs the batch when the operator asks. */
 const run=async(title:string,steps:string[],work:(step:(n:number)=>void)=>Promise<SpendStatus>)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);
  const step=(current:number)=>setActivity({title,steps,current});
  try{
   const final=await work(step);
   if(final.status==='dropped')throw new Error(final.reason??'The pool dropped this spend.');
   step(steps.length-1);await sync();setActivity({title,steps,current:steps.length,done:true});setAmount('');void refreshArk();
  }catch(error){setActivity(a=>({...(a??{title,steps,current:0}),error:(error as Error).message}));}
  finally{busyRef.current=false;setBusy(false);}
 };
 type Member={built:BuiltSpend;extra?:Parameters<typeof spendBody>[3];coin?:{txid:string;vout:number}};
 /** Proves every member, submits them in the order a group id commits to, and waits for all; only a coin's member signs. */
 const submitAll=async(members:Member[],step:(n:number)=>void,first:number)=>{
  step(first);const proofs=[];for(const m of members)proofs.push(await prove(m.built,pool!.proving!.spend));
  step(first+1);const ids:string[]=[];
  for(const [i,m] of members.entries()){const id=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));await rollupApi('/spends',spendBody(id,m.built,proofs[i]!,m.extra));ids.push(id);}
  step(first+2);
  const finals=await Promise.all(ids.map((id,i)=>waitForSpend(id,async request=>{
   const coin=members[i]!.coin;if(!coin)throw new Error('The pool asked to sign a spend with no deposit coin.');
   checkSigningRequest(request,coin,pool!.pool!.script);step(first+3);
   await rollupApi(`/spends/${id}/sign`,await signDeposit(native(),request));
  })));
  return finals.find(f=>f.status==='dropped')??finals[0]!;
 };
 /** Waits for the self-sent exact coin to show up with the value and asset holding a deposit needs. */
 const exactCoin=async(txid:string,sats:number,asset?:{assetId:string;amount:bigint})=>{
  for(let i=0;i<30;i++){
   await new Promise(r=>setTimeout(r,1000));
   const wallet=await openCustomerArkWallet(native(),pool!.network),found=(await wallet.wallet.getSpendableVtxos()).find(v=>v.txid===txid&&v.value===sats&&(asset?v.assets?.length===1&&v.assets[0]!.assetId===asset.assetId&&BigInt(v.assets[0]!.amount)===asset.amount:!v.assets?.length));
   if(found?.tapTree&&found.intentTapLeafScript)return {txid:found.txid,vout:found.vout,value:found.value,tapTree:hex.encode(found.tapTree instanceof Uint8Array?found.tapTree:hex.decode(String(found.tapTree))),leaf:walletIntentLeafScriptHex(found.intentTapLeafScript)};
  }
  throw new Error('The exact coin did not appear in your Arkade wallet; try again.');
 };
 const shield=()=>void run('Shielding',['Prepare an exact coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],async step=>{
  const value=amountOf(amount),wallet=(await refreshArk())!;step(0);
  if(!assetId){
   if(value<DUST)throw new Error(`Shield at least ${DUST} sats.`);
   const coin=await exactCoin(await wallet.wallet.send({recipients:[{address:wallet.address,amount:Number(value)}]}),Number(value));
   return submitAll([{built:await account.current!.spend({deposit:value},self.current!),extra:{coin},coin}],step,1);
  }
  // An asset coin also holds the dust in sats; the group's BTC slot deposits those sats as a note of their own.
  const coin=await exactCoin(await wallet.wallet.send({recipients:[{address:wallet.address,amount:DUST,assets:[{assetId,amount:value}]}]}),DUST,{assetId,amount:value});
  const [assetSlot,btcSlot]=await account.current!.depositAsset(assetFieldOfId(assetId),value,BigInt(coin.value),self.current!);
  return submitAll([{built:assetSlot,extra:{coin,asset:assetId},coin},{built:btcSlot}],step,1);
 });
 const send=()=>void run('Sending privately',['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const spends=await account.current!.pay(parseRollupAddress(to.trim()),amountOf(amount),self.current!,new Set(),assetId?assetFieldOfId(assetId):0n);
  return submitAll(spends.map(built=>({built})),step,1);
 });
 const withdraw=()=>void run('Withdrawing',['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const value=amountOf(amount),program=ArkAddress.decode(ark!.address).pkScript.subarray(2);
  if(assetId){const [payout,carrier]=await account.current!.withdrawAsset(assetFieldOfId(assetId),value,program,self.current!);return submitAll([{built:payout,extra:{program,asset:assetId}},{built:carrier,extra:{program}}],step,1);}
  if(value<BigInt(DUST))throw new Error(`Withdraw at least ${DUST} sats.`);
  const input=pickNote(account.current!.notes(),value,new Set());if(!input)throw new Error('No single note covers this amount.');
  return submitAll([{built:await account.current!.spend({input,withdraw:value,program},self.current!),extra:{program}}],step,1);
 });
 const list=async(id:string)=>{try{const wallet=(await refreshArk())!;await wallet.wallet.send({recipients:[{address:pool!.pool!.address,amount:DUST,assets:[{assetId:id,amount:1n}]}]});setListed(id);void refreshArk();}catch(error){setPoolError((error as Error).message);}};

 const reserves=Object.keys(pool?.pool?.reserves??{}),address=self.current?rollupAddressOf(self.current):'';
 const shown=assetId?assetNotes[assetId]??[]:notes,balance=notes.reduce((sum,n)=>sum+n.amount,0n);
 const maxSend=[...shown].sort((a,b)=>a.amount<b.amount?1:-1).slice(0,3).reduce((sum,n)=>sum+n.amount,0n);
 const ready=pool?.phase==='ready',unit=assetId?'units':'sats';
 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>v2 pool</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test pool</strong><span>Development proving keys and test funds only. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</span></section>
  {!ready&&<section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><div><h2>{pool?pool.phase==='blocked'?'The pool is stopped':'The pool is being set up':'Connecting to the pool'}</h2><p className="stock-muted">{poolError||pool?.message}</p></div></section>}
  {ready&&<>
   <section className="stock-card stock-balance">
    <div><small>SHIELDED BALANCE{!synced&&' · SYNCING'}</small><strong>{sats(balance)} <em>sats</em></strong></div>
    <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{ark?`${sats(ark.available)} sats`:'Loading…'}</b></div><div><small>POOL</small><b>{pool!.pool!.batches} batches</b></div>
     {reserves.filter(id=>(assetNotes[id]??[]).length).map(id=><div key={id}><small>ASSET {short(id)}</small><b>{sats((assetNotes[id]??[]).reduce((sum,n)=>sum+n.amount,0n))} units</b></div>)}</div>
   </section>
   {activity&&<section className={'stock-card stock-activity'+(activity.done?' finished':activity.error?' failed':'')}><div className="stock-activity-head"><h2>{activity.title}</h2></div>
    <ol className="stock-steps">{activity.steps.map((label,i)=><li key={label} className={activity.error&&i===activity.current?'error':i<activity.current||activity.done?'done':i===activity.current?'active':''}><i/>{label}</li>)}</ol>
    {activity.error&&<p className="stock-blocked">{activity.error}</p>}
   </section>}
   <section className="stock-card stock-panel">
    <div className="stock-tabs" role="tablist" style={{gridTemplateColumns:'repeat(4,1fr)'}}>{(['receive','shield','send','withdraw'] as const).map(name=><button key={name} role="tab" aria-selected={tab===name} className={tab===name?'selected':''} onClick={()=>setTab(name)}>{name[0]!.toUpperCase()+name.slice(1)}</button>)}</div>
    {tab==='receive'?<div className="stock-receive">
     <div className="stock-address"><small>SHIELDED ADDRESS</small>{address?<Copyable value={address}/>:<code>Deriving…</code>}<p className="stock-muted">Share this to receive private payments inside the pool.</p></div>
     <div className="stock-address"><small>ARKADE ADDRESS · FUNDING</small>{ark?<Copyable value={ark.address}/>:<code>Loading…</code>}<p className="stock-muted">Fund this from the Mutinynet faucet, then shield it.</p></div>
     {ark?.assets.map(a=><div key={a.assetId} className="stock-address"><small>ARKADE ASSET {short(a.assetId)}</small><b>{sats(a.amount)} units</b>
      {reserves.includes(a.assetId)?<p className="stock-muted">Listed in the pool; shield it from the Shield tab.</p>:listed===a.assetId?<p className="stock-muted">Listing sent; the pool registers it within a minute.</p>:<><p className="stock-muted">Not in the pool yet. Listing it sends 1 unit and {DUST} sats to the pool, after which anyone can shield it.</p><button className="stock-ghost stock-mini" disabled={busy} onClick={()=>void list(a.assetId)}>List in the pool</button></>}</div>)}
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();(tab==='shield'?shield:tab==='send'?send:withdraw)();}}>
     {reserves.length>0&&<label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">Bitcoin</option>{reserves.map(id=><option key={id} value={id}>Asset {short(id)}</option>)}</select></label>}
     {tab==='send'&&<label>To<input value={to} onChange={e=>setTo(e.target.value)} placeholder="shrol1…" autoComplete="off" spellCheck={false}/></label>}
     <label>Amount ({unit})<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     <p className="stock-muted">{tab==='shield'?assetId?`Moves units from your Arkade balance into a private note, with ${DUST} sats beside them. The amount is public.`:'Moves sats from your Arkade balance into a private note. The amount is public.':tab==='send'?`Pays from up to three of your notes at once, up to ${sats(maxSend)} ${unit}; the amount and both parties stay private.`:assetId?`Pays out to your Arkade address with a ${DUST}-sat BTC note as its carrier; the amount is public.`:`Pays out to your Arkade address; the amount is public. At least ${DUST} sats.`}</p>
     <button className="stock-primary" disabled={busy||!synced||!amount||(tab==='send'&&!to.trim())}>{busy?'Working…':tab==='shield'?'Shield':tab==='send'?'Send':'Withdraw'}</button>
    </form>}
   </section>
   {(notes.length>0||Object.values(assetNotes).some(list=>list.length))&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">
    {notes.map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span><span className="ok">Spendable</span></div>)}
    {Object.entries(assetNotes).flatMap(([id,list])=>list.map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} units</span><span className="ok">Asset {short(id)}</span></div>))}
   </div></section>}
  </>}
  {!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery secret</h2><p className="stock-muted">It restores this wallet and its Arkade balance in any browser. Anyone who has it can spend your funds.</p>{reveal&&<div className="stock-address"><Copyable value={secret}/></div>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show secret</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <details className="stock-card stock-advanced"><summary>Restore</summary>
   <label>Recovery secret<input value={restore} onChange={e=>setRestore(e.target.value.trim())} autoComplete="off" spellCheck={false}/></label>
   <button disabled={busy||!restore} onClick={()=>{try{parseMasterSecret(restore);localStorage.setItem(SECRET,restore);location.reload();}catch(error){setPoolError((error as Error).message);}}}>Restore wallet</button>
  </details>
 </main></div>;
}
