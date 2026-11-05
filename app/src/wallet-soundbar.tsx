import {useEffect,useRef,useState} from 'react';
import type {StepState} from '../../src/shielded/handle.ts';
import {PAUSED_ERROR,sheetLine} from './rollup-client.ts';
import {refractionMap,supportsBackdropRefraction} from './wallet-refraction.ts';

export interface SoundbarItem {title:string;line:string;state:'active'|'done'|'failed';steps?:StepState}

/** The one thing the wallet is doing that the bar shows: a running action first, then the wallet's own upkeep. */
export function soundbarItem(o:{sheet?:StepState;recovering:boolean;inFlight:boolean;recoveryLine:string}):SoundbarItem|undefined{
 const s=o.sheet;
 if(s)return {title:s.title,line:sheetLine(s)+(s.error&&s.error!==PAUSED_ERROR&&s.title.startsWith('Shielding')?' It tries again in a minute.':''),state:s.error?'failed':s.done?'done':'active',steps:s};
 if(o.recovering)return {title:'Recovering',line:o.recoveryLine,state:'active'};
 if(o.inFlight)return {title:'Notes in flight',line:'They come back as spendable notes once the batch lands.',state:'active'};
 return undefined;
}

export function useMedia(query:string){
 const [match,setMatch]=useState(()=>matchMedia(query).matches);
 useEffect(()=>{const list=matchMedia(query),changed=()=>setMatch(list.matches);list.addEventListener('change',changed);changed();return()=>list.removeEventListener('change',changed);},[query]);
 return match;
}

export function Soundbar({item,onDismiss}:{item?:SoundbarItem;onDismiss:()=>void}){
 const [open,setOpen]=useState(false),steps=item?.steps;
 const bar=useRef<HTMLElement>(null),visible=Boolean(item);
 const [map,setMap]=useState<{width:number;height:number;href:string}>();
 useEffect(()=>{if(!steps)setOpen(false);},[steps]);
 useEffect(()=>{
  if(!visible||!supportsBackdropRefraction()){setMap(undefined);return;}
  const node=bar.current;
  if(!node)return;
  let frame=0,lastWidth=0,lastHeight=0;
  const measure=()=>{
   cancelAnimationFrame(frame);
   frame=requestAnimationFrame(()=>{
    const rect=node.getBoundingClientRect(),width=Math.round(rect.width),height=Math.round(rect.height);
    if(width<2||height<2){setMap(undefined);return;}
    if(width===lastWidth&&height===lastHeight)return;
    lastWidth=width;lastHeight=height;
    const href=refractionMap(width,height);
    setMap(href?{width,height,href}:undefined);
   });
  };
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);
  observer?.observe(node);
  window.addEventListener('resize',measure);
  measure();
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);cancelAnimationFrame(frame);};
 },[visible]);
 const pct=steps&&!steps.done&&!steps.error?Math.round(100*(steps.current+1)/steps.steps.length):undefined;
 return <>
  {map&&<svg width="0" height="0" aria-hidden="true" focusable="false" style={{position:'absolute',pointerEvents:'none'}}><defs><filter id="wallet-liquid-glass" x="0" y="0" width={map.width} height={map.height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feImage href={map.href} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="displacement"/><feDisplacementMap in="SourceGraphic" in2="displacement" scale="24" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>}
  <aside ref={bar} className={'stock-soundbar'+(item?` is-${item.state}`:' is-idle')+(open?' is-open':'')+(map?' has-refraction':'')} aria-label="Wallet activity">
  {steps&&<ol className="stock-steps" id="stock-soundbar-steps">{steps.steps.map((label,i)=><li key={i} className={steps.error&&i===steps.current?'error':i<steps.current||steps.done?'done':i===steps.current?'active':''}><i/>{label}</li>)}</ol>}
  <div className="stock-soundbar-bar">
   <span className="stock-eq" aria-hidden="true"><i/><i/><i/><i/><i/></span>
   <span className="stock-soundbar-text" role="status" aria-live="polite" aria-atomic="true">{item&&<><b>{item.title}</b><span>{item.line}</span></>}</span>
   {pct!==undefined&&<span className="stock-soundbar-pct">{pct}%</span>}
   {steps&&<button type="button" className="stock-soundbar-toggle" aria-expanded={open} aria-controls="stock-soundbar-steps" aria-label={open?'Hide the steps':'Show the steps'} onClick={()=>setOpen(o=>!o)}/>}
   {item&&item.state!=='active'&&<button type="button" className="stock-soundbar-dismiss" onClick={onDismiss}>Dismiss</button>}
  </div>
  {pct!==undefined&&<span className="stock-soundbar-track" aria-hidden="true"><span style={{width:`${pct}%`}}/></span>}
  </aside>
 </>;
}
