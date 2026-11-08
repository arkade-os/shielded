import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {registerHooks} from 'node:module';
import {payTarget} from '../app/src/rollup-client.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {ReceivePortal,amountQrValue}=await import('../app/src/wallet-receive.tsx');
const recipients=[
 ['unified','LNURL1EXAMPLE','lightning','lnurl1example'],
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
  const rendered=renderToStaticMarkup(createElement(ReceivePortal,{mode,payload:mode,value:'placeholder',description:'Test receive',amount:'330',onAmount:()=>{},onModeChange:()=>{},qrValue:amountQrValue(mode,'placeholder','330')}));
  assert.match(rendered,/aria-label="Receive amount in sats"/);
 }
});

test('payment URIs encode exact sats as eight decimal BTC amounts',()=>{
 for(const [mode,address,parameter]of recipients){
  for(const [amount,btc]of amounts){
   assert.equal(amountQrValue(mode,address,amount),`bitcoin:?${parameter}=${mode==='unified'?address.toLowerCase():address}&amount=${btc}`);
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
