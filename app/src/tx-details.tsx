import {Fragment,useEffect,useRef,useState,type PointerEvent} from 'react';
import {openUrl} from '@tauri-apps/plugin-opener';
import {Transaction,type TxKey} from '@arkade-os/sdk';
import {base64} from '@scure/base';
import {CopyButton,Icon} from './components.tsx';
import {writeWalletClipboard} from './wallet-clipboard.ts';
import {errorText} from './shielded-page.ts';
import {longPress} from './wallet-gestures.ts';

export type TxKind='ark'|'commitment'|'bitcoin';
export type TxFact=readonly [string,string];
export type TxRead={state:'found';facts:TxFact[]}|{state:'missing'}|{state:'error';message:string};
export interface TxSource {fetch:typeof fetch;indexer:string;esplora:string}
export interface TxView {kind:TxKind|'reveal';value:string;title:string;facts:TxFact[];explorer?:string}

const EXPLORER='https://explorer.mutinynet.arkade.sh',MEMPOOL='https://mempool.mutinynet.arkade.sh';
export const TX_KIND:Record<TxKind,string>={ark:'Arkade transaction',commitment:'Commitment transaction',bitcoin:'Bitcoin transaction'};
const SOURCE:Record<TxKind,string>={ark:'the Arkade indexer',commitment:'the Arkade indexer',bitcoin:'the Bitcoin explorer'};
export const REVEAL_LINE='Anyone with this link can check this payment\'s amount and recipient against the pool, and learns nothing else.';
export const EXPLORER_WARNING='Leaves Shielded: your browser opens the explorer without Tor.';
export const when=(at?:number)=>at?new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unknown';
export const txOf=(key:TxKey)=>key.arkTxid?{kind:'ark' as const,txid:key.arkTxid}:key.commitmentTxid?{kind:'commitment' as const,txid:key.commitmentTxid}:key.boardingTxid?{kind:'bitcoin' as const,txid:key.boardingTxid}:undefined;
export const explorerUrl=(kind:TxKind,txid:string)=>kind==='bitcoin'?`${MEMPOOL}/tx/${txid}`:`${EXPLORER}/${kind==='ark'?'tx':'commitment-tx'}/${txid}`;
export const shortLink=(value:string)=>{const v=value.replace(/^https?:\/\//,'');return v.length>16?`${v.slice(0,8)}…${v.slice(-4)}`:v;};

const MISSING:TxRead={state:'missing'},UNREADABLE:TxRead={state:'error',message:'The service sent an answer this wallet cannot read.'};
const sats=(value:bigint|number|string)=>`${BigInt(value).toLocaleString('en-US')} sats`;
// arkd answers an unknown batch with HTTP 500 "batch not found", not 404.
const refused=(status:number,body:any):TxRead=>status===404||/not found/i.test(String(body?.message??''))?MISSING:{state:'error',message:`The service answered HTTP ${status}.`};
/** What the wallet's own services know about one transaction, read through `source.fetch`: in the app, its Tor transport. */
export async function readTx(kind:TxKind,txid:string,source:TxSource,signal?:AbortSignal):Promise<TxRead>{
 const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30_000)]);
 const get=async(url:string)=>{const response=await source.fetch(url,{signal:deadline});return {ok:response.ok,status:response.status,body:await response.json().catch(()=>undefined)};};
 try{
  if(kind==='bitcoin'){
   const {ok,status,body:tx}=await get(`${source.esplora}/tx/${txid}`);
   if(!ok)return refused(status,tx);
   if(tx?.txid!==txid||typeof tx.status?.confirmed!=='boolean')return UNREADABLE;
   const facts:TxFact[]=[['Status',tx.status.confirmed?'Confirmed':'In the mempool, not confirmed yet']],height=tx.status.block_height;
   if(tx.status.confirmed&&Number.isSafeInteger(height)){
    facts.push(['Block height',height.toLocaleString('en-US')]);
    const tip=await get(`${source.esplora}/blocks`).then(blocks=>blocks.ok?blocks.body?.[0]?.height:undefined,()=>undefined);
    if(Number.isSafeInteger(tip)&&tip>=height)facts.push(['Confirmations',(tip-height+1).toLocaleString('en-US')]);
    if(tx.status.block_time>0)facts.push(['Mined',when(tx.status.block_time*1000)]);
   }
   if(Number.isSafeInteger(tx.fee))facts.push(['Fee',`${sats(tx.fee)}${tx.weight>0?` · ${(tx.fee/Math.ceil(tx.weight/4)).toFixed(1)} sat/vB`:''}`]);
   return {state:'found',facts};
  }
  if(kind==='ark'){
   const {ok,status,body}=await get(`${source.indexer}/v1/indexer/virtualTx/${txid}`);
   if(!ok)return refused(status,body);
   if(!Array.isArray(body?.txs))return UNREADABLE;
   if(!body.txs.length)return MISSING;
   const tx=Transaction.fromPSBT(base64.decode(body.txs[0]));
   if(tx.id!==txid)return UNREADABLE;
   let total=0n;for(let i=0;i<tx.outputsLength;i++)total+=tx.getOutput(i).amount??0n;
   return {state:'found',facts:[['Inputs',String(tx.inputsLength)],['Outputs',`${tx.outputsLength} · ${sats(total)}`]]};
  }
  const {ok,status,body:batch}=await get(`${source.indexer}/v1/indexer/commitmentTx/${txid}`);
  if(!ok)return refused(status,batch);
  if(typeof batch?.totalInputAmount!=='string'||typeof batch.totalOutputAmount!=='string')return UNREADABLE;
  const ended=Number(batch.endedAt);
  return {state:'found',facts:[...(ended>0?[['Batch ended',when(ended*1000)] as const]:[]),['Inputs',`${batch.totalInputVtxos} VTXOs · ${sats(batch.totalInputAmount)}`],['Outputs',`${batch.totalOutputVtxos} VTXOs · ${sats(batch.totalOutputAmount)}`]]};
 }catch(error){
  return {state:'error',message:deadline.aborted&&!signal?.aborted?'The service did not answer in time.':errorText(error)};
 }
}

function useHoldCopy(value:string){
 const [note,setNote]=useState<string>(),latest=useRef(value),touch=useRef(false),down=useRef(false),owed=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>(undefined);latest.current=value;
 const show=(text:string)=>{setNote(text);clearTimeout(timer.current);timer.current=setTimeout(()=>setNote(undefined),1500);};
 const copy=()=>Promise.resolve().then(()=>writeWalletClipboard(latest.current));
 // A touch hold carries no user activation until it lifts, so a write refused mid-hold is retried on the release, which does.
 const [press]=useState(()=>longPress(()=>{void copy().then(()=>show('Copied'),()=>{if(down.current)owed.current=true;else show('Couldn’t copy');});}));
 const release=(retry:boolean)=>{press.up();down.current=false;if(!owed.current)return;owed.current=false;if(retry)void copy().then(()=>show('Copied'),()=>show('Couldn’t copy'));else show('Couldn’t copy');};
 useEffect(()=>()=>{press.up();clearTimeout(timer.current);},[press]);
 return {note,spent:press.spent,bind:{
  onPointerDown:(event:PointerEvent)=>{touch.current=event.pointerType!=='mouse';owed.current=false;if(touch.current&&event.isPrimary){down.current=true;press.down(event.clientX,event.clientY);}},
  onPointerMove:(event:PointerEvent)=>press.move(event.clientX,event.clientY),
  onPointerUp:()=>release(true),onPointerCancel:()=>release(false),onPointerLeave:()=>release(false),
  // The WebView's own hold would select the text or open a menu over the copy.
  onContextMenu:(event:{preventDefault:()=>void})=>{if(touch.current)event.preventDefault();},
 }};
}

/** Every link-like value in an activity row: a tap opens it in the app, a hold copies `copy`. */
export function ActivityLink({value,copy=value,onOpen}:{value:string;copy?:string;onOpen:()=>void}){
 const hold=useHoldCopy(copy);
 return <button type="button" className="stock-txlink" aria-haspopup="dialog" title="Tap for details, hold to copy" {...hold.bind} onClick={()=>{if(!hold.spent())onOpen();}}><span aria-live="polite">{hold.note??shortLink(value)}</span></button>;
}

const Facts=({facts}:{facts:readonly TxFact[]})=><dl className="stock-facts">{facts.map(([label,value])=><Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>;

export function TxSheet({view,source,native,onClose}:{view:TxView;source:TxSource;native:boolean;onClose:()=>void}){
 const kind=view.kind==='reveal'?undefined:view.kind,layer=useRef<HTMLDialogElement>(null),close=useRef<HTMLButtonElement>(null),hold=useHoldCopy(view.value);
 const [read,setRead]=useState<TxRead>(),[attempt,setAttempt]=useState(0),[blocked,setBlocked]=useState(false);
 useEffect(()=>{
  const node=layer.current,previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
  // Taken in window's capture phase, so the Activity sheet's own Escape listener beneath never sees it.
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();event.preventDefault();onClose();}};
  if(node&&!node.open)node.showModal();close.current?.focus();addEventListener('keydown',key,true);
  return()=>{removeEventListener('keydown',key,true);node?.close();if(previous?.isConnected)previous.focus();};
 },[onClose]);
 useEffect(()=>{
  if(!kind)return;
  const controller=new AbortController();setRead(undefined);
  void readTx(kind,view.value,source,controller.signal).then(result=>{if(!controller.signal.aborted)setRead(result);});
  return()=>controller.abort();
 },[kind,view.value,source,attempt]);
 const again=<button type="button" className="stock-ghost stock-mini" onClick={()=>setAttempt(n=>n+1)}>Check again</button>;
 return <dialog ref={layer} className="tx-sheet-layer" aria-labelledby="tx-sheet-title" data-pull-refresh-ignore="" onCancel={event=>{event.preventDefault();onClose();}} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section className="stock-card tx-sheet">
   <header><small>{kind?TX_KIND[kind]:'Reveal link'}</small><button ref={close} type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={18}/></button></header>
   <h2 id="tx-sheet-title">{view.title}</h2>
   <Facts facts={view.facts}/>
   <div className="stock-copy"><code {...hold.bind}>{view.value}</code><CopyButton value={view.value}/></div>
   {hold.note&&<small role="status">{hold.note}</small>}
   {!kind?<p className="stock-muted">{REVEAL_LINE}</p>
    :<div className="tx-sheet-read" aria-live="polite"><small>From {SOURCE[kind]}</small>
     {!read?<p className="stock-muted">Loading…</p>
      :read.state==='found'?<Facts facts={read.facts}/>
      :read.state==='missing'?<p className="stock-muted">Not found yet: {SOURCE[kind]} has no record of this transaction. A new one can take a moment to appear. {again}</p>
      :<p className="stock-blocked" role="alert">Could not read this transaction. {read.message} {again}</p>}</div>}
   {view.explorer&&(native?<div className="tx-sheet-explorer"><button type="button" className="stock-ghost stock-mini" onClick={()=>{setBlocked(false);void openUrl(view.explorer!).catch(()=>setBlocked(true));}}>Open in explorer ↗</button><p className="stock-muted">{EXPLORER_WARNING}</p>
     {blocked&&<><p className="stock-blocked" role="alert">The explorer could not be opened. Copy its link instead.</p><div className="stock-copy"><code>{view.explorer}</code><CopyButton value={view.explorer}/></div></>}</div>
    :<p className="stock-muted"><a href={view.explorer} target="_blank" rel="noreferrer">Open in explorer ↗</a></p>)}
  </section>
 </dialog>;
}
