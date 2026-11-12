import {Channel,invoke} from '@tauri-apps/api/core';
import type {AndroidUpdatePackage,NativeRelease} from '../../src/native-release.ts';
import type {NativeStatus} from '../../src/native/transport.ts';
import androidSigning from '../../src-tauri/android-signing.json' with {type:'json'};

export type AndroidInstallStatus='idle'|'installing'|'confirmation-required'|'failed'|'installed';
export interface AndroidUpdateInfo {
 packageName:string;versionCode:number;signerSha256:string;installerPackageName:string|null;canRequestInstalls:boolean;
 installStatus:AndroidInstallStatus;installError:string|null;staged?:{id:string;versionCode:number;ready?:boolean};downloading?:{id:string};
}
export interface AndroidInstallResult {installStatus:AndroidInstallStatus|'permission-required';installError?:string|null}
export interface AndroidUpdateBackend {
 info():Promise<AndroidUpdateInfo>;
 download(generation:number,requestId:string,update:AndroidUpdatePackage,progress:(value:{received:number;total:number})=>void):Promise<{id:string;versionCode:number}>;
 cancel(id:string):Promise<void>;permission():Promise<void>;install(id:string):Promise<AndroidInstallResult>;confirm():Promise<AndroidInstallResult>;
}
export type AndroidUpdatePhase='idle'|'checking'|'available'|'blocked'|'downloading'|'ready'|'preparing'|'installing'|'confirmation-required'|'failed'|'unknown'|'installed';
export interface AndroidUpdateState {
 phase:AndroidUpdatePhase;release?:NativeRelease;info?:AndroidUpdateInfo;staged?:{id:string;versionCode:number};received:number;total:number;torReady:boolean;error:string;
}
interface UpdateNetwork {status():Promise<NativeStatus>;subscribe(listener:(status:NativeStatus)=>void):()=>void}
export function androidUpdateNotice(state:AndroidUpdateState){
 if(['installing','confirmation-required','unknown'].includes(state.phase))return 'Update pending';
 if(state.phase==='failed'&&state.info?.installStatus==='failed')return 'Update needs attention';
}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const signingConflict='This installation uses a different signing key. Keep this installation and its wallet data.';
let installationPreparation:(()=>Promise<void>)|undefined;
export function registerAndroidInstallPreparation(prepare:()=>Promise<void>){installationPreparation=prepare;return()=>{if(installationPreparation===prepare)installationPreparation=undefined;};}
export async function prepareAndroidInstall(){
 const prepare=installationPreparation;
 if(!prepare)throw new Error('The wallet cannot finish saving right now. Reopen Shielded and try again.');
 await prepare();
 if(installationPreparation!==prepare)throw new Error('The wallet changed while finishing its writes. Reopen Shielded and try again.');
}
export function androidUpdateBackend():AndroidUpdateBackend {
 return {
  info:()=>invoke('native_android_update_info'),
  download:(generation,requestId,{url,bytes,sha256,versionCode,packageName,signerSha256},progress)=>invoke('native_android_update_download',{generation,requestId,update:{url,bytes,sha256,versionCode,packageName,signerSha256},onProgress:new Channel(progress)}),
  cancel:id=>invoke('native_android_update_cancel',{id}),permission:()=>invoke('native_android_update_permission'),
  install:id=>invoke('native_android_update_install',{id}),confirm:()=>invoke('native_android_update_confirm'),
 };
}
// IPC may outlive this deadline; reconcile native status before another install.
const bounded=<T>(work:Promise<T>,milliseconds=10_000)=>new Promise<T>((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('Android did not respond. Check the update status and try again.')),milliseconds);
 work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
const installationConflict=(info:AndroidUpdateInfo)=>{
 if(info.installerPackageName==='com.android.vending')return 'Google Play manages this installation. Update Shielded through Google Play.';
 if(info.packageName!==androidSigning.packageName)return 'This update is for a different app. Keep this installation and its wallet data.';
 if(info.signerSha256.toLowerCase()!==androidSigning.certificateSha256)return signingConflict;
 return '';
};
const conflict=(info:AndroidUpdateInfo,update?:AndroidUpdatePackage)=>{
 const installed=installationConflict(info);if(installed)return installed;
 if(!update)return 'This release does not include an installable Android update yet.';
 if(info.packageName!==update.packageName)return 'This update is for a different app. Keep this installation and its wallet data.';
 if(info.signerSha256.toLowerCase()!==update.signerSha256.toLowerCase())return signingConflict;
 if(update.versionCode<=info.versionCode)return 'This version of Shielded is already installed.';
 return '';
};

export function createAndroidUpdateController(backend:AndroidUpdateBackend,network:UpdateNetwork,prepare:()=>Promise<void>=prepareAndroidInstall,isVisible:()=>boolean=()=>!document.hidden){
 let state:AndroidUpdateState={phase:'checking',received:0,total:0,torReady:false,error:''},latest:NativeRelease|undefined,stopped=false,revision=0,networkRevision=0;
 let status:NativeStatus={phase:'idle',generation:0},poll:ReturnType<typeof setTimeout>|undefined,refreshing:Promise<void>|undefined;
 type Download={id:string;generation:number;revision:number;cancel:(error:Error)=>void};
 let downloading:Download|undefined,permissionOpening=false,rearmPreflight:(()=>void)|undefined;
 const listeners=new Set<()=>void>();
 const publish=(change:Partial<AndroidUpdateState>)=>{if(stopped)return;state={...state,...change};for(const listener of listeners)listener();};
 const active=(owner:number)=>!stopped&&revision===owner;
 const installable=()=>!!state.staged&&(state.phase==='ready'||state.phase==='failed'&&state.info?.installStatus==='failed');
 const schedule=()=>{
  clearTimeout(poll);poll=undefined;
  if(!stopped&&isVisible()&&['installing','confirmation-required','unknown'].includes(state.phase))poll=setTimeout(()=>void refresh(),2500);
 };
 const available=(info:AndroidUpdateInfo)=>{
  const error=conflict(info,latest?.androidUpdate);
  publish({info,release:latest,phase:latest?(error?'blocked':'available'):'idle',staged:undefined,error,received:0,total:latest?.androidUpdate?.bytes??0});
 };
 const reconcile=(info:AndroidUpdateInfo)=>{
  const installed=info.installStatus==='installed',target=state.staged?.versionCode??state.release?.androidUpdate?.versionCode??latest?.androidUpdate?.versionCode;
  const staged=installed?(info.staged&&info.staged.versionCode>info.versionCode?info.staged:state.staged&&state.staged.versionCode>info.versionCode?state.staged:undefined):info.staged;
  const retryReady=info.staged?.ready===true&&info.staged.versionCode>info.versionCode;
  const newer=Math.max(staged?.versionCode??0,latest?.androidUpdate?.versionCode??0,target??0)>info.versionCode;
  if(installed&&!newer){publish({info,phase:'installed',error:'',staged:undefined});return;}
  if(info.installStatus==='installing'||info.installStatus==='confirmation-required'){
   publish({info,phase:info.installStatus,error:info.installError??'',staged:info.staged??state.staged});return;
  }
  if(info.installStatus==='failed'){publish({info,phase:'failed',staged:info.staged,error:info.installError??'Android did not install the update. Your wallet data stays on this device.'});return;}
  if(['installing','confirmation-required','unknown'].includes(state.phase)&&!retryReady&&!(installed&&(target===undefined||info.versionCode>=target))){
   publish({info,phase:'unknown',error:'Android has not confirmed the install status. Check again before starting another installation.'});return;
  }
  if(staged){
   const release=state.staged?.id===staged.id?state.release:latest;
   const error=conflict(info,release?.androidUpdate);
   if(error||release?.androidUpdate?.versionCode!==staged.versionCode){publish({info,phase:'blocked',staged,error:error||'A different update is saved. Discard it before downloading this release.'});return;}
   publish({info,phase:'ready',release,staged,received:release.androidUpdate.bytes,total:release.androidUpdate.bytes,error:''});return;
  }
  available(info);
 };
 async function refresh(){
  if(stopped||!isVisible()||downloading||state.phase==='preparing')return;
  if(refreshing)return refreshing;
  const owner=revision;
  refreshing=(async()=>{
   try{const info=await bounded(backend.info());if(active(owner)&&isVisible())reconcile(info);}
   catch(error){if(active(owner)&&isVisible())publish({phase:['installing','confirmation-required','unknown'].includes(state.phase)?'unknown':state.staged?'ready':'failed',error:message(error)});}
  })().finally(()=>{refreshing=undefined;if(active(owner))schedule();else if(!stopped&&isVisible())void refresh();});
  return refreshing;
 }
 const cancelDownload=(reason:string)=>{
  const previous=downloading;if(!previous)return;
  downloading=undefined;rearmPreflight=undefined;++revision;previous.cancel(new Error(reason));
  publish({phase:'failed',received:0,error:reason});void backend.cancel(previous.id).catch(()=>{});
 };
 // Android freezes renderer timers while hidden, so the preflight deadline counts foreground time only.
 const visiblyBounded=<T>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const arm=()=>{clearTimeout(timer);timer=isVisible()?setTimeout(()=>reject(new Error('Android did not respond. Check the update status and try again.')),10_000):undefined;};
  const settle=()=>{clearTimeout(timer);if(rearmPreflight===arm)rearmPreflight=undefined;};
  rearmPreflight=arm;arm();
  work.then(value=>{settle();resolve(value);},error=>{settle();reject(error);});
 });
 const accept=(next:NativeStatus)=>{
  if(stopped||next.generation<status.generation)return;
  networkRevision++;status=next;const ready=next.phase==='ready'&&(next.mode??'tor')==='tor';publish({torReady:ready});
  if(downloading&&(!ready||next.generation!==downloading.generation))cancelDownload('The Tor connection changed. Reconnect to Tor, then retry the download.');
 };
 const unsubscribe=network.subscribe(accept),initialNetwork=networkRevision;
 void network.status().then(next=>{if(!stopped&&networkRevision===initialNetwork)accept(next);},()=>{});
 void refresh();
 return {
  getSnapshot:()=>state,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  setRelease(release:NativeRelease|undefined){
   latest=release;
   if(downloading||['preparing','installing','confirmation-required','unknown'].includes(state.phase))return;
   if(state.staged){if(!state.release){publish({release});void refresh();}return;}
   if(state.info)available(state.info);else{publish({release});void refresh();}
  },
  refresh,
  async download(){
   const release=latest,update=release?.androidUpdate;
   if(stopped||downloading||state.staged||['preparing','installing','confirmation-required','unknown','installed'].includes(state.phase))return;
   if(!update){publish({phase:'blocked',error:'This release does not include an installable Android update yet.'});return;}
   if(!isVisible()||!state.torReady){publish({error:'Connect to Tor before downloading this update. Turn Tor on in the connection menu.'});return;}
   const owner:Download={id:crypto.randomUUID(),generation:status.generation,revision:++revision,cancel:()=>{}};
   const cancelled=new Promise<never>((_,reject)=>{owner.cancel=reject;});void cancelled.catch(()=>{});downloading=owner;
   publish({phase:'downloading',release,staged:undefined,received:0,total:update.bytes,error:''});
   try{
    const info=await Promise.race([visiblyBounded(backend.info()),cancelled]);
    if(downloading!==owner||!active(owner.revision))return;
    const blocked=conflict(info,update);if(blocked)throw new Error(blocked);
    if(info.installStatus==='installing'||info.installStatus==='confirmation-required')throw new Error('An Android installation is already pending. Check its status before downloading another update.');
    if(info.staged){downloading=undefined;reconcile(info);return;}
    if(info.downloading)throw new Error('Another update download is pending. Check its status before retrying.');
    publish({info});
    const work=backend.download(owner.generation,owner.id,update,progress=>{
     if(downloading!==owner||!active(owner.revision))return;
     if(!Number.isSafeInteger(progress.received)||progress.received<0||progress.total!==update.bytes||progress.received>progress.total){cancelDownload('Android reported invalid download progress. Retry the update.');return;}
     if(progress.received>state.received)publish({received:progress.received});
    });
    void work.then(saved=>{if(downloading!==owner||!active(owner.revision))void backend.cancel(saved.id).catch(()=>{});},()=>{});
    const saved=await Promise.race([work,cancelled]);
    if(downloading!==owner||!active(owner.revision))return;
    if(saved.versionCode!==update.versionCode||!saved.id)throw new Error('The saved update does not match this release. Retry the download.');
    downloading=undefined;publish({phase:'ready',staged:saved,received:update.bytes,error:''});
   }catch(error){if(downloading===owner&&active(owner.revision)){downloading=undefined;publish({phase:'failed',error:message(error)});void backend.cancel(owner.id).catch(()=>{});}}
  },
  cancel(){cancelDownload('Download cancelled. Your wallet is unchanged.');},
  async discard(){
   const staged=state.staged;if(stopped||!staged||!['ready','blocked','failed'].includes(state.phase))return;
   const owner=++revision;publish({phase:'checking',error:''});
   try{await bounded(backend.cancel(staged.id));if(active(owner)){publish({staged:undefined});await refresh();}}
   catch(error){if(active(owner))publish({phase:'ready',error:message(error)});}
  },
  async permission(){
   if(stopped||permissionOpening||!installable())return;
   permissionOpening=true;const owner=++revision;publish({error:''});
   try{await bounded(backend.permission());if(active(owner)&&isVisible())await refresh();}
   catch(error){if(active(owner))publish({error:message(error)});}
   finally{permissionOpening=false;}
  },
  async install(confirm=false){
   const saved=state.staged;
   if(stopped||!isVisible()||(confirm?state.phase!=='confirmation-required':!installable()))return;
   const owner=++revision;let submitted=false;publish({phase:'preparing',error:''});
   try{
    const info=await bounded(backend.info());if(!active(owner))return;
    if(!confirm&&info.installStatus==='failed'&&!info.staged){reconcile(info);return;}
    const blocked=confirm?installationConflict(info):conflict(info,state.release?.androidUpdate);if(blocked)throw new Error(blocked);
    publish({info});
    if(confirm&&info.installStatus!=='confirmation-required'){reconcile(info);return;}
    if(!confirm&&(info.installStatus==='installing'||info.installStatus==='confirmation-required')){reconcile(info);return;}
    if(!confirm&&(!info.staged||info.staged.id!==saved!.id||info.staged.versionCode!==saved!.versionCode))throw new Error('The saved update is unavailable. Download it again before installing.');
    if(!confirm&&!info.canRequestInstalls){publish({phase:'ready',info,error:'Allow Shielded to install updates in Android settings, then return and tap Install update.'});return;}
    await bounded(prepare(),30_000);if(!active(owner))return;
    submitted=true;publish({phase:'installing'});
    const result=await bounded(confirm?backend.confirm():backend.install(saved!.id),15_000);if(!active(owner))return;
    const phase=result.installStatus==='permission-required'?'ready':result.installStatus==='idle'?'unknown':result.installStatus;
    publish({phase,info:{...info,...(result.installStatus==='permission-required'?{canRequestInstalls:false}:{installStatus:result.installStatus})},...(phase==='installed'?{staged:undefined}:{}),error:result.installError??(phase==='unknown'?'Android has not confirmed the install status. Check again before starting another installation.':'')});
   }catch(error){if(active(owner))publish({phase:submitted?'unknown':confirm?'confirmation-required':saved?'ready':'failed',error:message(error)});}
   finally{if(active(owner))schedule();}
  },
  visibilityChanged(){
   if(stopped)return;
   rearmPreflight?.();
   if(!isVisible()){
    clearTimeout(poll);poll=undefined;
    if(state.phase==='preparing'){++revision;publish({phase:state.info?.installStatus==='confirmation-required'?'confirmation-required':'ready',error:'Installation paused. Return to Shielded and tap Install update when you are ready.'});}
   }
   else void refresh();
  },
  stop(){if(stopped)return;cancelDownload('Update download stopped.');stopped=true;++revision;clearTimeout(poll);unsubscribe();listeners.clear();},
 };
}
export type AndroidUpdateController=ReturnType<typeof createAndroidUpdateController>;
