import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {NativeTorHealthState} from '../app/src/native-tor-monitor.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:NativeTorHealth}=await import('../app/src/NativeTorHealth.tsx');
const render=(health:NativeTorHealthState,transportBusy=false)=>renderToStaticMarkup(createElement(NativeTorHealth,{health,transportBusy,onToggleTor:()=>{}}));

test('the native connection panel paints above the wallet surface',()=>{
 const css=readFileSync(new URL('../app/src/native-tor-health.css',import.meta.url),'utf8');
 assert.match(css,/\.native-wallet-topbar\{[^}]*position:relative[^}]*z-index:\d+/);
 assert.match(css,/\.native-tor-panel\{[^}]*z-index:\d+/);
});

test('legacy Tor status renders an accessible enabled Tor switch',()=>{
 const html=render({status:{phase:'ready',generation:1},check:'ok'});
 assert.match(html,/Tor connected/);
 assert.match(html,/class="native-tor-trigger"[^>]*aria-expanded="false"/);
 assert.match(html,/class="native-tor-panel"[^>]*hidden=""/);
 assert.match(html,/role="switch" aria-checked="true"/);
 assert.match(html,/>Use Tor<\/span>/);
 assert.doesNotMatch(html,/disabled=""|Direct connection|DNS lookups are exposed/);
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
 assert.match(html,/direct connection check failed/);
 assert.match(html,/Service unavailable/);
 assert.doesNotMatch(html,/Tor check failed|through Tor|Separate Tor scopes/);
});
