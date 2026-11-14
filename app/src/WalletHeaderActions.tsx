import {useId} from 'react';

export function WalletHeaderActions({native,onAbout}:{native:boolean;onAbout:()=>void}){
 return native
  ? <button type="button" className="stock-home" aria-haspopup="dialog" onClick={onAbout}>About</button>
  : <a className="stock-home" href="/">About</a>;
}

/** The app icon's shield, drawn from src-tauri/icon.svg without its square. */
export function BrandMark(){
 const id=useId().replace(/[^\w-]/g,'');
 return <svg className="stock-brand-mark" viewBox="84 36 344 440" aria-hidden="true"><defs>
  <linearGradient id={`${id}-brass`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff0c8"/><stop offset=".3" stopColor="#c29a60"/><stop offset=".55" stopColor="#f3dfb5"/><stop offset=".8" stopColor="#8c6b3e"/><stop offset="1" stopColor="#e0be83"/></linearGradient>
  <linearGradient id={`${id}-navy`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#2d4b60"/><stop offset=".5" stopColor="#162c40"/><stop offset="1" stopColor="#112234"/></linearGradient></defs>
  <path d="M256 48 416 108v132c0 100-72 172-160 224C168 412 96 340 96 240V108Z" fill={`url(#${id}-navy)`} stroke={`url(#${id}-brass)`} strokeWidth="18" strokeLinejoin="round"/>
  <g transform="translate(256 248) scale(3.6)" fill="none" strokeLinecap="round"><path d="M15-14C6-24-16-19-16-7c0 14 31 6 31 21C15 27-7 30-19 17" stroke="#f1e5cd" strokeWidth="6"/><path d="M0-29v8m0 46v8" stroke="#d2ae75" strokeWidth="2"/></g>
 </svg>;
}

export function WalletBrand({native,onAbout}:{native:boolean;onAbout:()=>void}){
 return native
  ? <button type="button" className="stock-brand" aria-haspopup="dialog" onClick={onAbout}><BrandMark/>Shielded<span>wallet</span></button>
  : <a className="stock-brand" href="/"><BrandMark/>Shielded<span>wallet</span></a>;
}
