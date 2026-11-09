import {useEffect,useRef,useState} from 'react';
import './native-about.css';

export default function NativeAbout({onClose,onClearWallet}:{onClose:()=>void;onClearWallet?:()=>Promise<void>}){
 const close=useRef<HTMLButtonElement>(null),[confirmClear,setConfirmClear]=useState(false),[clearing,setClearing]=useState(false),[clearError,setClearError]=useState('');
 const clear=async()=>{
  if(!onClearWallet||clearing)return;
  setClearing(true);setClearError('');
  try{await onClearWallet();}
  catch(error){setClearError(error instanceof Error?error.message:String(error));setClearing(false);}
 };
 useEffect(()=>{
  close.current?.focus();
  const previous=document.body.style.overflow,key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'&&!clearing)onClose();
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
 },[onClose,clearing]);
 return <div className="native-about-layer" onMouseDown={event=>{if(event.target===event.currentTarget&&!clearing)onClose();}}>
  <section className="native-about" role="dialog" aria-modal="true" aria-labelledby="native-about-title">
   <span>About</span>
   <h2 id="native-about-title">Your keys stay with you.</h2>
   <p>Shielded is a private Bitcoin wallet on Arkade. Payments inside the pool keep their amount, sender and recipient private. Deposits and withdrawals are public.</p>
   <p>This Mutinynet build is for testing with test funds only. Wallet traffic uses Tor by default, and Tor can be turned off. Repeated identifiers and timing can still reveal links.</p>
   {onClearWallet&&<section className="native-about-wallet" aria-labelledby="native-about-wallet-title">
    <span>Wallet controls</span>
    <h3 id="native-about-wallet-title">Clear this wallet</h3>
    <p>Remove the local wallet, recovery data and vault secret from this device. Keep your recovery phrase first.</p>
    {!confirmClear?<button type="button" className="native-about-clear" onClick={()=>setConfirmClear(true)}>Clear wallet…</button>:<div className="native-about-confirm" role="alert">
     <p>Pending Lightning swaps may still need this device&apos;s saved recovery records. Clear anyway?</p>
     <div><button type="button" onClick={()=>setConfirmClear(false)} disabled={clearing}>Keep wallet</button><button type="button" className="native-about-danger" onClick={()=>void clear()} disabled={clearing}>{clearing?'Clearing wallet…':'Clear permanently'}</button></div>
    </div>}
    {clearError&&<p className="native-about-error" role="alert">{clearError}</p>}
   </section>}
   <button ref={close} type="button" onClick={onClose} disabled={clearing}>Close</button>
  </section>
 </div>;
}
