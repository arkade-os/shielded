import {useEffect,useId,useLayoutEffect,useState,type RefObject} from 'react';
import {observeRefraction,type RefractionFrame} from './wallet-refraction.ts';

export function GlassRefraction({target,active=true,radius=28,bezel=20,strength=32}:{target:RefObject<HTMLElement|null>;active?:boolean;radius?:number;bezel?:number;strength?:number}){
 const id='wallet-surface-'+useId().replace(/[^a-zA-Z0-9_-]/g,''),[map,setMap]=useState<RefractionFrame>();
 useEffect(()=>{
  const node=target.current;
  if(!active||!node){setMap(undefined);return;}
  return observeRefraction(node,setMap,{radius,bezel});
 },[target,active,radius,bezel]);
 useLayoutEffect(()=>{
  const node=target.current,filter=`url(#${id})`;
  if(!node||!active||!map)return;
  node.style.setProperty('--wallet-glass-filter',filter);node.classList.add('has-liquid-refraction');
  return()=>{if(node.style.getPropertyValue('--wallet-glass-filter')===filter){node.style.removeProperty('--wallet-glass-filter');node.classList.remove('has-liquid-refraction');}};
 },[target,active,map,id]);
 return active&&map?<svg width="0" height="0" aria-hidden="true" focusable="false" style={{position:'absolute',pointerEvents:'none'}}><defs><filter id={id} x="0" y="0" width={map.width} height={map.height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feImage href={map.href} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="displacement"/><feDisplacementMap in="SourceGraphic" in2="displacement" scale={strength} xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>:null;
}
