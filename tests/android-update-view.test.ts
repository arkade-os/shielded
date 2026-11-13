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
const defaults:AndroidUpdateState={phase:'available',release,received:0,total:50*1024*1024,networkReady:true,torReady:true,error:'',info:{packageName:'io.arkade.shielded',versionCode:100122,signerSha256:release.androidUpdate!.signerSha256,installerPackageName:null,canRequestInstalls:true,installStatus:'idle',installError:null}};
const render=(state:Partial<AndroidUpdateState>)=>renderToStaticMarkup(createElement(AndroidAppUpdateDialog,{state:{...defaults,...state},onClose:()=>{},onDownload:()=>{},onCancel:()=>{},onDiscard:()=>{},onPermission:()=>{},onInstall:()=>{},onConfirm:()=>{},onRefresh:()=>{}}));

test('Android update is an accessible in-app dialog with its version and build',()=>{
 const html=render({});assert.match(html,/role="dialog" aria-modal="true"/);assert.match(html,/Shielded 0.1.0/);assert.match(html,/Build 123/);assert.match(html,/Download update/);assert.match(html,/through Tor/);assert.doesNotMatch(html,/<a\b|target=|Copy download link|uninstall/i);
});

test('download progress shows percent, received bytes, total bytes and a cancel action',()=>{
 const html=render({phase:'downloading',received:20*1024*1024,total:50*1024*1024});
 assert.match(html,/40%/);assert.match(html,/20.0 MB of 50.0 MB/);assert.match(html,/<progress max="100" value="40" aria-label="Update download"/);assert.match(html,/Cancel download/);assert.doesNotMatch(html,/Install update/);
});

test('with Tor off the download stays available and names both direct destinations',()=>{
 const html=render({torReady:false});assert.match(html,/<button type="button">Download update/);assert.match(html,/Tor is off, so the download connects directly to the Shielded download server, or to GitHub if that server can’t provide it/);assert.doesNotMatch(html,/through Tor|<a\b/);
});

test('a connecting wallet disables downloading until it is ready',()=>{
 const html=render({networkReady:false,torReady:false});assert.match(html,/Wait for the wallet to connect/);assert.match(html,/<button type="button" disabled="">Download update/);
});

test('Android settings permission is a separate action and the install remains disabled',()=>{
 const html=render({phase:'ready',staged:{id:'saved',versionCode:100123},info:{...defaults.info!,canRequestInstalls:false}});
 assert.match(html,/Allow installation in Android settings/);assert.match(html,/<button type="button" disabled="">Install update/);assert.match(html,/Download verified/);assert.match(html,/wallet will lock and finish saving/);assert.match(html,/Discard downloaded update/);
});

test('verified updates install only through the explicit install action',()=>{
 const html=render({phase:'ready',staged:{id:'saved',versionCode:100123}});assert.match(html,/<button type="button">Install update/);assert.doesNotMatch(html,/Download update|Allow installation/);
 const pending=render({phase:'confirmation-required'});assert.match(pending,/Continue in Android installer/);assert.doesNotMatch(pending,/Download update|>Install update</);
 const unknown=render({phase:'unknown',error:'Installer response lost'});assert.match(unknown,/Check install status/);assert.match(unknown,/role="alert"/);assert.doesNotMatch(unknown,/Retry download|>Install update</);
});

test('signing conflicts protect the current installation without offering destructive workarounds',()=>{
 const html=render({phase:'blocked',error:'This installation uses a different signing key. Keep this installation and its wallet data.'});assert.match(html,/different signing key/);assert.match(html,/Keep this installation and its wallet data/);assert.doesNotMatch(html,/Download update|Install update|uninstall|clear wallet/i);
});

test('the update dialog stays above the wallet with mobile safe areas and reduced-motion support',()=>{
 const css=readFileSync(new URL('../app/src/android-app-update.css',import.meta.url),'utf8');assert.match(css,/z-index:160/);assert.match(css,/env\(safe-area-inset-top\)/);assert.match(css,/env\(safe-area-inset-bottom\)/);assert.match(css,/max-height:calc\(100dvh/);assert.match(css,/overflow:auto/);assert.match(css,/prefers-reduced-motion:reduce/);
 const provider=readFileSync(new URL('../app/src/AppUpdates.tsx',import.meta.url),'utf8');assert.match(provider,/\{children\}\{androidOpen&&androidController/);
});

test('the update dialog names the installed build beside the release it offers',()=>{
 Object.assign(globalThis,{__NATIVE_BUILD_NUMBER__:187,__APP_COMMIT__:'53aedc5c7cb6157bb23ad50efbb0e9913aa98ffe'});
 try{const html=render({});assert.match(html,/Build 123/);assert.match(html,/<p class="android-update-installed">This wallet is Build 187 · 53aedc5<\/p>/);}
 finally{delete (globalThis as Record<string,unknown>).__NATIVE_BUILD_NUMBER__;delete (globalThis as Record<string,unknown>).__APP_COMMIT__;}
 assert.doesNotMatch(render({}),/android-update-installed/);
});
