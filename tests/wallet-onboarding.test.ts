import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WalletOnboardingProps} from '../app/src/WalletOnboarding.tsx';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:WalletOnboarding}=await import('../app/src/WalletOnboarding.tsx');
const defaults:WalletOnboardingProps={transport:'browser',setup:true,busy:false,phase:'',error:'',phrase:'',onPhraseChange:()=>{},onCreate:()=>{},onRestore:()=>{},onReconnect:()=>{}};
const render=(props:Partial<WalletOnboardingProps>={})=>renderToStaticMarkup(createElement(WalletOnboarding,{...defaults,...props}));

test('browser onboarding offers explicit wallet setup without advertising embedded Tor',()=>{
 const html=render();
 assert.match(html,/>Create wallet<\/button>/);
 assert.match(html,/>Restore a wallet<\/button>/);
 assert.match(html,/Your keys stay in this browser/);
 assert.match(html,/Browser connection/);
 assert.match(html,/It does not start Tor/);
 assert.doesNotMatch(html,/Tor connected|Starting Tor|Wallet traffic uses Tor|native-tor-health/);
});

test('native onboarding retains checked Tor health and its network privacy limits',()=>{
 const html=render({transport:'tor',torHealth:{status:{phase:'ready',generation:1},check:'ok'}});
 assert.match(html,/Tor connected/);
 assert.match(html,/Wallet traffic uses Tor/);
 assert.match(html,/Repeated identifiers and timing can still reveal links/);
 assert.doesNotMatch(html,/Browser connection|It does not start Tor/);
});

test('transport-specific opening screens do not promise the browser a private route',()=>{
 const browser=render({setup:false,busy:true,phase:'Opening your wallet'}),native=render({transport:'tor',setup:false,busy:true,phase:'Connecting to Tor'});
 assert.match(browser,/>Opening your<\/span>/);
 assert.doesNotMatch(browser,/private route|Unlock and reconnect|Privately\./);
 assert.match(native,/private route/);
 assert.match(native,/before any wallet traffic leaves this device/);
 assert.match(render({setup:false}),/>Reload wallet<\/button>/);
});

test('busy setup blocks both key creation and restore selection while errors stay readable',()=>{
 const html=render({busy:true,error:'Storage unavailable <retry>'});
 assert.equal([...html.matchAll(/<button[^>]*disabled=""/g)].length,2);
 assert.match(html,/role="alert">Storage unavailable &lt;retry&gt;/);
 assert.equal([...render().matchAll(/<button[^>]*disabled=""/g)].length,0);
});

test('multiple onboarding instances have distinct accessible titles and SVG definitions',()=>{
 const html=renderToStaticMarkup(createElement(Fragment,null,createElement(WalletOnboarding,defaults),createElement(WalletOnboarding,{...defaults,transport:'tor'})));
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(new Set(ids).size,ids.length);
 const titles=[...html.matchAll(/aria-labelledby="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(titles.length,2);
 for(const title of titles)assert.ok(ids.includes(title));
});
