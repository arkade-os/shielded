import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Children,createElement,isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {registerHooks} from 'node:module';
import {payTarget} from '../app/src/rollup-client.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {ReceivePortal,amountQrValue,receiveAmount,invoiceRequestAmount}=await import('../app/src/wallet-receive.tsx');
const recipients=[
 ['shielded','shrol_example','shielded','shrol_example'],
 ['arkade','tark_example','ark','tark_example'],
] as const;
const amounts=[
 ['1','0.00000001'],
 ['12','0.00000012'],
 ['330','0.00000330'],
 ['12345678','0.12345678'],
 ['100000000','1.00000000'],
 ['9999999999','99.99999999'],
] as const;

test('the shared amount form covers every receive tab',()=>{
 for(const mode of ['unified','shielded','arkade'] as const){
  const rendered=renderToStaticMarkup(createElement(ReceivePortal,{mode,payload:mode,value:'placeholder',description:'Test receive',amount:'330',onAmount:()=>{},onModeChange:()=>{}}));
  assert.match(rendered,/aria-label="Receive amount in sats"/);
 }
});

test('without unified, the portal offers shielded and arkade only',()=>{
 const tabs=(unified?:boolean)=>{const rendered=renderToStaticMarkup(createElement(ReceivePortal,{...(unified===undefined?{}:{unified}),mode:'shielded',payload:'shielded',value:'shrol_example',description:'Test receive',onModeChange:()=>{}}));return [[...rendered.matchAll(/id="receive-tab-(\w+)"/g)].map(m=>m[1]),/--glass-count:(\d)/.exec(rendered)?.[1]];};
 assert.deepEqual(tabs(false),[['shielded','arkade'],'2']);
 assert.deepEqual(tabs(),[['unified','shielded','arkade'],'3']);
});

test('the receive strip lays out one column per offered tab, as its lens does',()=>{
 const pill=/\.receive-pill\{[^}]*\}/.exec(readFileSync(new URL('../app/src/wallet-receive.css',import.meta.url),'utf8'))?.[0]??'';
 assert.match(pill,/grid-template-columns:repeat\(var\(--glass-count,3\),minmax\(0,1fr\)\)/);
});

test('payment URIs encode exact sats as eight decimal BTC amounts',()=>{
 for(const [mode,address,parameter]of recipients){
  for(const [amount,btc]of amounts){
   assert.equal(amountQrValue(mode,address,amount),`bitcoin:?${parameter}=${address}&amount=${btc}`);
  }
 }
});

test('empty, zero, invalid and noninteger amounts do not produce an amount QR',()=>{
 for(const [mode,address]of recipients){
  for(const amount of ['','0','00','01','-1','+1','1.5','1e3','1,000',' 330','330 ','abc','NaN','Infinity']){
   assert.equal(amountQrValue(mode,address,amount),undefined,`${mode}: ${JSON.stringify(amount)}`);
  }
 }
});

test('invalid receive input stays visible and cannot expose a plain-address QR or copy control',()=>{
 for(const [mode,address]of [['unified','alice@lnurl.example'],...recipients] as const)for(const amount of ['1.5','01','0','-1','1e3','1,000','10000000000']){
  const rendered=renderToStaticMarkup(createElement(ReceivePortal,{mode,payload:mode,value:address,description:'Test receive',amount,onAmount:()=>{},onModeChange:()=>{},action:createElement('button',{},'Copy Lightning address')}));
  assert.ok(rendered.includes(`value="${amount}"`));
  assert.match(rendered,/aria-invalid="true"/);
  assert.match(rendered,/aria-describedby="receive-amount-error"/);
  assert.match(rendered,/id="receive-amount-error"[^>]*role="alert"/);
  assert.doesNotMatch(rendered,/class="stock-qr"|Copy address|Copy Lightning address|receive-share/);
  assert.equal(receiveAmount(amount),undefined);
 }
});

test('the receive input passes pasted text to validation without rewriting it',()=>{
 type Change=(event:{target:{value:string}})=>void;
 const findInput=(node:ReactNode):Change|undefined=>{
  for(const child of Children.toArray(node)){
   if(!isValidElement<{children?:ReactNode;onChange?:Change}>(child))continue;
   if(child.type==='input')return child.props.onChange;
   const found=findInput(child.props.children);if(found)return found;
  }
 };
 let change:Change|undefined,received='';
 function Capture(){
  const view=ReceivePortal({mode:'shielded',payload:'shielded',value:'shrol_example',description:'Test receive',amount:'1',onAmount:amount=>{received=amount;},onModeChange:()=>{}});
  change=findInput(view);return view;
 }
 renderToStaticMarkup(createElement(Capture));
 assert.ok(change);
 for(const raw of ['1.5','01','-1','1e3','1,000','10000000000']){change({target:{value:raw}});assert.equal(received,raw);}
});

test('an exact amount stays behind a request control until it is asked for or already set',()=>{
 const base={mode:'shielded',payload:'shielded',value:'shrol_example',description:'Test receive',onModeChange:()=>{}} as const;
 const collapsed=renderToStaticMarkup(createElement(ReceivePortal,{...base,amount:'',onAmount:()=>{}}));
 assert.match(collapsed,/<button type="button" class="receive-amount-toggle">Request an exact amount<\/button>/);
 assert.doesNotMatch(collapsed,/Receive amount in sats|Remove amount/);
 const set=renderToStaticMarkup(createElement(ReceivePortal,{...base,amount:'330',onAmount:()=>{}}));
 assert.match(set,/aria-label="Receive amount in sats"/);assert.match(set,/aria-label="Remove amount"/);assert.doesNotMatch(set,/Request an exact amount/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(ReceivePortal,base)),/Request an exact amount|Receive amount in sats/);
});

test('asking for an amount focuses the field that replaces the request, and removing it clears the amount and focuses the request again',()=>{
 type Props={children?:ReactNode;className?:string;onClick?:()=>void;ref?:(element:{focus:()=>void}|null)=>void};
 const find=(node:ReactNode,match:(props:Props,type:unknown)=>boolean):Props|undefined=>{
  for(const child of Children.toArray(node)){
   if(!isValidElement<Props>(child))continue;
   if(match(child.props,child.type))return child.props;
   const found=find(child.props.children,match);if(found)return found;
  }
 };
 const amounts:string[]=[];let view:ReactNode,focused=0;const element={focus:()=>{focused++;}};
 function Capture({amount}:{amount:string}){view=ReceivePortal({mode:'shielded',payload:'shielded',value:'shrol_example',description:'Test receive',amount,onAmount:value=>{amounts.push(value);},onModeChange:()=>{}});return view;}
 renderToStaticMarkup(createElement(Capture,{amount:''}));
 const request=find(view,props=>!!props.className?.includes('receive-amount-toggle'))!;
 request.ref!(element);assert.equal(focused,0,'rendering an open or closed amount never takes focus');
 request.onClick!();request.ref!(element);request.ref!(element);assert.equal(focused,1);
 renderToStaticMarkup(createElement(Capture,{amount:'330'}));
 const field=find(view,(_,type)=>type==='input')!,remove=find(view,props=>!!props.className?.includes('receive-amount-remove'))!;
 field.ref!(element);assert.equal(focused,1);
 remove.onClick!();assert.deepEqual(amounts,['']);field.ref!(element);assert.equal(focused,2);
});

test('copy and share form one group whose copy names what it copies, a payment link once an amount is set',()=>{
 const base={mode:'shielded',payload:'shielded',description:'Test receive',onModeChange:()=>{}} as const;
 assert.match(renderToStaticMarkup(createElement(ReceivePortal,{...base,value:'shrol_example'})),/<div class="receive-controls"><button[^>]*>Copy address<\/button><\/div>/);
 assert.match(renderToStaticMarkup(createElement(ReceivePortal,{...base,value:'bitcoin:?shielded=shrol_example&amount=0.00000330',amount:'330',onAmount:()=>{}})),/<div class="receive-controls"><button[^>]*>Copy payment link<\/button><\/div>/);
});

test('nothing on the receive sheet moves the QR: copy feedback overlays it, a mode change only fades, and the docked sheet keeps one height',()=>{
 const css=readFileSync(new URL('../app/src/wallet-receive.css',import.meta.url),'utf8'),glass=readFileSync(new URL('../app/src/wallet-glass.css',import.meta.url),'utf8');
 assert.match(css,/\.receive-qr-control\{position:relative/);assert.match(css,/\.receive-qr-feedback\{position:absolute/);
 assert.match(css,/@keyframes receive-appear\{from\{opacity:\.4\}\}/);
 assert.match(glass,/\.stock-page\.has-dock \.stock-panel\.is-receive\{height:/);
 assert.match(readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8'),/\(docked&&tab==='receive'\?' is-receive':''\)/);
});

test('empty receive amount retains address-only receiving without a validation error',()=>{
 const rendered=renderToStaticMarkup(createElement(ReceivePortal,{mode:'shielded',payload:'shielded',value:'shrol_example',description:'Test receive',amount:'',onAmount:()=>{},onModeChange:()=>{}}));
 assert.match(rendered,/class="stock-qr"/);
 assert.match(rendered,/Copy address/);
 assert.doesNotMatch(rendered,/aria-invalid="true"|receive-amount-error/);
});

test('invoice requests require a valid exact amount and known limits',()=>{
 const bounds={min:1000n,max:50000n};
 for(const amount of ['','01','1.5','0','999','50001','10000000000'])assert.equal(invoiceRequestAmount(amount,bounds),undefined,amount);
 for(const amount of ['1000','50000']){
  assert.equal(invoiceRequestAmount(amount,undefined),undefined,'limits have not loaded');
  assert.equal(invoiceRequestAmount(amount,bounds),BigInt(amount));
 }
});

test('a combined payment URI retains the preferred Arkade destination',()=>{
 assert.deepEqual(payTarget('bitcoin:?lightning=LNURL1EXAMPLE&amount=0.00000012&ark=tark_example'),{to:'tark_example',amount:12});
});

test('an address that is still loading or masked for restore cannot become an amount QR',()=>{
 for(const [mode]of recipients)for(const address of ['', ' '])assert.equal(amountQrValue(mode,address,'330'),undefined);
});

for(const [mode,address,,to]of recipients)test(`${mode} amount QRs roundtrip through the payment decoder`,()=>{
 for(const [amount]of amounts){
  const uri=amountQrValue(mode,address,amount);
  assert.ok(uri);
  assert.deepEqual(payTarget(uri),{to,amount:Number(amount)});
 }
});
