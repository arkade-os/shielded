import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {androidUpdateNotice,createAndroidUpdateController,prepareAndroidInstall,registerAndroidInstallPreparation,type AndroidUpdateBackend,type AndroidUpdateInfo} from '../app/src/android-updates.ts';
import {parseNativeRelease} from '../src/native-release.ts';
import type {NativeStatus} from '../src/native/transport.ts';
import {androidUpdateFixture,nativeReleaseFixture} from './fixtures/native-release.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const raw=nativeReleaseFixture(),release=parseNativeRelease({...raw,androidUpdate:androidUpdateFixture(raw)}),update=release.androidUpdate!;
function fixture(t:TestContext,options:{info?:Partial<AndroidUpdateInfo>;status?:NativeStatus;prepare?:()=>Promise<void>;withoutRelease?:boolean}={}){
 let visible=true,listener:(status:NativeStatus)=>void=()=>{},status:NativeStatus=options.status??{phase:'ready',generation:1,mode:'tor'};
 let info:AndroidUpdateInfo={packageName:update.packageName,versionCode:update.versionCode-1,signerSha256:update.signerSha256,installerPackageName:null,canRequestInstalls:true,installStatus:'idle',installError:null,...options.info};
 const downloads:{id:string;generation:number;progress:(value:{received:number;total:number})=>void;result:ReturnType<typeof deferred<{id:string;versionCode:number}>>}[]=[],cancelled:string[]=[],events:string[]=[];
 let infoRead=()=>Promise.resolve(info),install:AndroidUpdateBackend['install']=async()=>{info={...info,installStatus:'installing'};return {installStatus:'installing'};};
 const backend:AndroidUpdateBackend={
  info:()=>{events.push('info');return infoRead();},
  download:(generation,id,_update,progress)=>{assert.equal(_update,update);const result=deferred<{id:string;versionCode:number}>();downloads.push({id,generation,progress,result});events.push('download');return result.promise;},
  cancel:async id=>{cancelled.push(id);if(info.staged?.id===id)info={...info,staged:undefined};},permission:async()=>{events.push('permission');},
  install:async id=>{events.push('install:'+id);return install(id);},confirm:async()=>{events.push('confirm');info={...info,installStatus:'installing'};return {installStatus:'installing'};},
 };
 const controller=createAndroidUpdateController(backend,{status:async()=>status,subscribe:receive=>{listener=receive;return()=>{listener=()=>{};};}},async()=>{events.push('prepare');await options.prepare?.();},()=>visible);
 if(!options.withoutRelease)controller.setRelease(release);t.after(()=>controller.stop());
 const finish=async()=>{const pending=downloads.at(-1)!;info={...info,staged:{id:pending.id,versionCode:update.versionCode}};pending.result.resolve(info.staged!);await flush();};
 return {controller,downloads,cancelled,events,finish,state:controller.getSnapshot,setInfo:(change:Partial<AndroidUpdateInfo>)=>{info={...info,...change};},read:(read:typeof infoRead)=>{infoRead=read;},install:(fn:typeof install)=>{install=fn;},visible:(value:boolean)=>{visible=value;controller.visibilityChanged();},emit:(next:NativeStatus)=>{status=next;listener(next);}};
}

test('Android downloads require a ready Tor generation and never change direct mode',async t=>{
 const f=fixture(t,{status:{phase:'ready',generation:3,mode:'direct'}});await flush();await f.controller.download();
 assert.equal(f.downloads.length,0);assert.match(f.state().error,/Connect to Tor/);
 f.emit({phase:'bootstrapping',generation:4,mode:'tor'});await f.controller.download();assert.equal(f.downloads.length,0);
 f.emit({phase:'ready',generation:4,mode:'tor'});const pending=f.controller.download();await flush();assert.equal(f.downloads.length,1);assert.equal(f.downloads[0]!.generation,4);
 await f.finish();await pending;assert.equal(f.state().phase,'ready');
});

test('a download owns progress, rejects double clicks and becomes installable only after native verification',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await f.controller.download();await flush();
 assert.equal(f.downloads.length,1);const work=f.downloads[0]!;
 work.progress({received:35,total:update.bytes});assert.deepEqual([f.state().phase,f.state().received,f.state().total],['downloading',35,update.bytes]);
 work.progress({received:20,total:update.bytes});assert.equal(f.state().received,35);
 await f.finish();await pending;assert.equal(f.state().phase,'ready');assert.equal(f.state().staged?.id,work.id);assert.equal(f.state().received,update.bytes);
});

test('Tor pause or generation replacement cancels the owner and fences late progress and saved files',async t=>{
 for(const next of [{phase:'paused',generation:2},{phase:'ready',generation:2,mode:'tor'}] as NativeStatus[]){
  const f=fixture(t);await flush();const pending=f.controller.download();await flush();const work=f.downloads[0]!;
  f.emit(next);await pending;assert.equal(f.state().phase,'failed');assert.ok(f.cancelled.includes(work.id));
  work.progress({received:update.bytes,total:update.bytes});work.result.resolve({id:work.id,versionCode:update.versionCode});await flush();
  assert.equal(f.state().staged,undefined);assert.equal(f.state().received,0);assert.match(f.state().error,/Tor connection changed/);
 }
});

test('app switches retain the same download, progress and verified package without restarting',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();const work=f.downloads[0]!;
 work.progress({received:35,total:update.bytes});f.visible(false);f.emit({phase:'ready',generation:1,mode:'tor',foreground:false});
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,35);assert.deepEqual(f.cancelled,[]);
 f.visible(true);f.emit({phase:'ready',generation:1,mode:'tor',foreground:true});await flush();
 assert.equal(f.downloads.length,1);assert.equal(f.state().received,35);await f.finish();await pending;
 const saved=f.state().staged!,cancelCount=f.cancelled.length;f.visible(false);assert.equal(f.state().phase,'ready');assert.equal(f.state().staged,saved);assert.equal(f.cancelled.length,cancelCount);
 f.visible(true);await flush();assert.equal(f.state().staged?.id,saved.id);assert.equal(f.state().phase,'ready');
});

test('an existing download can complete while hidden without opening the Android installer',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();f.visible(false);
 assert.equal(f.state().phase,'downloading');await f.finish();await pending;
 assert.equal(f.state().phase,'ready');assert.equal(f.state().received,update.bytes);assert.deepEqual(f.cancelled,[]);
 f.visible(true);await flush();assert.equal(f.state().phase,'ready');assert.equal(f.downloads.length,1);
 assert.equal(f.events.some(event=>event==='confirm'||event.startsWith('install:')),false);
});

test('frozen renderer watchdogs cannot cancel a native transfer after a background switch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await flush();const pending=f.controller.download();await flush();
 const work=f.downloads[0]!;work.progress({received:35,total:update.bytes});f.visible(false);t.mock.timers.tick(11*60_000);await flush();
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,35);assert.deepEqual(f.cancelled,[]);
 f.visible(true);await flush();t.mock.timers.tick(45_000);await flush();assert.equal(f.state().phase,'downloading');
 work.progress({received:70,total:update.bytes});assert.equal(f.state().received,70);await f.finish();await pending;assert.equal(f.state().phase,'ready');
});

test('a preflight already started in the foreground retains its owner across a soft app switch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t);await flush();const checking=deferred<AndroidUpdateInfo>();f.read(()=>checking.promise);
 const pending=f.controller.download();await flush();f.visible(false);t.mock.timers.tick(45_000);await flush();
 assert.equal(f.state().phase,'downloading');f.visible(true);
 checking.resolve({packageName:update.packageName,versionCode:update.versionCode-1,signerSha256:update.signerSha256,installerPackageName:null,canRequestInstalls:true,installStatus:'idle',installError:null});await flush();
 assert.equal(f.downloads.length,1);assert.equal(f.downloads[0]!.generation,1);assert.deepEqual(f.cancelled,[]);await f.finish();await pending;
});

test('an unresponsive update preflight remains bounded while the app is visible',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await flush();f.read(()=>new Promise(()=>{}));
 const pending=f.controller.download();await flush();t.mock.timers.tick(10_000);await pending;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Android did not respond/);assert.equal(f.downloads.length,0);
});

test('app switches cannot reset the visible-time budget of an unresponsive preflight',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(t);await flush();f.read(()=>new Promise(()=>{}));
 const pending=f.controller.download();await flush();t.mock.timers.tick(6_000);
 f.visible(false);t.mock.timers.tick(60_000);f.visible(true);await flush();t.mock.timers.tick(3_999);await flush();
 assert.equal(f.state().phase,'downloading');t.mock.timers.tick(1);await pending;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Android did not respond/);
});

test('explicit cancellation fences the old transfer after a replacement has begun',async t=>{
 const f=fixture(t);await flush();const first=f.controller.download();await flush();const old=f.downloads[0]!;
 f.visible(false);f.controller.cancel();await first;f.visible(true);await flush();const second=f.controller.download();await flush();const current=f.downloads[1]!;
 current.progress({received:70,total:update.bytes});old.progress({received:update.bytes,total:update.bytes});old.result.resolve({id:old.id,versionCode:update.versionCode});await flush();
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,70);assert.equal(f.state().staged,undefined);
 await f.finish();await second;assert.equal(f.state().staged?.id,current.id);assert.ok(f.cancelled.includes(old.id));assert.equal(f.cancelled.includes(current.id),false);
});

test('preflight refuses store-managed, signer, app and version mismatches without downloading',async t=>{
 for(const [info,pattern] of [[{installerPackageName:'com.android.vending'},/Google Play/],[{signerSha256:'0'.repeat(64)},/different signing key/],[{packageName:'other.app'},/different app/],[{versionCode:update.versionCode},/already installed/]] as [Partial<AndroidUpdateInfo>,RegExp][]){
  const f=fixture(t,{info});await flush();assert.equal(f.state().phase,'blocked');await f.controller.download();assert.equal(f.downloads.length,0);assert.match(f.state().error,pattern);assert.doesNotMatch(f.state().error,/uninstall/i);
 }
});

test('fresh preflight catches signing changes after release detection',async t=>{
 const f=fixture(t);await flush();assert.equal(f.state().phase,'available');f.setInfo({signerSha256:'f'.repeat(64)});await f.controller.download();
 assert.equal(f.downloads.length,0);assert.match(f.state().error,/Keep this installation and its wallet data/);
});

test('invalid progress cancels the download and a native transfer timeout leaves retry available',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();
 f.downloads[0]!.progress({received:1,total:update.bytes+1});await pending;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/invalid download progress/);
 const retry=f.controller.download();await flush();f.downloads.at(-1)!.result.reject(new Error('Tor download timed out'));await retry;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Tor download timed out/);
});

test('restored verified updates are reconciled after metadata arrives and are never downloaded twice',async t=>{
 const f=fixture(t,{info:{staged:{id:crypto.randomUUID(),versionCode:update.versionCode}}});await flush();assert.equal(f.state().phase,'ready');
 await f.controller.download();assert.equal(f.downloads.length,0);
 await f.controller.discard();assert.equal(f.state().phase,'available');assert.equal(f.state().staged,undefined);
});

test('settings grant never installs automatically; the next explicit install awaits wallet preparation',async t=>{
 const preparation=deferred<void>(),f=fixture(t,{info:{canRequestInstalls:false},prepare:()=>preparation.promise});await flush();const pending=f.controller.download();await flush();await f.finish();await pending;
 await f.controller.install();assert.equal(f.events.includes('prepare'),false);assert.equal(f.state().phase,'ready');assert.match(f.state().error,/Android settings/);
 await f.controller.permission();f.visible(false);f.setInfo({canRequestInstalls:true});f.visible(true);await flush();
 assert.equal(f.state().phase,'ready');assert.equal(f.events.some(event=>event.startsWith('install:')),false);
 const installing=f.controller.install();await flush();await f.controller.install();assert.equal(f.state().phase,'preparing');assert.equal(f.events.some(event=>event.startsWith('install:')),false);
 preparation.resolve();await installing;assert.equal(f.events.filter(event=>event==='prepare').length,1);assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);assert.equal(f.state().phase,'installing');
});

test('missing or failing wallet preparation prevents all installer commands',async t=>{
 await assert.rejects(prepareAndroidInstall(),/cannot finish saving/);
 const unregister=registerAndroidInstallPreparation(async()=>{throw new Error('Wallet writes are still pending');});await assert.rejects(prepareAndroidInstall(),/writes are still pending/);unregister();
 const f=fixture(t,{prepare:async()=>{throw new Error('Wallet writes are still pending');}});await flush();const pending=f.controller.download();await flush();await f.finish();await pending;await f.controller.install();
 assert.equal(f.state().phase,'ready');assert.match(f.state().error,/writes are still pending/);assert.equal(f.events.some(event=>event.startsWith('install:')),false);
});

test('hiding during preparation fences a late flush from opening the installer',async t=>{
 const preparation=deferred<void>(),f=fixture(t,{prepare:()=>preparation.promise});await flush();const pending=f.controller.download();await flush();await f.finish();await pending;
 const installing=f.controller.install();await flush();assert.equal(f.state().phase,'preparing');f.visible(false);preparation.resolve();await installing;
 assert.equal(f.events.some(event=>event.startsWith('install:')),false);assert.equal(f.state().phase,'ready');
});

test('retiring the wallet preparation owner rejects a late flush',async()=>{
 const flush=deferred<void>(),unregister=registerAndroidInstallPreparation(()=>flush.promise),preparing=prepareAndroidInstall();
 unregister();flush.resolve();await assert.rejects(preparing,/wallet changed/);
});

test('an ambiguous installation is reconciled without a second install or automatic confirmation',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;
 f.install(async()=>{throw new Error('Installer response lost');});await f.controller.install();assert.equal(f.state().phase,'unknown');await f.controller.install();
 await f.controller.refresh();assert.equal(f.state().phase,'unknown');assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
 f.setInfo({installStatus:'confirmation-required'});await f.controller.refresh();assert.equal(f.state().phase,'confirmation-required');assert.equal(f.events.includes('confirm'),false);
 await f.controller.install(true);assert.deepEqual(f.events.filter(event=>event==='prepare'||event==='confirm'),['prepare','prepare','confirm']);assert.equal(f.state().phase,'installing');
 f.setInfo({installStatus:'installed',versionCode:update.versionCode});await f.controller.refresh();assert.equal(f.state().phase,'installed');assert.equal(f.state().staged,undefined);
});

test('a native installer failure is shown explicitly and cannot silently become an automatic retry',async t=>{
 const f=fixture(t,{info:{installStatus:'failed',installError:'Installation was declined'}});await flush();assert.equal(f.state().phase,'failed');assert.match(f.state().error,/declined/);
 assert.equal(f.events.some(event=>event.startsWith('install:')),false);
});

test('a committed Android confirmation survives process restart without release metadata or a staged file',async t=>{
 const f=fixture(t,{withoutRelease:true,info:{installStatus:'confirmation-required',canRequestInstalls:false}});await flush();
 assert.equal(f.state().release,undefined);assert.equal(f.state().staged,undefined);assert.equal(androidUpdateNotice(f.state()),'Update pending');
 await f.controller.install(true);assert.deepEqual(f.events.filter(event=>event==='prepare'||event==='confirm'),['prepare','confirm']);assert.equal(f.state().phase,'installing');
});

test('native installation failures remain discoverable without metadata and ordinary check failures do not claim a pending install',async t=>{
 const f=fixture(t,{withoutRelease:true,info:{installStatus:'failed',installError:'The Android confirmation expired'}});await flush();assert.equal(androidUpdateNotice(f.state()),'Update needs attention');
 assert.equal(androidUpdateNotice({...f.state(),info:{...f.state().info!,installStatus:'idle'}}),undefined);
});

test('hidden controllers do not poll installer status and retain its pending state',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{info:{installStatus:'installing'}});await flush();assert.equal(f.state().phase,'installing');
 f.visible(false);const count=f.events.filter(event=>event==='info').length;t.mock.timers.tick(30_000);await flush();assert.equal(f.events.filter(event=>event==='info').length,count);
 f.setInfo({installStatus:'confirmation-required'});f.visible(true);await flush();assert.equal(f.state().phase,'confirmation-required');assert.equal(f.events.includes('confirm'),false);
});

test('a retired preflight cannot start a download after a new generation is ready',async t=>{
 const f=fixture(t);await flush();const checking=deferred<AndroidUpdateInfo>();f.read(()=>checking.promise);const pending=f.controller.download();await flush();
 f.emit({phase:'ready',mode:'tor',generation:2});checking.resolve({packageName:update.packageName,versionCode:update.versionCode-1,signerSha256:update.signerSha256,installerPackageName:null,canRequestInstalls:true,installStatus:'idle',installError:null});await pending;
 assert.equal(f.downloads.length,0);assert.equal(f.state().staged,undefined);
});

test('an older completed installation cannot hide a newer release after a status refresh',async t=>{
 const f=fixture(t,{withoutRelease:true,info:{installStatus:'installed'}});await flush();assert.equal(f.state().phase,'installed');
 f.controller.setRelease(release);assert.equal(f.state().phase,'available');await f.controller.refresh();
 assert.equal(f.state().phase,'available');assert.equal(f.state().release,release);
 const pending=f.controller.download();await flush();assert.equal(f.downloads.length,1);await f.finish();await pending;
});

test('an older installed status retains a newer verified file across refresh and background return',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const staged=f.state().staged!;
 f.setInfo({installStatus:'installed'});await f.controller.refresh();
 assert.equal(f.state().phase,'ready');assert.equal(f.state().staged?.id,staged.id);
 f.visible(false);f.visible(true);await flush();assert.equal(f.state().phase,'ready');assert.equal(f.state().staged?.id,staged.id);
 assert.equal(f.cancelled.length,0);assert.equal(f.events.some(event=>event.startsWith('install:')),false);
 f.setInfo({staged:undefined});await f.controller.refresh();assert.equal(f.state().phase,'ready');assert.equal(f.state().staged?.id,staged.id);
});

test('a newer file discovered with an older installed record stays ready for explicit installation',async t=>{
 const staged={id:crypto.randomUUID(),versionCode:update.versionCode},f=fixture(t,{info:{installStatus:'installed',staged}});await flush();
 assert.equal(f.state().phase,'ready');assert.deepEqual(f.state().staged,staged);assert.equal(f.events.some(event=>event.startsWith('install:')),false);
});

test('an older installed record cannot release a newer pending installation for retry',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const staged=f.state().staged!;
 await f.controller.install();assert.equal(f.state().phase,'installing');f.setInfo({installStatus:'installed'});await f.controller.refresh();
 assert.equal(f.state().phase,'unknown');assert.equal(f.state().staged?.id,staged.id);await f.controller.install();
 assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);assert.equal(f.events.includes('confirm'),false);
 f.setInfo({installStatus:'installed',versionCode:update.versionCode,staged:undefined});await f.controller.refresh();assert.equal(f.state().phase,'installed');
});

test('a failed staged install can open settings and requires another explicit install after permission returns',async t=>{
 const staged={id:crypto.randomUUID(),versionCode:update.versionCode},f=fixture(t,{info:{installStatus:'failed',installError:'Installation was declined',staged,canRequestInstalls:false}});await flush();
 assert.equal(f.state().phase,'failed');await f.controller.permission();assert.equal(f.events.filter(event=>event==='permission').length,1);
 f.visible(false);f.setInfo({canRequestInstalls:true});f.visible(true);await flush();assert.equal(f.state().phase,'failed');assert.equal(f.state().staged?.id,staged.id);
 assert.equal(f.events.some(event=>event.startsWith('install:')),false);await f.controller.install();assert.equal(f.state().phase,'installing');assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
});

test('a known precommit failure retains native failed status and the verified file for explicit recovery',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const staged=f.state().staged!;
 f.install(async()=>{f.setInfo({installStatus:'failed',installError:'Android could not prepare the installer',canRequestInstalls:false});return {installStatus:'failed',installError:'Android could not prepare the installer'};});
 await f.controller.install();assert.equal(f.state().phase,'failed');assert.equal(f.state().info?.installStatus,'failed');assert.equal(f.state().staged?.id,staged.id);assert.match(f.state().error,/could not prepare/);
 await f.controller.refresh();assert.equal(f.state().phase,'failed');assert.equal(f.state().staged?.id,staged.id);assert.equal(androidUpdateNotice(f.state()),'Update needs attention');
 assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
 await f.controller.discard();assert.equal(f.state().staged,undefined);assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
});

test('completion of the selected update exposes a later release without retaining its completed install fence',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;await f.controller.install();
 const later={...release,buildNumber:release.buildNumber+1,androidUpdate:{...update,versionCode:update.versionCode+1}};f.controller.setRelease(later);
 f.setInfo({installStatus:'installed',versionCode:update.versionCode});await f.controller.refresh();
 assert.equal(f.state().phase,'available');assert.equal(f.state().release,later);assert.equal(f.state().staged,undefined);assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
});

test('install preflight reconciles an evicted verified file before allowing an explicit new download',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;
 f.setInfo({installStatus:'failed',installError:'The downloaded update is missing. Download it again.',staged:undefined});await f.controller.install();
 assert.equal(f.state().phase,'failed');assert.equal(f.state().staged,undefined);assert.match(f.state().error,/downloaded update is missing/);
 assert.equal(f.events.some(event=>event.startsWith('install:')),false);assert.equal(f.downloads.length,1);
 const retry=f.controller.download();await flush();assert.equal(f.downloads.length,2);await f.finish();await retry;assert.equal(f.state().phase,'ready');
});

for(const installStatus of ['idle','installed'] as const)test(`native Ready recovers a pre-owner failure despite an older ${installStatus} record and waits for explicit retry`,async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const saved=f.state().staged!;
 f.install(async()=>{throw new Error('Platform identity is temporarily unavailable');});await f.controller.install();assert.equal(f.state().phase,'unknown');
 const staged={...saved,ready:true};f.setInfo({installStatus,staged});await f.controller.refresh();
 assert.equal(f.state().phase,'ready');assert.equal(f.state().staged?.id,saved.id);assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
 f.install(async()=>({installStatus:'installing'}));await f.controller.install();assert.equal(f.state().phase,'installing');assert.equal(f.events.filter(event=>event.startsWith('install:')).length,2);
});

for(const ready of [undefined,false])test(`ambiguous native ownership remains fenced when Ready is ${String(ready)}`,async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const saved=f.state().staged!;
 f.install(async()=>{throw new Error('Install reply lost');});await f.controller.install();const staged={...saved,...(ready===undefined?{}:{ready})};f.setInfo({installStatus:'idle',staged});await f.controller.refresh();
 assert.equal(f.state().phase,'unknown');await f.controller.install();assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
});

for(const installStatus of ['installing','confirmation-required'] as const)test(`native ${installStatus} takes precedence over a Ready marker`,async t=>{
 const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const saved=f.state().staged!;
 f.install(async()=>{throw new Error('Install reply lost');});await f.controller.install();const staged={...saved,ready:true};f.setInfo({installStatus,staged});await f.controller.refresh();
 assert.equal(f.state().phase,installStatus);await f.controller.install();assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);assert.equal(f.events.includes('confirm'),false);
});

test('native Ready cannot bypass the pinned identity or the newer-version check',async t=>{
 for(const changed of [{signerSha256:'0'.repeat(64)},{versionCode:update.versionCode}]){
  const f=fixture(t);await flush();const pending=f.controller.download();await flush();await f.finish();await pending;const saved=f.state().staged!;
  f.install(async()=>{throw new Error('Install reply lost');});await f.controller.install();const staged={...saved,ready:true};f.setInfo({...changed,installStatus:'idle',staged});await f.controller.refresh();
  assert.notEqual(f.state().phase,'ready');await f.controller.install();assert.equal(f.events.filter(event=>event.startsWith('install:')).length,1);
 }
});
