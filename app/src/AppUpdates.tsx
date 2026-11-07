import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {registerAppCache} from './app-cache.ts';
import {NATIVE_RELEASE_ORIGIN,type NativeRelease} from '../../src/native-release.ts';
import {createNativeUpdateMonitor} from './native-updates.ts';

const native=typeof __NATIVE_BUILD__!=='undefined'&&__NATIVE_BUILD__;
type Update={apply?:()=>void;release?:NativeRelease};
const Updates=createContext<Update>({});
let registered=false,browserApply:(()=>void)|undefined;
const browserListeners=new Set<(apply:()=>void)=>void>();

export function AppUpdatesProvider({children}:{children:ReactNode}){
 const [update,setUpdate]=useState<Update>({});
 useEffect(()=>{
  if(native){
   let stopped=false,monitor:ReturnType<typeof createNativeUpdateMonitor>|undefined;
   void import('../../src/native/index.ts').then(({nativeNetwork,nativeReleaseFetch})=>{
    if(stopped)return;
    monitor=createNativeUpdateMonitor({...nativeNetwork,fetch:nativeReleaseFetch},{commit:__APP_COMMIT__,buildNumber:__NATIVE_BUILD_NUMBER__,platform:__NATIVE_PLATFORM__,channel:'native-mutinynet',network:'mutinynet'},release=>setUpdate({release}),()=>!document.hidden);
    document.addEventListener('visibilitychange',monitor.visibilityChanged);
   }).catch(()=>{});
   return()=>{stopped=true;if(monitor){document.removeEventListener('visibilitychange',monitor.visibilityChanged);monitor.stop();}};
  }
  const receive=(apply:()=>void)=>setUpdate({apply});browserListeners.add(receive);
  if(browserApply)receive(browserApply);
  if(!registered){registered=true;registerAppCache(apply=>{browserApply=apply;for(const listener of browserListeners)listener(apply);});}
  return()=>{browserListeners.delete(receive);};
 },[]);
 return <Updates.Provider value={update}>{children}</Updates.Provider>;
}

export function AppUpdateNotice({tone='light'}:{tone?:'light'|'dark'}){
 const {apply,release}=useContext(Updates);
 if(release)return <a className="app-update-notice" data-tone={tone} href={NATIVE_RELEASE_ORIGIN+'/#download'} aria-label="Native app update available. View downloads."><span className="app-update-dot" aria-hidden="true"/>Update available</a>;
 return apply?<button className="app-update-notice" data-tone={tone} type="button" onClick={apply} aria-label="Update app to the new version"><span className="app-update-dot" aria-hidden="true"/>Update available</button>:null;
}
