import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DESKTOP_UPDATE_FORMATS,parseNativeRelease,type NativePlatform,type NativeRelease} from '../src/native-release.ts';
import type {NativeStatus} from '../src/native/transport.ts';
import {createUpdateController} from '../app/src/android-updates.ts';
import {DesktopUpdateNotice} from '../app/src/AppUpdates.tsx';
import {desktopUpdateBackend,desktopUpdatePackage,desktopUpdatePolicy,type DesktopStagedUpdate,type DesktopUpdateBackend,type DesktopUpdateInfo,type DesktopUpdatePackage} from '../app/src/desktop-updates.ts';
import {nativeReleaseFixture} from './fixtures/native-release.ts';

const signature=Buffer.alloc(64,9).toString('base64');
const release=(signed=true)=>{const raw=nativeReleaseFixture();if(signed)for(const item of raw.packages)Object.assign(item,{signature});return parseNativeRelease(raw);};

test('each desktop host picks only its own signed in-app installer',()=>{
 const signed=release();
 assert.match(desktopUpdatePackage(signed,'windows-x86_64')!.file,/-setup\.exe$/);
 assert.match(desktopUpdatePackage(signed,'linux-x86_64')!.file,/\.AppImage$/);
 assert.match(desktopUpdatePackage(signed,'macos-universal')!.file,/-release-Shielded\.app\.zip$/);
 for(const platform of ['android-arm64','ios','freebsd'])assert.equal(desktopUpdatePackage(signed,platform),undefined,platform);
 assert.equal(desktopUpdatePackage(release(false),'windows-x86_64'),undefined);
});

test('a download sends the host exactly the signed fields it accepts',async()=>{
 const calls:{command:string;args:Record<string,unknown>}[]=[];
 Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
 Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{value:{invoke:async(command:string,args:Record<string,unknown>)=>{calls.push({command,args});return {id:'staged',buildNumber:123};},transformCallback:()=>7,unregisterCallback(){}},configurable:true});
 const signed=release(),item=desktopUpdatePackage(signed,'windows-x86_64')!;
 assert.deepEqual(await desktopUpdateBackend().download(4,'request',item,()=>{}),{id:'staged',buildNumber:123});
 const [{command,args}]=calls;
 assert.equal(command,'native_desktop_update_download');
 assert.deepEqual(Object.keys(args).sort(),['generation','onProgress','requestId','update']);
 assert.deepEqual(args.update,{url:item.url,bytes:item.bytes,sha256:item.sha256,commit:signed.commit,buildNumber:signed.buildNumber,signature});
});

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const host:DesktopUpdateInfo={platform:'windows-x86_64',buildNumber:122,commit:'f'.repeat(40),unsupported:null,staged:null,downloading:null};
function desktop(t:TestContext,options:{info?:Partial<DesktopUpdateInfo>;release?:NativeRelease;platform?:string;install?:()=>Promise<void>;prepare?:()=>Promise<void>}={}){
 let info={...host,...options.info},visible=true,listener=(_:NativeStatus)=>{},status:NativeStatus={phase:'ready',generation:1,mode:'tor'};
 const events:string[]=[],downloads:{id:string;update:DesktopUpdatePackage;result:ReturnType<typeof deferred<DesktopStagedUpdate>>}[]=[];
 const backend:DesktopUpdateBackend={
  info:async()=>info,
  download:(_generation,id,update)=>{const result=deferred<DesktopStagedUpdate>();downloads.push({id,update,result});events.push('download');return result.promise;},
  cancel:async id=>{events.push('cancel:'+id);},
  open:id=>{events.push('install:'+id);return options.install?.()??new Promise<void>(()=>{});},
 };
 const controller=createUpdateController(desktopUpdatePolicy(options.platform??'windows-x86_64'),backend,{status:async()=>status,subscribe:receive=>{listener=receive;return()=>{};}},async()=>{events.push('prepare');await options.prepare?.();status={phase:'paused',generation:2};listener(status);},()=>visible);
 controller.setRelease(options.release??release());t.after(()=>controller.stop());
 const finish=async()=>{const {id,update,result}=downloads.at(-1)!;info={...info,staged:{id,buildNumber:update.buildNumber}};result.resolve(info.staged!);await flush();};
 return {controller,events,downloads,finish,state:controller.getSnapshot,visible:(value:boolean)=>{visible=value;controller.visibilityChanged();}};
}
const notice=(controller:ReturnType<typeof desktop>['controller'])=>renderToStaticMarkup(createElement(DesktopUpdateNotice,{controller,onOpen:()=>{}}));

test('each desktop host downloads its own signed installer with the release identity the signature covers',async t=>{
 const signed=release();
 for(const platform of ['windows-x86_64','linux-x86_64','macos-universal'] as NativePlatform[]){
  const f=desktop(t,{platform,info:{platform}});await flush();assert.equal(f.state().phase,'available');
  void f.controller.update();await flush();const {file,commit,buildNumber,signature:signs,bytes}=f.downloads[0]!.update;
  assert.ok(file.includes(platform)&&file.endsWith(DESKTOP_UPDATE_FORMATS[platform]!),file);assert.deepEqual([commit,buildNumber,signs,f.state().total],[signed.commit,signed.buildNumber,signature,bytes]);
 }
 const unsigned=desktop(t,{release:release(false)});await flush();await unsigned.controller.update();
 assert.equal(unsigned.state().phase,'blocked');assert.match(unsigned.state().error,/no signed in-app update/);assert.equal(unsigned.downloads.length,0);
});

test('an installation that cannot replace itself or an unsigned release keeps the downloads link and its reason',async t=>{
 const reason='This installation cannot update itself. Download the new version from the downloads page.';
 const blocked=desktop(t,{info:{unsupported:reason}});await flush();await blocked.controller.update();
 assert.equal(blocked.state().phase,'blocked');assert.equal(blocked.downloads.length,0);
 assert.match(notice(blocked.controller),/<a\b[^>]*title="This installation cannot update itself\. Download the new version from the downloads page\."/);assert.doesNotMatch(notice(blocked.controller),/<button/);
 const unsigned=desktop(t,{release:release(false)});await flush();assert.match(notice(unsigned.controller),/<a\b[^>]*title="This release has no signed in-app update for this computer\."/);
 const supported=desktop(t);assert.match(notice(supported.controller),/<a\b/);assert.doesNotMatch(notice(supported.controller),/title=/);
 await flush();assert.match(notice(supported.controller),/<button[^>]*aria-label="Native app update available\. View the update\."/);assert.doesNotMatch(notice(supported.controller),/<a\b/);
});

test('desktop install starts only after the wallet is saved and locked; a failed save keeps the installer',async t=>{
 const f=desktop(t);await flush();void f.controller.update();await flush();await f.finish();
 assert.deepEqual(f.events,['download','prepare','install:'+f.downloads[0]!.id]);assert.equal(f.state().phase,'installing');
 const g=desktop(t,{prepare:async()=>{throw new Error('Wallet writes are still pending');}});await flush();const pending=g.controller.update();await flush();await g.finish();await pending;
 assert.deepEqual(g.events,['download','prepare']);assert.equal(g.state().phase,'failed');assert.match(g.state().error,/writes are still pending/);assert.equal(g.state().staged?.id,g.downloads[0]!.id);
});

test('an install that never answers, or answers as Shielded exits, stays on installing',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const install of [()=>new Promise<void>(()=>{}),async()=>{}]){
  const f=desktop(t,{install});await flush();void f.controller.update();await flush();await f.finish();
  t.mock.timers.tick(60_000);await flush();
  await f.controller.refresh();f.controller.setRelease(release());f.controller.cancel();f.visible(false);f.visible(true);void f.controller.update();await flush();
  assert.deepEqual([f.state().phase,f.state().error],['installing','']);assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
 }
});

test('cancelling a desktop download tells the host and fences its late result',async t=>{
 const f=desktop(t);await flush();const pending=f.controller.update();await flush();assert.equal(f.state().phase,'downloading');const work=f.downloads[0]!;
 f.controller.cancel();await pending;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Download cancelled/);assert.ok(f.events.includes('cancel:'+work.id));
 work.result.resolve({id:work.id,buildNumber:work.update.buildNumber});await flush();
 assert.equal(f.state().staged,undefined);assert.deepEqual(f.events.filter(event=>event==='prepare'||event.startsWith('install:')),[]);
});

test('a refused install keeps the verified installer, and Try again installs it with the wallet locked',async t=>{
 let attempts=0;const f=desktop(t,{install:async()=>{if(++attempts===1)throw new Error('Could not start the installer: access denied');await new Promise(()=>{});}});
 await flush();const first=f.controller.update();await flush();await f.finish();await first;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Could not start the installer/);assert.equal(f.state().networkReady,false);const id=f.state().staged!.id;
 void f.controller.update();await flush();
 assert.equal(f.downloads.length,1);assert.deepEqual(f.events.slice(1),['prepare','install:'+id,'prepare','install:'+id]);assert.equal(f.state().phase,'installing');
});
