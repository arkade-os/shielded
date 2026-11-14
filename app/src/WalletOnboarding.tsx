import {useCallback,useEffect,useId,useMemo,useReducer,useState} from 'react';
import {spirograph,wave} from './guilloche.tsx';
import NativeTorHealth from './NativeTorHealth.tsx';
import {AppUpdateNotice} from './AppUpdates.tsx';
import type {NativeTorHealthState} from './native-tor-monitor.ts';
import {preloadWalletPoseidon} from './wallet-crypto.ts';
import type {PasskeyWordCount} from '../../packages/protocol/src/passkey.ts';
import './wallet-onboarding.css';

export interface WalletOnboardingProps {
 transport:'tor'|'browser';
 setup:boolean;
 busy:boolean;
 opening?:boolean;
 phase:string;
 error:string;
 phrase:string;
 onPhraseChange:(value:string)=>void;
 onCreate:()=>void;
 onRestore:()=>void;
 onReconnect:()=>void;
 torHealth?:NativeTorHealthState;
 onToggleTor?:()=>void;
 transportBusy?:boolean;
 reconnectLabel?:string;
 /** Ignored on the native transport, which shows no passkey controls. */
 passkey?:{onCreate:(words:PasskeyWordCount)=>void;onRestore:()=>void};
}

type PrivacyPanel='tor'|'privacy';
export function walletPrivacyPanel(current:PrivacyPanel|null,action:{panel:PrivacyPanel;open:boolean}):PrivacyPanel|null{
 return action.open?action.panel:current===action.panel?null:current;
}

function ShieldMark({small=false}:{small?:boolean}){
 return <svg width={small?17:27} height={small?20:31} viewBox="0 0 28 32" fill="none" aria-hidden="true"><path d="M14 2 25 6v9c0 7-5 11-11 15C8 26 3 22 3 15V6l11-4Z" stroke="currentColor" strokeWidth="1.4"/><path d="M18.5 11c-2.8-3-8-1.2-8 1.8 0 3.2 7.3 1.5 7.3 5 0 3.3-5.4 4.5-8 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

export function EngravedShield(){
 const id=useId().replace(/:/g,''),shape='M0-115C32-100 62-94 91-91V-13C91 48 49 91 0 121-49 91-91 48-91-13V-91C-62-94-32-100 0-115Z';
 const engraving=useMemo(()=>Array.from({length:24},(_,i)=>wave(23+i*4,5.8,14,i*.29,240)),[]);
 const rosette=useMemo(()=>spirograph(38,11,18,960),[]);
 return <div className="wallet-onboarding-art" aria-hidden="true"><svg viewBox="0 0 360 340" focusable="false">
  <defs>
   <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff0c8"/><stop offset=".25" stopColor="#c29a60"/><stop offset=".5" stopColor="#f3dfb5"/><stop offset=".72" stopColor="#8c6b3e"/><stop offset="1" stopColor="#e0be83"/></linearGradient>
   <linearGradient id={`${id}-face`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#2d4b60"/><stop offset=".48" stopColor="#162c40"/><stop offset="1" stopColor="#112234"/></linearGradient>
   <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d4b77b"/><stop offset=".42" stopColor="#9ab6c8"/><stop offset="1" stopColor="#947e57"/></linearGradient>
   <clipPath id={`${id}-clip`}><path d={shape} transform="scale(.91)"/></clipPath>
   <filter id={`${id}-shadow`} x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="11"/></filter>
  </defs>
  <ellipse cx="184" cy="304" rx="87" ry="9" fill="#030b12" opacity=".7" filter={`url(#${id}-shadow)`}/>
  <g className="wallet-onboarding-orbit" fill="none" stroke="#afc4d4"><ellipse cx="180" cy="164" rx="144" ry="144" strokeOpacity=".11"/><ellipse cx="180" cy="164" rx="154" ry="154" strokeOpacity=".15" strokeDasharray="1 9"/><path d="M17 164h12m302 0h12M180 1v12m0 302v12" strokeOpacity=".3"/></g>
  <g transform="translate(177 163) rotate(-9)">
   {Array.from({length:11},(_,i)=><path key={i} d={shape} transform={`translate(${5-i*.45} ${9-i*.8})`} fill="#695235" stroke="#9e7e4e" strokeWidth=".5"/>)}
   <path d={shape} fill={`url(#${id}-rim)`}/>
   <path d={shape} transform="scale(.958)" fill={`url(#${id}-face)`} stroke="#b89b68" strokeWidth=".65"/>
   <path d={shape} transform="scale(.91)" fill="none" stroke="#afc4d4" strokeOpacity=".25" strokeWidth=".6"/>
   <g clipPath={`url(#${id}-clip)`} fill="none" stroke={`url(#${id}-line)`} strokeWidth=".5" opacity=".68">{engraving.map((d,i)=><path key={i} d={d}/>)}<path d={rosette} strokeWidth=".55"/></g>
   <circle r="37" fill="#142a3d" stroke="#d2ae75" strokeWidth=".65"/>
   <circle r="32" fill="none" stroke="#afc4d4" strokeOpacity=".23" strokeWidth=".5"/>
   <path d="M15-14C6-24-16-19-16-7c0 14 31 6 31 21C15 27-7 30-19 17" fill="none" stroke="#f1e5cd" strokeWidth="6" strokeLinecap="round"/>
   <path d="M0-27v7m0 45v7" stroke="#d2ae75" strokeWidth="1.6" strokeLinecap="round"/>
   <path d="M-75-74c25-3 50-10 75-21" fill="none" stroke="#f4e0b5" strokeOpacity=".7" strokeWidth=".7"/>
  </g>
 </svg></div>;
}

export default function WalletOnboarding({transport,setup,busy,opening=false,phase,error,phrase,onPhraseChange,onCreate,onRestore,onReconnect,torHealth,onToggleTor,transportBusy=false,reconnectLabel,passkey}:WalletOnboardingProps){
 const [restoring,setRestoring]=useState(false),[privacyPanel,changePrivacyPanel]=useReducer(walletPrivacyPanel,null),id=useId();
 const [passkeyWords,setPasskeyWords]=useState<PasskeyWordCount>(12),[passkeyAction,setPasskeyAction]=useState<'create'|'restore'>();
 const onTorOpenChange=useCallback((open:boolean)=>changePrivacyPanel({panel:'tor',open}),[]);
 const native=transport==='tor',direct=native&&(torHealth?.status.mode??'tor')==='direct',tor=native&&!direct,passkeys=native?undefined:passkey;
 const titleId=`${id}-title`,phraseId=`${id}-phrase`,warningId=`${id}-warning`,privacyId=`${id}-privacy`,passkeyId=`${id}-passkey`;
 const restore=setup&&restoring;
 const waiting=setup&&native&&torHealth?.status.phase!=='ready',disabled=busy||transportBusy||waiting;
 useEffect(()=>{preloadWalletPoseidon();},[]);
 return <div className={`wallet-onboarding${restore?' wallet-onboarding-restoring':''}${!setup?' wallet-onboarding-connecting':''}${opening?' wallet-onboarding-opening':''}`}>
  <header className="wallet-onboarding-header">
   <div className="wallet-onboarding-brand"><ShieldMark/><span>Shielded</span></div>
   <span className="wallet-onboarding-network">Mutinynet</span>
  </header>
  <main className="wallet-onboarding-stage">
   {!restore&&<EngravedShield/>}
   <section className="wallet-onboarding-content" aria-labelledby={titleId}>
    {restore&&<button className="wallet-onboarding-back" type="button" disabled={busy||transportBusy} onClick={()=>setRestoring(false)}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m11.5 5-5 5 5 5M7 10h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>Back</button>}
    <h1 id={titleId}>{opening?<><span>Opening your</span><span>private wallet.</span></>:restore?<><span>Welcome</span><span>back.</span></>:setup?<><span>Your bitcoin.</span><span>Your business.</span></>:busy?(tor?<><span>Taking the</span><span>private route.</span></>:<><span>Opening your</span><span>wallet.</span></>):<><span>Let’s reconnect.</span>{tor&&<span>Privately.</span>}</>}</h1>
    <p className="wallet-onboarding-description">{opening?'Shielded is preparing this device and catching up with the private pool. Your keys stay here.':restore?'Your recovery phrase brings your wallet back to this device.':setup?(native?'Private Bitcoin payments on Arkade. Your keys stay with you.':'Private Bitcoin payments on Arkade. Your keys stay in this browser.'):(tor?'Your wallet connects through Tor before any wallet traffic leaves this device.':direct?'Your wallet connects directly while Tor is off. Your IP address and DNS lookups are exposed.':'Your browser connects to the wallet services using its own network connection.')}</p>
    {opening?<p className="wallet-onboarding-phase wallet-onboarding-opening-phase" role="status" aria-live="polite"><span className="wallet-onboarding-spinner" aria-hidden="true"/><span>{phase||'Preparing your private wallet'}</span></p>
     :(!setup||waiting)&&<p className="wallet-onboarding-phase" role="status">{(busy||waiting)&&<span className="wallet-onboarding-spinner" aria-hidden="true"/>}{phase||(native?(direct?'Connecting directly':'Connecting to Tor'):'Opening your wallet')}</p>}
    {error&&<p className="wallet-onboarding-error" role="alert">{error}</p>}
    {opening&&error&&<div className="wallet-onboarding-actions"><button className="wallet-onboarding-primary" type="button" disabled={busy} onClick={onReconnect}>{busy?'Please wait…':'Reload wallet'}</button></div>}
    {!opening&&(restore?<form className="wallet-onboarding-restore-form" onSubmit={event=>{event.preventDefault();if(!disabled&&phrase.trim())onRestore();}}>
     <label htmlFor={phraseId}>Recovery phrase</label>
     <textarea id={phraseId} value={phrase} onChange={event=>onPhraseChange(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled} autoFocus rows={4} placeholder="Enter your recovery phrase" aria-describedby={warningId}/>
     <p id={warningId} className="wallet-onboarding-restore-warning">Keep the original app data for outstanding Lightning swaps. The phrase alone cannot recover every pending swap.</p>
     <button className="wallet-onboarding-primary" type="submit" disabled={disabled||!phrase.trim()}>{busy?'Restoring wallet…':'Restore wallet'}</button>
    </form>:<div className="wallet-onboarding-actions">
     {setup?<><button className="wallet-onboarding-primary" type="button" disabled={disabled} onClick={()=>{if(!disabled){setPasskeyAction(undefined);onCreate();}}}>{busy&&!passkeyAction?'Creating wallet…':'Create wallet'}</button><button className="wallet-onboarding-secondary" type="button" disabled={disabled} onClick={()=>{if(!disabled)setRestoring(true);}}>Restore a wallet</button>
      {passkeys&&<div className="wallet-onboarding-passkey" role="group" aria-labelledby={passkeyId}>
       <p id={passkeyId}>Passkey <span>Beta</span></p>
       <button className="wallet-onboarding-secondary" type="button" disabled={disabled} onClick={()=>{if(!disabled){setPasskeyAction('create');passkeys.onCreate(passkeyWords);}}}>{busy&&passkeyAction==='create'?'Waiting for your passkey…':'Create with a passkey'}</button>
       <label><input type="checkbox" checked={passkeyWords===24} disabled={disabled} onChange={event=>setPasskeyWords(event.target.checked?24:12)}/>24-word recovery phrase instead of 12</label>
       <button className="wallet-onboarding-secondary" type="button" disabled={disabled} onClick={()=>{if(!disabled){setPasskeyAction('restore');passkeys.onRestore();}}}>{busy&&passkeyAction==='restore'?'Waiting for your passkey…':'Restore with a passkey'}</button>
       <small>Anyone who can use this passkey, including through the account it syncs with, can spend from this wallet.</small>
      </div>}</>:<button className="wallet-onboarding-primary" type="button" disabled={busy||transportBusy} onClick={()=>{if(!busy&&!transportBusy)onReconnect();}}>{busy?'Please wait…':reconnectLabel??(native?'Unlock and reconnect':'Reload wallet')}</button>}
    </div>)}
    {!opening&&waiting&&!busy&&!transportBusy&&<button className="wallet-onboarding-secondary" type="button" onClick={onReconnect}>Retry connection</button>}
   </section>
  </main>
  <footer className="wallet-onboarding-footer">
   <div className="app-header-status">{native?<NativeTorHealth health={torHealth} tone="dark" onToggleTor={onToggleTor} transportBusy={transportBusy} open={privacyPanel==='tor'} onOpenChange={onTorOpenChange}/>:<span className="wallet-onboarding-connection">Browser connection</span>}<AppUpdateNotice tone="dark"/></div>
   <details className="wallet-onboarding-privacy" open={privacyPanel==='privacy'} onToggle={event=>changePrivacyPanel({panel:'privacy',open:event.currentTarget.open})} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();changePrivacyPanel({panel:'privacy',open:false});event.currentTarget.querySelector('summary')?.focus();}}}><summary aria-controls={privacyId} aria-expanded={privacyPanel==='privacy'} onClick={event=>{event.preventDefault();changePrivacyPanel({panel:'privacy',open:privacyPanel!=='privacy'});}}>About your privacy<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg></summary><div className="wallet-onboarding-privacy-menu" id={privacyId} aria-label="About your privacy" role="region" tabIndex={0}><p>{tor?'Wallet traffic uses Tor. Repeated identifiers and timing can still reveal links.':direct?'Tor is off. Your IP address and DNS lookups are exposed. Direct connections have no Tor circuit isolation.':'This wallet uses your browser’s network connection. It does not start Tor. Your browser and network determine your network privacy.'} Deposits into and withdrawals from the private pool are public.</p></div></details>
  </footer>
 </div>;
}
