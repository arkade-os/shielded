import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import type {NativeTorHealthState} from './native-tor-monitor.ts';
import './native-tor-health.css';

export const initialTorHealth:NativeTorHealthState={status:{phase:'idle',generation:0},check:'idle'};

export function torPanelPosition(rect:{left:number;top:number;bottom:number},viewport:{width:number;height:number},tone:'light'|'dark'):CSSProperties{
 const edge=16,gap=10,width=Math.min(320,Math.max(0,viewport.width-edge*2)),left=Math.max(edge,Math.min(rect.left,viewport.width-width-edge)),below=Math.max(0,viewport.height-rect.bottom-gap-edge),above=Math.max(0,rect.top-gap-edge);
 const openAbove=tone==='dark'?above>=160||above>=below:above>=below;
 return openAbove?{left,width,bottom:Math.max(edge,viewport.height-rect.top+gap),maxHeight:above}:{left,width,top:rect.bottom+gap,maxHeight:below};
}

export default function NativeTorHealth({health=initialTorHealth,tone='light',onToggleTor,transportBusy=false}:{health?:NativeTorHealthState;tone?:'light'|'dark';onToggleTor?:()=>void;transportBusy?:boolean}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState<CSSProperties>({}),host=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panelId=useId();
 const {status,check,checkedAt,latencyMs}=health;
 const direct=(status.mode??'tor')==='direct';
 const ready=status.phase==='ready',connected=ready&&check==='ok';
 const label=direct?status.phase==='error'||check==='failed'?'Direct connection failed · Tor off':status.phase==='paused'?'Direct paused':ready?(connected?'Tor off · Direct connection':check==='checking'?'Checking direct connection':'Direct ready'):'Connecting directly':status.phase==='paused'?'Tor paused':status.phase==='error'?'Tor unavailable':status.phase==='bootstrapping'?'Connecting to Tor':ready?(connected?'Tor connected':check==='failed'?'Tor check failed':check==='checking'?'Checking Tor':'Tor ready'):'Starting Tor';
 const state=direct&&status.phase==='error'||ready&&check==='failed'?'error':direct?'direct':connected?'connected':status.phase==='error'||ready&&check==='failed'?'error':status.phase==='paused'?'paused':'connecting';
 const progress=!direct&&status.phase==='bootstrapping'&&status.progress&&/^\d{1,3}%$/.test(status.progress)?status.progress:undefined;
 const detail=direct?(status.phase==='paused'?'The direct connection is paused. Unlock the wallet to reconnect.':status.phase==='error'?(status.error||'The direct connection is unavailable. Reconnect to try again.'):ready&&check==='failed'?'The latest direct connection check failed. Tor remains off.':connected?'A recent direct connection to the wallet service succeeded.':ready?'Checking the direct connection to the wallet service.':'Connecting directly to the wallet services.'):status.phase==='paused'?'The private connection is paused. Unlock the wallet to reconnect.':status.phase==='error'?(status.error||'Tor could not start. Reconnect to try again.'):ready&&check==='failed'?'The latest connection check through Tor failed. Your wallet never falls back to a direct connection.':connected?'A recent connection to the wallet service succeeded through Tor.':ready?'Tor is ready. Checking the connection to the wallet service.':'Tor starts automatically and keeps wallet traffic private while it connects.';
 const place=()=>{
  const rect=trigger.current?.getBoundingClientRect();
  if(!rect)return {};
  return torPanelPosition(rect,{width:innerWidth,height:innerHeight},tone);
 };
 const toggle=()=>{
  if(!open)setPosition(place());
  setOpen(value=>!value);
 };
 useLayoutEffect(()=>{
  if(!open)return;
  const update=()=>setPosition(place());
  update();addEventListener('resize',update);addEventListener('scroll',update,true);
  return()=>{removeEventListener('resize',update);removeEventListener('scroll',update,true);};
 },[open,tone]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!host.current?.contains(target)&&!panel.current?.contains(target))setOpen(false);},key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}};
  addEventListener('pointerdown',outside);addEventListener('keydown',key);
  return()=>{removeEventListener('pointerdown',outside);removeEventListener('keydown',key);};
 },[open]);
 useEffect(()=>{
  if(!open)return;
  const frame=requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('[role=switch]')?.focus({preventScroll:true}));
  return()=>cancelAnimationFrame(frame);
 },[open]);
 useEffect(()=>{
  if(typeof document==='undefined')return;
  const root=document.documentElement,sync=()=>{if(root.classList.contains('native-sheet-open'))setOpen(false);};
  sync();const observer=new MutationObserver(sync);observer.observe(root,{attributes:true,attributeFilter:['class']});
  return()=>observer.disconnect();
 },[]);
 const body=<><strong>{label}</strong><p>{detail}</p>
  {progress&&<progress max={100} value={Math.min(100,parseInt(progress,10))} aria-label="Tor bootstrap progress"/>}
  {ready&&checkedAt&&<p className="native-tor-checked">Last checked {new Date(checkedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}{latencyMs!==undefined?` · ${(latencyMs/1000).toFixed(1)}s`:''}</p>}
  {ready&&check==='failed'&&health.error&&<p className="native-tor-problem">{health.error}</p>}
  {onToggleTor&&<button className="native-tor-switch" type="button" role="switch" aria-checked={!direct} disabled={transportBusy} onClick={()=>{if(!transportBusy){setOpen(false);onToggleTor();requestAnimationFrame(()=>trigger.current?.focus());}}}><span>Use Tor</span><span className="native-tor-switch-track" aria-hidden="true"/></button>}
  <p className="native-tor-privacy">{direct?'Your IP address and DNS lookups are exposed. Direct connections have no Tor circuit isolation.':'Separate Tor scopes protect unrelated wallet items. Repeated identifiers and timing can still reveal links. Wallet services may be unavailable even when Tor is connected.'}</p>
 </>;
 const content=<div ref={panel} className="native-tor-panel" id={panelId} role="region" aria-label="Connection details" data-tone={tone} style={position}>{body}</div>;
 return <><div ref={host} className="native-tor-health" data-tone={tone} data-health={state}>
  <button ref={trigger} type="button" className="native-tor-trigger" aria-label={`Wallet connection: ${label}`} aria-expanded={open} aria-controls={panelId} onClick={toggle}><span className="native-tor-dot" aria-hidden="true"/><span role="status" aria-live="polite">{label}{progress&&<span className="native-tor-percent"> {progress}</span>}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></button>
  {typeof document==='undefined'?<div className="native-tor-panel" id={panelId} role="region" aria-label="Connection details" data-tone={tone} hidden>{body}</div>:!open?<div id={panelId} hidden/>:null}
 </div>{open&&typeof document!=='undefined'?createPortal(content,document.body):null}</>;
}
