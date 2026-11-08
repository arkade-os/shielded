import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {bytesToHex} from '@noble/hashes/utils.js';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {installNativeTransport,nativeNetwork,type NativeMode} from '../../src/native/index.ts';
import {createNativeStorage} from './native-storage.ts';
import {createNativeCleanup} from './native-cleanup.ts';
import {openNativeVault} from './native-open.ts';
import {saveNativeSetup} from './native-setup.ts';
import NativeConnectionWarning from './NativeConnectionWarning.tsx';
import {createNativeTorMonitor,type NativeTorHealthState} from './native-tor-monitor.ts';
import WalletOnboarding from './WalletOnboarding.tsx';
import NativeTorHealth from './NativeTorHealth.tsx';
import {AppUpdateNotice} from './AppUpdates.tsx';

installNativeTransport();
const Wallet=lazy(()=>import('./RollupWallet'));
const getSecret=()=>invoke<string|null>('plugin:shielded-platform|secret_get');
const putSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_set',{value});
type Session={generation:number;cache:ReturnType<typeof createNativeStorage>};

export default function NativeWallet(){
 const [session,setSession]=useState<Session>(),[phase,setPhase]=useState('Connecting to Tor'),[error,setError]=useState('');
 const [setup,setSetup]=useState(false),[phrase,setPhrase]=useState(''),[busy,setBusy]=useState(true);
 const [torHealth,setTorHealth]=useState<NativeTorHealthState>({status:{phase:'idle',generation:0},check:'idle'});
 const [externalLink,setExternalLink]=useState('');
 const [confirmDirect,setConfirmDirect]=useState(false),[switching,setSwitching]=useState(false),[saving,setSaving]=useState(false);
 const selectedMode=useRef<NativeMode>('tor'),transition=useRef(false),creating=useRef<Promise<void>|undefined>(undefined);
 const setupAllowed=useRef(false);
 const active=useRef<Session|undefined>(undefined),attempt=useRef(0),cleanup=useRef(createNativeCleanup()),closed=useRef<Promise<void>>(Promise.resolve()),manualLock=useRef(false);
 const opening=useRef<Promise<void>|undefined>(undefined);
 const openingGeneration=useRef<number|undefined>(undefined);
 const healthExpired=useRef(false);
 const stop=useRef<(()=>Promise<void>)|undefined>(undefined);
 const onShutdown=useCallback((shutdown:(()=>Promise<void>)|undefined)=>{stop.current=shutdown;},[]);
 const fail=(cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause));
 const pause=useCallback(()=>{
  ++attempt.current;
  setupAllowed.current=false;setSetup(false);
  const previous=active.current;active.current=undefined;
  const shutdown=stop.current;stop.current=undefined;
  const writing=previous?.cache.flush(),pending=opening.current;
  setSession(undefined);setBusy(false);setPhase('Private connection paused');previous?.cache.clearMemory();
  // An ambiguous vault write must settle before a new open reconciles its metadata.
  const pendingWrite=creating.current;
  const closing=cleanup.current.add(async()=>{await pendingWrite?.catch(()=>{});await nativeNetwork.pause();},...(shutdown?[shutdown]:[]),...(writing?[()=>writing.catch(()=>{})]:[]));
  closed.current=Promise.all([closed.current.catch(()=>{}),closing,pending]).then(()=>{});
  void closed.current.catch(fail);return closed.current;
 },[]);
 const open=useCallback(()=>{
  if(opening.current)return opening.current;
  if(document.hidden||manualLock.current){setBusy(false);setPhase('Private connection paused');return Promise.resolve();}
  const previousClose=closed.current;
  const run=(async()=>{
   healthExpired.current=false;
   const mine=++attempt.current;setupAllowed.current=false;setSetup(false);setBusy(true);setError('');
  try{
   await cleanup.current.drain();
   await previousClose.catch(()=>{});
   if(mine!==attempt.current||document.hidden||manualLock.current)return;
   setPhase(selectedMode.current==='tor'?'Connecting to Tor':'Opening direct connection');
   const generationGuard=()=>mine===attempt.current&&!document.hidden&&!manualLock.current&&!healthExpired.current;
   const opened=await openNativeVault(async()=>{
    const status=await nativeNetwork.start(selectedMode.current);
    if(status.phase==='ready')openingGeneration.current=status.generation;
    return status;
   },getSecret,generationGuard,{generation:(await nativeNetwork.status()).generation,mode:selectedMode.current,current:generationGuard});
   openingGeneration.current=undefined;
   if(!opened||mine!==attempt.current||document.hidden||manualLock.current)return;
   if(healthExpired.current)return;
   const {secret,status}=opened;
   if(secret===null){
    if(localStorage.getItem('shielded-native-wallet')==='1')throw new Error('The native wallet secret is unavailable. Keep the app data and restore access to its vault.');
    setupAllowed.current=true;setSetup(true);setPhase('Create or restore your wallet');return;
   }
   setSetup(false);const cache=createNativeStorage(secret,localStorage,putSecret);
   manualLock.current=false;const next={generation:status.generation,cache};active.current=next;setSession(next);setPhase(status.mode==='direct'?'Tor off · Direct connection':'Tor connected');
  }catch(cause){if(mine===attempt.current)fail(cause);}
  finally{if(mine===attempt.current){setBusy(false);openingGeneration.current=undefined;}}
  })();
  opening.current=run.finally(()=>{opening.current=undefined;});return opening.current;
 },[]);
 const create=async(restore:boolean)=>{
  if(creating.current||transition.current||manualLock.current||!setupAllowed.current)return;
  const mine=attempt.current;setBusy(true);setSaving(true);setError('');
  healthExpired.current=false;
  const writing=saveNativeSetup(torHealth.status,nativeNetwork.status,()=>mine===attempt.current&&!document.hidden&&!manualLock.current&&!transition.current,
   ()=>restore?bytesToHex(parseMasterSecret(phrase)):bytesToHex(crypto.getRandomValues(new Uint8Array(32))),async secret=>{
    setupAllowed.current=false;setSetup(false);setPhase('Reopen the wallet to confirm secure storage');
    await putSecret(secret);localStorage.setItem('shielded-native-wallet','1');
    if(!restore){localStorage.setItem('shielded-rollup-wallet-born-v1','new');localStorage.setItem('shielded-rollup-wallet-created-v1',String(Date.now()));}
   });
  creating.current=writing;
  try{
   await writing;
   if(creating.current===writing)creating.current=undefined;
   if(mine===attempt.current){setPhrase('');await open();}
  }catch(cause){if(mine===attempt.current){fail(cause);setBusy(false);}}
  finally{if(creating.current===writing)creating.current=undefined;setSaving(false);}
 };
 const switchMode=async(mode:NativeMode)=>{
  if(transition.current||creating.current||manualLock.current)return;
  transition.current=true;setSwitching(true);setConfirmDirect(false);setError('');
  const mine=attempt.current+1;
   try{await pause();if(mine!==attempt.current||document.hidden||manualLock.current||!transition.current)return;selectedMode.current=mode;await open();}
  catch(cause){fail(cause);}
  finally{transition.current=false;setSwitching(false);}
 };
 const toggleTor=()=>{if(transition.current||creating.current||manualLock.current)return;if(selectedMode.current==='direct')void switchMode('tor');else setConfirmDirect(true);};
 useEffect(()=>{
  let live=true;void open();
  const visibility=()=>{
   if(document.hidden)void pause();
   else if(!manualLock.current&&!active.current)void closed.current.catch(()=>{}).then(()=>{if(!manualLock.current&&!document.hidden)void open();});
  };
  document.addEventListener('visibilitychange',visibility);
  const external=(event:MouseEvent)=>{
   const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;
   const url=new URL(anchor.getAttribute('href')!,location.href);
   if(['http:','https:'].includes(url.protocol)&&url.origin!==location.origin){event.preventDefault();event.stopPropagation();setExternalLink(url.href);}
  };
  document.addEventListener('click',external,true);
  const monitor=createNativeTorMonitor(nativeNetwork,health=>{
   if(!live)return;setTorHealth(health);
   const observed=active.current;
   const connecting=openingGeneration.current;
   if(connecting!==undefined&&(health.status.phase!=='ready'||health.status.generation!==connecting)){
    openingGeneration.current=undefined;healthExpired.current=true;
   }
   if(observed&&(health.status.phase!=='ready'||health.status.generation!==observed.generation))void pause();
  },cause=>{if(live){fail(cause);if(active.current)void pause();}},()=>!document.hidden);
  return()=>{live=false;monitor.stop();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',external,true);void pause();};
 },[open,pause]);
 const reload=useCallback(()=>{
  const current=active.current,mine=attempt.current;if(!current)return;
  void current.cache.flush().then(async()=>{
   if(active.current!==current||attempt.current!==mine||manualLock.current||document.hidden)return;
   const nextAttempt=attempt.current+1;await pause();
   if(attempt.current===nextAttempt&&!manualLock.current&&!document.hidden)await open();
  }).catch(cause=>{if(active.current===current&&attempt.current===mine){fail(cause);void pause();}});
 },[open,pause]);
 return <>
  {session&&<div className="native-wallet-topbar"><div className="app-header-status"><NativeTorHealth health={torHealth} onToggleTor={toggleTor} transportBusy={switching||saving}/><AppUpdateNotice/></div><button className="native-wallet-lock" type="button" onClick={()=>{manualLock.current=true;setConfirmDirect(false);void pause();}}>Lock wallet</button></div>}
  {confirmDirect&&<NativeConnectionWarning onCancel={()=>setConfirmDirect(false)} onConfirm={()=>void switchMode('direct')}/>}
  {externalLink&&<section className="stock-warning" role="dialog" aria-label="External link"><p>Copy this link to open it outside Shielded. Your browser uses its own network connection.</p><input aria-label="Link to copy" readOnly value={externalLink} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>setExternalLink('')}>Close</button></section>}
  {session?<Suspense fallback={<p role="status">Opening wallet</p>}><Wallet key={session.generation} storage={session.cache.storage} reload={reload} onShutdown={onShutdown}/></Suspense>
   :<WalletOnboarding transport="tor" setup={setup} busy={busy||switching||saving} phase={phase} error={error} phrase={phrase} torHealth={torHealth} onToggleTor={manualLock.current?undefined:toggleTor} transportBusy={switching||saving} onPhraseChange={setPhrase} onCreate={()=>void create(false)} onRestore={()=>void create(true)} onReconnect={()=>{if(transition.current||creating.current)return;manualLock.current=false;void open();}}/>}
 </>;
}
