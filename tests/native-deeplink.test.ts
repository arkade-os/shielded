import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentDeepLink} from '../app/src/native-deeplink.ts';

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
 assert.equal(paymentDeepLink(null),undefined);
});

test('a native deep-link batch uses its first supported payment URI',()=>{
 assert.equal(paymentDeepLink(['lightning:lnbc1first','arkade:tark1second']),'lightning:lnbc1first');
});
