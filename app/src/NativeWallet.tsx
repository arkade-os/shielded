import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {getCurrent,onOpenUrl} from '@tauri-apps/plugin-deep-link';
import {bytesToHex} from '@noble/hashes/utils.js';
import {base64urlnopad} from '@scure/base';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {createPasskeySeed,passkeyRpId,restorePasskeySeed,type PasskeyFallback,type PasskeyWordCount} from '../../packages/protocol/src/passkey.ts';
import {installNativeTransport,nativeNetwork,type NativeMode,type NativeStatus} from '../../src/native/index.ts';
import {createNativeStorage} from './native-storage.ts';
import {createNativeCleanup} from './native-cleanup.ts';
import {createNativeViewHandoff,currentNativeWalletView,isNativeWalletViewActive,nativeWalletPresentation,type NativeWalletView} from './native-view-handoff.ts';
import {NATIVE_FOREGROUND_HOLD,nativeForegroundHold,openNativeVault,reopenNativeForeground,resumeNativeForeground} from './native-open.ts';
import {saveNativeSetup} from './native-setup.ts';
import {commitNativeSetup,waitNativePasskeyForeground} from './native-passkey-operation.ts';
import {nativePasskeys,nativePasskeySupport,type NativePasskeySupport} from './native-passkeys.ts';
import {passkeyRecord} from './passkey-record.ts';
import {pendingNativeSetup,reconcileNativeSetup} from './native-setup-journal.ts';
import {passkeyFailureView,passkeyUserName} from './shielded-page.ts';
import {deviceLockFallback,lockedReadBack,lockedSecretCache,lockedSecretCreate,newLockedSecret,readNativeSecret,restoreOverLock,unlockError} from './native-locked.ts';
import PasskeyFallbackSheet,{deviceLockName} from './PasskeyFallbackSheet.tsx';
import {clearNativeWalletData,RESET_PENDING} from './native-reset.ts';
import NativeConnectionWarning,{NativeExternalLink} from './NativeConnectionWarning.tsx';
import {createNativeTorMonitor,type NativeTorHealthState} from './native-tor-monitor.ts';
import WalletOnboarding from './WalletOnboarding.tsx';
import NativeTorHealth from './NativeTorHealth.tsx';
import type {WalletConnection} from './RollupWallet.tsx';
import NativeResumePresentation from './NativeResumePresentation.tsx';
import {createNativeResumePresentation,type NativeResumeSnapshot} from './native-resume-presentation.ts';
import {AppUpdateNotice} from './AppUpdates.tsx';
import {Icon} from './components.tsx';
import {clearNativeTransientDocument} from './wallet-recovery.ts';
import {watchPaymentDeepLinks,type IncomingPayment} from './native-deeplink.ts';
import {registerAndroidInstallPreparation} from './android-updates.ts';
import {watchPageVisibility} from './page-visibility.ts';

installNativeTransport();
const loadWallet=()=>import('./RollupWallet');
const Wallet=lazy(loadWallet);
const getSecret=()=>invoke<string|null>('plugin:shielded-platform|secret_get');
const putSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_set',{value});
const createSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_create',{value});
const clearSecret=()=>invoke<void>('plugin:shielded-platform|secret_clear');
const lockedSecret=lockedSecretCache();
const LOCK_PLATFORM=typeof __NATIVE_PLATFORM__==='string'&&__NATIVE_PLATFORM__.startsWith('windows')?'windows':'android';
const PASSKEY_RP_ID=passkeyRpId(globalThis.__SHIELDED_NATIVE__!.poolOrigin,location.hostname);
type Session={onResumeSnapshot?:(snapshot:NativeResumeSnapshot)=>void;onScannerIntentChange?:(requested:boolean)=>void;onResumeScannerHandled?:(token:number)=>void;generation:number;cache:ReturnType<typeof createNativeStorage>;resumed:boolean;onReady?:()=>void;onStartupFailure?:(message:string)=>void;onStartupStage?:(message:string)=>void;words?:string};
const clearTransientDocument=()=>clearNativeTransientDocument(document.documentElement,[...document.querySelectorAll('[inert]')]);

export default function NativeWallet(){
 const [views,setViews]=useState<{shown?:NativeWalletView<Session>;candidate?:NativeWalletView<Session>}>({}),[phase,setPhase]=useState('Connecting to Tor'),[error,setError]=useState('');
 const [reconnecting,setReconnecting]=useState(false);
 const presentation=nativeWalletPresentation(views,reconnecting),shown=presentation.shown,candidate=presentation.views.find(item=>item.view===views.candidate)?.view,session=shown?.session;
 const [setup,setSetup]=useState(false),[phrase,setPhrase]=useState(''),[busy,setBusy]=useState(true);
 const [torHealth,setTorHealth]=useState<NativeTorHealthState>({status:{phase:'idle',generation:0},check:'idle'}),[walletConnection,setWalletConnection]=useState<WalletConnection>();
 const [externalLink,setExternalLink]=useState('');
 const [paymentRequest,setPaymentRequest]=useState<IncomingPayment>();
 const [confirmDirect,setConfirmDirect]=useState(false),[switching,setSwitching]=useState(false),[saving,setSaving]=useState(false);
 const [resetPending,setResetPending]=useState(()=>localStorage.getItem(RESET_PENDING)==='1');
 const [passkeySupport,setPasskeySupport]=useState<NativePasskeySupport>(),[setupIntent,setSetupIntent]=useState<ReturnType<typeof pendingNativeSetup>>();
 const [fallbackName,setFallbackName]=useState(''),[unlock,setUnlock]=useState<{gone:boolean}>(),fallback=useRef<PasskeyFallback|undefined>(undefined),setupWords=useRef<string|undefined>(undefined),unlockHeld=useRef<Error|undefined>(undefined);
 const selectedMode=useRef<NativeMode|undefined>(undefined),transition=useRef(false),clearing=useRef(false),creating=useRef<Promise<void>|undefined>(undefined);
 const setupOperation=useRef<{controller:AbortController;expected:NativeStatus}|undefined>(undefined);
 const cancelSetup=useCallback(()=>{const operation=setupOperation.current;if(!operation)return;setupOperation.current=undefined;operation.controller.abort();setSaving(!!creating.current);},[]);
 const setupAllowed=useRef(false);
 const active=useRef<Session|undefined>(undefined),attempt=useRef(0),cleanup=useRef(createNativeCleanup()),closed=useRef<Promise<void>>(Promise.resolve()),manualLock=useRef(false);
 const resumeRevision=useRef(0),nativeForeground=useRef(true);
 const pageVisible=useRef(!document.hidden);
 const pageForeground=useCallback(()=>pageVisible.current&&!document.hidden,[]);
 const resumeMemory=useRef(createNativeResumePresentation()),resumeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const [,setResumeRender]=useState(0);
 const clearResume=useCallback(()=>{clearTimeout(resumeTimer.current);resumeMemory.current.clear();setResumeRender(value=>value+1);},[]);
 const freezeResume=useCallback(()=>{
  resumeMemory.current.freeze();clearTimeout(resumeTimer.current);const ticket=resumeMemory.current.ticket;
  resumeTimer.current=setTimeout(()=>{resumeMemory.current.expire(ticket);setResumeRender(value=>value+1);},resumeMemory.current.remaining);
  setResumeRender(value=>value+1);
 },[]);
 const paymentRequestRevision=useRef(0),paymentRequestPending=useRef(false);
 const connectionPending=useRef(false);
 const openingOperation=useRef<Promise<void>|undefined>(undefined);
 const openingGeneration=useRef<number|undefined>(undefined);
 const healthExpired=useRef(false);
 const fail=(cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause));
 const handoff=useRef(createNativeViewHandoff<Session>(shutdown=>{
  const closing=cleanup.current.add(shutdown);closed.current=Promise.all([closed.current.catch(()=>{}),closing]).then(()=>{});void closed.current.catch(fail);
 }));
 const liveShown=useCallback(()=>{
  const {shown,candidate}=handoff.current.snapshot,view=currentNativeWalletView(shown);
  return view&&!candidate&&active.current===view.session&&!openingOperation.current?view:undefined;
 },[]);
 const retained=useCallback(async()=>{
  const view=liveShown();if(!view)return false;
  const status=await nativeNetwork.status().catch(()=>undefined);
  return !!status&&status.phase==='ready'&&status.generation===view.session.generation&&selectedMode.current!==undefined&&(status.mode??'tor')===selectedMode.current&&liveShown()===view;
 },[liveShown]);
 const pause=useCallback(()=>{
  cancelSetup();
  clearResume();clearTransientDocument();
  ++attempt.current;
  connectionPending.current=true;setReconnecting(false);
  setupAllowed.current=false;setSetup(false);
  const previous=active.current;active.current=undefined;
  const retiring=handoff.current.retire(false);setViews(handoff.current.snapshot);
  const pending=openingOperation.current;setBusy(false);setPhase('Private connection paused');
  // An ambiguous vault write must settle before a new open reconciles its metadata.
  const pendingWrite=creating.current;
  const paused=nativeNetwork.pause();void paused.catch(()=>{});
  const closing=cleanup.current.add(async()=>{await pendingWrite?.catch(()=>{});await paused.catch(()=>nativeNetwork.pause());},async()=>{for(const view of retiring)await view.shutdown?.();await previous?.cache.flush();});
  closed.current=Promise.all([closed.current.catch(()=>{}),closing,pending]).then(()=>{}).finally(()=>previous?.cache.clearMemory());
  void closed.current.catch(fail);return closed.current;
 },[clearResume,cancelSetup]);
 const suspend=useCallback(()=>{
  cancelSetup();
  if(handoff.current.snapshot.shown&&!handoff.current.snapshot.shown.retired)freezeResume();
  clearTransientDocument();
  ++attempt.current;connectionPending.current=true;setReconnecting(true);
  setupAllowed.current=false;setSetup(false);setBusy(false);setPhase('Reconnecting your private session');
  const previous=active.current,pending=openingOperation.current,pendingWrite=creating.current;
  const retiring=handoff.current.retire(true);setViews(handoff.current.snapshot);
  const paused=nativeNetwork.pause(true);void paused.catch(()=>{});
  const closing=cleanup.current.add(async()=>{await pendingWrite?.catch(()=>{});await paused.catch(()=>nativeNetwork.pause());},async()=>{for(const view of retiring)await view.shutdown?.();await previous?.cache.flush();});
  closed.current=Promise.all([closed.current.catch(()=>{}),closing,pending]).then(()=>{});
  void closed.current.catch(fail);return closed.current;
 },[freezeResume,cancelSetup]);
 useEffect(()=>{let live=true;void nativePasskeySupport().then(support=>{if(live)setPasskeySupport(support);},()=>{if(live)setPasskeySupport({available:false,reason:'Passkeys are unavailable on this device. Use a recovery phrase to create or restore a wallet.'});});return()=>{live=false;};},[]);
 useEffect(()=>registerAndroidInstallPreparation(async()=>{
  if(clearing.current||localStorage.getItem(RESET_PENDING)==='1')throw new Error('The wallet is being cleared. Finish that operation before installing an update.');
  manualLock.current=true;setConfirmDirect(false);await pause();
  if(clearing.current||localStorage.getItem(RESET_PENDING)==='1')throw new Error('The wallet is being cleared. Finish that operation before installing an update.');
 }),[pause]);
 const finishReset=useCallback(()=>{
  if(openingOperation.current)return openingOperation.current;
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
  openingOperation.current=run.finally(()=>{openingOperation.current=undefined});return openingOperation.current;
 },[]);
 const open=useCallback(()=>{
  if(setupOperation.current)return Promise.resolve();
  if(openingOperation.current)return openingOperation.current;
   if(!pageForeground()||!nativeForeground.current){setBusy(false);setPhase(!pageForeground()?'Private connection paused':NATIVE_FOREGROUND_HOLD);return Promise.resolve();}
   if(localStorage.getItem(RESET_PENDING)==='1')return finishReset();
   if(manualLock.current||clearing.current){setBusy(false);setPhase('Private connection paused');return Promise.resolve();}
  const previousClose=closed.current;
  const resume=active.current;
  const run=(async()=>{
   healthExpired.current=false;
   const mine=++attempt.current;connectionPending.current=true;setupAllowed.current=false;setSetup(false);setUnlock(undefined);setBusy(!resume);setReconnecting(!!resume);setError('');
   void loadWallet().catch(()=>{});
  try{
   setPhase(resume?'Closing previous wallet operations':'Starting your private connection');
   await cleanup.current.drain();
   if(mine!==attempt.current)return;
   await previousClose.catch(()=>{});
   const mode=selectedMode.current??=await nativeNetwork.hostMode();
    if(mine!==attempt.current||!pageForeground()||!nativeForeground.current||manualLock.current||clearing.current)return;
   setPhase(mode==='tor'?(resume?'Checking Tor readiness':'Connecting to Tor'):'Opening direct connection');
    const generationGuard=()=>mine===attempt.current&&pageForeground()&&nativeForeground.current&&!manualLock.current&&!clearing.current&&!healthExpired.current;
   const opened=await openNativeVault(async()=>{
    const status=await nativeNetwork.start(mode);
    if(status.phase==='ready')openingGeneration.current=status.generation;
    return status;
   },()=>readNativeSecret(getSecret,lockedSecret,unlockHeld,localStorage),generationGuard,{mode,current:generationGuard});
   if(opened&&opened.secret!==null)await loadWallet();
   openingGeneration.current=undefined;
    if(mine!==attempt.current||!pageForeground()||!nativeForeground.current||manualLock.current||clearing.current)return;
   if(!opened||healthExpired.current)throw new Error('The connection changed while opening the wallet. Reconnect to try again.');
   const {secret,status}=opened;
   const pending=reconcileNativeSetup(localStorage,secret);setSetupIntent(pending);
   if(secret===null){
    if(resume||localStorage.getItem('shielded-native-wallet')==='1')throw new Error('The native wallet secret is unavailable. Keep the app data and restore access to its vault.');
    connectionPending.current=false;setupAllowed.current=true;setSetup(true);setPhase('Create or restore your wallet');return;
   }
   if(resume&&resume.cache.storage.getItem('shielded-rollup-wallet-secret-v1')!==secret)throw new Error('The native vault changed. Lock and reopen the wallet before continuing.');
   setSetup(false);const cache=resume?.cache??createNativeStorage(secret,localStorage,putSecret);
   manualLock.current=false;const next:Session={generation:status.generation,cache,resumed:!!resume,words:setupWords.current};setupWords.current=undefined;active.current=next;
   const view=handoff.current.stage(next,{awaitReady:true}),candidate=handoff.current.snapshot.candidate===view;
   next.onResumeSnapshot=snapshot=>{if(active.current===next&&!view.retired)resumeMemory.current.remember(snapshot);};
   next.onScannerIntentChange=requested=>{if(active.current===next&&!view.retired&&(!requested||!paymentRequestPending.current))resumeMemory.current.scanner(requested);};
   next.onResumeScannerHandled=token=>{if(active.current===next&&!view.retired){resumeMemory.current.acknowledge(token);setResumeRender(value=>value+1);}};
    const current=()=>active.current===next&&mine===attempt.current&&pageForeground()&&nativeForeground.current&&!manualLock.current&&!clearing.current&&!healthExpired.current&&handoff.current.snapshot.candidate===view;
   if(candidate){
    next.onStartupFailure=message=>{
     if(!current())return;
     const rejected=handoff.current.discard(view);if(!rejected)return;clearResume();
     if(rejected.shutdown)void cleanup.current.add(rejected.shutdown).catch(fail);
     setError(message);void suspend().catch(fail);
    };
    next.onStartupStage=message=>{if(current())setPhase(message);};
    let checking=false;
    next.onReady=()=>{
     if(checking||!current())return;checking=true;
     void nativeNetwork.status().then(latest=>{
      if(!current())return;
      if(latest.phase!=='ready'||latest.generation!==next.generation||(latest.mode??'tor')!==selectedMode.current){next.onStartupFailure?.('The connection changed while opening the wallet. Reconnect to try again.');return;}
      if(handoff.current.promote(view,current)){resumeMemory.current.promote();setResumeRender(value=>value+1);setViews(handoff.current.snapshot);setReconnecting(false);setError('');setPhase(latest.mode==='direct'?'Tor off · Direct connection':'Tor connected');}
     }).catch(cause=>next.onStartupFailure?.(cause instanceof Error?cause.message:String(cause))).finally(()=>{checking=false;});
    };
   }
   setViews(handoff.current.snapshot);connectionPending.current=false;setReconnecting(candidate);setPhase(candidate?'Opening your private wallet':status.mode==='direct'?'Tor off · Direct connection':'Tor connected');
  }catch(cause){if(mine===attempt.current){if(cause instanceof Error&&cause.name==='NativeUnlock'){connectionPending.current=false;setupAllowed.current=true;setSetup(true);setUnlock({gone:unlockError(cause).gone});}fail(cause);}}
  finally{if(mine===attempt.current){setBusy(false);openingGeneration.current=undefined;}}
  })();
  openingOperation.current=run.finally(()=>{openingOperation.current=undefined;});return openingOperation.current;
 },[finishReset,suspend,clearResume,pageForeground]);
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
 const create=async(restore:boolean,withPasskey=false,wordCount:PasskeyWordCount=12,offer?:PasskeyFallback)=>{
  if(setupOperation.current||creating.current||transition.current||manualLock.current||!setupAllowed.current)return;
  const operation={controller:new AbortController(),expected:torHealth.status};setupOperation.current=operation;
  const mine=attempt.current;setBusy(true);setSaving(true);setError('');
  healthExpired.current=false;
  const current=()=>setupOperation.current===operation&&!operation.controller.signal.aborted&&mine===attempt.current&&!manualLock.current&&!transition.current&&!clearing.current&&!healthExpired.current&&(operation.expected.mode??'tor')===selectedMode.current;
  const check=()=>{if(!current())throw new Error('The wallet setup was cancelled. Reopen the wallet before continuing.');};
  const foreground=()=>pageForeground()&&nativeForeground.current;
  let metadata:Parameters<typeof commitNativeSetup>[0]['metadata']={},locked:ReturnType<typeof newLockedSecret>|undefined;
  try{
   const pending=pendingNativeSetup(localStorage);
   if(pending&&!restore)throw new Error('Finish the pending setup with the same passkey or recovery phrase before creating another wallet.');
   if(withPasskey&&(!passkeySupport?.available||pending&&!pending.passkey))throw new Error(passkeySupport?.reason??'Finish the pending setup with its recovery phrase.');
   await waitNativePasskeyForeground(operation.expected,nativeNetwork.status,check,foreground);
   const existing=await getSecret();check();
   if(existing!==null){setupOperation.current=undefined;setSaving(false);setPhrase('');await open();return;}
   await saveNativeSetup(operation.expected,nativeNetwork.status,current,async()=>{
    await waitNativePasskeyForeground(operation.expected,nativeNetwork.status,check,foreground);
    if(offer){const made=newLockedSecret(offer.wordCount);locked=made;metadata={created:offer.createdAt,lock:{words:offer.wordCount}};return made.master;}
    if(withPasskey){
     setPhase('Waiting for your passkey');
     const client=nativePasskeys(undefined,{signal:operation.controller.signal,current:check,foreground,before:()=>waitNativePasskeyForeground(operation.expected,nativeNetwork.status,check,foreground)});
     const at=Date.now(),seed=await (restore?restorePasskeySeed({rpId:PASSKEY_RP_ID,credentialId:pending?.passkey&&base64urlnopad.decode(pending.passkey.credentialId),wordCount:pending?.passkey?.words,client}):createPasskeySeed({rpId:PASSKEY_RP_ID,userName:passkeyUserName(at),createdAt:at,wordCount,client}));
     try{check();metadata={passkey:passkeyRecord(seed),...restore?{}:{created:Date.now()}};return bytesToHex(seed.master);}finally{seed.master.fill(0);}
    }
    const master=restore?parseMasterSecret(phrase):crypto.getRandomValues(new Uint8Array(32));
    try{metadata=restore?{}:{created:Date.now()};return bytesToHex(master);}finally{master.fill(0);}
   },secret=>commitNativeSetup({expected:operation.expected,status:nativeNetwork.status,current:check,foreground,storage:localStorage,secret,metadata,recordBeforeWrite:restore||withPasskey||!!offer,read:locked?()=>lockedReadBack(secret):getSecret,write:value=>{
    check();if(!foreground())throw new Error('Wait until the wallet is active before confirming secure storage.');setupAllowed.current=false;setSetup(false);setPhase('Confirming secure wallet storage');
    if(!locked)return restore?restoreOverLock(()=>createSecret(value)):createSecret(value);
    // Cached as soon as it is stored: if the prompt sent the app to the background, the next open still asks no second time.
    const made=locked;return lockedSecretCreate(made.entropy).then(()=>{void lockedSecret.read(async()=>made.entropy);setupWords.current=made.words;});
   },onWrite:writing=>{
    creating.current=writing;
    const settled=()=>{if(creating.current===writing){creating.current=undefined;if(setupOperation.current!==operation)setSaving(false);}};
    void writing.then(settled,settled);
   }}));
   check();setupOperation.current=undefined;setSaving(false);setPhrase('');await open();
  // An unconfirmed credential is not retried implicitly; the SDK may already have created it.
  }catch(cause){
   const lockOffer=restore||offer?undefined:await deviceLockFallback(cause);
   if(current()){
    if(lockOffer){fallback.current=lockOffer;setFallbackName(lockOffer.userName);}
    else{
     const view=offer?{message:`${unlockError(cause).message} You can delete the passkey “${offer.userName}” in your passkey settings.`,disablePasskeys:true}:passkeyFailureView(cause,restore?'restore':'create');
     setError(view.message??(cause instanceof Error?cause.message:String(cause)));if(view.disablePasskeys)setPasskeySupport({available:false,reason:view.message!});
     if(offer){setupAllowed.current=false;setSetup(false);}
     try{setSetupIntent(pendingNativeSetup(localStorage));}catch(error){fail(error);setupAllowed.current=false;setSetup(false);}
    }
    setBusy(false);
   }
  }
  finally{if(setupOperation.current===operation){setupOperation.current=undefined;setSaving(false);}if(offer&&fallback.current===offer){fallback.current=undefined;setFallbackName('');}}
 };
 const cancelFallback=()=>{
  const offer=fallback.current;if(!offer||setupOperation.current)return;
  fallback.current=undefined;setFallbackName('');const view=passkeyFailureView(offer,'create');setError(view.message!);setPasskeySupport({available:false,reason:view.message!});
 };
 const switchMode=async(mode:NativeMode)=>{
  if(transition.current||creating.current||manualLock.current)return;
  transition.current=true;setSwitching(true);setConfirmDirect(false);setError('');
  const mine=attempt.current+1;
  try{await pause();if(mine!==attempt.current||!pageForeground()||manualLock.current||!transition.current)return;selectedMode.current=mode;await open();}
  catch(cause){fail(cause);}
  finally{transition.current=false;setSwitching(false);}
 };
 const toggleTor=()=>{if(transition.current||creating.current||manualLock.current)return;if(selectedMode.current==='direct')void switchMode('tor');else setConfirmDirect(true);};
 useEffect(()=>{
  return watchPaymentDeepLinks({onOpenUrl,getCurrent},uri=>{paymentRequestPending.current=true;resumeMemory.current.scanner(false);setResumeRender(value=>value+1);setPaymentRequest({id:++paymentRequestRevision.current,uri});});
 },[]);
 useEffect(()=>{
  let live=true;
  const resume=(mine:number)=>{
   if(setupOperation.current)return Promise.resolve();
   const current=()=>live&&mine===resumeRevision.current&&!manualLock.current&&!clearing.current&&pageForeground()&&nativeForeground.current;
   // A retained return keeps its open sheets, so only a rebuild may clear their document locks.
   return resumeNativeForeground(Promise.all([closed.current,openingOperation.current]),current,async()=>{
    clearTransientDocument();
    await reopenNativeForeground(handoff.current.snapshot,current,suspend,open);
   },retained);
  };
  const visibility=()=>{
   const mine=++resumeRevision.current;
   if(setupOperation.current)return;
   if(!pageForeground()){
    if(!liveShown())void suspend();
   }else if(!manualLock.current)void resume(mine).catch(fail);
  };
  const external=(event:MouseEvent)=>{
   const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;
   if(anchor.getAttribute('data-native-external')==='true')return;
   const url=new URL(anchor.getAttribute('href')!,location.href);
   if(['http:','https:'].includes(url.protocol)&&url.origin!==location.origin){event.preventDefault();event.stopPropagation();setExternalLink(url.href);}
  };
  document.addEventListener('click',external,true);
  const monitor=createNativeTorMonitor(nativeNetwork,health=>{
   if(!live)return;setTorHealth(health);
   const wasForeground=nativeForeground.current;nativeForeground.current=health.status.foreground!==false;
   if(health.status.phase==='error'||selectedMode.current!==undefined&&health.status.mode!==undefined&&health.status.mode!==selectedMode.current)clearResume();
   const observed=active.current;
   const operation=setupOperation.current;
   if(operation&&(health.status.phase!=='ready'||health.status.generation!==operation.expected.generation||(health.status.mode??'tor')!==(operation.expected.mode??'tor'))){
    healthExpired.current=true;void suspend().then(()=>{if(live&&!manualLock.current&&pageForeground()&&nativeForeground.current)return open();}).catch(fail);return;
   }
   const connecting=openingGeneration.current;
   if(connecting!==undefined&&(health.status.phase!=='ready'||health.status.generation!==connecting)){
    openingGeneration.current=undefined;healthExpired.current=true;
   }
   if(observed&&!connectionPending.current&&(health.status.phase!=='ready'||health.status.generation!==observed.generation)){
    void suspend().then(()=>{if(live&&!manualLock.current&&pageForeground()&&nativeForeground.current)return open();}).catch(fail);
   }else if(!wasForeground&&nativeForeground.current&&!manualLock.current&&pageForeground()){
    void resume(++resumeRevision.current).catch(fail);
   }
   const held=nativeForegroundHold(health.status,{visible:pageForeground(),live:!!liveShown(),paused:manualLock.current||clearing.current});
   if(held){setBusy(false);setPhase(held);}
  },cause=>{if(live){fail(cause);if(setupOperation.current||active.current&&!connectionPending.current)void suspend();}},pageForeground);
  const stopVisibility=watchPageVisibility(visible=>{pageVisible.current=visible;monitor.visibilityChanged();visibility();});
  return()=>{live=false;stopVisibility();monitor.stop();document.removeEventListener('click',external,true);void pause();};
 },[open,pause,suspend,clearResume,liveShown,retained,pageForeground]);
 const reload=useCallback(()=>{
  const current=active.current,mine=attempt.current;if(!current)return;
  void current.cache.flush().then(async()=>{
   if(active.current!==current||attempt.current!==mine||manualLock.current||!pageForeground())return;
   const nextAttempt=attempt.current+1;await pause();
   if(attempt.current===nextAttempt&&!manualLock.current&&pageForeground())await open();
  }).catch(cause=>{if(active.current===current&&attempt.current===mine){fail(cause);void pause();}});
   },[open,pause,pageForeground]);
 const candidateOpening=!!candidate;
 const reconnectOpening=reconnecting&&!error;
 const opening=candidateOpening||reconnectOpening;
 const frozen=resumeMemory.current.snapshot;
 const showOpening=presentation.showOpening&&!frozen;
 const controls=<div className="native-wallet-controls"><NativeTorHealth health={torHealth} compact onToggleTor={toggleTor} onReconnect={walletConnection?.reconnect} reconnectBusy={walletConnection?.busy} problem={walletConnection?.problem} transportBusy={switching||saving}/><button className="native-wallet-lock" type="button" aria-label="Lock wallet" onClick={()=>{manualLock.current=true;lockedSecret.forget();setConfirmDirect(false);void pause();}}><Icon name="lock" size={19}/></button></div>;
 return <>
  {confirmDirect&&<NativeConnectionWarning onCancel={()=>setConfirmDirect(false)} onConfirm={()=>void switchMode('direct')}/>}
  {externalLink&&<NativeExternalLink url={externalLink} onClose={()=>setExternalLink('')}/>}
    {frozen&&<NativeResumePresentation snapshot={frozen} phase={phase} error={error} controls={<div className="app-header-status">{controls}<AppUpdateNotice/></div>}/>}
    {presentation.views.map(({view,visible})=>{const viewActive=isNativeWalletViewActive(view,visible);return <Suspense key={view.session.generation} fallback={visible?<p role="status">Opening wallet</p>:null}><Wallet nativeHost onResumeSnapshot={view.session.onResumeSnapshot} onScannerIntentChange={view.session.onScannerIntentChange} resumeScanner={viewActive&&!paymentRequestPending.current?resumeMemory.current.delivery():undefined} onResumeScannerHandled={view.session.onResumeScannerHandled} storage={view.session.cache.storage} reload={reload} onConnection={setWalletConnection} onShutdown={view.onShutdown} onClearWallet={clearWallet} onReady={view.session.onReady} onStartupFailure={view.session.onStartupFailure} onStartupStage={view.session.onStartupStage} paymentRequest={paymentRequest} onPaymentRequestHandled={id=>{if(id===paymentRequestRevision.current)paymentRequestPending.current=false;setPaymentRequest(current=>current?.id===id?undefined:current);}} animateEntrance={!view.session.resumed&&viewActive} suspended={view.retired} viewActive={viewActive} hidden={!viewActive} headerControls={controls} setupPhrase={view.session.words}/></Suspense>;})}
    {showOpening&&<WalletOnboarding transport="tor" setup={setup||opening} opening={opening} busy={busy||switching||saving||opening} phase={phase} error={error} phrase={phrase} torHealth={torHealth} onToggleTor={manualLock.current||opening?undefined:toggleTor} transportBusy={switching||saving} reconnectLabel={resetPending?'Retry wallet reset':undefined} onPhraseChange={setPhrase} onCreate={()=>void create(false)} onRestore={()=>void create(true)} pendingSetup={!!setupIntent} passkey={passkeySupport?.available&&(!setupIntent||setupIntent.passkey)?{onCreate:words=>void create(false,true,words),onRestore:()=>void create(true,true)}:undefined} passkeyUnavailable={passkeySupport&&!passkeySupport.available?passkeySupport.reason:undefined} onReconnect={()=>{if(transition.current||creating.current||setupOperation.current)return;manualLock.current=false;void (resetPending?finishReset():open());}} unlock={unlock?{label:deviceLockName(LOCK_PLATFORM),gone:unlock.gone,onUnlock:()=>{unlockHeld.current=undefined;void open();},onUsePhrase:()=>setError('')}:undefined}>{setup&&fallbackName&&<PasskeyFallbackSheet platform={LOCK_PLATFORM} windowsWarning={false} passkeyName={fallbackName} busy={busy||saving} onContinue={()=>{const offer=fallback.current;if(offer)void create(false,false,offer.wordCount,offer);}} onCancel={cancelFallback}/>}</WalletOnboarding>}
 </>;
}
