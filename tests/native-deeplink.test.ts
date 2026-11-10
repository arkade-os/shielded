import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentDeepLink,watchPaymentDeepLinks} from '../app/src/native-deeplink.ts';

test('a native deep link selects an untouched BIP21 payment URI',()=>{
 const uri='BITCOIN:bc1qexample?amount=0.00000012&label=Coffee&lightning=LNBC1EXAMPLE';
 assert.equal(paymentDeepLink(['https://example.com',' '+uri+' ']),uri);
});

test('native payment deep links include Lightning invoices and Arkade addresses',()=>{
 assert.equal(paymentDeepLink(['lightning:lnbc1example']),'lightning:lnbc1example');
 assert.equal(paymentDeepLink(['arkade:tark1example?amount=0.00000012']),'arkade:tark1example?amount=0.00000012');
});

test('a native deep link ignores unsafe schemes, control characters and oversized values',()=>{
 assert.equal(paymentDeepLink(['javascript:alert(1)','https://example.com','bitcoin:bc1qbad\nnext']),undefined);
 assert.equal(paymentDeepLink(['bitcoin:'+ 'x'.repeat(16*1024)]),undefined);
 assert.equal(paymentDeepLink(['bitcoin:'+'é'.repeat(8_190)]),undefined);
 assert.equal(paymentDeepLink(null),undefined);
});

test('a native deep-link batch uses its first supported payment URI',()=>{
 assert.equal(paymentDeepLink(['lightning:lnbc1first','arkade:tark1second']),'lightning:lnbc1first');
});

test('a newer OS payment event is not replaced by a delayed launch lookup',async()=>{
 let event:((urls:string[]|null)=>void)|undefined;
 let resolveCurrent:((urls:string[]|null)=>void)|undefined;
 const received:string[]=[];
 const stop=watchPaymentDeepLinks({
  onOpenUrl:async receive=>{event=receive;return()=>{};},
  getCurrent:()=>new Promise(resolve=>{resolveCurrent=resolve;}),
 },uri=>received.push(uri));
 event?.(['lightning:lnbc1new']);
 resolveCurrent?.(['bitcoin:bc1qold']);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(received,['lightning:lnbc1new']);
 stop();
});
