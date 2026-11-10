import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {getCurrent,onOpenUrl} from '@tauri-apps/plugin-deep-link';
import {bytesToHex} from '@noble/hashes/utils.js';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {installNativeTransport,nativeNetwork,type NativeMode} from '../../src/native/index.ts';
import {createNativeStorage} from './native-storage.ts';
import {createNativeCleanup} from './native-cleanup.ts';
import {createNativeViewHandoff,isNativeWalletViewActive,type NativeWalletView} from './native-view-handoff.ts';
import {openNativeVault,resumeNativeForeground} from './native-open.ts';
import {saveNativeSetup} from './native-setup.ts';
import {clearNativeWalletData,RESET_PENDING} from './native-reset.ts';
import NativeConnectionWarning from './NativeConnectionWarning.tsx';
import {createNativeTorMonitor,type NativeTorHealthState} from './native-tor-monitor.ts';
import WalletOnboarding from './WalletOnboarding.tsx';
import NativeTorHealth from './NativeTorHealth.tsx';
import {AppUpdateNotice} from './AppUpdates.tsx';
import {clearNativeTransientDocument} from './wallet-recovery.ts';
import {paymentDeepLink,type IncomingPayment} from './native-deeplink.ts';

installNativeTransport();
const loadWallet=()=>import('./RollupWallet');
const Wallet=lazy(loadWallet);
const getSecret=()=>invoke<string|null>('plugin:shielded-platform|secret_get');
const putSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_set',{value});
const clearSecret=()=>invoke<void>('plugin:shielded-platform|secret_clear');
type Session={generation:number;cache:ReturnType<typeof createNativeStorage>;resumed:boolean;onReady?:()=>void;onStartupFailure?:(message:string)=>void};
const clearTransientDocument=()=>clearNativeTransientDocument(document.documentElement,[...document.querySelectorAll('[inert]')]);

export default function NativeWallet(){
 const [views,setViews]=useState<{shown?:NativeWalletView<Session>;candidate?:NativeWalletView<Session>}>({}),[phase,setPhase]=useState('Connecting to Tor'),[error,setError]=useState('');
 const session=views.shown?.session;
 const [setup,setSetup]=useState(false),[phrase,setPhrase]=useState(''),[busy,setBusy]=useState(true);
 const [torHealth,setTorHealth]=useState<NativeTorHealthState>({status:{phase:'idle',generation:0},check:'idle'});
 const [externalLink,setExternalLink]=useState('');
 const [paymentRequest,setPaymentRequest]=useState<IncomingPayment>();
 const [confirmDirect,setConfirmDirect]=useState(false),[switching,setSwitching]=useState(false),[saving,setSaving]=useState(false);
 const [reconnecting,setReconnecting]=useState(false);
 const [resetPending,setResetPending]=useState(()=>localStorage.getItem(RESET_PENDING)==='1');
 const selectedMode=useRef<NativeMode>('tor'),transition=useRef(false),clearing=useRef(false),creating=useRef<Promise<void>|undefined>(undefined);
 const setupAllowed=useRef(false);
 const active=useRef<Session|undefined>(undefined),attempt=useRef(0),cleanup=useRef(createNativeCleanup()),closed=useRef<Promise<void>>(Promise.resolve()),manualLock=useRef(false);
 const resumeRevision=useRef(0);
 const paymentRequestRevision=useRef(0);
 const connectionPending=useRef(false);
 const opening=useRef<Promise<void>|undefined>(undefined);
 const openingGeneration=useRef<number|undefined>(undefined);
 const healthExpired=useRef(false);
 const fail=(cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause));
 const handoff=useRef(createNativeViewHandoff<Session>(shutdown=>{
  const closing=cleanup.current.add(shutdown);closed.current=Promise.all([closed.current.catch(()=>{}),closing]).then(()=>{});void closed.current.catch(fail);
 }));
 const pause=useCallback(()=>{
  clearTransientDocument();
  ++attempt.current;
  connectionPending.current=true;setReconnecting(false);
  setupAllowed.current=false;setSetup(false);
  const previous=active.current;active.current=undefined;
  const retiring=handoff.current.retire(false);setViews(handoff.current.snapshot);
  const pending=opening.current;setBusy(false);setPhase('Private connection paused');
  // An ambiguous vault write must settle before a new open reconciles its metadata.
  const pendingWrite=creating.current;
  const paused=nativeNetwork.pause();void paused.catch(()=>{});
  const closing=cleanup.current.add(async()=>{await pendingWrite?.catch(()=>{});await paused.catch(()=>nativeNetwork.pause());},async()=>{for(const view of retiring)await view.shutdown?.();await previous?.cache.flush();});
  closed.current=Promise.all([closed.current.catch(()=>{}),closing,pending]).then(()=>{}).finally(()=>previous?.cache.clearMemory());
  void closed.current.catch(fail);return closed.current;
 },[]);
 const suspend=useCallback(()=>{
  clearTransientDocument();
  ++attempt.current;connectionPending.current=true;setReconnecting(true);
  setupAllowed.current=false;setSetup(false);setBusy(false);setPhase('Private connection paused');
  const previous=active.current,pending=opening.current,pendingWrite=creating.current;
  const retiring=handoff.current.retire(true);setViews(handoff.current.snapshot);
  const paused=nativeNetwork.pause();void paused.catch(()=>{});
  const closing=cleanup.current.add(async()=>{await pendingWrite?.catch(()=>{});await paused.catch(()=>nativeNetwork.pause());},async()=>{for(const view of retiring)await view.shutdown?.();await previous?.cache.flush();});
  closed.current=Promise.all([closed.current.catch(()=>{}),closing,pending]).then(()=>{});
  void closed.current.catch(fail);return closed.current;
 },[]);
 const finishReset=useCallback(()=>{
  if(opening.current)return opening.current;
  clearing.current=true;setResetPending(true);setBusy(true);setError('');setPhase('Finishing wallet reset');
  const run=(async()=>{
   try{
    await nativeNetwork.pause();
    await clearNativeWalletData(clearSecret,{onBlocked:()=>setPhase('Waiting for wallet data to close')});
    location.reload();
   }catch(cause){
    setBusy(false);fail(cause);throw cause;
   }
  })();
  opening.current=run.finally(()=>{opening.current=undefined});return opening.current;
 },[]);
 const open=useCallback(()=>{
  if(opening.current)return opening.current;
   if(document.hidden){setBusy(false);setPhase('Private connection paused');return Promise.resolve();}
   if(localStorage.getItem(RESET_PENDING)==='1')return finishReset();
   if(manualLock.current||clearing.current){setBusy(false);setPhase('Private connection paused');return Promise.resolve();}
  const previousClose=closed.current;
  const resume=active.current;
  const run=(async()=>{
   healthExpired.current=false;
   const mine=++attempt.current;connectionPending.current=true;setupAllowed.current=false;setSetup(false);setBusy(!resume);setReconnecting(!!resume);setError('');
   void loadWallet().catch(()=>{});
  try{
   await cleanup.current.drain();
   if(mine!==attempt.current)return;
   await previousClose.catch(()=>{});
    if(mine!==attempt.current||document.hidden||manualLock.current||clearing.current)return;
   setPhase(selectedMode.current==='tor'?'Connecting to Tor':'Opening direct connection');
    const generationGuard=()=>mine===attempt.current&&!document.hidden&&!manualLock.current&&!clearing.current&&!healthExpired.current;
   const opened=await openNativeVault(async()=>{
    const status=await nativeNetwork.start(selectedMode.current);
    if(status.phase==='ready')openingGeneration.current=status.generation;
    return status;
   },getSecret,generationGuard,{mode:selectedMode.current,current:generationGuard});
   if(opened&&opened.secret!==null)await loadWallet();
   openingGeneration.current=undefined;
    if(mine!==attempt.current||document.hidden||manualLock.current||clearing.current)return;
   if(!opened||healthExpired.current)throw new Error('The connection changed while opening the wallet. Reconnect to try again.');
   const {secret,status}=opened;
   if(secret===null){
    if(resume||localStorage.getItem('shielded-native-wallet')==='1')throw new Error('The native wallet secret is unavailable. Keep the app data and restore access to its vault.');
    connectionPending.current=false;setupAllowed.current=true;setSetup(true);setPhase('Create or restore your wallet');return;
   }
   if(resume&&resume.cache.storage.getItem('shielded-rollup-wallet-secret-v1')!==secret)throw new Error('The native vault changed. Lock and reopen the wallet before continuing.');
   setSetup(false);const cache=resume?.cache??createNativeStorage(secret,localStorage,putSecret);
   manualLock.current=false;const next:Session={generation:status.generation,cache,resumed:!!resume};active.current=next;
   const view=handoff.current.stage(next),candidate=handoff.current.snapshot.candidate===view;
    const current=()=>active.current===next&&mine===attempt.current&&!document.hidden&&!manualLock.current&&!clearing.current&&!healthExpired.current&&handoff.current.snapshot.candidate===view;
   if(candidate){
    next.onStartupFailure=message=>{
     if(!current())return;
     const rejected=handoff.current.discard(view);if(!rejected)return;
     if(rejected.shutdown)void cleanup.current.add(rejected.shutdown).catch(fail);
     setError(message);void suspend().catch(fail);
    };
    let checking=false;
    next.onReady=()=>{
     if(checking||!current())return;checking=true;
     void nativeNetwork.status().then(latest=>{
      if(!current())return;
      if(latest.phase!=='ready'||latest.generation!==next.generation||(latest.mode??'tor')!==selectedMode.current){next.onStartupFailure?.('The connection changed while opening the wallet. Reconnect to try again.');return;}
      if(handoff.current.promote(view,current)){setViews(handoff.current.snapshot);setReconnecting(false);setError('');setPhase(latest.mode==='direct'?'Tor off · Direct connection':'Tor connected');}
     }).catch(cause=>next.onStartupFailure?.(cause instanceof Error?cause.message:String(cause))).finally(()=>{checking=false;});
    };
   }
   setViews(handoff.current.snapshot);connectionPending.current=false;setReconnecting(candidate);setPhase(candidate?'Reconnecting wallet':status.mode==='direct'?'Tor off · Direct connection':'Tor connected');
  }catch(cause){if(mine===attempt.current)fail(cause);}
  finally{if(mine===attempt.current){setBusy(false);openingGeneration.current=undefined;}}
  })();
  opening.current=run.finally(()=>{opening.current=undefined;});return opening.current;
 },[finishReset,suspend]);
 const clearWallet=useCallback(async()=>{
  if(transition.current||creating.current)throw new Error('Wait for the current wallet operation to finish before clearing it.');
  transition.current=true;clearing.current=true;setResetPending(true);localStorage.setItem(RESET_PENDING,'1');setBusy(true);setSaving(true);setError('');setPhase('Clearing wallet');
  try{
   await pause();
   await clearNativeWalletData(clearSecret,{onBlocked:()=>setPhase('Waiting for wallet data to close')});
   location.reload();
  }catch(cause){
   transition.current=false;clearing.current=false;setSaving(false);setBusy(false);fail(cause);throw cause;
  }
 },[pause]);
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
  let live=true,unlisten:(()=>void)|undefined;
  const receive=(urls:string[]|null)=>{
   if(!live)return;
   const uri=paymentDeepLink(urls);
   if(uri)setPaymentRequest({id:++paymentRequestRevision.current,uri});
  };
  void onOpenUrl(receive).then(remove=>{if(live)unlisten=remove;else remove();}).catch(()=>{});
  void getCurrent().then(receive).catch(()=>{});
  return()=>{live=false;unlisten?.();};
 },[]);
 useEffect(()=>{
  let live=true;
  const visibility=()=>{
   clearTransientDocument();
   const mine=++resumeRevision.current;
   if(document.hidden){
    void suspend();
   }else if(!manualLock.current){
    const restart=async()=>{
     const shown=handoff.current.snapshot.shown;
     if(shown&&!shown.retired)await suspend();
     if(live&&mine===resumeRevision.current&&!manualLock.current&&!clearing.current&&!document.hidden)await open();
    };
    void resumeNativeForeground(Promise.all([closed.current,opening.current]),()=>live&&mine===resumeRevision.current&&!manualLock.current&&!clearing.current&&!document.hidden,restart).catch(fail);
   }
  };
  document.addEventListener('visibilitychange',visibility);
  visibility();
  const external=(event:MouseEvent)=>{
   const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;
   if(anchor.getAttribute('data-native-external')==='true')return;
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
   if(observed&&!connectionPending.current&&(health.status.phase!=='ready'||health.status.generation!==observed.generation)){
    void suspend().then(()=>{if(live&&!manualLock.current&&!document.hidden)return open();}).catch(fail);
   }
  },cause=>{if(live){fail(cause);if(active.current&&!connectionPending.current)void suspend();}},()=>!document.hidden);
  return()=>{live=false;monitor.stop();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',external,true);void pause();};
 },[open,pause,suspend]);
 const reload=useCallback(()=>{
  const current=active.current,mine=attempt.current;if(!current)return;
  void current.cache.flush().then(async()=>{
   if(active.current!==current||attempt.current!==mine||manualLock.current||document.hidden)return;
   const nextAttempt=attempt.current+1;await pause();
   if(attempt.current===nextAttempt&&!manualLock.current&&!document.hidden)await open();
  }).catch(cause=>{if(active.current===current&&attempt.current===mine){fail(cause);void pause();}});
   },[open,pause]);
 return <>
  {session&&<div className="native-wallet-topbar"><div className="app-header-status"><NativeTorHealth health={torHealth} onToggleTor={toggleTor} transportBusy={switching||saving||(reconnecting&&!error)}/><AppUpdateNotice/>{reconnecting&&<span role="status">{error||phase}</span>}{reconnecting&&error&&<button type="button" onClick={()=>void open()}>Reconnect</button>}</div><button className="native-wallet-lock" type="button" onClick={()=>{manualLock.current=true;setConfirmDirect(false);void pause();}}>Lock wallet</button></div>}
  {confirmDirect&&<NativeConnectionWarning onCancel={()=>setConfirmDirect(false)} onConfirm={()=>void switchMode('direct')}/>}
  {externalLink&&<section className="stock-warning" role="dialog" aria-label="External link"><p>Copy this link to open it outside Shielded. Your browser uses its own network connection.</p><input aria-label="Link to copy" readOnly value={externalLink} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>setExternalLink('')}>Close</button></section>}
    {session?<>{[views.shown,views.candidate].filter((view):view is NativeWalletView<Session>=>!!view).map(view=>{const shown=view===views.shown,viewActive=isNativeWalletViewActive(view,shown);return <Suspense key={view.session.generation} fallback={shown?<p role="status">Opening wallet</p>:null}><Wallet nativeHost storage={view.session.cache.storage} reload={reload} onShutdown={view.onShutdown} onClearWallet={clearWallet} onReady={view.session.onReady} onStartupFailure={view.session.onStartupFailure} paymentRequest={paymentRequest} onPaymentRequestHandled={id=>setPaymentRequest(current=>current?.id===id?undefined:current)} animateEntrance={!view.session.resumed} suspended={view.retired} viewActive={viewActive} hidden={!viewActive}/></Suspense>;})}</>
   :<WalletOnboarding transport="tor" setup={setup} busy={busy||switching||saving} phase={phase} error={error} phrase={phrase} torHealth={torHealth} onToggleTor={manualLock.current?undefined:toggleTor} transportBusy={switching||saving} reconnectLabel={resetPending?'Retry wallet reset':undefined} onPhraseChange={setPhrase} onCreate={()=>void create(false)} onRestore={()=>void create(true)} onReconnect={()=>{if(transition.current||creating.current)return;manualLock.current=false;void (resetPending?finishReset():open());}}/>}
 </>;
}
