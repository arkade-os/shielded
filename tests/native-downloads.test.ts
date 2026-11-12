import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import decodeQR from 'qr/decode.js';
import {nativeDownloadUrl,parseNativeRelease,type NativePlatform,type NativeReleasePackage} from '../src/native-release.ts';
import type {NativeDownloadsState} from '../app/src/NativeDownloads.tsx';
import {androidUpdateFixture,nativeReleaseFixture} from './fixtures/native-release.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:/\/app\/src\/AppUpdates\.(?:tsx|js)(?:\?|$)/.test(url)?{format:'module',source:"export const AppUpdateNotice=()=> 'Update available';",shortCircuit:true}:next(url,context)});
const {NativeDownloadsContent,NativeDownloadQr,detectNativeDownloadPlatform,nativeDownloadPlatforms,loadNativeDownloads,createNativeDownloadsLoader}=await import('../app/src/NativeDownloads.tsx');
const {default:ShieldedHome}=await import('../app/src/ShieldedHome.tsx');
const commit='a'.repeat(40),tag=`native-mutinynet-${commit.slice(0,12)}-run123-attempt1`;
const formats:[NativePlatform,string,'release'|'debug',boolean][]=[
 ['windows-x86_64','.exe','release',false],['linux-x86_64','.deb','release',false],['linux-x86_64','.AppImage','release',false],
 ['macos-universal','.dmg','release',false],['macos-universal','.app.zip','release',false],
 ['android-arm64','.apk','release',true],['android-arm64','.apk','debug',false],['ios','.ipa','release',true],['ios','-simulator.app.zip','release',false],
];
const packages:NativeReleasePackage[]=formats.map(([platform,extension,profile,requiresSigning],index)=>{
 const file=`shielded-mutinynet-${platform}-${profile}-${requiresSigning?'unsigned-':''}${commit.slice(0,12)}${extension}`;
 return {platform,file,url:`https://github.com/arkade-os/shielded/releases/download/${tag}/${file}`,profile,requiresSigning,bytes:(index+1)*1_048_576,sha256:String(index).repeat(64)};
});
const release=parseNativeRelease({schema:1,channel:'native-mutinynet',network:'mutinynet',commit,buildNumber:123,version:'0.1.0',publishedAt:'2026-11-07T12:00:00Z',releaseUrl:`https://github.com/arkade-os/shielded/releases/tag/${tag}`,environment:{node:'24.22.2',rust:'1.96.0',sourceDateEpoch:1794240000,lockfileSha256:'c'.repeat(64),rustLockfileSha256:'d'.repeat(64)},packages});
const render=(value:typeof release|null)=>renderToStaticMarkup(createElement(NativeDownloadsContent,{release:value}));
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('all five install guides remain available while public downloads are unavailable',()=>{
 const html=render(null);
 assert.match(html,/id="download"/);
 assert.match(html,/Checking downloads/);
 assert.match(html,/aria-busy="true"/);
 assert.doesNotMatch(html,/Retry downloads/);
 assert.equal([...html.matchAll(/<summary>Install on /g)].length,5);
 for(const name of ['Windows','Linux','macOS','Android','iOS'])assert.ok(html.includes(`<summary>Install on ${name}`),name);
 assert.equal([...html.matchAll(/<ol>/g)].length,5);
 assert.match(html,/build from source/);
 assert.match(html,/Mutinynet test coins only/);
 assert.doesNotMatch(html,/href=""|github\.com\/[^" ]*\/actions\/|releases\/latest|releases\/download\/latest/);
 assert.equal([...html.matchAll(/class="nd-download"/g)].length,0);
});

test('failed release metadata offers an accessible retry while every install guide remains available',()=>{
 const html=renderToStaticMarkup(createElement(NativeDownloadsContent,{release:null,state:'error',onRetry:()=>{}}));
 assert.match(html,/Downloads are unavailable right now/);
 assert.match(html,/<button[^>]*type="button"[^>]*>Retry downloads<\/button>/);
 assert.match(html,/build from source/);
 assert.equal([...html.matchAll(/<summary>Install on /g)].length,5);
 assert.doesNotMatch(html,/Downloads are being prepared|Checking downloads|class="nd-download"/);
});

test('public packages keep their signing requirements and exact build identity visible',()=>{
 const html=render(release),rows=[...html.matchAll(/<article class="nd-platform"[\s\S]*?<\/article>/g)].map(match=>match[0]);
 assert.equal(rows.length,5);
 assert.match(html,/Version 0\.1\.0/);assert.match(html,/Build 123/);assert.match(html,/aaaaaaaaaaaa/);assert.match(html,/Published 2026-11-07/);
 assert.match(html,/Reproducible build inputs are pinned/);assert.match(html,/Node <code>24\.22\.2<\/code> · Rust <code>1\.96\.0<\/code>/);assert.match(html,/npm lock <code>cccccccccccc<\/code>/);
 assert.match(rows[2]!,/Unsigned and not notarized/);
 const primaryAndroid=rows[3]!.match(/<div class="nd-package-links">([\s\S]*?)<\/div>/)![1]!;
 assert.match(primaryAndroid,/Debug APK/);assert.doesNotMatch(primaryAndroid,/Unsigned release APK|unsigned/);
 assert.match(rows[3]!,/Unsigned release APK/);assert.match(rows[3]!,/development key can change/);assert.match(rows[3]!,/Keep the existing installation and its data/);
 assert.match(rows[3]!.match(/<div class="nd-platform-heading">[\s\S]*?<p>([\s\S]*?)<\/p>/)![1]!,/Debug APK signed with a development key/);
 assert.match(rows[4]!,/Device IPA \(signing required\)/);assert.match(rows[4]!,/Simulator ZIP/);assert.match(rows[4]!,/unsigned and cannot be tapped to install/);
 for(const item of packages){assert.ok(html.includes(nativeDownloadUrl(release,item)),item.file);assert.ok(!html.includes(item.url),item.file);assert.ok(html.includes(`SHA-256 ${item.sha256}`),item.file);}
 assert.equal([...html.matchAll(/>Source<\/a>/g)].length,9);
 assert.doesNotMatch(html,/href=""|\/actions\/|releases\/latest|uninstall|disable Gatekeeper|xattr/);
});

test('a legacy release remains downloadable and says its reproducibility metadata predates the current channel',()=>{
  const {environment:_,...legacy}=release, parsed=parseNativeRelease({...legacy,buildNumber:37}), html=render(parsed);
  assert.match(html,/This older release predates reproducible build metadata/);
  assert.match(html,/class="nd-download"/);
  for(const item of parsed.packages)assert.ok(html.includes(`SHA-256 ${item.sha256}`),item.file);
  assert.doesNotMatch(html,/Downloads are unavailable right now/);
});

test('Android downloads prefer the stable signed APK while preserving every legacy checksum',()=>{
 const base=nativeReleaseFixture(),update=androidUpdateFixture(base),signed=parseNativeRelease({...base,androidUpdate:update}),html=render(signed);
 const android=[...html.matchAll(/<article class="nd-platform"[\s\S]*?<\/article>/g)][3]![0],primary=android.match(/<div class="nd-package-links">([\s\S]*?)<\/div>/)![1]!;
 assert.match(primary,/Signed APK/);assert.ok(primary.includes(nativeDownloadUrl(signed,signed.androidUpdate!)));assert.doesNotMatch(primary,/Debug APK|Unsigned release APK/);
 assert.match(android.match(/<div class="nd-platform-heading">[\s\S]*?<p>([\s\S]*?)<\/p>/)![1]!,/Signed Android app with in-place updates over Tor/);
 assert.ok(html.indexOf('class="nd-package-links"')<html.indexOf('class="nd-reproducible"'),'download controls precede technical build details');
 assert.ok(android.includes(`SHA-256 ${update.sha256}`));assert.equal([...android.matchAll(/>Source<\/a>/g)].length,3);
 for(const item of signed.packages.filter(item=>item.platform==='android-arm64'))assert.ok(android.includes(`SHA-256 ${item.sha256}`));
 assert.match(android,/in-place updates/);assert.match(android,/wallet data/);assert.match(android,/Keep the existing installation and its data/);
});

test('the landing page offers visible download anchors and retains the web wallet',()=>{
 const html=renderToStaticMarkup(createElement(ShieldedHome));
 assert.match(html,/class="sh-download-nav" href="\/download#download">Download/);
 assert.match(html,/href="\/download#download">Download Shielded/);
 assert.match(html,/href="\/wallet">Open wallet/);
 assert.match(html,/Your keys stay on your device/);
 assert.doesNotMatch(html,/Your keys never leave your browser/);
});

test('the marketing header never offers a wallet update even when one is available',()=>{
 const html=renderToStaticMarkup(createElement(ShieldedHome)),header=html.match(/<header\b[\s\S]*?<\/header>/)![0];
 assert.doesNotMatch(header,/Update available|app-update-notice/);
 assert.match(header,/Open wallet/);
});

test('the dedicated downloads page starts with downloads instead of the large hero illustration',()=>{
 const html=renderToStaticMarkup(createElement(ShieldedHome,{downloadOnly:true}));
 assert.match(html,/id="download"/);assert.match(html,/sh-download-page/);
 assert.doesNotMatch(html,/class="sh-hero"|class="sh-art"/);
 assert.match(html,/href="\/#privacy"/);
});

test('download metadata uses the same-origin endpoint and the shared validated response reader',async()=>{
 const signal=new AbortController().signal;
 const fetcher=(async(input,init)=>{assert.equal(input,'/api/native/releases');assert.equal(init?.signal,signal);assert.equal(init?.cache,'no-store');assert.equal(init?.credentials,'omit');return Response.json(release);}) as typeof fetch;
 assert.deepEqual(await loadNativeDownloads(signal,fetcher),release);
 for(const response of [new Response('Unavailable',{status:503}),new Response('{'),Response.json({...release,packages:[]}),new Response('x',{headers:{'content-length':'65537'}})]){
  assert.equal(await loadNativeDownloads(signal,(async()=>response) as typeof fetch),null);
 }
 assert.equal(await loadNativeDownloads(signal,(async()=>{throw new Error('offline');}) as typeof fetch),null);
 const aborted=new AbortController();aborted.abort();
 assert.equal(await loadNativeDownloads(aborted.signal,(async(_input,init)=>{init?.signal?.throwIfAborted();throw new Error('unreachable');}) as typeof fetch),null);
});

test('failed downloads leave loading state and retry coalesces clicks until validated metadata arrives',async t=>{
 const states:NativeDownloadsState[]=[],requests:{signal:AbortSignal;result:ReturnType<typeof deferred<Response>>}[]=[];
 const loader=createNativeDownloadsLoader(state=>states.push(state),(async(_input,init)=>{const result=deferred<Response>();requests.push({signal:init!.signal!,result});return result.promise;}) as typeof fetch);t.after(()=>loader.stop());
 const first=loader.retry();assert.equal(loader.retry(),first);assert.equal(requests.length,1);assert.equal(states.at(-1)?.state,'loading');
 requests[0]!.result.reject(new Error('offline'));await first;
 assert.equal(states.at(-1)?.state,'error');
 assert.match(renderToStaticMarkup(createElement(NativeDownloadsContent,{...states.at(-1)!,onRetry:()=>{void loader.retry();}})),/Retry downloads/);
 const retry=loader.retry();assert.equal(loader.retry(),retry);assert.equal(requests.length,2);assert.equal(states.at(-1)?.state,'loading');
 assert.equal(requests[0]!.signal.aborted,false);assert.equal(requests[1]!.signal.aborted,false);
 requests[1]!.result.resolve(Response.json(release));await retry;
 assert.deepEqual(states.at(-1),{state:'ready',release});assert.doesNotMatch(renderToStaticMarkup(createElement(NativeDownloadsContent,states.at(-1)!)),/Retry downloads|unavailable right now/);
});

test('a stalled download becomes retryable at the deadline and its late response cannot replace a fresh release',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const states:NativeDownloadsState[]=[],requests:{signal:AbortSignal;result:ReturnType<typeof deferred<Response>>}[]=[];
 const loader=createNativeDownloadsLoader(state=>states.push(state),(async(_input,init)=>{const result=deferred<Response>();requests.push({signal:init!.signal!,result});return result.promise;}) as typeof fetch);t.after(()=>loader.stop());
 const first=loader.retry();t.mock.timers.tick(9_999);await flush();assert.equal(states.at(-1)?.state,'loading');
 t.mock.timers.tick(1);await first;assert.equal(requests[0]!.signal.aborted,true);assert.equal(states.at(-1)?.state,'error');
 const retry=loader.retry(),fresh=parseNativeRelease({...release,version:'0.2.0',buildNumber:124});assert.equal(requests.length,2);
 requests[1]!.result.resolve(Response.json(fresh));await retry;
 requests[0]!.result.resolve(Response.json(release));await flush();assert.deepEqual(states.at(-1),{state:'ready',release:fresh});
 t.mock.timers.tick(10_000);await flush();assert.deepEqual(states.at(-1),{state:'ready',release:fresh});
});

test('unmount aborts the active download and old callbacks cannot overwrite a remounted view',async()=>{
 const states:NativeDownloadsState[]=[],old=deferred<Response>(),current=deferred<Response>();let signal!:AbortSignal;
 const stopped=createNativeDownloadsLoader(state=>states.push(state),(async(_input,init)=>{signal=init!.signal!;return old.promise;}) as typeof fetch);
 const abandoned=stopped.retry();stopped.stop();assert.equal(signal.aborted,true);await abandoned;const count=states.length;
 await stopped.retry();assert.equal(states.length,count);
 const mounted=createNativeDownloadsLoader(state=>states.push(state),(async()=>current.promise) as typeof fetch),loaded=mounted.retry();
 current.resolve(Response.json(release));await loaded;old.resolve(Response.json({...release,version:'0.2.0',buildNumber:124}));await flush();
 assert.deepEqual(states.at(-1),{state:'ready',release});assert.equal(states.length,count+2);mounted.stop();
});

test('download detection distinguishes mobile platforms before their desktop user-agent tokens',()=>{
 const visitors:[{userAgent?:string;platform?:string;maxTouchPoints?:number},NativePlatform|undefined][]=[
  [{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',platform:'Linux armv8l'},'android-arm64'],
  [{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',platform:'iPhone'},'ios'],
  [{userAgent:'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)',platform:'iPad'},'ios'],
  [{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15',platform:'MacIntel',maxTouchPoints:5},'ios'],
  [{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)',platform:'MacIntel',maxTouchPoints:0},'macos-universal'],
  [{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',platform:'Win32'},'windows-x86_64'],
  [{userAgent:'Mozilla/5.0 (X11; Linux x86_64)',platform:'Linux x86_64'},'linux-x86_64'],
  [{platform:'Win32'},'windows-x86_64'],[{userAgent:'Mozilla/5.0 (X11; CrOS x86_64 15917)',platform:'Linux x86_64'},undefined],[{},undefined],[{userAgent:'Unknown device'},undefined],
 ];
 for(const [visitor,platform] of visitors)assert.equal(detectNativeDownloadPlatform(visitor),platform,JSON.stringify(visitor));
});

test('Other systems expands every guide with the detected platform first and collapses back to it',()=>{
 const all:NativePlatform[]=['windows-x86_64','linux-x86_64','macos-universal','android-arm64','ios'];
 for(const platform of all){
  assert.deepEqual(nativeDownloadPlatforms(platform,false),[platform]);
  const expanded=nativeDownloadPlatforms(platform,true);assert.equal(expanded[0],platform);assert.deepEqual(new Set(expanded),new Set(all));assert.equal(expanded.length,5);
  assert.deepEqual(nativeDownloadPlatforms(platform,false),[platform]);
 }
 assert.deepEqual(nativeDownloadPlatforms(undefined,false),all);assert.deepEqual(nativeDownloadPlatforms(undefined,true),all);
});

test('a known visitor sees their own packages and install guide with an accessible Other systems control',()=>{
 const html=renderToStaticMarkup(createElement(NativeDownloadsContent,{release,platform:'android-arm64'}));
 assert.equal([...html.matchAll(/<article class="nd-platform"/g)].length,1);assert.match(html,/Downloads for Android/);
 assert.match(html,/aria-expanded="false" aria-controls="nd-platforms"/);assert.match(html,/>Other systems<\/button>/);assert.match(html,/<summary>Install on Android/);
 assert.doesNotMatch(html,/<summary>Install on Windows|<summary>Install on macOS|<summary>Install on Linux|<summary>Install on iOS/);
});

test('every primary and alternative binary has an adjacent QR control, including unsigned and debug APKs',()=>{
 const base=nativeReleaseFixture(),signed=parseNativeRelease({...base,androidUpdate:androidUpdateFixture(base)}),html=render(signed);
 const all=[...signed.packages,signed.androidUpdate!];
 for(const item of all){
  const at=html.indexOf(`<a href="${nativeDownloadUrl(signed,item)}">`);assert.ok(at>=0,item.file);const end=html.indexOf('</a>',at)+4;
  assert.match(html.slice(end,end+220),/^<button[^>]*class="nd-qr-button"[^>]*aria-label="Show QR code for /,item.file);
 }
 const primary=[...html.matchAll(/<a class="nd-download" href="([^"]+)">[\s\S]*?<\/a><button[^>]*class="nd-qr-button"/g)];
 assert.equal(primary.length,8);assert.ok(primary.some(match=>match[1]===nativeDownloadUrl(signed,signed.androidUpdate!)));
 assert.equal([...html.matchAll(/class="nd-qr-button"/g)].length,18);
 assert.doesNotMatch(html,/api\.qrserver|quickchart|chart\.googleapis/);
});

function decodedDownloadQr(html:string){
 const modules=Number(/viewBox="0 0 (\d+) \d+"/.exec(html)?.[1]),path=/<path d="([^"]*)"/.exec(html)?.[1];assert.ok(modules&&path);
 const scale=4,width=modules*scale,data=new Uint8Array(width*width*4).fill(255);
 for(const module of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g))for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){
  const at=((Number(module[2])*scale+y)*width+Number(module[1])*scale+x)*4;data[at]=data[at+1]=data[at+2]=0;
 }
 return decodeQR({width,height:width,data});
}

test('each locally rendered download QR decodes to its exact validated binary URL',()=>{
 const base=nativeReleaseFixture(),signed=parseNativeRelease({...base,androidUpdate:androidUpdateFixture(base)});
 for(const item of [...signed.packages,signed.androidUpdate!]){
  const html=renderToStaticMarkup(createElement(NativeDownloadQr,{item,onClose:()=>{}}));
  assert.match(html,/<dialog[^>]*aria-labelledby="nd-qr-title"/);assert.match(html,/aria-label="Close download QR code"/);assert.ok(html.includes(`href="${item.url}"`));
  assert.equal(decodedDownloadQr(html),item.url,item.file);assert.doesNotMatch(html,/<img|https:\/\/(?:api\.qrserver|quickchart|chart\.googleapis)/);
 }
});
