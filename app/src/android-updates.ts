import {Channel,invoke} from '@tauri-apps/api/core';
import type {AndroidUpdatePackage,NativeRelease,NativeReleasePackage} from '../../src/native-release.ts';
import type {NativeStatus} from '../../src/native/transport.ts';
import androidSigning from '../../src-tauri/android-signing.json' with {type:'json'};

type AndroidStaged={id:string;versionCode:number};
export interface AndroidUpdateInfo {packageName:string;versionCode:number;signerSha256:string;installerPackageName:string|null;staged?:AndroidStaged;downloading?:{id:string}}
export interface UpdateBackend<Info,Package,Staged> {
 info():Promise<Info>;
 download(generation:number,requestId:string,update:Package,progress:(value:{received:number;total:number})=>void):Promise<Staged>;
 cancel(id:string):Promise<void>;open(id:string):Promise<void>;
}
export type AndroidUpdateBackend=UpdateBackend<AndroidUpdateInfo,AndroidUpdatePackage,AndroidStaged>;
/** `exits`: opening the update closes Shielded, so it has no deadline and the dialog stays on installing. */
export interface UpdatePolicy<Info,Package,Staged> {host:string;missing:string;package(release:NativeRelease):Package|undefined;conflict(info:Info,update?:Package):string;matches(staged:Staged,update:Package):boolean;exits?:boolean}
export type UpdatePhase='idle'|'checking'|'available'|'blocked'|'downloading'|'preparing'|'installing'|'failed';
export interface UpdateState<Info=unknown,Staged={id:string}> {
 phase:UpdatePhase;release?:NativeRelease;info?:Info;staged?:Staged;received:number;total:number;networkReady:boolean;torReady:boolean;error:string;
}
export type AndroidUpdateState=UpdateState<AndroidUpdateInfo,AndroidStaged>;
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
const OFFLINE='Open or reconnect your wallet before downloading this update.',NO_APK='This release does not include an installable Android update yet.';
const installationConflict=(info:AndroidUpdateInfo)=>{
 if(info.installerPackageName==='com.android.vending')return 'Google Play manages this installation. Update Shielded through Google Play.';
 if(info.packageName!==androidSigning.packageName)return 'This update is for a different app. Keep this installation and its wallet data.';
 if(info.signerSha256.toLowerCase()!==androidSigning.certificateSha256)return signingConflict;
 return '';
};
const conflict=(info:AndroidUpdateInfo,update?:AndroidUpdatePackage)=>{
 const installed=installationConflict(info);if(installed)return installed;
 if(!update)return NO_APK;
 if(info.packageName!==update.packageName)return 'This update is for a different app. Keep this installation and its wallet data.';
 if(info.signerSha256.toLowerCase()!==update.signerSha256.toLowerCase())return signingConflict;
 if(update.versionCode<=info.versionCode)return 'This version of Shielded is already installed.';
 return '';
};
const androidPolicy:UpdatePolicy<AndroidUpdateInfo,AndroidUpdatePackage,AndroidStaged>={host:'Android',missing:NO_APK,package:release=>release.androidUpdate,conflict,matches:(staged,update)=>staged.versionCode===update.versionCode};

export const createAndroidUpdateController=(backend:AndroidUpdateBackend,network:UpdateNetwork,prepare?:()=>Promise<void>,isVisible?:()=>boolean)=>createUpdateController(androidPolicy,backend,network,prepare,isVisible);
export function createUpdateController<Info extends {staged?:Staged|null;downloading?:unknown},Package extends NativeReleasePackage,Staged extends {id:string}>(policy:UpdatePolicy<Info,Package,Staged>,backend:UpdateBackend<Info,Package,Staged>,network:UpdateNetwork,prepare:()=>Promise<void>=prepareAndroidInstall,isVisible:()=>boolean=()=>!document.hidden){
 let state:UpdateState<Info,Staged>={phase:'checking',received:0,total:0,networkReady:false,torReady:false,error:''},latest:NativeRelease|undefined,stopped=false,revision=0,networkRevision=0,updating=0;
 let status:NativeStatus={phase:'idle',generation:0},refreshing:Promise<void>|undefined;
 type Download={id:string;generation:number;cancel:(error:Error)=>void};
 let downloading:Download|undefined,rearmPreflight:(()=>void)|undefined;
 const listeners=new Set<()=>void>(),NO_REPLY=`${policy.host} did not respond. Try again.`;
 const bounded=<T>(work:Promise<T>,milliseconds=10_000)=>new Promise<T>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(NO_REPLY)),milliseconds);
  work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
 });
 const publish=(change:Partial<UpdateState<Info,Staged>>)=>{if(stopped)return;state={...state,...change};for(const listener of listeners)listener();};
 const active=(owner:number)=>!stopped&&revision===owner;
 const busy=()=>updating>0&&active(updating);
 const kept=(info:Info,update?:Package)=>info.staged&&update&&policy.matches(info.staged,update)?info.staged:undefined;
 const available=(info:Info)=>{
  const update=latest&&policy.package(latest),error=policy.conflict(info,update);
  publish({info,release:latest,phase:latest?(error?'blocked':'available'):'idle',staged:kept(info,update),error,received:0,total:update?.bytes??0});
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
 async function download(owner:number,update:Package){
  if(!state.networkReady)throw new Error(OFFLINE);
  const transfer:Download={id:crypto.randomUUID(),generation:status.generation,cancel:()=>{}};
  const cancelled=new Promise<never>((_,reject)=>{transfer.cancel=reject;});void cancelled.catch(()=>{});downloading=transfer;
  publish({phase:'downloading',received:0,total:update.bytes});
  try{
   const work=backend.download(transfer.generation,transfer.id,update,progress=>{
    if(downloading!==transfer||!active(owner))return;
    if(!Number.isSafeInteger(progress.received)||progress.received<0||progress.total!==update.bytes||progress.received>progress.total){cancelDownload(`${policy.host} reported invalid download progress. Try again.`);return;}
    // Native reports 0 once as each source attempt starts, so a host-to-GitHub fallback restarts the count.
    if(progress.received>state.received||(progress.received===0&&state.received>0))publish({received:progress.received});
   });
   void work.then(saved=>{if(downloading!==transfer||!active(owner))void backend.cancel(saved.id).catch(()=>{});},()=>{});
   const saved=await Promise.race([work,cancelled]);
   if(downloading!==transfer||!active(owner))return;
   if(!policy.matches(saved,update)||!saved.id)throw new Error('The saved update does not match this release. Try again.');
   downloading=undefined;publish({staged:saved,received:update.bytes});return saved;
  }catch(error){if(downloading===transfer){downloading=undefined;void backend.cancel(transfer.id).catch(()=>{});}throw error;}
 }
 async function update(){
  const release=latest,update=release&&policy.package(release);
  if(stopped||!isVisible()||!['available','failed'].includes(state.phase))return;
  if(!update){publish({phase:'blocked',error:policy.missing});return;}
  if(!state.staged&&!state.networkReady){publish({error:OFFLINE});return;}
  const owner=updating=++revision;publish({phase:'checking',release,error:''});
  try{
   const info=await visiblyBounded(backend.info());if(!active(owner))return;
   const blocked=policy.conflict(info,update);if(blocked){publish({phase:'blocked',info,staged:undefined,error:blocked});return;}
   let staged=kept(info,update);publish({staged});
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
   if(policy.exits){publish({phase:'installing'});await backend.open(staged.id);return;}
   await bounded(backend.open(staged.id),15_000);if(!active(owner))return;
   publish({phase:'available'});
  }catch(error){if(active(owner))publish({phase:'failed',received:0,error:message(error)});}
  // The host may answer just before it exits, so installing keeps the owner and no refresh can reopen the update.
  finally{if(updating===owner&&state.phase!=='installing')updating=0;}
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
export type UpdateController=ReturnType<typeof createUpdateController>;
