import {useEffect,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import {x25519} from '@noble/curves/ed25519.js';
import type {PublishedBatch} from '../../packages/protocol/src/rollup/account.ts';
import {decodeDisclosure,incomingNotes,parseViewKey,verifyDisclosure,type Disclosure,type IncomingNote} from '../../packages/protocol/src/rollup/disclosure.ts';
import {rollupAddressOf} from '../../packages/protocol/src/rollup/wallet.ts';
import {rollupApi} from './rollup-client.ts';

const EXPLORER='https://explorer.mutinynet.arkade.sh';
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'';
const unit=(asset:bigint)=>asset===0n?'sats':'asset units';
const batchOf=async(n:number)=>(await rollupApi<{batches:PublishedBatch[]}>(`/batches?from=${n}&limit=1`)).batches[0];
const hashFn=async()=>{const poseidon=await buildPoseidon();return (v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));};

type Checked={disclosure:Disclosure;ok:boolean[];batches:Record<number,PublishedBatch|undefined>};
type Watched={address:string;notes:IncomingNote[]};

/** /verify#<disclosure> checks one revealed payment; /watch#<view key> lists every note a view key can see. */
export default function Disclose(){
 const watch=location.pathname.startsWith('/watch'),[input,setInput]=useState(decodeURIComponent(location.hash.slice(1)));
 const [checked,setChecked]=useState<Checked>(),[watched,setWatched]=useState<Watched>(),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const run=async(value:string)=>{
  setError('');setChecked(undefined);setWatched(undefined);if(!value.trim())return;setWorking(true);
  try{
   const hash=await hashFn();
   if(watch){
    const key=parseViewKey(value),all:PublishedBatch[]=[];
    for(;;){const page=await rollupApi<{total:number;batches:PublishedBatch[]}>(`/batches?from=${all.length}&limit=100`);all.push(...page.batches);if(all.length>=page.total||!page.batches.length)break;}
    setWatched({address:rollupAddressOf({owner:key.owner,viewPublic:x25519.getPublicKey(key.viewSecret)}),notes:await incomingNotes(hash,all,key)});
   }else{
    const disclosure=decodeDisclosure(value.includes('#')?value.slice(value.indexOf('#')+1):value),batches:Record<number,PublishedBatch|undefined>={};
    for(const n of new Set(disclosure.notes.map(note=>Math.floor(note.index/32))))batches[n]=await batchOf(n);
    const ok=await verifyDisclosure(hash,disclosure,index=>batches[Math.floor(index/32)]?.slots[Math.floor((index%32)/2)]?.commitments[index%2]);
    setChecked({disclosure,ok,batches});
   }
  }catch(error){setError((error as Error).message);}finally{setWorking(false);}
 };
 useEffect(()=>{
  void run(input);
  const changed=()=>{const value=decodeURIComponent(location.hash.slice(1));setInput(value);void run(value);};
  addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);
 },[]);
 const totals=(items:{asset:bigint;amount:bigint}[])=>{const m=new Map<bigint,bigint>();for(const i of items)m.set(i.asset,(m.get(i.asset)??0n)+i.amount);return [...m].map(([asset,amount])=>`${sats(amount)} ${unit(asset)}`).join(' + ');};
 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>{watch?'View key':'Verify'}</span></a><a className="stock-home" href="/wallet">Wallet</a></header>
  <section className="stock-card"><h2>{watch?'Watch a wallet with its view key':'Check a revealed payment'}</h2>
   <p className="stock-muted">{watch?'A view key shows every note a wallet received, its own deposits and change included. It cannot spend, and it cannot tell which notes were spent.':'A revealed payment opens the notes of one private payment, so anyone can check its amount and recipient against what the pool published. It shows nothing else about either wallet.'}</p>
   <form className="stock-send" onSubmit={e=>{e.preventDefault();history.replaceState(null,'',`#${input.trim()}`);void run(input);}}>
    <label>{watch?'View key':'Revealed payment link'}<input value={input} onChange={e=>setInput(e.target.value)} placeholder={watch?'shview1…':'https://…/verify#…'} autoComplete="off" spellCheck={false}/></label>
    <button className="stock-primary" disabled={working||!input.trim()}>{working?'Checking…':watch?'Show received notes':'Check payment'}</button>
   </form>
   {error&&<p className="stock-blocked">{error}</p>}
  </section>
  {checked&&<section className={'stock-card stock-verdict '+(checked.ok.every(Boolean)?'ok':'bad')}>
   <h2>{checked.ok.every(Boolean)?`Verified: ${totals(checked.disclosure.notes)}`:'This does not match the pool'}</h2>
   <p className="stock-muted">{checked.ok.every(Boolean)?'Every note below is exactly the one the pool published at its position, owned by this address.':'At least one note differs from what the pool published, so this payment is not proven.'}</p>
   <dl className="stock-facts"><dt>To</dt><dd><code>{checked.disclosure.to}</code></dd>
    {checked.disclosure.notes.map((note,i)=>{const batch=Math.floor(note.index/32),record=checked.batches[batch];
     return <div key={i} className="stock-fact-row"><dt>Note {i+1}</dt><dd>{checked.ok[i]?'✓':'✗'} {sats(note.amount)} {unit(note.asset)} · batch #{batch}{record?.at?` · ${when(record.at)}`:''}{record?.txid&&<> · <a className="stock-txlink" href={`${EXPLORER}/tx/${record.txid}`} target="_blank" rel="noreferrer">{short(record.txid)} ↗</a></>}</dd></div>;})}
   </dl>
  </section>}
  {watched&&<section className="stock-card stock-history"><h2>{watched.notes.length?`Received ${totals(watched.notes)}`:'No notes received yet'}</h2>
   <p className="stock-muted">For <code>{watched.address}</code></p>
   <ul>{watched.notes.slice().reverse().map(note=><li key={note.index}><details><summary><span className={'stock-kind '+(note.deposit?'shield':'receive')}>{note.deposit?'Shielded':'Received'}</span><b className="in">+{sats(note.amount)} {unit(note.asset)}</b><time>{when(note.at)}</time></summary>
    <dl><dt>Batch</dt><dd>#{note.batch}{note.txid&&<> · <a className="stock-txlink" href={`${EXPLORER}/tx/${note.txid}`} target="_blank" rel="noreferrer">{short(note.txid)} ↗</a></>}</dd><dt>Leaf</dt><dd>{note.index}</dd></dl></details></li>)}</ul>
  </section>}
 </main></div>;
}
