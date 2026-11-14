import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,type TestContext} from 'node:test';
import {Children,createElement,isValidElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {ReceivePortal,ReceiveQrButton}=await import('../app/src/wallet-receive.tsx');
const {default:NativeTorHealth,bindTorPanelDismiss}=await import('../app/src/NativeTorHealth.tsx');
const {default:WalletOnboarding,walletPrivacyPanel}=await import('../app/src/WalletOnboarding.tsx');
type Props={children?:ReactNode;className?:string;onClick?:()=>Promise<void>;[key:string]:unknown};
function find(node:ReactNode,predicate:(element:ReactElement<Props>)=>boolean):ReactElement<Props>|undefined{
 for(const child of Children.toArray(node)){
  if(!isValidElement<Props>(child))continue;
  if(predicate(child))return child;
  const nested=find(child.props.children,predicate);if(nested)return nested;
 }
}
function clipboard(t:TestContext,writeText:(text:string)=>Promise<void>){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');});
 t.mock.timers.enable({apis:['setTimeout']});
}
function qrClick(props:Parameters<typeof ReceivePortal>[0]){
 let click:(()=>Promise<void>)|undefined;
 function Capture(){
  const portal=ReceivePortal(props),qr=find(portal,node=>node.type===ReceiveQrButton);assert.ok(qr);
  const view=ReceiveQrButton(qr.props as Parameters<typeof ReceiveQrButton>[0]);
  click=find(view,node=>node.type==='button'&&node.props.className==='receive-qr-wrap')?.props.onClick;
  return view;
 }
 renderToStaticMarkup(createElement(Capture));assert.ok(click);return click;
}
const receive={mode:'unified',payload:'unified',value:'LNURL1'+('A'.repeat(70)),description:'Receive payment',onModeChange:()=>{}} as const;

test('a receive QR is a keyboard-accessible copy button while masked and invalid values expose none',()=>{
 const html=renderToStaticMarkup(createElement(ReceivePortal,receive));
 assert.match(html,/<button[^>]*class="receive-qr-wrap"[^>]*aria-label="Copy unified address from QR code"/);
 for(const props of [{value:''},{amount:'1.5'}]){
  const hidden=renderToStaticMarkup(createElement(ReceivePortal,{...receive,...props}));
  assert.doesNotMatch(hidden,/receive-qr-wrap|Copy unified address from QR code/);
 }
});

test('QR activation copies the exact encoded payload including its payment scheme and amount',async t=>{
 const copied:string[]=[];clipboard(t,async value=>{copied.push(value);});
 await qrClick(receive)();assert.equal(copied.at(-1),receive.value);
 for(const qrValue of ['lightning:alice@example.test','LIGHTNING:LNBC1EXAMPLE','bitcoin:?ark=tark_example&amount=0.00000330']){
  await qrClick({...receive,qrValue})();
  assert.equal(copied.at(-1),qrValue);
 }
});

test('inactive receive QRs cannot copy and repeated pending clicks do not duplicate writes',async t=>{
 let calls=0,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 clipboard(t,async()=>{calls++;await pending;});
 await qrClick({...receive,active:false})();assert.equal(calls,0);
 const click=qrClick(receive),first=click();await click();assert.equal(calls,1);
 release();await first;await click();assert.equal(calls,2);
});

test('denied clipboard writes are caught and the QR action remains retryable',async t=>{
 let calls=0;clipboard(t,async()=>{if(++calls===1)throw new Error('Permission denied');});
 const click=qrClick(receive);
 await assert.doesNotReject(click());await assert.doesNotReject(click());assert.equal(calls,2);
});

test('the first route verification omits its attempt suffix while later retries retain it',()=>{
 for(const attempt of [undefined,1]){
  const html=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'checking',attempt}}));
  assert.match(html,/Verifying private route/);assert.doesNotMatch(html,/try 1/);
 }
 const retry=renderToStaticMarkup(createElement(NativeTorHealth,{health:{status:{phase:'ready',generation:1},check:'checking',attempt:2}}));
 assert.match(retry,/Verifying private route · try 2/);
});

test('controlled Tor disclosure activation forwards its next state and renders the owner state',()=>{
 let owner=false,click:(()=>void)|undefined;
 function Capture(){
  const view=NativeTorHealth({open:owner,onOpenChange:open=>{owner=open;}});
  click=find(view,node=>node.type==='button'&&node.props.className==='native-tor-trigger')?.props.onClick;
  return view;
 }
 assert.match(renderToStaticMarkup(createElement(Capture)),/aria-expanded="false"/);assert.ok(click);click();
 assert.equal(owner,true);assert.match(renderToStaticMarkup(createElement(Capture)),/aria-expanded="true"/);click!();assert.equal(owner,false);
});

test('opening either privacy panel replaces the other and stale close events preserve the new owner',()=>{
 let owner:Parameters<typeof walletPrivacyPanel>[0]=null;
 for(const [first,second]of [['tor','privacy'],['privacy','tor']] as const){
  owner=walletPrivacyPanel(null,{panel:first,open:true});
  owner=walletPrivacyPanel(owner,{panel:second,open:true});assert.equal(owner,second);
  owner=walletPrivacyPanel(owner,{panel:first,open:false});assert.equal(owner,second);
  owner=walletPrivacyPanel(owner,{panel:second,open:false});assert.equal(owner,null);
 }
});

test('onboarding privacy activation delegates native summary toggling to its disclosure owner',()=>{
 let summary:ReactElement<Props>|undefined;
 function Capture(){
  const view=WalletOnboarding({transport:'browser',setup:true,busy:false,phase:'',error:'',phrase:'',onPhraseChange:()=>{},onCreate:()=>{},onRestore:()=>{},onReconnect:()=>{}});
  summary=find(view,node=>node.type==='summary');return view;
 }
 renderToStaticMarkup(createElement(Capture));assert.ok(summary?.props.onClick);
 let prevented=false;(summary.props.onClick as unknown as (event:{preventDefault:()=>void})=>void)({preventDefault:()=>{prevented=true;}});
 assert.equal(prevented,true);assert.equal(summary.props['aria-expanded'],false);
});

test('Tor panel dismissal handles portaled content, outside pointers, Escape and listener cleanup',()=>{
 const events=new EventTarget(),host={},panel={};let closed=0,focused=0;
 const dispose=bindTorPanelDismiss(events,target=>target===host||target===panel,()=>closed++,()=>focused++);
 const dispatch=(type:string,target:unknown,key?:string)=>{const event=new Event(type);Object.defineProperties(event,{target:{value:target},key:{value:key}});events.dispatchEvent(event);};
 dispatch('pointerdown',host);dispatch('pointerdown',panel);assert.equal(closed,0);
 dispatch('keydown',panel,'Enter');assert.equal(closed,0);
 dispatch('pointerdown',{});assert.equal(closed,1);assert.equal(focused,0);
 dispatch('keydown',panel,'Escape');assert.equal(closed,2);assert.equal(focused,1);
 dispose();dispatch('pointerdown',{});dispatch('keydown',panel,'Escape');assert.equal(closed,2);assert.equal(focused,1);
});

test('Paste reads the Android clipboard through the platform plugin, and Send keeps its sheet and spinner until the payment starts',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
 const wallet=source('../app/src/RollupWallet.tsx');
 assert.match(wallet,/__NATIVE_PLATFORM__\.startsWith\('android'\)\?await invoke<string\|null>\('plugin:shielded-platform\|clipboard_text'\):navigator\.clipboard\.readText\(\)/);
 assert.match(source('../src-tauri/plugins/shielded-platform/build.rs'),/"clipboard_text"/);
 assert.match(source('../src-tauri/capabilities/main.json'),/"shielded-platform:allow-clipboard-text"/);
 assert.match(source('../src-tauri/plugins/shielded-platform/android/src/main/java/io/arkade/shielded/platform/ShieldedPlatformPlugin.kt'),/fun clipboardText\(invoke: Invoke\)/);
 const submit=/const submit=\(\)=>\{if\(quote\)\{([\s\S]*?)\},routeCopy/.exec(wallet)?.[1]??'';
 assert.doesNotMatch(submit.split('try{')[0]!,/setSheetOpen\(false\)/,'the sheet does not close before the payment is prepared');
 assert.match(submit,/\}finally\{if\(mounted\.current\)setSheetOpen\(false\);\}/);
 assert.match(wallet,/aria-busy=\{busy\|\|quoting\}>\{busy\|\|quoting\?<><span className="stock-spinner" aria-hidden="true"\/>/);
});
