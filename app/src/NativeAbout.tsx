import {useEffect,useRef} from 'react';
import './native-about.css';

// Build-time constants; `typeof` keeps a build that never defined them, and the tests, from throwing.
export const installedBuild=()=>{
 const number=typeof __NATIVE_BUILD_NUMBER__==='number'?__NATIVE_BUILD_NUMBER__:0,commit=typeof __APP_COMMIT__==='string'?__APP_COMMIT__.slice(0,7):'';
 return number>0?`Build ${number}${commit?` · ${commit}`:''}`:undefined;
};

export default function NativeAbout({onClose}:{onClose:()=>void}){
 const close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  close.current?.focus();
  const previous=document.body.style.overflow,key=(event:KeyboardEvent)=>{
   if(event.key==='Escape')onClose();
   if(event.key==='Tab'){
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('.native-about button')];
    if(!buttons.length)return;
    const first=buttons[0]!,last=buttons.at(-1)!;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   }
  };
  document.body.style.overflow='hidden';addEventListener('keydown',key);
  return()=>{document.body.style.overflow=previous;removeEventListener('keydown',key);};
 },[onClose]);
 return <div className="native-about-layer" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section className="native-about" role="dialog" aria-modal="true" aria-labelledby="native-about-title">
   <span>About</span>
   <h2 id="native-about-title">Your keys stay with you.</h2>
   <p>Shielded is a private Bitcoin wallet on Arkade. Payments inside the pool keep their amount, sender and recipient private. Deposits and withdrawals are public.</p>
   <p>This Mutinynet build is for testing with test funds only. Wallet traffic uses Tor by default, and Tor can be turned off. Repeated identifiers and timing can still reveal links.</p>
   {installedBuild()&&<p className="native-about-build">{installedBuild()}</p>}
   <button ref={close} type="button" onClick={onClose}>Close</button>
  </section>
 </div>;
}
