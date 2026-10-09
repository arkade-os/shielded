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
const parties={you:'Your browser',op:'Pool operator',ark:'Arkade'} as const;
type Party=keyof typeof parties;
const stations:{name:string;by:Party;text:React.ReactNode}[]=[
 {name:'Keys',by:'you',text:<>One recovery secret derives a spend key <var>ask</var>, a nullifier key <var>nk</var> and an X25519 view key. Your bech32m address, <code>shrol21…</code>, carries your owner hash and the public view key.</>},
 {name:'Prove',by:'you',text:<>Each output is sealed to its recipient’s view key with ECDH and AES-GCM. A Groth16 proof then shows the spend is valid; its statement binds the nullifiers it spends (one, or two for a merge), two new commitments and the sealed record’s digest.</>},
 {name:'Batch',by:'op',text:<>Spends wait for eleven, or ten seconds after the first; merges of two notes wait up to a minute. The operator fills empty slots with its own zero-value spends, so no batch shows how full it was, then proves the whole state update at once.</>},
 {name:'Verify',by:'ark',text:<>One Arkade transaction spends the pool’s head VTXO through its batch leaf. The Arkade emulator checks all twelve proofs in one <code>OP_ECPAIRING</code> and the amounts against the real outputs, then co-signs, as does arkd. <a href="#sh-fig-2">See Fig. 2.</a></>},
 {name:'Sync',by:'you',text:<>Every wallet replays each published batch into its own copy of the state, trial-decrypts the records with its view key to find its notes, and computes its own Merkle paths. It never asks anyone for one.</>},
];
type Part={name:string;text:React.ReactNode;maybe?:boolean;packet?:boolean};
const txIn:Part[]=[{name:'Pool head',text:'The pool’s sats and its supply-1 pool token.'},{name:'Asset reserve',text:'The reserve of the one asset this batch moves.',maybe:true},{name:'Deposits',text:'Coins entering the pool. Amount and source are public.',maybe:true}];
const txOut:Part[]=[{name:'New head',text:'Carries the pool token and the updated sats.'},{name:'Asset reserve',text:'Back beside the new head, its amount updated.',maybe:true},{name:'Withdrawals',text:'Public, and at least 330 sats each.',maybe:true},{name:'State packet',text:<>Extension packet <code>0x87</code>:</>,packet:true}];
const defs:[React.ReactNode,React.ReactNode,React.ReactNode][]=[
 ['owner',<>Poseidon(domain, ak, nk)</>,'Goes in your address. ak = Poseidon(tag, ask), and ask never leaves your browser.'],
 ['cm',<>Poseidon(domain, amount, asset, owner, ρ)</>,'A note’s commitment, appended to the note tree.'],
 ['nf',<>Poseidon(domain, nk, ρ)</>,'Revealed when the note is spent; a repeat is refused. A zero-value placeholder input hashes under its own tag, so it can never reveal a real note’s nullifier.'],
 ['asset',<>SHA-256<sub>248</sub>(AssetId)</>,'Any Arkade asset, as the circuit sees it.'],
 ['ctDigest',<>SHA-256<sub>248</sub>(sealed record)</>,'Binds the encrypted outputs, so no one can swap them.'],
 ['groupId',<>Poseidon(tag, nf<sub>0</sub>, nf<sub>1</sub>, nf<sub>2</sub>)</>,'Up to three notes pay as one, in consecutive slots.'],
 ['statement',<>Poseidon(domain, root, nf…, cm<sub>0</sub>, cm<sub>1</sub>, ctDigest, groupId, groupSize)</>,'Public input one of five. The other four, deposit, withdraw, asset and destination, are zero for a private payment.'],
 [<>da<sub>i</sub></>,<>Poseidon(da<sub>i−1</sub>, nf<sub>i</sub>…, cm<sub>i,0</sub>, cm<sub>i,1</sub>, ctDigest<sub>i</sub>)</>,<>Chained over the eleven slots from da<sub>0</sub>{' = 0'}. The last link is the DA root.</>],
 [<>statement<sub>batch</sub></>,<>SHA-256<sub>248</sub>(header || old || new || da<sub>11</sub>)</>,'Binds the old and new state commitments to the DA root. The batch proof’s twelfth public input.'],
];
const spec:{title:string;by?:Party;rows:[string,string][]}[]=[
 {title:'Spend proof',by:'you',rows:[['Proof system','Groth16 on BN254'],['Constraints','10,818'],['Public inputs','5'],['Notes','1 in, 2 out'],['Deposit input','zero-value dummy'],['Proving key','8.1 MB, cached by hash']]},
 {title:'Batch',by:'op',rows:[['Slots','11'],['Closes','10 s after the first'],['Constraints','509,799'],['Public inputs','12']]},
 {title:'State',rows:[['Note tree','depth 32, 4.29 billion'],['Per batch','one 32-leaf subtree'],['Nullifiers','indexed tree, depth 32'],['Root window','last 64 batches']]},
 {title:'On Arkade',by:'ark',rows:[['Transaction','8,665 bytes'],['Weight','34,660 of 40,000 WU'],['Per payment','about 3,150 WU'],['State packet','64 bytes, type 0x87'],['Renewal','weekly, 48 h early'],['Listing an asset','1 unit + 330 sats']]},
];
const trust:{title:string;by?:Party;text:string}[]=[
 {title:'A test network',text:'Mutinynet test coins only. The proving keys come from a small testnet ceremony over the shared Hermez powers of tau, sealed with a Bitcoin block hash; the README shows how to verify them.'},
 {title:'Arkade checks the proofs',by:'ark',text:'The Arkade emulator verifies the proofs and arkd must co-sign; Bitcoin itself does not verify them. Both must stay honest and online. If they do not, there is no independent exit from the pool.'},
 {title:'The operator keeps order',by:'op',text:'The pool operator orders batches and can delay or refuse a spend, but cannot spend a note without its owner’s proof. If it refuses you or stops, anyone holding the published batch key can prove a batch without it, until the pool head expires. Deposits and withdrawals are public, amount and address.'},
];
const pt=(r:number,deg:number)=>[(r*Math.sin(deg*Math.PI/180)).toFixed(1),(-r*Math.cos(deg*Math.PI/180)).toFixed(1)].join(' ');
const studPaths=Array.from({length:4},(_,k)=>wave(8.5,2.2,8,k*Math.PI/4,72));
const dial={
 ticks:Array.from({length:60},(_,i)=>'M'+pt(i%5?159:152,i*6)+'L'+pt(165,i*6)).join(''),
 spokes:Array.from({length:12},(_,k)=>'M'+pt(124,k*30)+'Q'+pt(92,k*30+5)+' '+pt(56,k*30+26)),
 hub:Array.from({length:6},(_,k)=>wave(40,4.5,9,k*Math.PI/3,120)),
 turned:spirograph(120,33,38,1440),
};

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

function Stud(){
 return <svg className="sh-stud" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false"><circle r="11"/>{studPaths.map((d,i)=><path key={i} d={d}/>)}</svg>;
}
// Stretched to the list's height, so each curve lands on the centre of an equal-height row.
function Wire({n}:{n:number}){
 return <svg className="sh-wire" viewBox="0 0 44 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">{Array.from({length:n},(_,i)=>{const y=(2*i+1)*50/n;return <path key={i} d={`M0 ${y}C24 ${y} 20 50 44 50`}/>;})}</svg>;
}
function Dial(){
 return <div className="sh-dial" data-reveal role="img" aria-label="A dial of twelve proofs: eleven client proofs, one per slot, and the batch proof at twelve o’clock, all converging on one pairing check at the center.">
  <svg viewBox="-200 -200 400 400" focusable="false">
   <defs><path id="sh-micro-ring" d="M0 -181A181 181 0 1 1 0 181A181 181 0 1 1 0 -181"/></defs>
   <circle className="sh-bezel" r="196"/><circle className="sh-bezel is-fine" r="190"/><circle className="sh-bezel is-fine" r="172"/>
   <text className="sh-micro"><textPath href="#sh-micro-ring" textLength="1137" lengthAdjust="spacing">{'eleven client proofs and one batch proof, one randomized multi-pairing check · '.repeat(3)}</textPath></text>
   <path className="sh-ticks" d={dial.ticks}/><path className="sh-turned" d={dial.turned}/>
   {Array.from({length:11},(_,i)=>{const [x,y]=pt(141,(i+1)*30).split(' ');return <text key={i} className="sh-num" x={x} y={y}>{i+1}</text>;})}
   <path className="sh-index" d="M-7 -151L7 -151L0 -137Z"/>
   {dial.spokes.map((d,k)=><path key={k} className={'sh-spoke'+(k?'':' is-batch')} d={d} pathLength={1} style={{'--k':k||12} as React.CSSProperties}/>)}
   {dial.spokes.map((_,k)=>{const [x,y]=pt(124,k*30).split(' ');return <circle key={k} className={'sh-node'+(k?'':' is-batch')} cx={x} cy={y} r="3"/>;})}
   <g className="sh-hub"><circle r="56"/><circle className="is-fine" r="50"/>{dial.hub.map((d,i)=><path key={i} d={d}/>)}<circle className="sh-hub-core" r="5"/></g>
  </svg>
 </div>;
}
function Plate(){
 const parts=(list:Part[])=><ul className="sh-io">{list.map(part=><li key={part.name} className={part.maybe?'is-maybe':undefined}><b>{part.name}</b><p>{part.text}</p>{part.packet&&<span className="sh-packet" aria-hidden="true"><i>state</i><i>DA root</i></span>}</li>)}</ul>;
 return <section id="under-the-hood" className="sh-plate" aria-labelledby="sh-hood-title">
  <Ribbon dark/>
  <div className="sh-plate-frame">
   <div className="sh-corners" aria-hidden="true"><Stud/><Stud/><Stud/><Stud/></div>
   <h2 id="sh-hood-title">Under the hood</h2>
   <p className="sh-plate-lead">Each payment is a Groth16 proof your browser makes. The operator gathers eleven into one Arkade transaction, and Arkade verifies all of them, with the operator’s own proof, in a single pairing check.</p>
   <ul className="sh-key" aria-label="Key to the figures">{(Object.keys(parties) as Party[]).map(p=><li key={p} className={'is-'+p}>{parties[p]}</li>)}</ul>
   <figure className="sh-fig">
    <figcaption><h3><span>Fig. 1</span>The life of a private payment</h3></figcaption>
    <ol className="sh-path">{stations.map(s=><li key={s.name} className={'is-'+s.by}><Stud/><h4>{s.name}</h4><p className="sh-by">{parties[s.by]}</p><p>{s.text}</p></li>)}</ol>
   </figure>
   <figure id="sh-fig-2" className="sh-fig">
    <figcaption><h3><span>Fig. 2</span>One batch, one Arkade transaction</h3><p>Solid parts are in every batch; dashed parts only when a batch has them.</p></figcaption>
    <div className="sh-tx">
     <div className="sh-side is-in"><h4>Inputs</h4>{parts(txIn)}<Wire n={txIn.length}/></div>
     <Dial/>
     <p className="sh-dial-note">One <code>OP_ECPAIRING</code> checks all twelve proofs. The batch leaf then matches deposits, withdrawals and asset legs to the real outputs before the Arkade emulator co-signs.</p>
     <div className="sh-side is-out"><h4>Outputs</h4><Wire n={txOut.length}/>{parts(txOut)}</div>
     <div className="sh-weight">
      <div className="sh-scale" aria-hidden="true"><i/></div>
      <div className="sh-marks" aria-hidden="true"><span>0</span><span style={{left:'25%'}}>10,000</span><span style={{left:'50%'}}>20,000</span><span style={{left:'75%'}}>30,000</span><span>40,000</span></div>
      <p>Measured on Mutinynet, a full batch transaction is <b>8,665 bytes</b> and <b>34,660 WU</b>, inside arkd’s 40,000 WU limit: about 3,150 WU for each of its eleven payments.</p>
     </div>
    </div>
   </figure>
   <div className="sh-ref">
    <div><h3>Definitions</h3><dl className="sh-defs">{defs.map(([term,value,note],i)=><React.Fragment key={i}><dt>{term}</dt><dd><code>= {value}</code><p>{note}</p></dd></React.Fragment>)}</dl></div>
    <div><h3>Specification</h3><div className="sh-spec">{spec.map(group=><div key={group.title} className={group.by&&'is-'+group.by}><h4>{group.title}</h4><dl>{group.rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>)}</div></div>
   </div>
   <div className="sh-trust">
    <h3>What you are trusting</h3>
    <div>{trust.map(item=><div key={item.title} className={item.by&&'is-'+item.by}><h4><Stud/>{item.title}</h4><p>{item.text}</p></div>)}</div>
   </div>
  </div>
  <Ribbon dark/>
 </section>;
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
     <p className="sh-kicker">Private · Your keys · On Arkade</p>
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
   <Plate/>
   <section className="sh-section sh-keys" aria-labelledby="sh-keys-title">
    <Seal className="sh-watermark"/>
    <h2 id="sh-keys-title">Your keys never leave your browser.</h2>
    <p>The wallet creates your keys on this device and proves every spend here. The pool’s operator orders transactions and keeps encrypted records, but it cannot move your Bitcoin on its own: a spend counts only with a proof that your keys alone can make.</p>
    <p>The operator can still delay or refuse a transaction, and restoring a wallet needs its encrypted records together with your recovery secret. Keep that secret safe: no one can reset it for you.</p>
    <a className="sh-cta" href="/wallet">Open the wallet <span aria-hidden="true">→</span></a>
   </section>
  </main>
  <footer className="sh-footer"><Ribbon dark/><div><span>Shielded on Arkade</span><span>An experimental privacy pool for Bitcoin, running on Mutinynet.</span></div></footer>
 </div>;
}
