import {useEffect,useRef,useState,type CSSProperties,type KeyboardEvent,type ReactNode,type TouchEvent} from 'react';
import {CopyButton,Icon} from './components.tsx';
import {QrCode} from './wallet-qr.tsx';
import {GlassRefraction} from './wallet-glass-surface.tsx';
import {bindSwipeGesture} from './wallet-gestures.ts';
import {invoiceInRange,type InvoiceBounds} from './rollup-client.ts';
import './wallet-receive.css';

export type ReceiveMode='unified'|'shielded'|'arkade';
export type ReceivePayload='unified'|'shielded'|'lightning'|'invoice'|'arkade';

type ReceivePortalProps={
 active?:boolean;
 mode:ReceiveMode;
 payload:ReceivePayload;
 onModeChange:(mode:ReceiveMode)=>void;
 value:string;
 qrValue?:string;
 amount?:string;
 onAmount?:(amount:string)=>void;
 loading?:string;
 description:string;
 action?:ReactNode;
 children?:ReactNode;
};

const MODES:[ReceiveMode,string,string][]=[
 ['unified','Unified','flow'],
 ['shielded','Shielded','shield'],
 ['arkade','Arkade','wallet'],
];
const TITLES:Record<ReceivePayload,string>={unified:'Unified address',shielded:'Shielded address',lightning:'Lightning address',invoice:'Lightning invoice',arkade:'Arkade address'};
const LABELS:Record<ReceivePayload,string>={unified:'Unified address',shielded:'Shielded address',lightning:'Lightning address',invoice:'Lightning invoice',arkade:'Arkade address'};
const short=(value:string)=>value.length>48?`${value.slice(0,20)}…${value.slice(-12)}`:value;

export const receiveAmount=(amount:string):bigint|undefined=>/^[1-9]\d{0,9}$/.test(amount)?BigInt(amount):undefined;
export function invoiceRequestAmount(amount:string,bounds:InvoiceBounds|undefined):bigint|undefined{
 const sats=receiveAmount(amount);
 return sats!==undefined&&bounds&&invoiceInRange(bounds,sats)?sats:undefined;
}
export function amountQrValue(mode:ReceiveMode,value:string,amount:string):string|undefined{
 const sats=receiveAmount(amount);
 if(!value.trim()||sats===undefined)return undefined;
 const btc=(sats/100000000n).toString()+'.'+String(sats%100000000n).padStart(8,'0');
 const destination=mode==='unified'?value.toLowerCase():value;
 return `bitcoin:?${mode==='unified'?'lightning':mode==='shielded'?'shielded':'ark'}=${destination}&amount=${btc}`;
}

export function ReceivePortal({active=true,mode,payload,onModeChange,value,qrValue,amount,onAmount,loading,description,action,children}:ReceivePortalProps){
 const [expanded,setExpanded]=useState(false);
 const buttons=useRef<(HTMLButtonElement|null)[]>([]);
 const strip=useRef<HTMLDivElement>(null),lens=useRef<HTMLSpanElement>(null);
 const start=useRef<{x:number;y:number}|null>(null);
 const selected=MODES.findIndex(([id])=>id===mode);
 const navigation=useRef({selected,onModeChange});navigation.current={selected,onModeChange};
 const canShare=typeof navigator!=='undefined'&&typeof navigator.share==='function';
 const invoice=payload==='invoice';
 const invalidAmount=!!amount&&receiveAmount(amount)===undefined;
 const displayValue=invalidAmount?'':value;
 useEffect(()=>setExpanded(false),[mode,value]);
 useEffect(()=>{
  if(!active||!strip.current)return;
  return bindSwipeGesture(strip.current,direction=>{
   const view=navigation.current,index=view.selected+(direction==='next'?1:-1),next=MODES[index];
   if(next){view.onModeChange(next[0]);buttons.current[index]?.focus();}
  },{allowButtons:true});
 },[active]);

 const keyTab=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
  let next:number;
  if(event.key==='ArrowRight')next=(index+1)%MODES.length;
  else if(event.key==='ArrowLeft')next=(index+MODES.length-1)%MODES.length;
  else if(event.key==='Home')next=0;
  else if(event.key==='End')next=MODES.length-1;
  else return;
  event.preventDefault();
  onModeChange(MODES[next]![0]);
  buttons.current[next]?.focus();
 };
 const touchStart=(event:TouchEvent<HTMLDivElement>)=>{
  const target=event.target as HTMLElement;
  const touch=event.touches[0];
  start.current=touch&&!target.closest('button,a,input,textarea,select,summary')?{x:touch.clientX,y:touch.clientY}:null;
 };
 const touchEnd=(event:TouchEvent<HTMLDivElement>)=>{
  const origin=start.current,touch=event.changedTouches[0];
  start.current=null;
  if(!origin||!touch)return;
  const dx=touch.clientX-origin.x,dy=touch.clientY-origin.y;
  if(Math.abs(dx)<48||Math.abs(dx)<Math.abs(dy)*1.35)return;
  const next=selected+(dx<0?1:-1);
  if(MODES[next])onModeChange(MODES[next][0]);
 };

 return <section className="receive-portal" aria-label="Receive payment">
  <div ref={strip} className="receive-pill wallet-glass-track" style={{'--glass-index':selected,'--glass-count':3} as CSSProperties} role="tablist" aria-label="Receive with">
   <span ref={lens} className="wallet-glass-lens" aria-hidden="true"/>
   {MODES.map(([id,label,icon],index)=><button key={id} ref={element=>{buttons.current[index]=element;}} type="button" role="tab" id={`receive-tab-${id}`} aria-selected={mode===id} aria-controls="receive-display" tabIndex={mode===id?0:-1} className={mode===id?'is-selected':''} onClick={()=>onModeChange(id)} onKeyDown={event=>keyTab(event,index)}><Icon name={icon} size={17}/><span>{label}</span></button>)}
  </div>
  <div id="receive-display" className="receive-display" role="tabpanel" aria-labelledby={`receive-tab-${mode}`} onTouchStart={touchStart} onTouchEnd={touchEnd} onTouchCancel={()=>{start.current=null;}}>
   <div key={mode} className="receive-stage">
    <div className="receive-stage-copy"><span className="receive-stage-mark" aria-hidden="true"><Icon name={payload==='invoice'?'bolt':MODES[selected]?.[2]??'shield'} size={17}/></span><h2>{TITLES[payload]}</h2></div>
    {displayValue?<div className="receive-qr-wrap"><QrCode value={qrValue??displayValue} label={`QR code for your ${LABELS[payload].toLowerCase()}`}/></div>
     :<div className="receive-empty" role="status"><Icon name={MODES[selected]?.[2]??'shield'} size={34}/><span>{invalidAmount?'Enter a valid amount to show your payment QR.':loading??'Your address will appear here.'}</span></div>}
    {displayValue&&<div className="receive-address"><span>{LABELS[payload]}</span>{short(displayValue)===displayValue?<code>{displayValue}</code>:<button type="button" className="receive-address-value" aria-expanded={expanded} title={expanded?'Show less':'Show full address'} onClick={()=>setExpanded(open=>!open)}><code>{expanded?displayValue:short(displayValue)}</code></button>}</div>}
   </div>
   <p className="receive-description">{description}</p>
   {displayValue&&<div className="receive-controls"><CopyButton value={displayValue} label={invoice?'Copy invoice':'Copy address'}/>{canShare&&<button type="button" className="receive-share" onClick={()=>void navigator.share({text:displayValue}).catch(()=>{})}><Icon name="share" size={17}/>Share</button>}</div>}
   {action&&!invalidAmount&&<div className="receive-action">{action}</div>}
  </div>
  {children&&<div className="receive-details">{children}</div>}
  {onAmount&&<div className="receive-details receive-amount">
   <label className="receive-amount-field">Exact amount<input inputMode="numeric" aria-label="Receive amount in sats" aria-invalid={invalidAmount||undefined} aria-describedby={invalidAmount?'receive-amount-error':undefined} placeholder="Amount in sats" value={amount??''} onChange={event=>onAmount(event.target.value)}/></label>
   <span className="receive-amount-unit" aria-hidden="true">sats</span>
   {invalidAmount&&<p id="receive-amount-error" className="receive-amount-error" role="alert">Enter a whole number from 1 to 9,999,999,999 sats, without leading zeros.</p>}
  </div>}
  <GlassRefraction target={lens} active={active} radius={999} bezel={9} strength={14}/>
 </section>;
}
