import {useEffect,useRef,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {openUrl} from '@tauri-apps/plugin-opener';
import {nativeUpdateUrl} from '../../src/native-release.ts';
import type {UpdateController,UpdateState} from './android-updates.ts';
import {installedBuild} from './installed-build.ts';
import './android-app-update.css';

const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(1)} MB`;
export function AndroidAppUpdateDialog({state,onClose,onUpdate,onCancel,desktop=false}:{state:UpdateState;onClose:()=>void;onUpdate:()=>void;onCancel:()=>void;desktop?:boolean}){
 const dialog=useRef<HTMLElement>(null),close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined,overflow=document.body.style.overflow;
  close.current?.focus();document.body.style.overflow='hidden';
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape')onClose();
   if(event.key!=='Tab')return;
   const buttons=[...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],first=buttons[0],last=buttons.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
  addEventListener('keydown',key);return()=>{document.body.style.overflow=overflow;removeEventListener('keydown',key);if(previous?.isConnected)previous.focus();};
 },[onClose]);
 const {phase,release,staged,error,networkReady,torReady}=state,percent=state.total?Math.min(100,Math.floor(state.received/state.total*100)):0,build=installedBuild();
 const canUpdate=['available','failed'].includes(phase),offline=!staged&&!networkReady;
 // Desktop releases carry the APK too, so only Android sizes its button from it.
 const bytes=desktop?state.total:release?.androidUpdate?.bytes,handoff=desktop?'Shielded closes, installs the update and reopens.':'Android installs the update over this app and keeps your wallet data.';
 const headings:Record<UpdateState['phase'],string>={idle:'Shielded updates',checking:'Checking this installation',available:'A new Shielded is ready',blocked:'Keep this installation',downloading:torReady?'Bringing your update through Tor':'Downloading your update',preparing:'Saving and locking your wallet',installing:'Installing your update',failed:'The update needs another try'};
 return <div className="android-update-layer" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section ref={dialog} className="android-update-dialog" role="dialog" aria-modal="true" aria-labelledby="android-update-title" aria-describedby="android-update-description">
   <header><span className="android-update-mark" aria-hidden="true">S</span><button ref={close} type="button" className="android-update-close" onClick={onClose} aria-label="Close update">Close</button></header>
   <h2 id="android-update-title">{headings[phase]}</h2>
   {release&&<p className="android-update-version">Shielded {release.version}<span>Build {release.buildNumber}</span></p>}
   {build&&<p className="android-update-installed">This wallet is {build}</p>}
   <p id="android-update-description">{phase==='downloading'?'The download keeps going if you switch apps while your wallet is unlocked. Closing Shielded stops it.':phase==='preparing'?`Finishing wallet writes before ${desktop?'Shielded closes to install the update':'opening Android’s installer'}.`:phase==='installing'?handoff:`${torReady?'Download inside Shielded through Tor.':'Download inside Shielded.'} ${handoff}`}</p>
   {phase==='downloading'&&<div className="android-update-progress" role="status" aria-live="polite"><div><strong>{percent}%</strong><span>{size(state.received)} of {size(state.total)}</span></div><progress max={100} value={percent} aria-label="Update download"/></div>}
   {canUpdate&&staged&&<p className="android-update-verified">Download verified. Your wallet will lock and finish saving before installation.</p>}
   {error&&<p className="android-update-error" role="alert">{error}</p>}
   {phase==='failed'&&<p className="android-update-help">Or <a href={nativeUpdateUrl()} data-native-external="true" onClick={event=>{event.preventDefault();void openUrl(nativeUpdateUrl()).catch(()=>{});}}>install it from the download page</a>.</p>}
   {canUpdate&&offline&&<p className="android-update-help">Open or reconnect your wallet, then download.</p>}{canUpdate&&!staged&&networkReady&&!torReady&&<p className="android-update-help">Tor is off, so the download connects directly to the Shielded download server, or to GitHub if that server can’t provide it. Shielded still verifies it before installing.</p>}
   <div className="android-update-actions">
    {canUpdate&&<button type="button" onClick={onUpdate} disabled={offline}>{phase==='failed'?'Try again':`Update${bytes?` · ${size(bytes)}`:''}`}</button>}
    {phase==='downloading'&&<button type="button" className="android-update-secondary" onClick={onCancel}>Cancel download</button>}
   </div>
  </section>
 </div>;
}
export default function AndroidAppUpdate({controller,onClose,desktop}:{controller:UpdateController;onClose:()=>void;desktop?:boolean}){
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const view=<AndroidAppUpdateDialog state={state} onClose={onClose} onUpdate={()=>void controller.update()} onCancel={controller.cancel} desktop={desktop}/>;
 return typeof document==='undefined'?view:createPortal(view,document.body);
}
