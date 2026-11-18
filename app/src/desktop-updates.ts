import {Channel,invoke} from '@tauri-apps/api/core';
import {DESKTOP_UPDATE_FORMATS,type NativePlatform,type NativeRelease,type NativeReleasePackage} from '../../src/native-release.ts';
import type {UpdateBackend,UpdatePolicy} from './android-updates.ts';

export interface DesktopStagedUpdate {id:string;buildNumber:number}
/** `unsupported` says why this installation cannot replace itself (a .deb, a read-only bundle, a build without a release number). */
export interface DesktopUpdateInfo {platform:NativePlatform|null;buildNumber:number;commit:string;unsupported:string|null;staged:DesktopStagedUpdate|null;downloading:string|null}
export interface DesktopUpdatePackage extends NativeReleasePackage {signature:string;commit:string;buildNumber:number}
export type DesktopUpdateBackend=UpdateBackend<DesktopUpdateInfo,DesktopUpdatePackage,DesktopStagedUpdate>;
export function desktopUpdatePackage(release:NativeRelease,platform:string):DesktopUpdatePackage|undefined{
 const suffix=DESKTOP_UPDATE_FORMATS[platform as NativePlatform],item=suffix?release.packages.find(item=>item.platform===platform&&item.file.endsWith(suffix)&&item.signature):undefined;
 return item&&{...item,signature:item.signature!,commit:release.commit,buildNumber:release.buildNumber};
}
const UNSIGNED='This release has no signed in-app update for this computer.',UNSUPPORTED='This installation cannot update itself. Download the new version from the downloads page.';
export const desktopUpdatePolicy=(platform:string):UpdatePolicy<DesktopUpdateInfo,DesktopUpdatePackage,DesktopStagedUpdate>=>({
 host:'The updater',missing:UNSIGNED,exits:true,package:release=>desktopUpdatePackage(release,platform),
 conflict:(info,update)=>info.unsupported!==null?info.unsupported||UNSUPPORTED:update?'':UNSIGNED,matches:(staged,update)=>staged.buildNumber===update.buildNumber,
});
export function desktopUpdateBackend():DesktopUpdateBackend {
 return {
  info:()=>invoke('native_desktop_update_info'),
  download:(generation,requestId,{url,bytes,sha256,commit,buildNumber,signature},progress)=>invoke('native_desktop_update_download',{generation,requestId,update:{url,bytes,sha256,commit,buildNumber,signature},onProgress:new Channel(progress)}),
  cancel:id=>invoke('native_desktop_update_cancel',{id}),
  // The host exits or relaunches once the installer is under way, so this may never settle.
  open:id=>invoke('native_desktop_update_install',{id}),
 };
}
