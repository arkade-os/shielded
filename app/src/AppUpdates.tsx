import {createContext,lazy,Suspense,useCallback,useContext,useEffect,useState,useSyncExternalStore,type MouseEvent,type ReactNode} from 'react';
import {openUrl} from '@tauri-apps/plugin-opener';
import {registerAppCache} from './app-cache.ts';
import {DESKTOP_UPDATE_FORMATS,nativeUpdateUrl,type NativeRelease} from '../../src/native-release.ts';
import {createNativeUpdateMonitor} from './native-updates.ts';
import {watchPageVisibility} from './page-visibility.ts';
import {androidUpdateBackend,createAndroidUpdateController,createUpdateController,type UpdateController} from './android-updates.ts';
import {desktopUpdateBackend,desktopUpdatePolicy} from './desktop-updates.ts';

const native=typeof __NATIVE_BUILD__!=='undefined'&&__NATIVE_BUILD__;
const android=native&&typeof __NATIVE_PLATFORM__!=='undefined'&&__NATIVE_PLATFORM__==='android-arm64';
const desktop=native&&typeof __NATIVE_PLATFORM__!=='undefined'&&Object.hasOwn(DESKTOP_UPDATE_FORMATS,__NATIVE_PLATFORM__);
const AndroidAppUpdate=lazy(()=>import('./AndroidAppUpdate.tsx'));
type Update={apply?:()=>void;release?:NativeRelease;controller?:UpdateController;open?:()=>void};
const Updates=createContext<Update>({});
let registered=false,browserApply:(()=>void)|undefined;
const browserListeners=new Set<(apply:()=>void)=>void>();

export function AppUpdatesProvider({children}:{children:ReactNode}){
 const [update,setUpdate]=useState<Update>({});
 const [updateController,setUpdateController]=useState<UpdateController>(),[updateOpen,setUpdateOpen]=useState(false);
 const closeUpdate=useCallback(()=>setUpdateOpen(false),[]);
 useEffect(()=>{
  if(native){
   let stopped=false,visible=!document.hidden,monitor:ReturnType<typeof createNativeUpdateMonitor>|undefined;
   let controller:UpdateController|undefined;
   const stopVisibility=watchPageVisibility(value=>{visible=value;monitor?.visibilityChanged();controller?.visibilityChanged();});
   void import('../../src/native/index.ts').then(({nativeNetwork,nativeReleaseFetch})=>{
    if(stopped)return;
    const foreground=()=>visible&&!document.hidden;
    if(android)controller=createAndroidUpdateController(androidUpdateBackend(),nativeNetwork,undefined,foreground);
    else if(desktop)controller=createUpdateController(desktopUpdatePolicy(__NATIVE_PLATFORM__),desktopUpdateBackend(),nativeNetwork,undefined,foreground);
    setUpdateController(controller);
    monitor=createNativeUpdateMonitor({...nativeNetwork,fetch:nativeReleaseFetch},{commit:__APP_COMMIT__,buildNumber:__NATIVE_BUILD_NUMBER__,platform:__NATIVE_PLATFORM__,channel:'native-mutinynet',network:'mutinynet'},release=>{controller?.setRelease(release);setUpdate({release});},foreground);
   }).catch(()=>{});
   return()=>{stopped=true;stopVisibility();monitor?.stop();controller?.stop();};
  }
  const receive=(apply:()=>void)=>setUpdate({apply});browserListeners.add(receive);
  if(browserApply)receive(browserApply);
  if(!registered){registered=true;registerAppCache(apply=>{browserApply=apply;for(const listener of browserListeners)listener(apply);});}
  return()=>{browserListeners.delete(receive);};
 },[]);
 return <Updates.Provider value={{...update,controller:updateController,open:()=>{setUpdateOpen(true);void updateController?.refresh();}}}>{children}{updateOpen&&updateController&&<Suspense fallback={null}><AndroidAppUpdate controller={updateController} onClose={closeUpdate} desktop={desktop}/></Suspense>}</Updates.Provider>;
}

export function NativeUpdateLink({tone='light',reason}:{tone?:'light'|'dark';reason?:string}){
 const [error,setError]=useState('');
 const open=(event:MouseEvent<HTMLAnchorElement>)=>{
  if(!native)return;
  event.preventDefault();setError('');
  void openUrl(nativeUpdateUrl()).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
 };
 return <><a className="app-update-notice" data-tone={tone} data-native-external="true" href={nativeUpdateUrl()} target={native?'_blank':undefined} rel="noreferrer" onClick={open} aria-label="Native app update available. Open downloads." title={reason||undefined}><span className="app-update-dot" aria-hidden="true"/>Update available</a>{error&&<><span className="app-update-open-error" role="alert">Could not open downloads.</span><NativeUpdateFallback/></>}</>;
}

export function NativeUpdateFallback(){
 return <details className="app-update-open-fallback"><summary>Copy download link</summary><input aria-label="Download link to copy" readOnly value={nativeUpdateUrl()} onFocus={event=>event.target.select()}/></details>;
}

const UpdateButton=({tone,onClick,disabled}:{tone:'light'|'dark';onClick?:()=>void;disabled?:boolean})=><button className="app-update-notice" data-tone={tone} type="button" disabled={disabled} onClick={onClick} aria-label="Native app update available. View the update."><span className="app-update-dot" aria-hidden="true"/>Update available</button>;
/** The downloads page stays the route until the host confirms it can replace this installation with a signed installer. */
export function DesktopUpdateNotice({controller,tone='light',onOpen}:{controller:UpdateController;tone?:'light'|'dark';onOpen:()=>void}){
 const {info,phase,error}=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 return info&&phase!=='blocked'?<UpdateButton tone={tone} onClick={onOpen}/>:<NativeUpdateLink tone={tone} reason={error}/>;
}

export function AppUpdateNotice({tone='light'}:{tone?:'light'|'dark'}){
 const {apply,release,controller,open}=useContext(Updates);
 if(android&&release)return <UpdateButton tone={tone} disabled={!controller} onClick={open}/>;
 if(desktop&&release&&controller&&open)return <DesktopUpdateNotice controller={controller} tone={tone} onOpen={open}/>;
 if(release)return <NativeUpdateLink tone={tone}/>;
 return apply?<button className="app-update-notice" data-tone={tone} type="button" onClick={apply} aria-label="Update app to the new version"><span className="app-update-dot" aria-hidden="true"/>Update available</button>:null;
}
