import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AndroidUpdateState} from '../app/src/android-updates.ts';
import {parseNativeRelease} from '../src/native-release.ts';
import {androidUpdateFixture,nativeReleaseFixture} from './fixtures/native-release.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {AndroidAppUpdateDialog}=await import('../app/src/AndroidAppUpdate.tsx');
const raw=nativeReleaseFixture(),release=parseNativeRelease({...raw,androidUpdate:androidUpdateFixture(raw)});
const defaults:AndroidUpdateState={phase:'available',release,received:0,total:50*1024*1024,networkReady:true,torReady:true,error:'',info:{packageName:'io.arkade.shielded',versionCode:100122,signerSha256:release.androidUpdate!.signerSha256,installerPackageName:null}};
const staged={id:'saved',versionCode:100123};
const render=(state:Partial<AndroidUpdateState>)=>renderToStaticMarkup(createElement(AndroidAppUpdateDialog,{state:{...defaults,...state},onClose:()=>{},onUpdate:()=>{},onCancel:()=>{}}));
const actions=(html:string)=>[...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match=>match[1]).filter(label=>label!=='Close');

test('Android update is an accessible in-app dialog with its version, build and one Update action',()=>{
 const html=render({});assert.match(html,/role="dialog" aria-modal="true"/);assert.match(html,/Shielded 0.1.0/);assert.match(html,/Build 123/);assert.match(html,/through Tor/);
 assert.deepEqual(actions(html),['Update · 0.0 MB']);assert.doesNotMatch(html,/<a\b|target=|Copy download link|uninstall/i);
});

test('every phase offers at most one primary action, and failures pair their error with Try again',()=>{
 for(const [state,expected] of [
  [{},['Update · 0.0 MB']],[{staged},['Update · 0.0 MB']],[{phase:'failed',error:'Tor download timed out'},['Try again']],
  [{phase:'downloading'},['Cancel download']],[{phase:'checking'},[]],[{phase:'preparing',staged},[]],[{phase:'blocked',error:'Google Play manages this installation.'},[]],[{phase:'idle',release:undefined},[]],
 ] as [Partial<AndroidUpdateState>,string[]][])assert.deepEqual(actions(render(state)),expected,JSON.stringify(state));
 assert.match(render({phase:'failed',error:'Tor download timed out'}),/role="alert">Tor download timed out</);
});

test('download progress shows percent, received bytes, total bytes and a cancel action',()=>{
 const html=render({phase:'downloading',received:20*1024*1024,total:50*1024*1024});
 assert.match(html,/40%/);assert.match(html,/20.0 MB of 50.0 MB/);assert.match(html,/<progress max="100" value="40" aria-label="Update download"/);assert.match(html,/Cancel download/);
});

test('with Tor off the download stays available and names both direct destinations',()=>{
 const html=render({torReady:false});assert.match(html,/<button type="button">Update/);assert.match(html,/Tor is off, so the download connects directly to the Shielded download server, or to GitHub if that server can’t provide it/);assert.doesNotMatch(html,/through Tor|<a\b/);
});

test('a connecting wallet disables a download but not a verified update, which locks the wallet first',()=>{
 const html=render({networkReady:false,torReady:false});assert.match(html,/Open or reconnect your wallet/);assert.match(html,/<button type="button" disabled="">Update/);
 const ready=render({networkReady:false,torReady:false,staged});assert.match(ready,/<button type="button">Update/);assert.match(ready,/Download verified/);assert.match(ready,/wallet will lock and finish saving/);assert.doesNotMatch(ready,/Wait for the wallet|Tor is off/);
});

test('signing conflicts protect the current installation without offering destructive workarounds',()=>{
 const html=render({phase:'blocked',error:'This installation uses a different signing key. Keep this installation and its wallet data.'});assert.match(html,/different signing key/);assert.match(html,/Keep this installation and its wallet data/);assert.doesNotMatch(html,/Update ·|Try again|uninstall|clear wallet/i);
});

test('the update dialog stays above the wallet with mobile safe areas and reduced-motion support',()=>{
 const css=readFileSync(new URL('../app/src/android-app-update.css',import.meta.url),'utf8');assert.match(css,/z-index:160/);assert.match(css,/env\(safe-area-inset-top\)/);assert.match(css,/env\(safe-area-inset-bottom\)/);assert.match(css,/max-height:calc\(100dvh/);assert.match(css,/overflow:auto/);assert.match(css,/prefers-reduced-motion:reduce/);
 const provider=readFileSync(new URL('../app/src/AppUpdates.tsx',import.meta.url),'utf8');assert.match(provider,/\{children\}\{updateOpen&&updateController/);
});

test('the desktop dialog sizes its own installer, says Shielded closes and reopens, and never mentions Android',()=>{
 const desktop=(state:Partial<AndroidUpdateState>)=>renderToStaticMarkup(createElement(AndroidAppUpdateDialog,{state:{...defaults,...state},onClose:()=>{},onUpdate:()=>{},onCancel:()=>{},desktop:true}));
 assert.deepEqual(actions(desktop({})),['Update · 50.0 MB']);assert.match(desktop({}),/Download inside Shielded through Tor\. Shielded closes, installs the update and reopens\./);
 for(const phase of ['idle','checking','available','blocked','downloading','preparing','installing','failed'] as const)assert.doesNotMatch(desktop({phase,staged}),/Android/,phase);
 assert.match(desktop({phase:'preparing',staged}),/before Shielded closes to install the update/);
 const installing=desktop({phase:'installing',staged});assert.match(installing,/Installing your update/);assert.deepEqual(actions(installing),[]);
});

test('the update dialog names the installed build beside the release it offers',()=>{
 Object.assign(globalThis,{__NATIVE_BUILD_NUMBER__:187,__APP_COMMIT__:'53aedc5c7cb6157bb23ad50efbb0e9913aa98ffe'});
 try{const html=render({});assert.match(html,/Build 123/);assert.match(html,/<p class="android-update-installed">This wallet is Build 187 · 53aedc5<\/p>/);}
 finally{delete (globalThis as Record<string,unknown>).__NATIVE_BUILD_NUMBER__;delete (globalThis as Record<string,unknown>).__APP_COMMIT__;}
 assert.doesNotMatch(render({}),/android-update-installed/);
});
