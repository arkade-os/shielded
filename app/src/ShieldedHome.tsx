import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Gradient,Seal,spirograph,wave,type Tincture} from './guilloche.tsx';
import {rollupApi,type RollupPoolStatus} from './rollup-client.ts';
import './shielded-home.css';

const confidential=['Who you pay, and who pays you','How much each private payment moves','Your balance, and which notes are yours','Which note a payment spends. A proof reveals only a one-time mark that stops the note being spent twice.'];
const publicRecord=['Bitcoin entering the pool, with its amount and source','Bitcoin leaving the pool, with its amount and destination','When transactions happen','The total the pool holds'];
const steps=[
 {numeral:'I',name:'Deposit',tone:'azure',text:'Fund your wallet’s Arkade address, then shield an amount. It becomes a private note that only your keys can spend.'},
 {numeral:'II',name:'Pay privately',tone:'gules',text:'Send to another wallet’s shielded address. Your browser proves you own enough and that the books balance, without revealing which note is yours or how much moves.'},
 {numeral:'III',name:'Withdraw',tone:'vert',text:'Withdraw to your Arkade address and the Bitcoin leaves the pool. Like a deposit, this step is public.'},
] as const;
const limits=['Test Bitcoin on Mutinynet only. Nothing here has real value.','The proof system uses a development setup, not a public ceremony.','Spends are batched, up to eleven at a time. A batch closes ten seconds after its first spend arrives.','Spending rules are enforced by Arkade and its script verifier, so they must stay honest and online. There is no independent way out if they are not.','Keep your recovery secret safe. No one can reset it for you.'];

function Rosette(){
 const art=useRef<HTMLDivElement>(null);
 const layers=useMemo(()=>[
  {name:'rope',from:'teal' as Tincture,to:'purpure' as Tincture,paths:Array.from({length:24},(_,k)=>wave(226,12,18,k*Math.PI/12))},
  {name:'band',from:'gules' as Tincture,to:'or' as Tincture,paths:Array.from({length:20},(_,k)=>wave(176,20,12,k*Math.PI/10))},
  {name:'petals',from:'or' as Tincture,to:'gules' as Tincture,paths:[spirograph(120,35,68)]},
  {name:'core',from:'vert' as Tincture,to:'teal' as Tincture,paths:Array.from({length:12},(_,k)=>wave(52,7,8,k*Math.PI/6,180))},
 ],[]);
 useEffect(()=>{
  const node=art.current;if(!node||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  let frame=0;const update=()=>{frame=0;node.style.setProperty('--scroll',String(Math.min(window.scrollY,1200)));};
  const onScroll=()=>{if(!frame)frame=requestAnimationFrame(update);};
  update();window.addEventListener('scroll',onScroll,{passive:true});
  return()=>{window.removeEventListener('scroll',onScroll);cancelAnimationFrame(frame);};
 },[]);
 let index=0;
 // One SVG per layer so each spins as a composited layer instead of re-rasterizing every frame.
 return <div className="sh-art" ref={art} aria-hidden="true">
  <svg className="sh-frame" viewBox="-262 -262 524 524" focusable="false"><circle r="254"/><circle r="259"/><circle r="24"/></svg>
  <div className="sh-layer sh-beads"><svg viewBox="-262 -262 524 524" focusable="false">{Array.from({length:96},(_,k)=><circle key={k} cx={(244*Math.cos(k*Math.PI/48)).toFixed(1)} cy={(244*Math.sin(k*Math.PI/48)).toFixed(1)} r="1.8"/>)}</svg></div>
  {layers.map(layer=><div key={layer.name} className={'sh-layer sh-'+layer.name}><svg viewBox="-262 -262 524 524" focusable="false"><defs><Gradient id={'sh-g-'+layer.name} from={layer.from} to={layer.to}/></defs>{layer.paths.map(d=><path key={index} d={d} pathLength={1} style={{'--i':index++} as React.CSSProperties}/>)}</svg></div>)}
 </div>;
}

function Ribbon({dark=false}:{dark?:boolean}){
 const strands=useMemo(()=>{
  const line=(amplitude:number,phase:number)=>{let d='';for(let x=0;x<=2400;x+=8)d+=(x?'L':'M')+x+' '+(24+amplitude*Math.sin(x/150*2*Math.PI+phase)).toFixed(1);return d;};
  return [...Array.from({length:5},(_,k)=>({tone:'or',d:line(9,k*.5)})),...Array.from({length:4},(_,k)=>({tone:'gules',d:line(14,Math.PI+k*.45)})),...Array.from({length:4},(_,k)=>({tone:'azure',d:line(5,Math.PI/2+k*.6)}))];
 },[]);
 return <div className={'sh-ribbon'+(dark?' is-dark':'')} aria-hidden="true"><svg viewBox="0 0 2400 48" preserveAspectRatio="none" focusable="false">{strands.map((strand,i)=><path key={i} className={'sh-'+strand.tone} d={strand.d}/>)}</svg></div>;
}

function PoolFlow(){
 const vault=useMemo(()=>[...Array.from({length:18},(_,k)=>wave(98,5,20,k*Math.PI/9,200)),...Array.from({length:14},(_,k)=>wave(76,7,12,k*Math.PI/7,180))],[]);
 const coin=(side:'in'|'out',amount:string,delay:number)=><g key={side+amount} className={'sh-coin sh-'+side} style={{animationDelay:delay+'s'}}><circle r="14"/><circle className="sh-coin-ring" r="9"/><text y="-24">{amount}</text></g>;
 return <div className="sh-pool" role="img" aria-label="Bitcoin enters the pool with a visible amount, moves inside as unlabeled notes, and leaves with a visible amount.">
  <svg className="sh-pool-flow" viewBox="0 0 1000 240" focusable="false">
   <line x1="30" y1="120" x2="384" y2="120"/><line x1="616" y1="120" x2="970" y2="120"/>
   {coin('in','4,000 sats',0)}{coin('in','1,500 sats',-2.6)}{coin('in','600 sats',-5.2)}
   {coin('out','2,000 sats',-1.3)}{coin('out','900 sats',-3.9)}{coin('out','3,100 sats',-6.5)}
   <g className="sh-orbit">{Array.from({length:6},(_,k)=><circle key={k} cx={500+34*Math.cos(k*Math.PI/3)} cy={120+34*Math.sin(k*Math.PI/3)} r="4.5"/>)}</g>
  </svg>
  <div className="sh-pool-vault"><svg viewBox="-110 -110 220 220" focusable="false"><defs><Gradient id="sh-g-vault-a" from="teal" to="purpure"/><Gradient id="sh-g-vault-b" from="azure" to="gules"/></defs><circle r="106"/>{vault.map((d,i)=><path key={i} d={d}/>)}</svg></div>
 </div>;
}
function Medallion({numeral,tone}:{numeral:string;tone:Tincture}){
 const paths=useMemo(()=>[...Array.from({length:14},(_,k)=>wave(44,4,12,k*Math.PI/7,160)),...Array.from({length:10},(_,k)=>wave(31,5,8,k*Math.PI/5,140))],[]);
 return <div className="sh-medal" aria-hidden="true"><svg viewBox="-50 -50 100 100" focusable="false"><defs><Gradient id={'sh-g-medal-'+tone} from={tone} to="or"/></defs><circle r="48"/>{paths.map((d,i)=><path key={i} d={d} pathLength={1} stroke={`url(#sh-g-medal-${tone})`} style={{'--i':i} as React.CSSProperties}/>)}</svg><span>{numeral}</span></div>;
}

export default function ShieldedHome(){
 useEffect(()=>{
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.setAttribute('data-visible','');observer.unobserve(entry.target);}},{rootMargin:'0px 0px -15% 0px'});
  document.querySelectorAll('[data-reveal]').forEach(node=>observer.observe(node));
  document.querySelector('.shielded-home')?.classList.add('sh-ready');
  return()=>observer.disconnect();
 },[]);
 const [pool,setPool]=useState<RollupPoolStatus>(),[error,setError]=useState(false);
 useEffect(()=>{rollupApi<RollupPoolStatus>('/status').then(setPool,()=>setError(true));},[]);
 const phase=pool?.phase,tone=error||phase==='blocked'?'is-blocked':phase==='ready'?'is-open':'';
 const status=error?'Pool status is unavailable right now.':phase==='ready'?'The test pool is open on Mutinynet.':pool?.message??'Checking the pool…';
 const item=(text:string,n:number)=><li key={text} style={{'--n':n} as React.CSSProperties}>{text}</li>;
 return <div className="shielded-home">
  <header className="sh-header"><a className="sh-wordmark" href="/">Shielded<span>on Arkade</span></a><nav aria-label="Main"><a href="#privacy">Privacy</a><a href="#how">How it works</a><a className="sh-cta" href="/wallet">Open wallet</a></nav></header>
  <main>
   <section className="sh-hero" aria-labelledby="sh-title">
    <div className="sh-hero-text">
     <p className="sh-kicker">Private · Self-custodial · On Arkade</p>
     <h1 id="sh-title">Bitcoin, held in confidence.</h1>
     <p className="sh-lead">Shielded is a private pool for Bitcoin on Arkade. Inside it, payments move as private notes: each one is checked for validity, yet no one learns who paid whom, or how much.</p>
     <div className="sh-actions"><a className="sh-cta" href="/wallet">Open the wallet <span aria-hidden="true">→</span></a><a href="#privacy">What stays private</a></div>
     <p className={'sh-status '+tone} role="status"><i aria-hidden="true"/>{status}</p>
    </div>
    <Rosette/>
   </section>
   <Ribbon/>
   <section id="privacy" className="sh-section" aria-labelledby="sh-privacy-title" data-reveal>
    <h2 id="sh-privacy-title">What the world sees, and what it doesn’t.</h2>
    <PoolFlow/>
    <div className="sh-pool-captions"><p><b>Enters in public</b>A deposit shows its amount and source.</p><p><b>Moves in private</b>Inside, notes carry no visible amount or owner.</p><p><b>Leaves in public</b>A withdrawal shows its amount and destination.</p></div>
    <div className="sh-ledger">
     <div className="sh-sealed"><h3>Kept in confidence</h3><ul>{confidential.map(item)}</ul></div>
     <div className="sh-public"><h3>On the public record</h3><ul>{publicRecord.map((text,n)=>item(text,n+1))}</ul></div>
    </div>
    <p className="sh-aside">Privacy grows with company. The more people share the pool, the harder it is to link a deposit to a withdrawal, so avoid withdrawing the exact amount you have just deposited.</p>
   </section>
   <Ribbon/>
   <section id="how" className="sh-section" aria-labelledby="sh-how-title" data-reveal>
    <h2 id="sh-how-title">How it works</h2>
    <ol className="sh-steps">{steps.map(step=><li key={step.name}><Medallion numeral={step.numeral} tone={step.tone}/><h3>{step.name}</h3><p>{step.text}</p></li>)}</ol>
   </section>
   <Ribbon/>
   <section className="sh-section sh-keys" aria-labelledby="sh-keys-title">
    <Seal className="sh-watermark"/>
    <h2 id="sh-keys-title">Your keys never leave your browser.</h2>
    <p>The wallet creates your keys on this device and proves every spend here. The pool’s operator orders transactions and keeps encrypted records, but it cannot move your Bitcoin on its own: a spend counts only with a proof that your keys alone can make.</p>
    <p>The operator can still delay or refuse a transaction, and restoring a wallet needs its encrypted records together with your recovery secret.</p>
   </section>
   <section className="sh-certificate" aria-labelledby="sh-limits-title">
    <Seal className="sh-wax">S</Seal>
    <h2 id="sh-limits-title">An experiment, stated plainly</h2>
    <ul>{limits.map(text=><li key={text}>{text}</li>)}</ul>
    <a className="sh-cta" href="/wallet">Open the wallet <span aria-hidden="true">→</span></a>
   </section>
  </main>
  <footer className="sh-footer"><Ribbon dark/><div><span>Shielded on Arkade</span><span>An experimental privacy pool for Bitcoin, running on Mutinynet.</span></div></footer>
 </div>;
}
