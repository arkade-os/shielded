import {createContext,lazy,Suspense,useCallback,useContext,useEffect,useState,type MouseEvent,type ReactNode} from 'react';
import {openUrl} from '@tauri-apps/plugin-opener';
import {registerAppCache} from './app-cache.ts';
import {nativeUpdateUrl,type NativeRelease} from '../../src/native-release.ts';
import {createNativeUpdateMonitor} from './native-updates.ts';
import {androidUpdateBackend,androidUpdateNotice,createAndroidUpdateController,type AndroidUpdateController} from './android-updates.ts';

const native=typeof __NATIVE_BUILD__!=='undefined'&&__NATIVE_BUILD__;
const android=native&&typeof __NATIVE_PLATFORM__!=='undefined'&&__NATIVE_PLATFORM__==='android-arm64';
const AndroidAppUpdate=lazy(()=>import('./AndroidAppUpdate.tsx'));
type Update={apply?:()=>void;release?:NativeRelease;android?:AndroidUpdateController;androidNotice?:string;openAndroid?:()=>void};
const Updates=createContext<Update>({});
let registered=false,browserApply:(()=>void)|undefined;
const browserListeners=new Set<(apply:()=>void)=>void>();

export function AppUpdatesProvider({children}:{children:ReactNode}){
 const [update,setUpdate]=useState<Update>({});
 const [androidController,setAndroidController]=useState<AndroidUpdateController>(),[androidOpen,setAndroidOpen]=useState(false);
 const [androidNotice,setAndroidNotice]=useState<string>();
 const closeAndroid=useCallback(()=>setAndroidOpen(false),[]);
 useEffect(()=>{
  if(native){
   let stopped=false,monitor:ReturnType<typeof createNativeUpdateMonitor>|undefined;
   let controller:AndroidUpdateController|undefined,unsubscribeAndroid:(()=>void)|undefined;
   void import('../../src/native/index.ts').then(({nativeNetwork,nativeReleaseFetch})=>{
    if(stopped)return;
    if(android){controller=createAndroidUpdateController(androidUpdateBackend(),nativeNetwork);setAndroidController(controller);const owned=controller;unsubscribeAndroid=controller.subscribe(()=>setAndroidNotice(androidUpdateNotice(owned.getSnapshot())));}
    monitor=createNativeUpdateMonitor({...nativeNetwork,fetch:nativeReleaseFetch},{commit:__APP_COMMIT__,buildNumber:__NATIVE_BUILD_NUMBER__,platform:__NATIVE_PLATFORM__,channel:'native-mutinynet',network:'mutinynet'},release=>{controller?.setRelease(release);setUpdate({release});},()=>!document.hidden);
    document.addEventListener('visibilitychange',monitor.visibilityChanged);
    if(controller)document.addEventListener('visibilitychange',controller.visibilityChanged);
   }).catch(()=>{});
   return()=>{stopped=true;unsubscribeAndroid?.();if(monitor){document.removeEventListener('visibilitychange',monitor.visibilityChanged);monitor.stop();}if(controller){document.removeEventListener('visibilitychange',controller.visibilityChanged);controller.stop();}};
  }
  const receive=(apply:()=>void)=>setUpdate({apply});browserListeners.add(receive);
  if(browserApply)receive(browserApply);
  if(!registered){registered=true;registerAppCache(apply=>{browserApply=apply;for(const listener of browserListeners)listener(apply);});}
  return()=>{browserListeners.delete(receive);};
 },[]);
 return <Updates.Provider value={{...update,android:androidController,androidNotice,openAndroid:()=>{setAndroidOpen(true);void androidController?.refresh();}}}>{children}{androidOpen&&androidController&&<Suspense fallback={null}><AndroidAppUpdate controller={androidController} onClose={closeAndroid}/></Suspense>}</Updates.Provider>;
}

export function NativeUpdateLink({tone='light'}:{tone?:'light'|'dark'}){
 const [error,setError]=useState('');
 const open=(event:MouseEvent<HTMLAnchorElement>)=>{
  if(!native)return;
  event.preventDefault();setError('');
  void openUrl(nativeUpdateUrl()).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
 };
 return <><a className="app-update-notice" data-tone={tone} data-native-external="true" href={nativeUpdateUrl()} target={native?'_blank':undefined} rel="noreferrer" onClick={open} aria-label="Native app update available. Open downloads."><span className="app-update-dot" aria-hidden="true"/>Update available</a>{error&&<><span className="app-update-open-error" role="alert">Could not open downloads.</span><NativeUpdateFallback/></>}</>;
}

export function NativeUpdateFallback(){
 return <details className="app-update-open-fallback"><summary>Copy download link</summary><input aria-label="Download link to copy" readOnly value={nativeUpdateUrl()} onFocus={event=>event.target.select()}/></details>;
}

export function AppUpdateNotice({tone='light'}:{tone?:'light'|'dark'}){
 const {apply,release,android:controller,androidNotice,openAndroid}=useContext(Updates);
 if(android&&(release||androidNotice))return <button className="app-update-notice" data-tone={tone} type="button" disabled={!controller} onClick={openAndroid} aria-label={androidNotice?`${androidNotice}. View Android installation.`:'Native app update available. Download through Tor.'}><span className="app-update-dot" aria-hidden="true"/>{androidNotice??'Update available'}</button>;
 if(release)return <NativeUpdateLink tone={tone}/>;
 return apply?<button className="app-update-notice" data-tone={tone} type="button" onClick={apply} aria-label="Update app to the new version"><span className="app-update-dot" aria-hidden="true"/>Update available</button>:null;
}
