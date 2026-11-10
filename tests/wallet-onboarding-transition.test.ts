import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WalletOnboardingProps} from '../app/src/WalletOnboarding.tsx';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:WalletOnboarding}=await import('../app/src/WalletOnboarding.tsx');
const {default:WalletEntrance}=await import('../app/src/WalletEntrance.tsx');
const defaults:WalletOnboardingProps={transport:'browser',setup:true,busy:false,phase:'',error:'',phrase:'',onPhraseChange:()=>{},onCreate:()=>{},onRestore:()=>{},onReconnect:()=>{}};
const render=(props:Partial<WalletOnboardingProps>={})=>renderToStaticMarkup(createElement(WalletOnboarding,{...defaults,...props}));

test('a ready transport keeps reconnect available without announcing wallet success',()=>{
 const html=render({transport:'tor',setup:false,busy:false,phase:'Tor connected',torHealth:{status:{phase:'ready',generation:1},check:'ok'}});
 assert.doesNotMatch(html,/wallet-onboarding-aperture|wallet-entrance-handoff/);
 assert.match(html,/Unlock and reconnect/);
 assert.doesNotMatch(html,/disabled=""/);
 assert.doesNotMatch(html,/data-opening-scene/);
});

test('a tor failure remains a recoverable error rather than an opening or success scene',()=>{
 for(const props of [
  {busy:true,phase:'Connecting to Tor'},
  {error:'Tor bootstrap failed'},
  {torHealth:{status:{phase:'bootstrapping',generation:1},check:'idle'}},
 ] as Partial<WalletOnboardingProps>[]){assert.doesNotMatch(render({transport:'tor',...props}),/data-opening-scene/);}
 const html=render({transport:'tor',setup:false,busy:false,error:'Tor bootstrap failed',torHealth:{status:{phase:'error',generation:1},check:'idle'}});
 assert.match(html,/role="alert".*Tor bootstrap failed/);
 assert.match(html,/Unlock and reconnect/);
});

test('a reconnect scene has no loading obstacle between the user and the retry action',()=>{
 const html=render({setup:false,busy:false});
 assert.match(html,/Reload wallet/);
 assert.doesNotMatch(html,/inert=""/);
});

test('the wallet entry reveals mounted wallet children with a pointer-inert shared shield handoff',()=>{
 const html=renderToStaticMarkup(createElement(WalletEntrance,null,createElement('main',null,'Your private balance')));
 assert.match(html,/Your private balance/);
 assert.match(html,/wallet-entrance-handoff/);
 assert.match(html,/wallet-onboarding-art/);
 assert.match(html,/aria-hidden="true"/);
 assert.doesNotMatch(html,/<main[^>]*(?:inert|aria-hidden)/);
 assert.match(html,/<main>Your private balance<\/main>/);
});

test('resuming a retained wallet keeps its children without replaying the entrance',()=>{
 const html=renderToStaticMarkup(createElement(WalletEntrance,{enabled:false,children:createElement('main',null,'Your private balance')}));
 assert.equal(html,'<main>Your private balance</main>');
});

test('privacy describes its separate named popover without replacing the connection status',()=>{
 const html=render();
 const controls=html.match(/summary[^>]*aria-controls="([^"]+)"/)?.[1];
 assert.ok(controls);
 assert.match(html,new RegExp(`class="wallet-onboarding-privacy-menu" id="${controls}" aria-label="About your privacy"`));
 assert.match(html,/Wallet traffic uses Tor|It does not start Tor/);
 assert.match(html,/Browser connection/);
});
