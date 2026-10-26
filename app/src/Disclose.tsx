import {useEffect,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import {x25519} from '@noble/curves/ed25519.js';
import {decodeDisclosure,parseFullViewKey,parseViewKey,verifyDisclosure,type Disclosure,type IncomingNote} from '../../packages/protocol/src/rollup/disclosure.ts';
import {EpochAccount,type EpochHistoryEntry,type EpochOwnedNote} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf} from '../../packages/protocol/src/rollup/wallet.ts';
import type {RollupEpochRecord} from '../../src/rollup/epoch-operator.ts';
import {epochPoolOf} from '../../src/shielded/epoch-checkpoint.ts';
import {epochIncomingNotes} from '../../src/shielded/epoch-disclosure.ts';
import {epochSyncAccount,poolApiOf,rollupApi,type PoolApi,type RollupPoolStatus} from './rollup-client.ts';

const EXPLORER='https://explorer.mutinynet.arkade.sh';
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'';
const unit=(asset:bigint)=>asset===0n?'sats':'asset units';
const totals=(items:{asset:bigint;amount:bigint}[])=>{const m=new Map<bigint,bigint>();for(const i of items)m.set(i.asset,(m.get(i.asset)??0n)+i.amount);return [...m].map(([asset,amount])=>`${sats(amount)} ${unit(asset)}`).join(' + ');};
const hashFn=async()=>{const poseidon=await buildPoseidon();return (v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));};
/** The shfvk2 replay. The classic replica took every epoch record as chain-only and showed the same balance; this one checks each record's commitments. */
export async function fullViewOf(hash:Hash,key:ReturnType<typeof parseFullViewKey>,api:PoolApi=poolApiOf('')){
 const account=new EpochAccount(hash,key,{epochLen:(await epochPoolOf(api)).epochLen});
 await epochSyncAccount(account,api);
 return account;
}
/** A note reads Unspent only while the account holds it. A payment to oneself across several notes leaves no history entry, so a spent note can have no batch to name. */
export function noteStateOf(account:EpochAccount){
 const spentIn=new Map(account.history.flatMap(e=>e.spent.map(nf=>[nf,e.batch] as const)));
 const held=new Set([...new Set(account.history.flatMap(e=>e.created.map(n=>n.asset)))].flatMap(asset=>account.notes(asset)).map(n=>n.nullifier));
 return (note:EpochOwnedNote)=>held.has(note.nullifier)?'Unspent':spentIn.has(note.nullifier)?`Spent in batch #${spentIn.get(note.nullifier)}`:'Spent';
}
/** /verify: the disclosure resolves against whichever pool answers, so the verdict carries that pool's token. */
export async function checkDisclosure(hash:Hash,disclosure:Disclosure,api:PoolApi=poolApiOf('')):Promise<Checked>{
 const batches:Record<number,RollupEpochRecord|undefined>={};
 for(const n of new Set(disclosure.notes.map(note=>Math.floor(note.index/32))))batches[n]=(await api<{batches:RollupEpochRecord[]}>(`/batches?from=${n}&limit=1`)).batches[0];
 const ok=await verifyDisclosure(hash,disclosure,index=>batches[Math.floor(index/32)]?.slots[Math.floor((index%32)/2)]?.commitments[index%2]);
 return {disclosure,ok,batches,pool:(await api<RollupPoolStatus>('/status').catch(()=>undefined))?.pool?.token};
}

export type Checked={disclosure:Disclosure;ok:boolean[];batches:Record<number,RollupEpochRecord|undefined>;pool?:string};
export type Watched={address:string;notes:IncomingNote[]}|{address:string;entries:EpochHistoryEntry[];state:(note:EpochOwnedNote)=>string};
const kinds={shield:'Shielded',receive:'Received',send:'Sent',withdraw:'Withdrew',merge:'Merged notes',renew:'Refreshed',recover:'Recovered'} as const;

export function Results({checked,watched}:{checked?:Checked;watched?:Watched}){
 return <>
  {checked&&<section className={'stock-card stock-verdict '+(checked.ok.every(Boolean)?'ok':'bad')}>
   <h2>{checked.ok.every(Boolean)?`Verified: ${totals(checked.disclosure.notes)}`:'This does not match the pool'}</h2>
   <p className="stock-muted">{checked.ok.every(Boolean)?'Every note below is exactly the one the pool published at its position, owned by this address.':'At least one note differs from what the pool published, so this payment is not proven. A link minted against a different pool, such as an earlier genesis, cannot verify here.'}</p>
   <dl className="stock-facts"><dt>Pool</dt><dd>{checked.pool?<code>{checked.pool}</code>:'Not reported'}</dd><dt>To</dt><dd><code>{checked.disclosure.to}</code></dd>
    {checked.disclosure.notes.map((note,i)=>{const batch=Math.floor(note.index/32),record=checked.batches[batch];
     return <div key={i} className="stock-fact-row"><dt>Note {i+1}</dt><dd>{checked.ok[i]?'✓':'✗'} {sats(note.amount)} {unit(note.asset)} · batch #{batch}{record?.at?` · ${when(record.at)}`:''}{record?.txid&&<> · <a className="stock-txlink" href={`${EXPLORER}/tx/${record.txid}`} target="_blank" rel="noreferrer">{short(record.txid)} ↗</a></>}</dd></div>;})}
   </dl>
  </section>}
  {watched&&'entries' in watched&&<section className="stock-card stock-history"><h2>{watched.entries.length?'Notes and spends':'No activity yet'}</h2>
   <p className="stock-muted">For <code>{watched.address}</code></p>
   <ul>{watched.entries.slice().reverse().map(e=><li key={`${e.batch}-${e.slots[0]}`}><details><summary><span className={'stock-kind '+e.kind}>{kinds[e.kind]}</span><b className={e.kind==='shield'||e.kind==='receive'?'in':'out'}>{e.amounts.length?totals(e.amounts):'No net change'}</b><time>{when(e.at)}</time></summary>
    <dl><dt>Batch</dt><dd>#{e.batch}{e.txid&&<> · <a className="stock-txlink" href={`${EXPLORER}/tx/${e.txid}`} target="_blank" rel="noreferrer">{short(e.txid)} ↗</a></>}</dd>
     {e.created.map(n=><div key={n.index} className="stock-fact-row"><dt>Note {n.epoch}/{n.index}</dt><dd>{sats(n.amount)} {unit(n.asset)} · {watched.state(n)}</dd></div>)}</dl></details></li>)}</ul>
  </section>}
  {watched&&'notes' in watched&&<section className="stock-card stock-history"><h2>{watched.notes.length?`${watched.notes.length} ${watched.notes.length===1?'note':'notes'} seen`:'No notes seen yet'}</h2>
   <p className="stock-muted">For <code>{watched.address}</code>. A refreshed or recovered note appears again as a new note, so this list does not add up to a balance.</p>
   <ul>{watched.notes.slice().reverse().map(note=><li key={note.index}><details><summary><span className={'stock-kind '+(note.deposit?'shield':'receive')}>{note.deposit?'Shielded':'Received'}</span><b className="in">+{sats(note.amount)} {unit(note.asset)}</b><time>{when(note.at)}</time></summary>
    <dl><dt>Batch</dt><dd>#{note.batch}{note.txid&&<> · <a className="stock-txlink" href={`${EXPLORER}/tx/${note.txid}`} target="_blank" rel="noreferrer">{short(note.txid)} ↗</a></>}</dd><dt>Position</dt><dd>{note.index}</dd></dl></details></li>)}</ul>
  </section>}
 </>;
}

/** /verify#<disclosure> checks one revealed payment; /watch#<view key> lists every note a view key can see. */
export default function Disclose(){
 const watch=location.pathname.startsWith('/watch'),[input,setInput]=useState(decodeURIComponent(location.hash.slice(1)));
 const [checked,setChecked]=useState<Checked>(),[watched,setWatched]=useState<Watched>(),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const run=async(value:string)=>{
  setError('');setChecked(undefined);setWatched(undefined);if(!value.trim())return;setWorking(true);
  try{
   const hash=await hashFn();
   if(watch&&value.trim().startsWith('shfvk')){
    const key=parseFullViewKey(hash,value),account=await fullViewOf(hash,key);
    setWatched({address:rollupAddressOf({owner:key.owner,viewPublic:x25519.getPublicKey(key.viewSecret)}),entries:[...account.history],state:noteStateOf(account)});
   }else if(watch){
    const key=parseViewKey(value),all:RollupEpochRecord[]=[];
    for(;;){const page=await rollupApi<{total:number;batches:RollupEpochRecord[]}>(`/batches?from=${all.length}&limit=100`);all.push(...page.batches);if(all.length>=page.total||!page.batches.length)break;}
    setWatched({address:rollupAddressOf({owner:key.owner,viewPublic:x25519.getPublicKey(key.viewSecret)}),notes:await epochIncomingNotes(hash,all,key)});
   }else setChecked(await checkDisclosure(hash,decodeDisclosure(value.includes('#')?value.slice(value.indexOf('#')+1):value)));
  }catch(error){setError((error as Error).message);}finally{setWorking(false);}
 };
 useEffect(()=>{
  void run(input);
  const changed=()=>{const value=decodeURIComponent(location.hash.slice(1));setInput(value);void run(value);};
  addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);
 },[]);
 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>{watch?'View key':'Verify'}</span></a><a className="stock-home" href="/wallet">Wallet</a></header>
  <section className="stock-card"><h2>{watch?'Watch a wallet with its view key':'Check a revealed payment'}</h2>
   <p className="stock-muted">{watch?'A view key (shview2…) shows every note a wallet received, its own deposits and change included. A full viewing key (shfvk2…) also shows which of them were spent. Neither can spend.':'A revealed payment opens the notes of one private payment, so anyone can check its amount and recipient against what the pool published. It shows nothing else about either wallet.'}</p>
   <form className="stock-send" onSubmit={e=>{e.preventDefault();history.replaceState(null,'',`#${input.trim()}`);void run(input);}}>
    <label>{watch?'View key':'Revealed payment link'}<input value={input} onChange={e=>setInput(e.target.value)} placeholder={watch?'shview21… or shfvk21…':'https://…/verify#…'} autoComplete="off" spellCheck={false}/></label>
    <button className="stock-primary" disabled={working||!input.trim()}>{working?'Checking…':watch?'Show received notes':'Check payment'}</button>
   </form>
   {error&&<p className="stock-blocked">{error}</p>}
  </section>
  <Results checked={checked} watched={watched}/>
 </main></div>;
}
