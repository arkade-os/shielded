import {Channel,invoke} from '@tauri-apps/api/core';
import {DESKTOP_UPDATE_FORMATS,type NativePlatform,type NativeRelease,type NativeReleasePackage} from '../../src/native-release.ts';

export interface DesktopStagedUpdate {id:string;buildNumber:number}
/** `unsupported` says why this installation cannot replace itself (a .deb, a read-only bundle, a build without a release number). */
export interface DesktopUpdateInfo {platform:NativePlatform|null;buildNumber:number;commit:string;unsupported:string|null;staged:DesktopStagedUpdate|null;downloading:string|null}
export interface DesktopUpdateBackend {
 info():Promise<DesktopUpdateInfo>;
 download(generation:number,requestId:string,release:NativeRelease,item:NativeReleasePackage,progress:(value:{received:number;total:number})=>void):Promise<DesktopStagedUpdate>;
 cancel(id:string):Promise<void>;
 install(id:string):Promise<void>;
}
export function desktopUpdatePackage(release:NativeRelease,platform:string):NativeReleasePackage|undefined{
 const suffix=DESKTOP_UPDATE_FORMATS[platform as NativePlatform];
 return suffix?release.packages.find(item=>item.platform===platform&&item.file.endsWith(suffix)&&item.signature):undefined;
}
export function desktopUpdateBackend():DesktopUpdateBackend {
 return {
  info:()=>invoke('native_desktop_update_info'),
  download:(generation,requestId,release,{url,bytes,sha256,signature},progress)=>invoke('native_desktop_update_download',{generation,requestId,update:{url,bytes,sha256,commit:release.commit,buildNumber:release.buildNumber,signature},onProgress:new Channel(progress)}),
  cancel:id=>invoke('native_desktop_update_cancel',{id}),
  // The host exits or relaunches once the installer is under way, so this may never settle.
  install:id=>invoke('native_desktop_update_install',{id}),
 };
}
