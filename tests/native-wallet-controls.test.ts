import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import {WalletHeaderActions} from '../app/src/WalletHeaderActions.tsx';
import {WalletSecurityMenu} from '../app/src/WalletSecurityMenu.tsx';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:NativeAbout}=await import('../app/src/NativeAbout.tsx');

test('the native About control never navigates back through the app entry point',()=>{
 const html=renderToStaticMarkup(createElement(WalletHeaderActions,{native:true,onAbout:()=>{}}));
 assert.match(html,/<button[^>]*>About<\/button>/);
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
 assert.doesNotMatch(html,/href=/);
});
