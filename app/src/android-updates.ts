import {Channel,invoke} from '@tauri-apps/api/core';
import type {AndroidUpdatePackage,NativeRelease} from '../../src/native-release.ts';
import type {NativeStatus} from '../../src/native/transport.ts';
import androidSigning from '../../src-tauri/android-signing.json' with {type:'json'};

export interface AndroidUpdateInfo {packageName:string;versionCode:number;signerSha256:string;installerPackageName:string|null;staged?:{id:string;versionCode:number};downloading?:{id:string}}
export interface AndroidUpdateBackend {
 info():Promise<AndroidUpdateInfo>;
 download(generation:number,requestId:string,update:AndroidUpdatePackage,progress:(value:{received:number;total:number})=>void):Promise<{id:string;versionCode:number}>;
 cancel(id:string):Promise<void>;open(id:string):Promise<void>;
}
export type AndroidUpdatePhase='idle'|'checking'|'available'|'blocked'|'downloading'|'preparing'|'failed';
export interface AndroidUpdateState {
 phase:AndroidUpdatePhase;release?:NativeRelease;info?:AndroidUpdateInfo;staged?:{id:string;versionCode:number};received:number;total:number;networkReady:boolean;torReady:boolean;error:string;
}
interface UpdateNetwork {status():Promise<NativeStatus>;subscribe(listener:(status:NativeStatus)=>void):()=>void}
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
  cancel:id=>invoke('native_android_update_cancel',{id}),open:id=>invoke('native_android_update_open',{id}),
 };
}
const NO_REPLY='Android did not respond. Try again.',OFFLINE='Open or reconnect your wallet before downloading this update.';
const bounded=<T>(work:Promise<T>,milliseconds=10_000)=>new Promise<T>((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error(NO_REPLY)),milliseconds);
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
 let state:AndroidUpdateState={phase:'checking',received:0,total:0,networkReady:false,torReady:false,error:''},latest:NativeRelease|undefined,stopped=false,revision=0,networkRevision=0,updating=0;
 let status:NativeStatus={phase:'idle',generation:0},refreshing:Promise<void>|undefined;
 type Download={id:string;generation:number;cancel:(error:Error)=>void};
 let downloading:Download|undefined,rearmPreflight:(()=>void)|undefined;
 const listeners=new Set<()=>void>();
 const publish=(change:Partial<AndroidUpdateState>)=>{if(stopped)return;state={...state,...change};for(const listener of listeners)listener();};
 const active=(owner:number)=>!stopped&&revision===owner;
 const busy=()=>updating>0&&active(updating);
 const available=(info:AndroidUpdateInfo)=>{
  const update=latest?.androidUpdate,error=conflict(info,update);
  publish({info,release:latest,phase:latest?(error?'blocked':'available'):'idle',staged:info.staged?.versionCode===update?.versionCode?info.staged:undefined,error,received:0,total:update?.bytes??0});
 };
 async function refresh(){
  if(stopped||!isVisible()||busy())return;
  if(refreshing)return refreshing;
  const owner=revision;
  refreshing=(async()=>{
   try{const info=await bounded(backend.info());if(active(owner)&&isVisible())available(info);}
   catch(error){if(active(owner)&&isVisible())publish({phase:'failed',error:message(error)});}
  })().finally(()=>{refreshing=undefined;});
  return refreshing;
 }
 const cancelDownload=(reason:string)=>{
  const previous=downloading;if(!previous)return;
  downloading=undefined;rearmPreflight=undefined;++revision;previous.cancel(new Error(reason));
  publish({phase:'failed',received:0,error:reason});void backend.cancel(previous.id).catch(()=>{});
 };
 // Android freezes renderer timers while hidden, so the preflight deadline counts foreground time only.
 const visiblyBounded=<T>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>|undefined,left=10_000,since=0;
  const arm=()=>{
   if(timer!==undefined){clearTimeout(timer);timer=undefined;left-=Date.now()-since;}
   if(isVisible()){since=Date.now();timer=setTimeout(()=>reject(new Error(NO_REPLY)),Math.max(0,left));}
  };
  const settle=()=>{clearTimeout(timer);if(rearmPreflight===arm)rearmPreflight=undefined;};
  rearmPreflight=arm;arm();
  work.then(value=>{settle();resolve(value);},error=>{settle();reject(error);});
 });
 const accept=(next:NativeStatus)=>{
  if(stopped||next.generation<status.generation)return;
  networkRevision++;status=next;const ready=next.phase==='ready';publish({networkReady:ready,torReady:ready&&(next.mode??'tor')==='tor'});
  if(downloading&&(!ready||next.generation!==downloading.generation))cancelDownload('The connection changed. Reconnect, then try again.');
 };
 async function download(owner:number,update:AndroidUpdatePackage){
  if(!state.networkReady)throw new Error(OFFLINE);
  const transfer:Download={id:crypto.randomUUID(),generation:status.generation,cancel:()=>{}};
  const cancelled=new Promise<never>((_,reject)=>{transfer.cancel=reject;});void cancelled.catch(()=>{});downloading=transfer;
  publish({phase:'downloading',received:0,total:update.bytes});
  try{
   const work=backend.download(transfer.generation,transfer.id,update,progress=>{
    if(downloading!==transfer||!active(owner))return;
    if(!Number.isSafeInteger(progress.received)||progress.received<0||progress.total!==update.bytes||progress.received>progress.total){cancelDownload('Android reported invalid download progress. Try again.');return;}
    // Native reports 0 once as each source attempt starts, so a host-to-GitHub fallback restarts the count.
    if(progress.received>state.received||(progress.received===0&&state.received>0))publish({received:progress.received});
   });
   void work.then(saved=>{if(downloading!==transfer||!active(owner))void backend.cancel(saved.id).catch(()=>{});},()=>{});
   const saved=await Promise.race([work,cancelled]);
   if(downloading!==transfer||!active(owner))return;
   if(saved.versionCode!==update.versionCode||!saved.id)throw new Error('The saved update does not match this release. Try again.');
   downloading=undefined;publish({staged:saved,received:update.bytes});return saved;
  }catch(error){if(downloading===transfer){downloading=undefined;void backend.cancel(transfer.id).catch(()=>{});}throw error;}
 }
 async function update(){
  const release=latest,update=release?.androidUpdate;
  if(stopped||!isVisible()||!['available','failed'].includes(state.phase))return;
  if(!update){publish({phase:'blocked',error:'This release does not include an installable Android update yet.'});return;}
  if(!state.staged&&!state.networkReady){publish({error:OFFLINE});return;}
  const owner=updating=++revision;publish({phase:'checking',release,error:''});
  try{
   const info=await visiblyBounded(backend.info());if(!active(owner))return;
   const blocked=conflict(info,update);if(blocked){publish({phase:'blocked',info,staged:undefined,error:blocked});return;}
   let staged=info.staged?.versionCode===update.versionCode?info.staged:undefined;publish({staged});
   if(!staged){
    if(info.downloading)throw new Error('Another update download is still running. Try again in a moment.');
    if(info.staged)await bounded(backend.cancel(info.staged.id));
    if(!active(owner))return;
    staged=await download(owner,update);if(!staged)return;
   }
   // A download that finished in the background waits for a tap rather than opening the installer on return.
   if(!isVisible()){publish({phase:'available',staged,received:0});return;}
   publish({phase:'preparing',staged});
   await bounded(prepare(),30_000);if(!active(owner))return;
   await bounded(backend.open(staged.id),15_000);if(!active(owner))return;
   publish({phase:'available'});
  }catch(error){if(active(owner))publish({phase:'failed',received:0,error:message(error)});}
  finally{if(updating===owner)updating=0;}
 }
 const unsubscribe=network.subscribe(accept),initialNetwork=networkRevision;
 void network.status().then(next=>{if(!stopped&&networkRevision===initialNetwork)accept(next);},()=>{});
 void refresh();
 return {
  getSnapshot:()=>state,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  setRelease(release:NativeRelease|undefined){
   latest=release;
   if(busy())return;
   if(state.info)available(state.info);else{publish({release});void refresh();}
  },
  refresh,
  update,
  cancel(){cancelDownload('Download cancelled. Your wallet is unchanged.');},
  visibilityChanged(){
   if(stopped)return;
   rearmPreflight?.();
   if(!isVisible()){if(state.phase==='preparing'){++revision;publish({phase:'available',error:''});}}
   else void refresh();
  },
  stop(){if(stopped)return;cancelDownload('Update download stopped.');stopped=true;++revision;unsubscribe();listeners.clear();},
 };
}
export type AndroidUpdateController=ReturnType<typeof createAndroidUpdateController>;
