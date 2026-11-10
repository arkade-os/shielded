import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import {WalletBrand,WalletHeaderActions} from '../app/src/WalletHeaderActions.tsx';
import {WalletCreatedNotice,WalletSecurityMenu} from '../app/src/WalletSecurityMenu.tsx';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:NativeAbout}=await import('../app/src/NativeAbout.tsx');

test('the native About control never navigates back through the app entry point',()=>{
 const html=renderToStaticMarkup(createElement(WalletHeaderActions,{native:true,onAbout:()=>{}}));
 assert.match(html,/<button[^>]*>About<\/button>/);
 assert.doesNotMatch(html,/href=/);
});

test('the native brand opens About in place instead of reloading the wallet route',()=>{
 const html=renderToStaticMarkup(createElement(WalletBrand,{native:true,onAbout:()=>{}}));
 assert.match(html,/<button[^>]*class="stock-brand"[^>]*>Shielded<span>wallet<\/span><\/button>/);
 assert.doesNotMatch(html,/href=/);
});

test('a loaded wallet offers clearing but not restoring another wallet',()=>{
 const html=renderToStaticMarkup(createElement(WalletSecurityMenu,{canReveal:true,canClear:true,onOpen:()=>{}}));
 assert.match(html,/Recovery phrase/);
 assert.match(html,/Clear wallet/);
 assert.doesNotMatch(html,/Restore wallet/);
});

test('clear is unavailable where the host cannot delete its vault',()=>{
 const html=renderToStaticMarkup(createElement(WalletSecurityMenu,{canReveal:false,canClear:false,onOpen:()=>{}}));
 assert.doesNotMatch(html,/Clear wallet|Restore wallet/);
 assert.match(html,/Viewing access/);
});

test('About renders as a modal dialog rather than a route',()=>{
 const html=renderToStaticMarkup(createElement(NativeAbout,{onClose:()=>{}}));
 assert.match(html,/role="dialog" aria-modal="true"/);
 assert.match(html,/Your keys stay with you/);
 assert.match(html,/uses Tor by default, and Tor can be turned off/);
 assert.doesNotMatch(html,/Wallet controls|Clear this wallet|Clear wallet…/);
 assert.doesNotMatch(html,/href=/);
});

test('a wallet without a creation timestamp renders no stray zero',()=>{
 assert.equal(renderToStaticMarkup(createElement(WalletCreatedNotice,{created:0})),'');
 assert.match(renderToStaticMarkup(createElement(WalletCreatedNotice,{created:Date.UTC(2026,10,10)})),/Created .*2026/);
});

test('the About dialog scrolls inside a short viewport',()=>{
 const css=readFileSync(new URL('../app/src/native-about.css',import.meta.url),'utf8');
 assert.match(css,/\.native-about\{[^}]*max-height:calc\(100dvh - 48px\)[^}]*overflow-y:auto/);
});
