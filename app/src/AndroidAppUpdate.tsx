import {useEffect,useRef,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {AndroidUpdateController,AndroidUpdateState} from './android-updates.ts';
import './android-app-update.css';

const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(1)} MB`;
export function AndroidAppUpdateDialog({state,onClose,onDownload,onCancel,onDiscard,onPermission,onInstall,onConfirm,onRefresh}:{state:AndroidUpdateState;onClose:()=>void;onDownload:()=>void;onCancel:()=>void;onDiscard:()=>void;onPermission:()=>void;onInstall:()=>void;onConfirm:()=>void;onRefresh:()=>void}){
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
 const {phase,release,info,staged,error,torReady}=state,percent=state.total?Math.min(100,Math.floor(state.received/state.total*100)):0;
 const canDownload=['available','failed'].includes(phase)&&!staged,canInstall=phase==='ready'||phase==='failed'&&!!staged&&info?.installStatus==='failed';
 const headings:Record<AndroidUpdateState['phase'],string>={idle:'Shielded updates',checking:'Checking this installation',available:'A new Shielded is ready',blocked:'Keep this installation',downloading:'Bringing your update through Tor',ready:'Ready to install',preparing:'Saving and locking your wallet',installing:'Installing with Android','confirmation-required':'Finish in the Android installer',failed:'The update needs another try',unknown:'Check the Android installer',installed:'Shielded is up to date'};
 return <div className="android-update-layer" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section ref={dialog} className="android-update-dialog" role="dialog" aria-modal="true" aria-labelledby="android-update-title" aria-describedby="android-update-description">
   <header><span className="android-update-mark" aria-hidden="true">S</span><button ref={close} type="button" className="android-update-close" onClick={onClose} aria-label="Close update">Close</button></header>
   <h2 id="android-update-title">{headings[phase]}</h2>
   {release&&<p className="android-update-version">Shielded {release.version}<span>Build {release.buildNumber}</span></p>}
   <p id="android-update-description">{phase==='downloading'?'Keep Shielded open while the update downloads privately.':phase==='preparing'?'Finishing wallet writes before opening Android’s installer.':phase==='installing'?'Android is handling this update. Your wallet stays on this device.':phase==='confirmation-required'?'Android needs your confirmation to finish installing Shielded.':phase==='unknown'?'An installation may still be pending. Check its status before trying another install.':phase==='installed'?'The Android installation completed. Your wallet data stays on this device.':'Download inside Shielded through Tor. Android installs the update over this app and keeps your wallet data.'}</p>
   {phase==='downloading'&&<div className="android-update-progress" role="status" aria-live="polite"><div><strong>{percent}%</strong><span>{size(state.received)} of {size(state.total)}</span></div><progress max={100} value={percent} aria-label="Update download"/></div>}
   {phase==='ready'&&<p className="android-update-verified">Download verified. Your wallet will lock and finish saving before installation.</p>}
   {error&&<p className="android-update-error" role="alert">{error}</p>}
   {canDownload&&!torReady&&<p className="android-update-help">Connect to Tor to download. Turn Tor on in the connection menu, then return here.</p>}
   <div className="android-update-actions">
    {canDownload&&<button type="button" onClick={onDownload} disabled={!torReady}>{phase==='failed'?'Retry download':'Download update'}{release?.androidUpdate?` · ${size(release.androidUpdate.bytes)}`:''}</button>}
    {phase==='downloading'&&<button type="button" className="android-update-secondary" onClick={onCancel}>Cancel download</button>}
    {canInstall&&<>{!info?.canRequestInstalls&&<button type="button" onClick={onPermission}>Allow installation in Android settings</button>}<button type="button" onClick={onInstall} disabled={!info?.canRequestInstalls}>Install update</button></>}
    {phase==='confirmation-required'&&<button type="button" onClick={onConfirm}>Continue in Android installer</button>}
    {['unknown','installing','failed','checking'].includes(phase)&&<button type="button" className="android-update-secondary" onClick={onRefresh}>Check install status</button>}
    {staged&&['ready','blocked','failed'].includes(phase)&&<button type="button" className="android-update-secondary" onClick={onDiscard}>Discard downloaded update</button>}
   </div>
  </section>
 </div>;
}
export default function AndroidAppUpdate({controller,onClose}:{controller:AndroidUpdateController;onClose:()=>void}){
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const view=<AndroidAppUpdateDialog state={state} onClose={onClose} onDownload={()=>void controller.download()} onCancel={controller.cancel} onDiscard={()=>void controller.discard()} onPermission={()=>void controller.permission()} onInstall={()=>void controller.install()} onConfirm={()=>void controller.install(true)} onRefresh={()=>void controller.refresh()}/>;
 return typeof document==='undefined'?view:createPortal(view,document.body);
}
