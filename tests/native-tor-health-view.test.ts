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
 assert.match(css,/\.native-tor-health\{[^}]*position:relative[^}]*z-index:\d+/);
 assert.match(css,/\.native-tor-panel\{[^}]*position:fixed[^}]*z-index:\d+/);
 assert.match(css,/\.native-tor-panel\{[^}]*max-width:calc\(100vw - 32px\)/);
 assert.match(css,/\.native-tor-panel\{[^}]*overflow:auto/);
 assert.match(css,/\.native-tor-panel\[data-tone=dark\]\{[^}]*background:#172a3c/);
 assert.match(css,/\.native-tor-panel\[data-tone=dark\] \.native-tor-switch\{/);
 assert.match(css,/\.stock-page\.has-sheet \.stock-backdrop\{z-index:45\}/);
 assert.match(css,/\.stock-page\.has-dock\.has-sheet \.stock-panel\{z-index:50\}/);
 const wallet=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8'),native=readFileSync(new URL('../app/src/NativeWallet.tsx',import.meta.url),'utf8');
 assert.match(wallet,/<main className="stock-shell"><header className="stock-header"><WalletBrand [^\n]*?\/><div className="app-header-status">\{headerControls\}<AppUpdateNotice\/>\{!headerControls&&<WalletHeaderActions /,'the controls take About\'s place in the page header, which goes inert behind an open sheet; the brand still opens About');
 assert.doesNotMatch(native+css,/native-wallet-topbar/);
});

test('the compact header control is an icon whose name, live text and badge carry each connection state',()=>{
 for(const [health,state,text] of [
  [{status:{phase:'ready',generation:1},check:'ok'},'connected','Tor connected'],
  [{status:{phase:'bootstrapping',generation:1,progress:'42%'},check:'idle'},'connecting','Building Tor circuits'],
  [{status:{phase:'error',generation:1},check:'idle'},'error','Tor unavailable'],
  [{status:{phase:'ready',generation:1,mode:'direct'},check:'ok'},'direct','Tor off · Direct connection'],
  [{status:{phase:'paused',generation:1},check:'idle'},'paused','Tor paused'],
 ] as const){
  const html=renderToStaticMarkup(createElement(NativeTorHealth,{health,compact:true,onToggleTor:()=>{},onReconnect:()=>{}}));
  assert.match(html,new RegExp(`data-health="${state}" data-compact="true"`),state);
  assert.match(html,new RegExp(`class="native-tor-trigger" aria-label="Wallet connection: ${text}"`),state);
  assert.match(html,new RegExp(`<span class="native-tor-live" role="status" aria-live="polite">${text}`),state);
  assert.match(html,/>Use Tor<\/span>/);assert.match(html,/<span>Reconnect<\/span>/);
 }
 const delayed=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'ok'},compact:true,problem:'Explorer unreachable'}));
 assert.match(delayed,/data-health="error"/);assert.match(delayed,/aria-label="Wallet connection: Tor connected · wallet data delayed"/);
 const css=readFileSync(new URL('../app/src/native-tor-health.css',import.meta.url),'utf8');
 assert.match(css,/\.native-wallet-controls \.native-tor-trigger,\.native-wallet-controls \.native-wallet-lock\{[^}]*width:44px;height:44px/);
 assert.match(readFileSync(new URL('../app/src/NativeWallet.tsx',import.meta.url),'utf8'),/<button className="native-wallet-lock" type="button" aria-label="Lock wallet"[^>]*onClick=\{\(\)=>\{manualLock\.current=true;setConfirmDirect\(false\);void pause\(\);\}\}>/);
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
 assert.match(native,/<NativeTorHealth health=\{torHealth\}[^>]*onReconnect=\{walletConnection\?\.reconnect\} reconnectBusy=\{walletConnection\?\.busy\} problem=\{walletConnection\?\.problem\}/);
 assert.match(native,/onConnection=\{setWalletConnection\}/);
 assert.match(wallet,/<WalletSyncStatus [^>]*onRetry=\{nativeHost\?undefined:/,'the app keeps no second reconnect in the balance card');
 assert.match(wallet,/reconnect:\(\)=>\{if\(!busyRef\.current&&!handleBusy\.current&&!actions\.current\?\.busy\)reload\(\);\}/,'a payment or exit in flight keeps the wallet open');
 const busy=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'ok'},onReconnect:()=>{},reconnectBusy:true}));
 assert.match(busy,/<button class="native-tor-switch native-tor-reconnect" type="button" disabled=""><span>Reconnect<\/span><span class="native-tor-reconnect-hint">After the payment in progress<\/span>/);
});
