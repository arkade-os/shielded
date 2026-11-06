import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {bytesToHex} from '@noble/hashes/utils.js';
import {parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {installNativeTransport,nativeNetwork} from '../../src/native/index.ts';
import {createNativeStorage} from './native-storage.ts';

installNativeTransport();
const Wallet=lazy(()=>import('./RollupWallet'));
const getSecret=()=>invoke<string|null>('plugin:shielded-platform|secret_get');
const putSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_set',{value});
type Session={generation:number;cache:ReturnType<typeof createNativeStorage>};

export default function NativeWallet(){
 const [session,setSession]=useState<Session>(),[phase,setPhase]=useState('Opening the native vault'),[error,setError]=useState('');
 const [setup,setSetup]=useState(false),[phrase,setPhrase]=useState(''),[busy,setBusy]=useState(false);
 const [externalLink,setExternalLink]=useState('');
 const active=useRef<Session|undefined>(undefined),attempt=useRef(0),closed=useRef<Promise<void>>(Promise.resolve()),manualLock=useRef(false);
 const opening=useRef<Promise<void>|undefined>(undefined);
 const stop=useRef<(()=>Promise<void>)|undefined>(undefined);
 const onShutdown=useCallback((shutdown:(()=>Promise<void>)|undefined)=>{stop.current=shutdown;},[]);
 const fail=(cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause));
 const pause=useCallback(()=>{
  ++attempt.current;
  const previous=active.current;active.current=undefined;
  const shutdown=stop.current;stop.current=undefined;
  setSession(undefined);setBusy(false);setPhase('Private connection paused');previous?.cache.clearMemory();
  closed.current=Promise.all([closed.current,nativeNetwork.pause(),shutdown?.(),opening.current]).then(()=>{});
  void closed.current.catch(fail);return closed.current;
 },[]);
 const open=useCallback(()=>{
  if(opening.current)return opening.current;
  if(document.hidden||manualLock.current){setBusy(false);setPhase('Private connection paused');return Promise.resolve();}
  const run=(async()=>{
  const mine=++attempt.current;setBusy(true);setError('');
  try{
   await closed.current;
   const secret=await getSecret();if(mine!==attempt.current)return;
   if(secret===null){
    if(localStorage.getItem('shielded-native-wallet')==='1')throw new Error('The native wallet secret is unavailable. Keep the app data and restore access to its vault.');
    setSetup(true);setPhase('Create or restore your wallet');return;
   }
   setSetup(false);setPhase('Connecting to Tor');
   const cache=createNativeStorage(secret,localStorage,putSecret),status=await nativeNetwork.start();
   if(mine!==attempt.current||document.hidden||manualLock.current){cache.clearMemory();if(mine===attempt.current)void pause();return;}
   if(status.phase!=='ready'){cache.clearMemory();throw new Error(status.error??'Tor is not ready.');}
   manualLock.current=false;const next={generation:status.generation,cache};active.current=next;setSession(next);setPhase('Tor connected');
  }catch(cause){if(mine===attempt.current)fail(cause);}
  finally{if(mine===attempt.current)setBusy(false);}
  })();
  opening.current=run.finally(()=>{opening.current=undefined;});return opening.current;
 },[]);
 const create=async(restore:boolean)=>{
  setBusy(true);setError('');
  try{
   const secret=restore?bytesToHex(parseMasterSecret(phrase)):bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
   await putSecret(secret);localStorage.setItem('shielded-native-wallet','1');
   if(!restore){localStorage.setItem('shielded-rollup-wallet-born-v1','new');localStorage.setItem('shielded-rollup-wallet-created-v1',String(Date.now()));}
   setPhrase('');await open();
  }catch(cause){fail(cause);setBusy(false);}
 };
 useEffect(()=>{
  let live=true;void open();
  const visibility=()=>{
   if(document.hidden){if(active.current||opening.current)void pause();}
   else if(!manualLock.current&&!active.current)void closed.current.then(()=>{if(!manualLock.current&&!document.hidden)void open();}).catch(fail);
  };
  document.addEventListener('visibilitychange',visibility);
  const external=(event:MouseEvent)=>{
   const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;
   const url=new URL(anchor.getAttribute('href')!,location.href);
   if(['http:','https:'].includes(url.protocol)&&url.origin!==location.origin){event.preventDefault();event.stopPropagation();setExternalLink(url.href);}
  };
  document.addEventListener('click',external,true);
  const timer=setInterval(()=>{
   if(document.hidden||!active.current)return;
   const observed=active.current;
   void nativeNetwork.status().then(status=>{if(live&&active.current===observed&&(status.phase!=='ready'||status.generation!==observed.generation))void pause();}).catch(cause=>{if(live&&active.current===observed){fail(cause);void pause();}});
  },1500);
  return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',external,true);void pause();};
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
  <section className="stock-warning stock-update" role="status"><span>{phase}. Wallet traffic uses Tor; repeated identifiers and timing can still reveal links.</span>{session&&<button type="button" onClick={()=>{manualLock.current=true;void pause();}}>Lock wallet</button>}</section>
  {externalLink&&<section className="stock-warning" role="dialog" aria-label="External link"><p>Copy this link to open it outside Shielded. Your browser uses its own network connection.</p><input aria-label="Link to copy" readOnly value={externalLink} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>setExternalLink('')}>Close</button></section>}
  {session?<Suspense fallback={<p role="status">Opening wallet</p>}><Wallet key={session.generation} storage={session.cache.storage} reload={reload} onShutdown={onShutdown}/></Suspense>
   :<div className="stock-page"><main className="stock-shell"><section className="stock-card">
    <h1>{setup?'Shielded wallet':'Private connection'}</h1><p>{phase}</p>
    {error&&<p role="alert">{error}</p>}
    {setup?<><button type="button" disabled={busy} onClick={()=>void create(false)}>Create wallet</button><details><summary>Restore a wallet</summary><label>Recovery phrase<textarea value={phrase} onChange={event=>setPhrase(event.target.value)} autoComplete="off" spellCheck={false}/></label><button type="button" disabled={busy||!phrase.trim()} onClick={()=>void create(true)}>Restore wallet</button><p>Keep the original app data for outstanding Lightning swaps. The phrase alone cannot recover every pending swap.</p></details></>
     :<button type="button" disabled={busy} onClick={()=>{manualLock.current=false;void open();}}>{busy?'Connecting…':'Unlock and reconnect'}</button>}
   </section></main></div>}
 </>;
}
