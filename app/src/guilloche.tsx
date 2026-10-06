import React,{useMemo} from 'react';
import './guilloche.css';

export const wave=(radius:number,amplitude:number,lobes:number,phase:number,steps=240)=>{
 let d='';
 for(let i=0;i<=steps;i++){const t=i/steps*2*Math.PI,r=radius+amplitude*Math.sin(lobes*t+phase);d+=(i?'L':'M')+(r*Math.cos(t)).toFixed(1)+' '+(r*Math.sin(t)).toFixed(1);}
 return d;
};
export const spirograph=(R:number,r:number,offset:number,steps=1440)=>{
 const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,turns=r/gcd(R,r);let d='';
 for(let i=0;i<=steps;i++){const t=i/steps*2*Math.PI*turns,x=(R-r)*Math.cos(t)+offset*Math.cos((R-r)/r*t),y=(R-r)*Math.sin(t)-offset*Math.sin((R-r)/r*t);d+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);}
 return d;
};

// Heraldic tinctures: [light, deep] pairs for gradient strokes.
export const tinctures={or:['#e4c46c','#a8781f'],gules:['#c24a63','#7d1631'],azure:['#3b78a8','#103554'],purpure:['#9563c0','#4f2475'],vert:['#4aa582','#185c45'],teal:['#45b7cb','#0b7f96']} as const;
export type Tincture=keyof typeof tinctures;
export function Gradient({id,from,to}:{id:string;from:Tincture;to:Tincture}){
 return <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={tinctures[from][0]}/><stop offset=".5" stopColor={tinctures[to][1]}/><stop offset="1" stopColor={tinctures[from][1]}/></linearGradient>;
}

export function Seal({className='',children}:{className?:string;children?:React.ReactNode}){
 const layers=useMemo(()=>[
  {name:'outer',from:'or' as Tincture,to:'gules' as Tincture,paths:Array.from({length:16},(_,k)=>wave(90,6,16,k*Math.PI/8,200))},
  {name:'middle',from:'azure' as Tincture,to:'teal' as Tincture,paths:Array.from({length:12},(_,k)=>wave(64,8,10,k*Math.PI/6,180))},
  {name:'inner',from:'gules' as Tincture,to:'purpure' as Tincture,paths:[spirograph(48,14,26,900)]},
 ],[]);
 return <div className={'seal '+className} aria-hidden="true">
  {layers.map(layer=><svg key={layer.name} className={'seal-'+layer.name} viewBox="-100 -100 200 200" focusable="false"><defs><Gradient id={'seal-g-'+layer.name} from={layer.from} to={layer.to}/></defs>{layer.paths.map((d,i)=><path key={i} d={d} stroke={`url(#seal-g-${layer.name})`}/>)}</svg>)}
  {children&&<span className="seal-mark">{children}</span>}
 </div>;
}
