import {useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {ArkAddress,SingleKey} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {RollupAccount,type BuiltSpend,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import {parseRollupAddress,rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeyMaterial,deriveWalletKeyMaterial,parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {openCustomerArkWallet} from '../../src/stock/ark-wallet.ts';
import {checkSigningRequest,DUST,pickNote,rollupApi,signDeposit,spendBody,syncAccount,waitForSpend,type RollupPoolStatus,type SpendStatus} from './rollup-client.ts';
import {CopyButton} from './components.tsx';

const SECRET='shielded-rollup-wallet-secret-v1',BACKED_UP='shielded-rollup-wallet-backed-up-v1';
type Tab='receive'|'shield'|'send'|'withdraw';
type Activity={title:string;steps:string[];current:number;done?:boolean;error?:string};
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US');
const amountOf=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('Enter a whole number of sats.');return BigInt(n);};
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
// Key URLs carry their hashes, so a browser cache can only ever hold the keys this pool proves with.
const prove=async(built:BuiltSpend,keys:{wasm:string;zkey:string})=>(await snarkjs.groth16.fullProve(toCircuitInput(built.witness.input),`/api/rollup/proving/spend.wasm?v=${keys.wasm}`,`/api/rollup/proving/spend.zkey?v=${keys.zkey}`,undefined,undefined,{singleThread:true})).proof;

export default function RollupWallet(){
 const [pool,setPool]=useState<RollupPoolStatus>(),[poolError,setPoolError]=useState('');
 const [secret,setSecret]=useState(()=>localStorage.getItem(SECRET)??''),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false),[restore,setRestore]=useState('');
 const [notes,setNotes]=useState<OwnedNote[]>([]),[synced,setSynced]=useState(false),[ark,setArk]=useState<{address:string;available:number}>();
 const [tab,setTab]=useState<Tab>('receive'),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[activity,setActivity]=useState<Activity>(),[busy,setBusy]=useState(false);
 const account=useRef<RollupAccount|undefined>(undefined),self=useRef<RollupRecipient|undefined>(undefined),busyRef=useRef(false);

 useEffect(()=>{if(!secret){const fresh=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));localStorage.setItem(SECRET,fresh);setSecret(fresh);}},[secret]);
 useEffect(()=>{
  let stop=false;
  const poll=async()=>{try{const status=await rollupApi<RollupPoolStatus>('/status');if(!stop){setPool(status);setPoolError('');}}catch(error){if(!stop)setPoolError((error as Error).message);}if(!stop&&!account.current)setTimeout(poll,10_000);};
  void poll();return()=>{stop=true;};
 },[]);
 const native=()=>SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret);
 const refreshArk=async()=>{if(!pool?.network)return;const wallet=await openCustomerArkWallet(native(),pool.network);setArk({address:wallet.address,available:(await wallet.wallet.getBalance()).available});return wallet;};
 const sync=async()=>{if(!account.current)return;await syncAccount(account.current);setNotes(account.current.notes());setSynced(true);};
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
 const submit=async(built:BuiltSpend,step:(n:number)=>void,first:number,extra:Parameters<typeof spendBody>[3]={},coin?:{txid:string;vout:number})=>{
  step(first);const proof=await prove(built,pool!.proving!.spend);
  step(first+1);const id=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));await rollupApi('/spends',spendBody(id,built,proof,extra));
  step(first+2);
  return waitForSpend(id,async request=>{
   if(!coin)throw new Error('The pool asked to sign a spend with no deposit coin.');
   checkSigningRequest(request,coin,pool!.pool!.script);step(first+3);
   await rollupApi(`/spends/${id}/sign`,await signDeposit(native(),request));
  });
 };
 const shield=()=>void run('Shielding',['Prepare an exact coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],async step=>{
  const sats=amountOf(amount);if(sats<DUST)throw new Error(`Shield at least ${DUST} sats.`);
  step(0);const wallet=(await refreshArk())!,txid=await wallet.wallet.send({recipients:[{address:wallet.address,amount:Number(sats)}]});
  let coin;for(let i=0;i<30&&!coin;i++){await new Promise(r=>setTimeout(r,1000));coin=(await openCustomerArkWallet(native(),pool!.network)).coins.find(c=>c.funding.txid===txid&&c.funding.value===Number(sats))?.funding;}
  if(!coin)throw new Error('The exact coin did not appear in your Arkade wallet; try again.');
  const built=await account.current!.spend({deposit:sats},self.current!);
  return submit(built,step,1,{coin:{txid:coin.txid,vout:coin.vout,tapTree:coin.tapTreeHex,leaf:coin.leafHex}},coin);
 });
 // A payment of several notes is one group: prove all, submit in the order its id commits to, then wait for every member.
 const send=()=>void run('Sending privately',['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const spends=await account.current!.pay(parseRollupAddress(to.trim()),amountOf(amount),self.current!);
  step(1);const proofs=[];for(const built of spends)proofs.push(await prove(built,pool!.proving!.spend));
  step(2);const ids:string[]=[];for(const [i,built] of spends.entries()){const id=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));await rollupApi('/spends',spendBody(id,built,proofs[i]!));ids.push(id);}
  step(3);const finals=await Promise.all(ids.map(id=>waitForSpend(id,async()=>{throw new Error('The pool asked to sign a payment that has no deposit.');})));
  return finals.find(f=>f.status==='dropped')??finals[0]!;
 });
 const withdraw=()=>void run('Withdrawing',['Pick a note','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],async step=>{
  step(0);const value=amountOf(amount);if(value<BigInt(DUST))throw new Error(`Withdraw at least ${DUST} sats.`);
  const input=pickNote(account.current!.notes(),value,new Set());if(!input)throw new Error('No single note covers this amount.');
  const program=ArkAddress.decode(ark!.address).pkScript.subarray(2);
  return submit(await account.current!.spend({input,withdraw:value,program},self.current!),step,1,{program});
 });

 const balance=notes.reduce((sum,n)=>sum+n.amount,0n),address=self.current?rollupAddressOf(self.current):'';
 const maxSend=[...notes].sort((a,b)=>a.amount<b.amount?1:-1).slice(0,3).reduce((sum,n)=>sum+n.amount,0n);
 const ready=pool?.phase==='ready';
 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>v2 pool</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test pool</strong><span>Development proving keys and test funds only. Payments inside the pool hide their amount, sender and recipient; deposits and withdrawals show their amounts.</span></section>
  {!ready&&<section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><div><h2>{pool?pool.phase==='blocked'?'The pool is stopped':'The pool is being set up':'Connecting to the pool'}</h2><p className="stock-muted">{poolError||pool?.message}</p></div></section>}
  {ready&&<>
   <section className="stock-card stock-balance">
    <div><small>SHIELDED BALANCE{!synced&&' · SYNCING'}</small><strong>{sats(balance)} <em>sats</em></strong></div>
    <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{ark?`${sats(ark.available)} sats`:'Loading…'}</b></div><div><small>POOL</small><b>{pool!.pool!.batches} batches</b></div></div>
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
    </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();(tab==='shield'?shield:tab==='send'?send:withdraw)();}}>
     {tab==='send'&&<label>To<input value={to} onChange={e=>setTo(e.target.value)} placeholder="shrol1…" autoComplete="off" spellCheck={false}/></label>}
     <label>Amount (sats)<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))}/></label>
     <p className="stock-muted">{tab==='shield'?'Moves sats from your Arkade balance into a private note. The amount is public.':tab==='send'?`Pays from up to three of your notes at once, up to ${sats(maxSend)} sats; the amount and both parties stay private.`:`Pays out to your Arkade address; the amount is public. At least ${DUST} sats.`}</p>
     <button className="stock-primary" disabled={busy||!synced||!amount||(tab==='send'&&!to.trim())}>{busy?'Working…':tab==='shield'?'Shield':tab==='send'?'Send':'Withdraw'}</button>
    </form>}
   </section>
   {notes.length>0&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">{notes.map(n=><div key={String(n.nullifier)}><span>{sats(n.amount)} sats</span><span className="ok">Spendable</span></div>)}</div></section>}
  </>}
  {!backedUp&&secret&&<section className="stock-card stock-recovery"><h2>Save your recovery secret</h2><p className="stock-muted">It restores this wallet and its Arkade balance in any browser. Anyone who has it can spend your funds.</p>{reveal&&<div className="stock-address"><Copyable value={secret}/></div>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show secret</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <details className="stock-card stock-advanced"><summary>Restore</summary>
   <label>Recovery secret<input value={restore} onChange={e=>setRestore(e.target.value.trim())} autoComplete="off" spellCheck={false}/></label>
   <button disabled={busy||!restore} onClick={()=>{try{parseMasterSecret(restore);localStorage.setItem(SECRET,restore);location.reload();}catch(error){setPoolError((error as Error).message);}}}>Restore wallet</button>
  </details>
 </main></div>;
}
