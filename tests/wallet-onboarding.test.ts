import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {Children,createElement,Fragment,isValidElement,type ReactNode} from 'react';
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

test('a locked native wallet and failed setup connection keep reconnect available',()=>{
 const locked=render({transport:'tor',setup:false,busy:false,phase:'Private connection paused',torHealth:{status:{phase:'paused',generation:2},check:'idle'}});
 assert.match(locked,/<button[^>]*>(?:Unlock and reconnect)<\/button>/);
 assert.doesNotMatch(locked,/<button[^>]*disabled[^>]*>Unlock and reconnect/);
 const failed=render({transport:'tor',setup:true,busy:false,torHealth:{status:{phase:'error',generation:3},check:'idle'}});
 assert.match(failed,/<button[^>]*disabled[^>]*>Create wallet/);
 assert.match(failed,/<button[^>]*>Retry connection<\/button>/);
});

test('native setup waits for a ready connection even when vault work is idle',()=>{
 const html=render({transport:'tor',phase:'Connecting to Tor',torHealth:{status:{phase:'bootstrapping',generation:1},check:'idle'}});
 assert.equal([...html.matchAll(/<button[^>]*disabled=""/g)].length,2);
 assert.match(html,/class="wallet-onboarding-phase" role="status"/);
 assert.match(html,/Connecting to Tor/);
});

test('ready direct native setup enables creation with an honest privacy warning',()=>{
 const html=render({transport:'tor',torHealth:{status:{phase:'ready',generation:2,mode:'direct'},check:'ok'},onToggleTor:()=>{}});
 assert.equal([...html.matchAll(/<button[^>]*disabled=""/g)].length,0);
 assert.match(html,/Your keys stay with you/);
 assert.match(html,/Tor off · Direct connection/);
 assert.match(html,/IP address and DNS lookups are exposed/);
 assert.match(html,/no Tor circuit isolation/);
 assert.match(html,/role="switch" aria-checked="false"/);
 assert.doesNotMatch(html,/Wallet traffic uses Tor|Your wallet connects through Tor|Separate Tor scopes/);
});

const buttons=(props:Partial<WalletOnboardingProps>)=>{
 const found:Record<string,()=>void>={};
 const walk=(node:ReactNode)=>Children.forEach(node,child=>{
  if(!isValidElement<{children?:ReactNode;onClick?:()=>void}>(child))return;
  if(child.type==='button'&&typeof child.props.children==='string'&&child.props.onClick)found[child.props.children]=child.props.onClick;
  walk(child.props.children);
 });
 function Capture(){const view=WalletOnboarding({...defaults,...props});walk(view);return view;}
 renderToStaticMarkup(createElement(Capture));return found;
};

test('browser onboarding offers passkeys as a beta beside the phrase actions, at 12 words unless asked for 24',()=>{
 const created:number[]=[];let restored=0;
 const passkey={onCreate:(words:number)=>{created.push(words);},onRestore:()=>{restored++;}};
 const html=render({passkey});
 assert.match(html,/>Create wallet<\/button><button[^>]*>Restore a wallet<\/button>\s*<div class="wallet-onboarding-passkey" role="group" aria-labelledby="([^"]+)"><p id="\1">Passkey <span>Beta<\/span><\/p>/);
 assert.match(html,/>Create with a passkey<\/button><label><input type="checkbox"\/>24-word recovery phrase instead of 12<\/label><button[^>]*>Restore with a passkey<\/button>/);
 assert.match(html,/Anyone who can use this passkey, including through the account it syncs with, can spend from this wallet\./);
 assert.doesNotMatch(render(),/passkey/i,'no passkey controls where the browser cannot use them');
 assert.equal([...render({passkey,busy:true}).matchAll(/<(?:button|input)[^>]*disabled=""/g)].length,5);
 const click=buttons({passkey});
 click['Create with a passkey']!();click['Restore with a passkey']!();
 assert.deepEqual(created,[12]);assert.equal(restored,1);
});

test('the native shell shows no passkey controls, even when given them',()=>{
 const html=render({transport:'tor',torHealth:{status:{phase:'ready',generation:1},check:'ok'},passkey:{onCreate:()=>{},onRestore:()=>{}}});
 assert.match(html,/>Create wallet<\/button><button[^>]*>Restore a wallet<\/button><\/div>/);
 assert.doesNotMatch(html,/passkey/i);
});

test('native transport changes disable creation, restore and the Tor switch',()=>{
 const html=render({transport:'tor',transportBusy:true,torHealth:{status:{phase:'ready',generation:2},check:'ok'},onToggleTor:()=>{}});
 assert.equal([...html.matchAll(/<button[^>]*disabled=""/g)].length,3);
 assert.match(html,/role="switch" aria-checked="true" disabled=""/);
});
