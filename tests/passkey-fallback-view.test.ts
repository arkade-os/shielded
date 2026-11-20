import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {Children,createElement,isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {prfSupport} from '@arkade-os/sdk';
import {createLockedPageWallet,isWindowsBrowser} from '../app/src/locked-wallet.ts';
import {CREATED,offersPasskeys,passkeyNextStep,passkeyUserName} from '../app/src/shielded-page.ts';
import type {WalletOnboardingProps} from '../app/src/WalletOnboarding.tsx';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
// All a static render of RollupWallet reads from the browser.
Object.assign(globalThis,{location:{hostname:'localhost',pathname:'/wallet',hash:''},document:{hidden:false},matchMedia:()=>({matches:false})});
const {default:PasskeyFallbackSheet}=await import('../app/src/PasskeyFallbackSheet.tsx');
const {default:WalletOnboarding}=await import('../app/src/WalletOnboarding.tsx');
const {default:RollupWallet}=await import('../app/src/RollupWallet.tsx');

const NAME='Shielded wallet · Nov 20, 2026, 6:45 PM';
const BROWSER='Your passkey was saved, but it can’t make this wallet’s keys on this device. Shielded can make a recovery phrase instead and keep it in this browser, locked by this passkey. This passkey won’t restore the wallet anywhere else: only the recovery phrase can. Back it up next.';
const WARNING='On Windows, any program running on this computer can read what this passkey locks, without asking you. Only continue if you trust the programs on this computer, and back up the recovery phrase.';
type SheetProps=Parameters<typeof PasskeyFallbackSheet>[0];
const sheetProps:SheetProps={platform:'browser',windowsWarning:false,passkeyName:NAME,busy:false,onContinue:()=>{},onCancel:()=>{}};
const sheet=(props:Partial<SheetProps>={})=>renderToStaticMarkup(createElement(PasskeyFallbackSheet,{...sheetProps,...props}));
const memory=()=>{const rows=new Map<string,string>();return {getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);},key:(i:number)=>[...rows.keys()][i]??null,get length(){return rows.size;}};};
const wallet=(storage:ReturnType<typeof memory>)=>renderToStaticMarkup(createElement(RollupWallet as (props:{storage:Storage})=>ReactNode,{storage:storage as unknown as Storage}));
const onClickOf=(node:ReactNode,label:string):(()=>void)|undefined=>{
 let found:(()=>void)|undefined;
 Children.forEach(node,child=>{
  if(found||!isValidElement<{children?:ReactNode;onClick?:()=>void}>(child))return;
  found=child.type==='button'&&child.props.children===label?child.props.onClick:onClickOf(child.props.children,label);
 });
 return found;
};
const defaults:WalletOnboardingProps={transport:'browser',setup:true,busy:false,phase:'',error:'',phrase:'',onPhraseChange:()=>{},onCreate:()=>{},onRestore:()=>{},onReconnect:()=>{}};
/** Clicks during render are render-phase updates, so each click's state shows in the next pass of the same static render. */
const onboarding=(props:Partial<WalletOnboardingProps>,clicks:string[]=[])=>{
 let step=0;
 function Capture(){
  const view=WalletOnboarding({...defaults,...props}),label=clicks[step];
  if(label!==undefined){const click=onClickOf(view,label);assert.ok(click,label);step++;click();}
  return view;
 }
 return renderToStaticMarkup(createElement(Capture));
};

test('the fallback sheet says the passkey cannot restore the wallet and offers only Continue or Cancel',()=>{
 const html=sheet();
 assert.ok(html.includes(BROWSER));
 assert.deepEqual([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match=>match[1]),['Continue','Cancel']);
 assert.equal([...sheet({busy:true}).matchAll(/<button[^>]*disabled=""/g)].length,2);
 for(const [platform,lock] of [['android','this phone’s fingerprint or PIN'],['windows','this computer’s Windows Hello']] as const){
  assert.ok(sheet({platform}).includes(`Your passkey was saved, but it can’t make this wallet’s keys on this device. Shielded can make a recovery phrase instead and lock it with ${lock}. This passkey isn’t needed for it; you can delete it (“${NAME}”). Keep a screen lock on this device, and back up the recovery phrase next: it’s the only way to restore this wallet.`),platform);
 }
 let cancelled=0;
 const escape=(busy:boolean)=>{let prevented=false;(PasskeyFallbackSheet({...sheetProps,busy,onCancel:()=>{cancelled++;}}).props.onCancel as (event:{preventDefault():void})=>void)({preventDefault:()=>{prevented=true;}});return prevented;};
 assert.equal(escape(true),true);assert.equal(cancelled,0,'Escape waits while Continue runs');
 assert.equal(escape(false),true);assert.equal(cancelled,1,'Escape is Cancel, never a silent close');
 const step=passkeyNextStep(Object.assign(new Error('x'),{name:'PasskeyFallback',credentialId:new Uint8Array(16),userHandle:new Uint8Array(32),userName:NAME,wordCount:12}))!;
 assert.equal(step.retry,false);
 assert.match(step.message,/no wallet was created\. Create a wallet with a recovery phrase instead\. You can delete the passkey “Shielded wallet · Nov 20, 2026, 6:45 PM” in your passkey settings\.$/);
});

test('the Windows warning shows only on Windows',t=>{
 assert.ok(sheet({windowsWarning:true}).includes(WARNING));
 assert.ok(!sheet().includes(WARNING));
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');});
 const on=(navigator:object)=>{Object.defineProperty(globalThis,'navigator',{configurable:true,value:navigator});return isWindowsBrowser();};
 assert.equal(on({userAgentData:{platform:'Windows'},userAgent:'Mozilla/5.0'}),true);
 assert.equal(on({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'}),true,'Firefox has no userAgentData');
 assert.equal(on({userAgentData:{platform:'macOS'},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}),false);
 assert.equal(on({userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8)'}),false);
});

test('a locked browser wallet opens on the unlock screen with a way out',async()=>{
 const storage=memory();
 await createLockedPageWallet(storage,{credentialId:new Uint8Array(16).fill(1),userHandle:new Uint8Array(32).fill(2),wordCount:12});
 const html=wallet(storage),name=passkeyUserName(Number(storage.getItem(CREATED)));
 assert.match(html,/<span>Unlock your<\/span><span>wallet\.<\/span>/);
 assert.ok(html.includes(`Use the passkey “${name}” to open this wallet.`),'the screen names the passkey');
 assert.match(html,/>Unlock with passkey<\/button><button[^>]*>Use recovery phrase instead<\/button>/);
 assert.doesNotMatch(html,/Create wallet|Restore a wallet|Create with a passkey|Restore with a passkey/);
 let unlocked=0,chosen=0;const unlock={label:name,onUnlock:()=>{unlocked++;},onUsePhrase:()=>{chosen++;}};
 onboarding({unlock},['Unlock with passkey']);assert.equal(unlocked,1);
 assert.doesNotMatch(onboarding({unlock,passkey:{onCreate:()=>{},onRestore:()=>{}}}),/Create with a passkey|Restore with a passkey/,'no second wallet beside a locked one');
 const confirm=onboarding({unlock},['Use recovery phrase instead']);
 assert.ok(confirm.includes('This replaces the locked wallet on this device. Your funds are safe if this is its recovery phrase.'));
 assert.doesNotMatch(confirm,/<textarea/);assert.equal(chosen,0);
 const restore=onboarding({unlock},['Use recovery phrase instead','Enter recovery phrase']);
 assert.match(restore,/<textarea[^>]*placeholder="Enter your recovery phrase"/);assert.match(restore,/>Restore wallet<\/button>/);assert.equal(chosen,1);
 assert.match(onboarding({unlock},['Use recovery phrase instead','Back']),/>Unlock with passkey<\/button>/);
 assert.match(onboarding({unlock,transport:'tor',torHealth:{status:{phase:'ready',generation:1},check:'ok'}}),/>Unlock<\/button>/);
});

test('the passkey group shows when the PRF probe says yes or unknown, and stays off when it says no',async t=>{
 t.after(()=>{Reflect.deleteProperty(globalThis,'PublicKeyCredential');});
 const probe=(prf?:boolean)=>{Object.assign(globalThis,{PublicKeyCredential:{getClientCapabilities:async()=>prf===undefined?{}:{'extension:prf':prf}}});return prfSupport();};
 assert.deepEqual([await probe(false),await probe(true),await probe()],['no','yes','unknown']);
 assert.deepEqual((['no','yes','unknown',undefined] as const).map(offersPasskeys),[false,true,true,false]);
 assert.doesNotMatch(wallet(memory()),/Create with a passkey/,'nothing shows before the probe answers');
 const source=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8');
 assert.match(source,/useEffect\(\(\)=>\{if\(!nativeHost\)void prfSupport\(\)\.then\(setPrf\);\},\[nativeHost\]\);/);
 assert.match(source,/passkey=\{offersPasskeys\(prf\)&&!passkeyOff\?/);
});
