import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {NATIVE_FOREGROUND_HOLD,NATIVE_MODE,nativeForegroundHold,openNativeVault,rememberedNativeMode,reopenNativeForeground,resumeNativeForeground} from '../app/src/native-open.ts';
import {createNativeViewHandoff} from '../app/src/native-view-handoff.ts';

test('native-only interruption retires a first opening candidate before reconstructing it',async()=>{
 const handoff=createNativeViewHandoff<{id:number}>(),calls:string[]=[];
 const old=handoff.stage({id:1},{awaitReady:true});old.onShutdown(async()=>{calls.push('shutdown');});
 assert.equal(handoff.promote(old,()=>false),false);
 await resumeNativeForeground(Promise.resolve(),()=>true,()=>reopenNativeForeground(handoff.snapshot,()=>true,async()=>{
  for(const view of handoff.retire(true))await view.shutdown?.();
 },async()=>{calls.push('open');handoff.stage({id:2},{awaitReady:true});}),async()=>false);
 assert.equal(old.retired,true);assert.equal(handoff.snapshot.candidate?.session.id,2);assert.deepEqual(calls,['shutdown','open']);
 assert.equal(handoff.promote(old,()=>true),false);
});

test('a lock while an interrupted candidate drains prevents a replacement open',async()=>{
 let finish!:()=>void,current=true,opens=0;
 const retiring=new Promise<void>(resolve=>{finish=resolve;});
 const resumed=reopenNativeForeground({candidate:{}},()=>current,()=>retiring,async()=>{opens++;});
 current=false;finish();await resumed;assert.equal(opens,0);
});
import {NativeBridge} from '../src/native/transport.ts';
import {NativePolicy} from '../src/native/policy.ts';
import type {NativeStatus} from '../src/native/transport.ts';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
test('an empty vault still starts Tor before showing native setup',async()=>{
 const calls:string[]=[];
 const opened=await openNativeVault(async()=>{calls.push('Tor');return {phase:'ready',generation:1};},async()=>{calls.push('vault');return null;},()=>true);
 assert.deepEqual(calls,['Tor','vault']);assert.deepEqual(opened,{status:{phase:'ready',generation:1},secret:null});
});
test('pausing during bootstrap prevents the vault read and wallet publication',async()=>{
 const started=deferred<NativeStatus>();let current=true,reads=0;
 const opened=openNativeVault(()=>started.promise,async()=>{reads++;return 'secret';},()=>current);
 current=false;started.resolve({phase:'ready',generation:1});assert.equal(await opened,undefined);assert.equal(reads,0);
});
test('a retired vault read cannot publish a native wallet',async()=>{
 const secret=deferred<string|null>();let current=true;
 const opened=openNativeVault(async()=>({phase:'ready',generation:1}),()=>secret.promise,()=>current);
 await Promise.resolve();current=false;secret.resolve('secret');assert.equal(await opened,undefined);
});
test('a failed Tor bootstrap cannot read the vault',async()=>{
 let reads=0;
 await assert.rejects(openNativeVault(async()=>({phase:'error',generation:1,error:'Tor unavailable'}),async()=>{reads++;return null;},()=>true),/Tor unavailable/);
 assert.equal(reads,0);
});

test('the vault is read only for the requested mode and a new generation',async()=>{
 for(const [status,opens] of [
  [{phase:'ready',generation:2},'blocked'],
  [{phase:'ready',generation:3,mode:'direct'},'blocked'],
  [{phase:'ready',generation:3},'opens'],
 ] as [NativeStatus,'opens'|'blocked'][]){
  const expected={generation:3,mode:'tor' as const,current:()=>true};
  let reads=0;
  const opened=await openNativeVault(async()=>status,async()=>{reads++;return 'secret';},()=>true,expected);
  assert.equal(reads,opens==='opens'?1:0);
  assert.equal(opened?.secret,opens==='opens'?'secret':undefined);
 }
});

test('a vault connection retired while reading cannot publish setup or a wallet',async()=>{
 const secret=deferred<string|null>();let healthy=true;
 const expected={generation:3,mode:'tor' as const,current:()=>healthy};
 const opened=openNativeVault(async()=>({phase:'ready',generation:3}),()=>secret.promise,()=>true,expected);
 await Promise.resolve();healthy=false;secret.resolve(null);
 assert.equal(await opened,undefined);
 healthy=true;
 assert.deepEqual(await openNativeVault(async()=>({phase:'ready',generation:3}),async()=>null,()=>true,expected),{status:{phase:'ready',generation:3},secret:null});
});

test('opening accepts the generation created by native start rather than the paused generation',async()=>{
 let generation=2;
 const bridge=new NativeBridge({invoke:async()=>({phase:'ready',generation:++generation}),channel:()=>{}},new NativePolicy('https://pool.example'));
 bridge.current={phase:'paused',generation};
 const opened=await openNativeVault(()=>bridge.start(),async()=>null,()=>true,{mode:'tor',current:()=>true});
 assert.equal(opened?.status.generation,3);assert.equal(opened.secret,null);
});

test('a replaced renderer opens the live direct session instead of restarting Tor',async()=>{
 const modes:unknown[]=[];
 const bridge=new NativeBridge({invoke:async(command,args)=>{
  if(command!=='native_start')return {phase:'ready',generation:7,mode:'direct'};
  modes.push(args?.mode);return {phase:'ready',generation:7,mode:args?.mode};
 },channel:()=>{}},new NativePolicy('https://pool.example'));
 const mode=await bridge.hostMode(),current=()=>true;
 const opened=await openNativeVault(()=>bridge.start(mode),async()=>'secret',current,{mode,current});
 assert.deepEqual(modes,['direct']);
 assert.equal(opened?.status.generation,7);assert.equal(opened.secret,'secret');
});

test('a visible renderer whose host still reports the background explains the wait',()=>{
 const waiting={visible:true,live:false,paused:false};
 for(const phase of ['paused','error','locked','bootstrapping','ready']){
  assert.equal(nativeForegroundHold({phase,generation:2,foreground:false},waiting),NATIVE_FOREGROUND_HOLD,phase);
 }
 assert.match(NATIVE_FOREGROUND_HOLD,/Switch to another app and back/);
 assert.doesNotMatch(NATIVE_FOREGROUND_HOLD,/native_|WindowEvent|Tauri|generation|webview|suspend/i);
 const held:[string,Parameters<typeof nativeForegroundHold>[1],NativeStatus][]=[
  ['a working wallet is not alarmed',{...waiting,live:true},{phase:'ready',generation:2,foreground:false}],
  ['a hidden renderer keeps the paused copy',{...waiting,visible:false},{phase:'paused',generation:2,foreground:false}],
  ['a deliberate lock or reset stays quiet',{...waiting,paused:true},{phase:'paused',generation:2,foreground:false}],
  ['a foreground host needs no excuse',waiting,{phase:'paused',generation:2,foreground:true}],
  ['a host that reports no foreground field is not Android',waiting,{phase:'paused',generation:2}],
 ];
 for(const [why,state,status] of held)assert.equal(nativeForegroundHold(status,state),undefined,why);
 assert.equal(nativeForegroundHold(undefined,waiting),undefined);
 // Reconnect routes through open(), so its guard must explain itself and still refuse to start.
 const native=readFileSync(new URL('../app/src/NativeWallet.tsx',import.meta.url),'utf8');
 assert.match(native,/if\(!pageForeground\(\)\|\|!nativeForeground\.current\)\{setBusy\(false\);setPhase\(!pageForeground\(\)\?'Private connection paused':NATIVE_FOREGROUND_HOLD\);return Promise\.resolve\(\);\}/);
 assert.match(native,/const held=nativeForegroundHold\(health\.status,\{visible:pageForeground\(\),live:!!liveShown\(\),paused:manualLock\.current\|\|clearing\.current\}\);\s*if\(held\)\{setBusy\(false\);setPhase\(held\);\}/);
 assert.match(native,/onReconnect=\{\(\)=>\{if\(transition\.current\|\|creating\.current\)return;manualLock\.current=false;void \(resetPending\?finishReset\(\):open\(\)\);\}\}/,'reconnect gains no path around the latch');
});

test('a cold launch that prewarmed Tor opens the remembered Tor-off choice',async()=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null};
 assert.equal(rememberedNativeMode(storage),'tor');
 rows.set(NATIVE_MODE,'direct');assert.equal(rememberedNativeMode(storage),'direct');
 rows.set(NATIVE_MODE,'bogus');assert.equal(rememberedNativeMode(storage),'tor');
 rows.set(NATIVE_MODE,'direct');const modes:unknown[]=[];
 const bridge=new NativeBridge({invoke:async(command,args)=>{
  if(command!=='native_start')return {phase:'bootstrapping',generation:1,mode:'tor'};
  modes.push(args?.mode);return {phase:'ready',generation:2,mode:args?.mode};
 },channel:()=>{}},new NativePolicy('https://pool.example'));
 const mode=await bridge.hostMode(rememberedNativeMode(storage)),current=()=>true;
 const opened=await openNativeVault(()=>bridge.start(mode),async()=>'secret',current,{mode,current});
 assert.deepEqual(modes,['direct']);assert.equal(opened?.status.mode,'direct');
});

test('the native wallet remembers the chosen mode and adopts it before its first start',()=>{
 const native=readFileSync(new URL('../app/src/NativeWallet.tsx',import.meta.url),'utf8');
 assert.match(native,/const selectedMode=useRef<NativeMode\|undefined>\(undefined\)/);
 assert.match(native,/const mode=selectedMode\.current\?\?=await nativeNetwork\.hostMode\(rememberedNativeMode\(localStorage\)\);/);
 assert.match(native,/selectedMode\.current=mode;localStorage\.setItem\(NATIVE_MODE,mode\);await open\(\);/);
 assert.match(native,/const status=await nativeNetwork\.start\(mode\);/);
 assert.match(native,/onConfirm=\{\(\)=>void switchMode\('direct'\)\}/,'Tor off still needs the confirmation');
 assert.doesNotMatch(native,/useRef<NativeMode>\('tor'\)/);
});

test('foreground waits for a delayed retired start and then opens one fresh generation',async()=>{
 const first=deferred<NativeStatus>();let generation=0,starts=0,reads=0,revision=0,visible=true;
 const bridge=new NativeBridge({invoke:async command=>{
  if(command==='native_pause')return {phase:'paused',generation:++generation};
  const status={phase:'ready',generation:++generation};return ++starts===1?first.promise:status;
 },channel:()=>{}},new NativePolicy('https://pool.example'));
 const published:number[]=[];
 const open=async()=>{
  const mine=++revision,current=()=>visible&&mine===revision;
  const opened=await openNativeVault(()=>bridge.start(),async()=>{reads++;return 'secret';},current,{mode:'tor',current});
  if(opened)published.push(opened.status.generation);
 };
 const opening=open();visible=false;revision++;
 const closing=Promise.all([bridge.pause(),opening]);
 visible=true;const resumeRevision=revision;
 const resumed=resumeNativeForeground(closing,()=>visible&&revision===resumeRevision,open);
 await Promise.resolve();assert.equal(starts,1);assert.equal(reads,0);
 first.resolve({phase:'ready',generation:1});await resumed;
 assert.equal(starts,2);assert.equal(reads,1);assert.deepEqual(published,[3]);
});

test('a second hide and show retires the first queued foreground resume',async()=>{
 const pending=deferred<void>();let revision=1,visible=true,starts=0;
 const resume=()=>{const mine=revision;return resumeNativeForeground(pending.promise,()=>visible&&revision===mine,async()=>{starts++;});};
 const first=resume();visible=false;revision++;visible=true;const latest=resume();
 pending.resolve();await Promise.all([first,latest]);assert.equal(starts,1);
});

test('locking or hiding before pending cleanup settles cannot restart the network',async()=>{
 for(const action of ['hide','lock']){
  const pending=deferred<void>();let visible=true,locked=false,starts=0;
  const resumed=resumeNativeForeground(pending.promise,()=>visible&&!locked,async()=>{starts++;});
  if(action==='hide')visible=false;else locked=true;
  pending.resolve();await resumed;assert.equal(starts,0);
 }
});

test('a delayed empty vault cannot publish setup after hide and show retires its opening',async()=>{
 const secret=deferred<string|null>();let revision=0,visible=true,reads=0,generation=0;
 const published:{generation:number;secret:string|null}[]=[];
 const open=async()=>{
  const mine=++revision,current=()=>visible&&mine===revision;
  const opened=await openNativeVault(async()=>({phase:'ready',generation:++generation}),()=>++reads===1?secret.promise:Promise.resolve(null),current,{mode:'tor',current});
  if(opened)published.push({generation:opened.status.generation,secret:opened.secret});
 };
 const opening=open();await Promise.resolve();visible=false;revision++;visible=true;
 const mine=revision,resumed=resumeNativeForeground(opening,()=>visible&&mine===revision,open);
 secret.resolve(null);await resumed;
 assert.equal(reads,2);assert.deepEqual(published,[{generation:2,secret:null}]);
});

test('returning to the same live wallet reconciles it without reopening the vault or network',async()=>{
 let starts=0,checks=0;
 await resumeNativeForeground(Promise.resolve(),()=>true,async()=>{starts++;},async()=>{checks++;return true;});
 assert.equal(checks,1);assert.equal(starts,0);
});

test('locking during foreground reconciliation cannot open a replacement wallet',async()=>{
 const status=deferred<boolean>();let current=true,starts=0;
 const resumed=resumeNativeForeground(Promise.resolve(),()=>current,async()=>{starts++;},()=>status.promise);
 await Promise.resolve();current=false;status.resolve(false);await resumed;
 assert.equal(starts,0);
});
