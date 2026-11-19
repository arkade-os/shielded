import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createAndroidUpdateController,prepareAndroidInstall,registerAndroidInstallPreparation,type AndroidUpdateBackend,type AndroidUpdateInfo} from '../app/src/android-updates.ts';
import {parseNativeRelease} from '../src/native-release.ts';
import type {NativeStatus} from '../src/native/transport.ts';
import {androidUpdateFixture,nativeReleaseFixture} from './fixtures/native-release.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const raw=nativeReleaseFixture(),release=parseNativeRelease({...raw,androidUpdate:androidUpdateFixture(raw)}),update=release.androidUpdate!;
const installed:AndroidUpdateInfo={packageName:update.packageName,versionCode:update.versionCode-1,signerSha256:update.signerSha256,installerPackageName:null};
function fixture(t:TestContext,options:{info?:Partial<AndroidUpdateInfo>;status?:NativeStatus;prepare?:()=>Promise<void>;cancel?:()=>Promise<void>}={}){
 let visible=true,listener:(status:NativeStatus)=>void=()=>{},status:NativeStatus=options.status??{phase:'ready',generation:1,mode:'tor'};
 let info:AndroidUpdateInfo={...installed,...options.info};
 const downloads:{id:string;generation:number;progress:(value:{received:number;total:number})=>void;result:ReturnType<typeof deferred<{id:string;versionCode:number}>>}[]=[],cancelled:string[]=[],events:string[]=[];
 let infoRead=()=>Promise.resolve(info),open=async(_id:string)=>{};
 const backend:AndroidUpdateBackend={
  info:()=>{events.push('info');return infoRead();},
  download:(generation,id,_update,progress)=>{assert.equal(_update,update);const result=deferred<{id:string;versionCode:number}>();downloads.push({id,generation,progress,result});events.push('download');return result.promise;},
  cancel:async id=>{cancelled.push(id);await options.cancel?.();if(info.staged?.id===id)info={...info,staged:undefined};},
  open:async id=>{events.push('open:'+id);return open(id);},
 };
 const lock=()=>{status={phase:'paused',generation:status.generation+1};listener(status);};
 const controller=createAndroidUpdateController(backend,{status:async()=>status,subscribe:receive=>{listener=receive;return()=>{listener=()=>{};};}},async()=>{events.push('prepare');await options.prepare?.();lock();},()=>visible);
 controller.setRelease(release);t.after(()=>controller.stop());
 const finish=async()=>{const pending=downloads.at(-1)!;info={...info,staged:{id:pending.id,versionCode:update.versionCode}};pending.result.resolve(info.staged!);await flush();};
 const handoffs=()=>events.filter(event=>event==='prepare'||event.startsWith('open:'));
 return {controller,downloads,cancelled,events,finish,handoffs,state:controller.getSnapshot,setInfo:(change:Partial<AndroidUpdateInfo>)=>{info={...info,...change};},read:(read:typeof infoRead)=>{infoRead=read;},open:(fn:typeof open)=>{open=fn;},visible:(value:boolean)=>{visible=value;controller.visibilityChanged();},emit:(next:NativeStatus)=>{status=next;listener(next);}};
}

test('one tap downloads, saves and locks, then hands the verified file to Android, with Tor on or off',async t=>{
 for(const mode of ['tor','direct'] as const){
  const f=fixture(t,{status:{phase:'ready',generation:3,mode}});await flush();assert.equal(f.state().phase,'available');assert.equal(f.state().torReady,mode==='tor');
  const pending=f.controller.update();await flush();assert.equal(f.state().phase,'downloading');assert.equal(f.downloads[0]!.generation,3);
  await f.finish();await pending;const id=f.downloads[0]!.id;
  assert.deepEqual(f.handoffs(),['prepare','open:'+id]);assert.equal(f.state().phase,'available');assert.equal(f.state().staged?.id,id);assert.equal(f.state().error,'');
  await flush();assert.equal(f.events.at(-1),'info','a finished handoff re-reads native state');
 }
 const g=fixture(t,{status:{phase:'bootstrapping',generation:4,mode:'tor'}});await flush();await g.controller.update();
 assert.equal(g.downloads.length,0);assert.match(g.state().error,/Open or reconnect your wallet/);
});

test('a download owns progress and the tap; a GitHub fallback restarts the count and a new release cannot interrupt it',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.update();await f.controller.update();await flush();
 assert.equal(f.downloads.length,1);const work=f.downloads[0]!;
 work.progress({received:35,total:update.bytes});assert.deepEqual([f.state().phase,f.state().received,f.state().total],['downloading',35,update.bytes]);
 work.progress({received:20,total:update.bytes});assert.equal(f.state().received,35);
 work.progress({received:0,total:update.bytes});assert.equal(f.state().received,0);
 f.controller.setRelease(release);assert.equal(f.state().phase,'downloading');
 await f.finish();await pending;assert.equal(f.downloads.length,1);assert.deepEqual(f.handoffs(),['prepare','open:'+work.id]);
});

test('a release that arrives during an update is offered from fresh native state once the update ends',async t=>{
 const later={...release,buildNumber:release.buildNumber+1,androidUpdate:{...update,versionCode:update.versionCode+1}};
 const f=fixture(t);await flush();const pending=f.controller.update();await flush();
 f.controller.setRelease(later);assert.equal(f.state().release,release);
 f.downloads[0]!.result.reject(new Error('Tor download timed out'));await pending;await flush();
 assert.equal(f.state().release,later);assert.equal(f.state().phase,'available');assert.equal(f.state().total,later.androidUpdate.bytes);
 const g=fixture(t);await flush();const unchanged=g.controller.update();await flush();
 g.downloads[0]!.result.reject(new Error('Tor download timed out'));await unchanged;await flush();
 assert.equal(g.state().phase,'failed');assert.match(g.state().error,/timed out/);
});

test('Tor pause or generation replacement cancels the download and fences late progress and saved files',async t=>{
 for(const next of [{phase:'paused',generation:2},{phase:'ready',generation:2,mode:'tor'}] as NativeStatus[]){
  const f=fixture(t);await flush();const pending=f.controller.update();await flush();const work=f.downloads[0]!;
  f.emit(next);await pending;assert.equal(f.state().phase,'failed');assert.ok(f.cancelled.includes(work.id));assert.match(f.state().error,/connection changed/);
  work.progress({received:update.bytes,total:update.bytes});work.result.resolve({id:work.id,versionCode:update.versionCode});await flush();
  assert.equal(f.state().staged,undefined);assert.equal(f.state().received,0);assert.deepEqual(f.handoffs(),[]);
 }
});

test('a download that finishes in the background waits for a tap instead of opening the installer',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.update();await flush();const work=f.downloads[0]!;
 work.progress({received:35,total:update.bytes});f.visible(false);f.emit({phase:'ready',generation:1,mode:'tor',foreground:false});
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,35);assert.deepEqual(f.cancelled,[]);
 await f.finish();await pending;assert.equal(f.state().phase,'available');assert.equal(f.state().staged?.id,work.id);
 f.visible(true);await flush();assert.equal(f.state().phase,'available');assert.deepEqual(f.handoffs(),[]);
 await f.controller.update();assert.equal(f.downloads.length,1);assert.deepEqual(f.handoffs(),['prepare','open:'+work.id]);
});

test('frozen renderer watchdogs cannot cancel a native transfer after a background switch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await flush();const pending=f.controller.update();await flush();
 const work=f.downloads[0]!;work.progress({received:35,total:update.bytes});f.visible(false);t.mock.timers.tick(11*60_000);await flush();
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,35);assert.deepEqual(f.cancelled,[]);
 f.visible(true);await flush();t.mock.timers.tick(45_000);await flush();assert.equal(f.state().phase,'downloading');
 work.progress({received:70,total:update.bytes});assert.equal(f.state().received,70);await f.finish();await pending;assert.equal(f.state().staged?.id,work.id);
});

test('a preflight already started in the foreground retains its owner across a soft app switch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t);await flush();const checking=deferred<AndroidUpdateInfo>();f.read(()=>checking.promise);
 const pending=f.controller.update();await flush();f.visible(false);t.mock.timers.tick(45_000);await flush();
 assert.equal(f.state().phase,'checking');f.visible(true);checking.resolve(installed);await flush();
 assert.equal(f.downloads.length,1);assert.equal(f.downloads[0]!.generation,1);assert.deepEqual(f.cancelled,[]);await f.finish();await pending;
});

test('an unresponsive preflight stays bounded by visible time only',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture(t);await flush();f.read(()=>new Promise(()=>{}));
 const pending=f.controller.update();await flush();t.mock.timers.tick(6_000);
 f.visible(false);t.mock.timers.tick(60_000);f.visible(true);await flush();t.mock.timers.tick(3_999);await flush();
 assert.equal(f.state().phase,'checking');t.mock.timers.tick(1);await pending;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Android did not respond/);assert.equal(f.downloads.length,0);
});

test('explicit cancellation fences the old transfer after a replacement has begun',async t=>{
 const f=fixture(t);await flush();const first=f.controller.update();await flush();const old=f.downloads[0]!;
 f.controller.cancel();await first;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Download cancelled/);
 const second=f.controller.update();await flush();const current=f.downloads[1]!;
 current.progress({received:70,total:update.bytes});old.progress({received:update.bytes,total:update.bytes});old.result.resolve({id:old.id,versionCode:update.versionCode});await flush();
 assert.equal(f.state().phase,'downloading');assert.equal(f.state().received,70);assert.equal(f.state().staged,undefined);
 await f.finish();await second;assert.equal(f.state().staged?.id,current.id);assert.ok(f.cancelled.includes(old.id));assert.equal(f.cancelled.includes(current.id),false);
});

test('store-managed, signer, app and version mismatches are a message without an action',async t=>{
 for(const [info,pattern] of [[{installerPackageName:'com.android.vending'},/Google Play/],[{signerSha256:'0'.repeat(64)},/different signing key/],[{packageName:'other.app'},/different app/],[{versionCode:update.versionCode},/already installed/]] as [Partial<AndroidUpdateInfo>,RegExp][]){
  const f=fixture(t,{info});await flush();assert.equal(f.state().phase,'blocked');await f.controller.update();assert.equal(f.downloads.length,0);assert.match(f.state().error,pattern);assert.doesNotMatch(f.state().error,/uninstall/i);
 }
 const f=fixture(t);await flush();assert.equal(f.state().phase,'available');f.setInfo({signerSha256:'f'.repeat(64)});void f.controller.update();await flush();
 assert.equal(f.downloads.length,0);assert.equal(f.state().phase,'blocked');assert.match(f.state().error,/Keep this installation and its wallet data/);
});

test('invalid progress, native failures and a download still running end in Try again without a handoff',async t=>{
 const f=fixture(t);await flush();const pending=f.controller.update();await flush();
 f.downloads[0]!.progress({received:1,total:update.bytes+1});await pending;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/invalid download progress/);
 const retry=f.controller.update();await flush();f.downloads.at(-1)!.result.reject(new Error('Tor download timed out'));await retry;assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Tor download timed out/);
 assert.deepEqual(f.handoffs(),[]);
 const g=fixture(t,{info:{downloading:{id:crypto.randomUUID()}}});await flush();await g.controller.update();
 assert.equal(g.downloads.length,0);assert.equal(g.state().phase,'failed');assert.match(g.state().error,/still running/);
});

test('a preflight that outlives the connection cannot start a download',async t=>{
 const f=fixture(t);await flush();const checking=deferred<AndroidUpdateInfo>();f.read(()=>checking.promise);const pending=f.controller.update();await flush();
 f.emit({phase:'paused',generation:2});checking.resolve(installed);await pending;
 assert.equal(f.downloads.length,0);assert.equal(f.state().phase,'failed');assert.match(f.state().error,/Open or reconnect your wallet/);
});

test('a verified download kept from earlier goes straight to the handoff, even while the wallet is locked',async t=>{
 const staged={id:crypto.randomUUID(),versionCode:update.versionCode},f=fixture(t,{info:{staged},status:{phase:'paused',generation:2}});await flush();
 assert.equal(f.state().phase,'available');assert.deepEqual(f.state().staged,staged);
 await f.controller.update();assert.equal(f.downloads.length,0);assert.deepEqual(f.handoffs(),['prepare','open:'+staged.id]);
});

test('a saved update for another release is discarded and replaced by one tap',async t=>{
 const old={id:crypto.randomUUID(),versionCode:update.versionCode-1},f=fixture(t,{info:{staged:old}});await flush();
 assert.equal(f.state().staged,undefined);const pending=f.controller.update();await flush();
 assert.deepEqual(f.cancelled,[old.id]);assert.equal(f.downloads.length,1);await f.finish();await pending;assert.deepEqual(f.handoffs(),['prepare','open:'+f.downloads[0]!.id]);
});

test('discarding the older saved update counts only visible time',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const old={id:crypto.randomUUID(),versionCode:update.versionCode-1},discarding=deferred<void>();
 const f=fixture(t,{info:{staged:old},cancel:()=>discarding.promise});await flush();const pending=f.controller.update();await flush();
 f.visible(false);t.mock.timers.tick(60_000);f.visible(true);await flush();
 discarding.resolve();await flush();assert.equal(f.state().phase,'downloading');assert.equal(f.downloads.length,1);await f.finish();await pending;
});

test('missing or failing wallet preparation prevents the handoff and keeps the verified file',async t=>{
 await assert.rejects(prepareAndroidInstall(),/cannot finish saving/);
 const unregister=registerAndroidInstallPreparation(async()=>{throw new Error('Wallet writes are still pending');});await assert.rejects(prepareAndroidInstall(),/writes are still pending/);unregister();
 const f=fixture(t,{prepare:async()=>{throw new Error('Wallet writes are still pending');}});await flush();const pending=f.controller.update();await flush();await f.finish();await pending;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/writes are still pending/);assert.deepEqual(f.handoffs(),['prepare']);assert.equal(f.state().staged?.id,f.downloads[0]!.id);
});

test('hiding during preparation fences a late flush from opening the installer',async t=>{
 const preparation=deferred<void>(),f=fixture(t,{prepare:()=>preparation.promise});await flush();const pending=f.controller.update();await flush();await f.finish();
 assert.equal(f.state().phase,'preparing');f.visible(false);preparation.resolve();await pending;
 assert.deepEqual(f.handoffs(),['prepare']);assert.equal(f.state().phase,'available');assert.equal(f.state().staged?.id,f.downloads[0]!.id);
 f.visible(true);await flush();await f.controller.update();assert.deepEqual(f.handoffs(),['prepare','prepare','open:'+f.downloads[0]!.id]);
});

test('retiring the wallet preparation owner rejects a late flush',async()=>{
 const flush=deferred<void>(),unregister=registerAndroidInstallPreparation(()=>flush.promise),preparing=prepareAndroidInstall();
 unregister();flush.resolve();await assert.rejects(preparing,/wallet changed/);
});

test('a failed handoff keeps the verified file, and Try again reopens the installer with the wallet locked',async t=>{
 const f=fixture(t);await flush();f.open(async()=>{throw new Error('Shielded was in the background, so Android did not open the installer. Try again.');});
 const pending=f.controller.update();await flush();await f.finish();await pending;
 assert.equal(f.state().phase,'failed');assert.match(f.state().error,/did not open the installer/);const staged=f.state().staged!;
 f.emit({phase:'paused',generation:2});assert.equal(f.state().networkReady,false);
 f.open(async()=>{});await f.controller.update();
 assert.equal(f.downloads.length,1);assert.deepEqual(f.handoffs(),['prepare','open:'+staged.id,'prepare','open:'+staged.id]);assert.equal(f.state().phase,'available');
});

test('a file evicted before the handoff is downloaded again once the locked wallet reconnects',async t=>{
 const f=fixture(t);await flush();const first=f.controller.update();await flush();await f.finish();await first;
 f.open(async()=>{f.setInfo({staged:undefined});throw new Error('The downloaded update is no longer on this device. Try again to download it.');});
 await f.controller.update();assert.equal(f.state().phase,'failed');assert.match(f.state().error,/no longer on this device/);assert.equal(f.state().networkReady,false);
 f.open(async()=>{});await f.controller.update();assert.equal(f.downloads.length,1);assert.match(f.state().error,/Open or reconnect your wallet/);assert.equal(f.state().staged,undefined);
 f.emit({phase:'ready',generation:4,mode:'tor'});const retry=f.controller.update();await flush();assert.equal(f.downloads.length,2);await f.finish();await retry;
 assert.equal(f.state().phase,'available');assert.equal(f.state().staged?.id,f.downloads[1]!.id);
});

test('one handoff command lines up across the capability, Rust and Kotlin, and the session installer is gone',async()=>{
 const {readFileSync}=await import('node:fs');
 const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8'),plugin='../src-tauri/plugins/shielded-platform/',platform=plugin+'android/src/main/java/io/arkade/shielded/platform/';
 const commands=['info','download','cancel','open'].map(name=>'native_android_update_'+name);
 assert.deepEqual(read('../src-tauri/build.rs').match(/native_android_update_\w+/g),commands);
 assert.deepEqual(read('../src-tauri/src/lib.rs').match(/native_android_update_\w+/g),commands);
 assert.deepEqual((JSON.parse(read('../src-tauri/capabilities/main.json')).permissions as unknown[]).filter(item=>typeof item==='string'&&item.startsWith('allow-native-android-update-')),commands.map(name=>'allow-'+name.replaceAll('_','-')));
 const rust=read('../src-tauri/src/android_updates.rs');
 assert.match(rust,/pub async fn native_android_update_open\([\s\S]*?crate::ensure_local\(&window\)\?;\s+let deadline = [^;]*?\+ HANDOFF_DEADLINE;\s+let prepared = updates\.prepared\(&id\)\?;[\s\S]*?check_candidate\([\s\S]*?android_open_update_installer\([\s\S]*?"deadline": u64::try_from\(deadline\.as_millis\(\)\)\.unwrap_or\(u64::MAX\)[\s\S]*?\.await;\s+if opened\.is_err\(\) \{\s+let _ = updates\.retire_if_missing\(&prepared\);/,'one deadline from the start of the handoff, and a failed handoff retires a stage whose file the recheck deleted');
 const deadline=Number(rust.match(/HANDOFF_DEADLINE: std::time::Duration = std::time::Duration::from_secs\((\d+)\)/)![1])*1000;
 const backstop=Number(read('../app/src/android-updates.ts').match(/bounded\(backend\.open\(staged\.id\),([\d_]+)\)/)![1].replace(/_/g,''));
 assert.ok(backstop>deadline,'the renderer outwaits the host deadline, so it never gives up on a handoff that can still open the installer');
 assert.match(read(plugin+'src/lib.rs'),/"updateOpenInstaller"/);
 const updater=read(platform+'AndroidUpdater.kt');
 assert.match(updater,/val file = AndroidUpdatePolicy\.privateApk\(directory, args\.path\)\s+(\/\/.*\s+)?try \{ verify\(file, args\) \} catch \(error: UpdateRejected\) \{ file\.delete\(\); throw error \}\s+val uri = FileProvider\.getUriForFile\(context, "\$ownPackage\.updates", file\)/);
 assert.match(updater,/setDataAndType\(uri, "application\/vnd\.android\.package-archive"\)/);
 assert.match(updater,/addFlags\(Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/);
 // The handoff must reach a preinstalled installer only; an implicit APK intent any app can claim.
 assert.match(updater,/intent\.setPackage\(systemInstaller\(intent\)\)\s+authorize \{\s+if \(AndroidUpdatePolicy\.handoffExpired\(args\.deadline, System\.currentTimeMillis\(\)\)\)\s+throw UpdateRejected\([^)]*\)\s+activity\(\)\.startActivity\(intent\)\s+\}/,'the deadline is checked on the main thread right before the installer starts');
 assert.match(updater,/\(error as\? AmbiguousUpdateAuthorization\)\?\.message/,'an installer launch that may have started keeps its own message');
 assert.match(updater,/PackageManager\.MATCH_SYSTEM_ONLY or PackageManager\.MATCH_DEFAULT_ONLY/);
 assert.match(updater,/resolved\?\.activityInfo\?\.packageName\s+\?: throw UpdateRejected\(/);
 assert.doesNotMatch(updater,/PackageInstaller|SharedPreferences|canRequestPackageInstalls|permission-required/);
 const manifest=read(plugin+'android/src/main/AndroidManifest.xml');
 assert.match(manifest,/REQUEST_INSTALL_PACKAGES/);assert.doesNotMatch(manifest,/UpdateReceiver/);
 assert.match(manifest,/<queries>[\s\S]*application\/vnd\.android\.package-archive[\s\S]*<\/queries>/);
 assert.match(manifest,/UpdateFileProvider" android:authorities="\$\{applicationId\}\.updates" android:exported="false" android:grantUriPermissions="true"/);
 assert.match(read(plugin+'android/src/main/res/xml/shielded_update_paths.xml'),/<cache-path name="shielded-updates" path="shielded-updates\/" \/>/);
 const kotlin=read(platform+'ShieldedPlatformPlugin.kt');
 assert.match(kotlin,/class UpdateArgs \{[^}]*var deadline: Long = 0[^}]*\}/,'the Rust "deadline" key reaches UpdateArgs, and 0 leaves verification unbounded');
 assert.deepEqual([...kotlin.matchAll(/@Command\s+fun (update\w+)/g)].map(match=>match[1]),['updateInfo','updateVerify','updateOpenInstaller']);
 assert.match(kotlin,/trusted\(\) && resumed\(\)/);assert.doesNotMatch(kotlin,/private var resumed/);
 assert.match(kotlin,/lifecycle\?\.currentState\?\.isAtLeast\(Lifecycle\.State\.RESUMED\)/);
});

test('the Android installer checks the folder the Rust host stages updates in',async()=>{
 const {readFileSync}=await import('node:fs');
 const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
 assert.match(read('../src-tauri/src/lib.rs'),/AndroidUpdates::new\(app\.path\(\)\.app_cache_dir\(\)\?\.join\("shielded-updates"\)\)/);
 assert.match(read('../src-tauri/plugins/shielded-platform/android/src/main/java/io/arkade/shielded/platform/AndroidUpdater.kt'),/private val directory = File\(this\.context\.cacheDir, "shielded-updates"\)/);
});
