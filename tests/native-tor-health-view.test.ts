import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {NativeTorHealthState} from '../app/src/native-tor-monitor.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:NativeTorHealth,torPanelPosition}=await import('../app/src/NativeTorHealth.tsx');
const render=(health:NativeTorHealthState,transportBusy=false)=>renderToStaticMarkup(createElement(NativeTorHealth,{health,transportBusy,onToggleTor:()=>{}}));

test('the native connection panel paints above the wallet surface',()=>{
 const css=readFileSync(new URL('../app/src/native-tor-health.css',import.meta.url),'utf8');
 assert.match(css,/\.native-wallet-topbar\{[^}]*position:relative[^}]*z-index:\d+/);
 assert.match(css,/\.native-tor-panel\{[^}]*position:fixed[^}]*z-index:\d+/);
 assert.match(css,/\.native-tor-panel\{[^}]*max-width:calc\(100vw - 32px\)/);
 assert.match(css,/\.native-tor-panel\{[^}]*overflow:auto/);
 assert.match(css,/\.native-tor-panel\[data-tone=dark\]\{[^}]*background:#172a3c/);
 assert.match(css,/\.native-tor-panel\[data-tone=dark\] \.native-tor-switch\{/);
 assert.match(css,/\.stock-page\.has-sheet \.stock-backdrop\{z-index:45\}/);
 assert.match(css,/\.stock-page\.has-dock\.has-sheet \.stock-panel\{z-index:50\}/);
 assert.match(css,/\.native-sheet-open \.native-wallet-topbar\{pointer-events:none\}/);
});

test('legacy Tor status renders an accessible enabled Tor switch',()=>{
 const html=render({status:{phase:'ready',generation:1},check:'ok'});
 assert.match(html,/Tor connected/);
 assert.match(html,/class="native-tor-trigger"[^>]*aria-expanded="false"/);
 assert.match(html,/class="native-tor-panel"[^>]*hidden=""/);
 assert.match(html,/data-tone="light"/);
 assert.match(html,/role="switch" aria-checked="true"/);
 assert.match(html,/>Use Tor<\/span>/);
 assert.doesNotMatch(html,/disabled=""|Direct connection|DNS lookups are exposed/);
});

test('the onboarding connection panel keeps its dark theme when portaled',()=>{
 const html=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'ok'},tone:'dark',onToggleTor:()=>{}}));
 assert.match(html,/class="native-tor-panel"[^>]*data-tone="dark"[^>]*hidden=""/);
});

test('the connection panel stays inside a short viewport and scrolls its details',()=>{
 const above=torPanelPosition({left:24,top:500,bottom:535},{width:360,height:640},'dark');
 assert.equal(above.bottom,150);
 assert.equal(above.maxHeight,474);
 const below=torPanelPosition({left:24,top:20,bottom:54},{width:360,height:240},'light');
 assert.equal(below.top,64);
 assert.equal(below.maxHeight,160);
 const tight=torPanelPosition({left:24,top:20,bottom:54},{width:180,height:100},'light');
 assert.equal(tight.width,148);
 assert.equal(tight.top,64);
 assert.equal(tight.maxHeight,20);
});

test('direct mode always shows its warning and never claims Tor connectivity',()=>{
 const html=render({status:{phase:'ready',generation:2,mode:'direct'},check:'ok',checkedAt:12345,latencyMs:50});
 assert.match(html,/data-health="direct"/);
 assert.match(html,/Tor off · Direct connection/);
 assert.match(html,/role="switch" aria-checked="false"/);
 assert.match(html,/IP address and DNS lookups are exposed/);
 assert.match(html,/no Tor circuit isolation/);
 assert.match(html,/Last checked/);
 assert.doesNotMatch(html,/Tor connected|through Tor|Separate Tor scopes|never falls back/);
});

test('switching disables the control and direct failures keep direct-mode copy',()=>{
 const html=render({status:{phase:'ready',generation:2,mode:'direct'},check:'failed',error:'Service unavailable'},true);
 assert.match(html,/role="switch" aria-checked="false" disabled=""/);
 assert.match(html,/wallet-service check failed through the direct connection/i);
 assert.match(html,/Service unavailable/);
 assert.doesNotMatch(html,/Tor check failed|through Tor|Separate Tor scopes/);
});

test('a ready Tor transport distinguishes a failed service probe from a bootstrap failure',(t)=>{
 t.mock.timers.enable({apis:['Date'],now:0});
 const html=render({status:{phase:'bootstrapping',generation:2,progress:'42%'},check:'idle'});
 assert.match(html,/Building Tor circuits/);
 assert.match(html,/42%/);
 assert.match(html,/The first connection can take a minute/);
 const checking=render({status:{phase:'ready',generation:2},check:'checking',attempt:2});
 assert.match(checking,/Verifying private route · try 2/);
 const firstFailure=render({status:{phase:'ready',generation:2},check:'failed',attempt:1,retryAt:5_000,error:'Service unavailable'});
 assert.match(firstFailure,/data-health="connecting"/);
 assert.match(firstFailure,/Tor connected · retrying service check/);
 assert.match(firstFailure,/in about 5s automatically while Tor stays on/i);
 const failed=render({status:{phase:'ready',generation:2},check:'failed',attempt:2,retryAt:5_000,error:'Service unavailable'});
 assert.match(failed,/data-health="error"/);
 assert.match(failed,/Private route unavailable · retrying/);
 assert.match(failed,/in about 5s automatically while Tor stays on/i);
 assert.match(failed,/Service unavailable/);
 t.mock.timers.tick(6_000);
 const overdue=render({status:{phase:'ready',generation:2},check:'failed',attempt:2,retryAt:5_000,error:'Service unavailable'});
 assert.doesNotMatch(overdue,/in about/i);
});

test('a wallet-data problem reaches the connection panel, which owns the one Reconnect',()=>{
 const html=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'ok'},problem:'Bitcoin explorer could not be reached through Tor.',onReconnect:()=>{},onToggleTor:()=>{}}));
 assert.match(html,/data-health="error"/);
 assert.match(html,/Tor connected · wallet data delayed/);
 assert.match(html,/<p class="native-tor-problem">Bitcoin explorer could not be reached through Tor\.<\/p>/);
 assert.match(html,/<button class="native-tor-switch native-tor-reconnect" type="button"><span>Reconnect<\/span><span class="native-tor-reconnect-hint">New Tor circuits, wallet reopens<\/span><\/button>/);
 assert.doesNotMatch(render({status:{phase:'ready',generation:1},check:'ok'}),/native-tor-reconnect|wallet data delayed/);
 const native=readFileSync(new URL('../app/src/NativeWallet.tsx',import.meta.url),'utf8'),wallet=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8');
 assert.match(native,/<NativeTorHealth health=\{torHealth\}[^>]*onReconnect=\{reload\} problem=\{walletProblem\}/);
 assert.match(native,/onConnectionProblem=\{setWalletProblem\}/);
 assert.match(wallet,/<WalletSyncStatus [^>]*onRetry=\{nativeHost\?undefined:/,'the app keeps no second reconnect in the balance card');
});
