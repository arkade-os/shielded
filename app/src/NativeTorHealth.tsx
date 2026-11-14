import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties,type PointerEvent} from 'react';
import {createPortal} from 'react-dom';
import type {NativeTorHealthState} from './native-tor-monitor.ts';
import './native-tor-health.css';

export const initialTorHealth:NativeTorHealthState={status:{phase:'idle',generation:0},check:'idle'};

export function torPanelPosition(rect:{left:number;top:number;bottom:number},viewport:{width:number;height:number},tone:'light'|'dark'):CSSProperties{
 const edge=16,gap=10,width=Math.min(320,Math.max(0,viewport.width-edge*2)),left=Math.max(edge,Math.min(rect.left,viewport.width-width-edge)),below=Math.max(0,viewport.height-rect.bottom-gap-edge),above=Math.max(0,rect.top-gap-edge);
 const openAbove=tone==='dark'?above>=160||above>=below:above>=below;
 return openAbove?{left,width,bottom:Math.max(edge,viewport.height-rect.top+gap),maxHeight:above}:{left,width,top:rect.bottom+gap,maxHeight:below};
}

export function bindTorPanelDismiss(target:EventTarget,inside:(node:EventTarget|null)=>boolean,close:()=>void,focus:()=>void){
 const outside=(event:Event)=>{if(!inside(event.target))close();},key=(event:Event)=>{if((event as KeyboardEvent).key==='Escape'){close();focus();}};
 target.addEventListener('pointerdown',outside);target.addEventListener('keydown',key);
 return()=>{target.removeEventListener('pointerdown',outside);target.removeEventListener('keydown',key);};
}

export default function NativeTorHealth({health=initialTorHealth,tone='light',onToggleTor,onReconnect,reconnectBusy=false,problem='',transportBusy=false,open:controlledOpen,onOpenChange,compact=false}:{health?:NativeTorHealthState;tone?:'light'|'dark';onToggleTor?:()=>void;onReconnect?:()=>void;reconnectBusy?:boolean;problem?:string;transportBusy?:boolean;open?:boolean;onOpenChange?:(open:boolean)=>void;compact?:boolean}){
 const [localOpen,setLocalOpen]=useState(false),[position,setPosition]=useState<CSSProperties>({}),host=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panelId=useId();
 const hover=useRef<{open:boolean;timer?:ReturnType<typeof setTimeout>}>({open:false});
 const controlled=controlledOpen!==undefined,open=controlledOpen??localOpen,setOpen=useCallback((value:boolean)=>{if(!controlled)setLocalOpen(value);onOpenChange?.(value);},[controlled,onOpenChange]);
 const {status,check,checkedAt,latencyMs,attempt,retryAt}=health;
 const direct=(status.mode??'tor')==='direct';
 const ready=status.phase==='ready',connected=ready&&check==='ok',delayed=connected&&!!problem;
 const retryingFirstTorCheck=!direct&&ready&&check==='failed'&&(attempt??1)<=1;
 const attemptSuffix=(attempt??1)>1?` · try ${attempt}`:'';
 const label=delayed?(direct?'Tor off · wallet data delayed':'Tor connected · wallet data delayed'):direct?status.phase==='error'||check==='failed'?'Direct service check failed · Tor off':status.phase==='paused'?'Direct paused':ready?(connected?'Tor off · Direct connection':check==='checking'?`Checking direct connection${attemptSuffix}`:'Direct ready'):'Connecting directly':status.phase==='paused'?'Tor paused':status.phase==='error'?'Tor unavailable':status.phase==='bootstrapping'?'Building Tor circuits':ready?(connected?'Tor connected':retryingFirstTorCheck?'Tor connected · retrying service check':check==='failed'?'Private route unavailable · retrying':check==='checking'?`Verifying private route${attemptSuffix}`:'Tor ready'):'Starting Tor';
 const state=delayed||direct&&(status.phase==='error'||ready&&check==='failed')?'error':direct?'direct':connected?'connected':retryingFirstTorCheck?'connecting':status.phase==='error'||ready&&check==='failed'?'error':status.phase==='paused'?'paused':'connecting';
 const progress=!direct&&status.phase==='bootstrapping'&&status.progress&&/^\d{1,3}%$/.test(status.progress)?status.progress:undefined;
 const now=Date.now(),retryIn=retryAt===undefined||retryAt<=now?undefined:Math.ceil((retryAt-now)/1000);
 const detail=direct?(status.phase==='paused'?'The direct connection is paused. Unlock the wallet to reconnect.':status.phase==='error'?(status.error||'The direct connection is unavailable. Reconnect to try again.'):ready&&check==='failed'?`Tor is still off. The wallet-service check failed through the direct connection; Shielded is retrying${retryIn?` in about ${retryIn}s`:''}.`:connected?'A recent direct connection to the wallet service succeeded.':ready?'Checking the direct connection to the wallet service.':'Connecting directly to the wallet services.'):status.phase==='paused'?'The private connection is paused. Unlock the wallet to reconnect.':status.phase==='error'?(status.error||'Tor could not start. Reconnect to try again.'):ready&&check==='failed'?`Tor is working, but the isolated wallet-service check failed. Shielded is retrying${retryIn?` in about ${retryIn}s`:''} automatically while Tor stays on and never falls back to a direct connection.`:connected?'A recent connection to the wallet service succeeded through Tor.':status.phase==='bootstrapping'?'Embedded Tor is building its circuits. The first connection can take a minute; no wallet traffic uses the direct network while this is running.':ready?'Tor is ready. Checking the connection to the wallet service.':'Tor starts automatically and keeps wallet traffic private while it connects.';
 const place=()=>{
  const rect=trigger.current?.getBoundingClientRect();
  if(!rect)return {};
  return torPanelPosition(rect,{width:innerWidth,height:innerHeight},tone);
 };
 const toggle=()=>{
  if(hover.current.open){hover.current.open=false;return;}
  if(!open)setPosition(place());
  setOpen(!open);
 };
 // A mouse opens the compact panel on hover; clicking then pins it, and leaving both trigger and panel closes an unpinned one.
 const hoverIn=(event:PointerEvent)=>{if(!compact||event.pointerType!=='mouse')return;clearTimeout(hover.current.timer);if(!open){hover.current.open=true;setPosition(place());setOpen(true);}};
 const hoverOut=(event:PointerEvent)=>{if(!compact||event.pointerType!=='mouse'||!hover.current.open)return;clearTimeout(hover.current.timer);hover.current.timer=setTimeout(()=>{hover.current.open=false;setOpen(false);},250);};
 useEffect(()=>{if(!open)hover.current.open=false;return()=>clearTimeout(hover.current.timer);},[open]);
 useLayoutEffect(()=>{
  if(!open)return;
  const update=()=>setPosition(place());
  update();addEventListener('resize',update);addEventListener('scroll',update,true);
  return()=>{removeEventListener('resize',update);removeEventListener('scroll',update,true);};
 },[open,tone]);
 useEffect(()=>{
  if(!open)return;
  return bindTorPanelDismiss(window,target=>!!host.current?.contains(target as Node)||!!panel.current?.contains(target as Node),()=>setOpen(false),()=>trigger.current?.focus());
 },[open,setOpen]);
 useEffect(()=>{
  if(!open||hover.current.open)return;
  const frame=requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('[role=switch]')?.focus({preventScroll:true}));
  return()=>cancelAnimationFrame(frame);
 },[open]);
 useEffect(()=>{
  if(typeof document==='undefined')return;
  const root=document.documentElement,sync=()=>{if(root.classList.contains('native-sheet-open'))setOpen(false);};
  sync();const observer=new MutationObserver(sync);observer.observe(root,{attributes:true,attributeFilter:['class']});
  return()=>observer.disconnect();
 },[setOpen]);
 const body=<><strong>{label}</strong><p>{detail}</p>
  {progress&&<progress max={100} value={Math.min(100,parseInt(progress,10))} aria-label="Tor bootstrap progress"/>}
  {ready&&checkedAt&&<p className="native-tor-checked">Last checked {new Date(checkedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}{latencyMs!==undefined?` · ${(latencyMs/1000).toFixed(1)}s`:''}</p>}
  {ready&&check==='failed'&&health.error&&<p className="native-tor-problem">{health.error}</p>}
  {problem&&<p className="native-tor-problem">{problem}</p>}
  {onReconnect&&<button className="native-tor-switch native-tor-reconnect" type="button" disabled={transportBusy||reconnectBusy} onClick={()=>{if(!transportBusy&&!reconnectBusy){setOpen(false);onReconnect();}}}><span>Reconnect</span><span className="native-tor-reconnect-hint">{reconnectBusy?'After the payment in progress':direct?'Wallet reopens':'New Tor circuits, wallet reopens'}</span></button>}
  {onToggleTor&&<button className="native-tor-switch" type="button" role="switch" aria-checked={!direct} disabled={transportBusy} onClick={()=>{if(!transportBusy){setOpen(false);onToggleTor();requestAnimationFrame(()=>trigger.current?.focus());}}}><span>Use Tor</span><span className="native-tor-switch-track" aria-hidden="true"/></button>}
  <p className="native-tor-privacy">{direct?'Your IP address and DNS lookups are exposed. Direct connections have no Tor circuit isolation.':'Separate Tor scopes protect unrelated wallet items. Repeated identifiers and timing can still reveal links. Wallet services may be unavailable even when Tor is connected.'}</p>
 </>;
 const content=<div ref={panel} className="native-tor-panel" id={panelId} role="region" aria-label="Connection details" data-tone={tone} style={position} onPointerEnter={hoverIn} onPointerLeave={hoverOut}>{body}</div>;
 return <><div ref={host} className="native-tor-health" data-tone={tone} data-health={state} data-compact={compact||undefined} onPointerEnter={hoverIn} onPointerLeave={hoverOut}>
  <button ref={trigger} type="button" className="native-tor-trigger" aria-label={`Wallet connection: ${label}`} aria-expanded={open} aria-controls={panelId} onClick={toggle}>{compact
   ?<><svg className="native-tor-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4.5c4 2.2 6.5 5.1 6.5 8.8a6.5 6.5 0 0 1-13 0c0-3.7 2.5-6.6 6.5-8.8Z"/><path d="M12 9.2c1.9 1.2 3 2.6 3 4.3a3 3 0 0 1-6 0c0-1.7 1.1-3.1 3-4.3Z"/><path d="M12 4.5c0-1.2.6-2.2 1.8-2.8"/>{direct&&<path d="m3.5 3.5 17 17"/>}</svg><span className="native-tor-dot" aria-hidden="true"/><span className="native-tor-live" role="status" aria-live="polite">{label}{progress&&` ${progress}`}</span></>
   :<><span className="native-tor-dot" aria-hidden="true"/><span role="status" aria-live="polite">{label}{progress&&<span className="native-tor-percent"> {progress}</span>}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></>}</button>
  {typeof document==='undefined'?<div className="native-tor-panel" id={panelId} role="region" aria-label="Connection details" data-tone={tone} hidden>{body}</div>:!open?<div id={panelId} hidden/>:null}
 </div>{open&&typeof document!=='undefined'?createPortal(content,document.body):null}</>;
}
