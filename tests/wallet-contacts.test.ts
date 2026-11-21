import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isBtcAddress,isLightningInvoice,isLnurl,isValidArkAddress} from '@arkade-os/sdk';
import {shieldedTargetOf} from '../src/shielded/rails.ts';
import {CONTACT_ADDRESS_MISSING,CONTACT_INVOICE,CONTACT_REQUEST,CONTACT_UNKNOWN,contactAddress,contactAddressError,contactKeys,contactName,contactNameOf,contactNames} from '../app/src/wallet-contacts.ts';

const SH='shrol21fwljy697marav7lxj5uspcpncmusg35wxjzf4l3s2fzs5cy0yqzyg8a6jqchj66k4jvtdvg0dez79z4memfsu4m36d8e9nxcpgsuc6clprr5h';
const ARK='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85wps4nhxlv3uxq3ez3gszlwfe62xcpa4tfv0rehdws8ww0g8utrwk48tu0';
const TB='tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const B58='mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const LN='alice@pay.example';
const INVOICE='lntbs210n1p4dpvmxpp58d4nqkxz5htt4ctfhyvfqnx0947fyp4uvdyg3g9j6xhahn2dytrqdqqcqzzsxqyz5vqsp5nxkcjl99y7h0uyp34xwgw6cldflucq8r7ssk06vylsjld60lfzps9qxpqysgqrf3yfzavh34pu5t8ee9perqp35z6534k6q3m5v5xckdrm4l869yrxrm4pxslwvqtzql96m69hq7sxwptw5fry9u8h3twyrdenungqxcqafud53';
const UNIFIED=`bitcoin:?shielded=${SH}&ark=${ARK}`;
const NEAR=B58.slice(0,-1)+'N';

test('the fixtures are what the SDK checks say they are',()=>{
 assert.equal(shieldedTargetOf(SH),SH);
 assert.ok(isValidArkAddress(ARK));
 assert.ok(isBtcAddress(TB));
 assert.ok(isBtcAddress(B58));
 assert.ok(isBtcAddress(NEAR));
 assert.ok(isLnurl(LN));
 assert.ok(isLightningInvoice(INVOICE));
});

test('every reusable kind is accepted and canonicalized',()=>{
 for(const good of [SH,ARK,TB,B58,LN,'Alice@Pay.Example',UNIFIED,`bitcoin:${TB}`])assert.equal(contactAddressError(good),undefined,good);
 assert.equal(contactAddress(' lightning:ALICE@PAY.EXAMPLE '),'ALICE@PAY.EXAMPLE');
 assert.equal(contactAddress(ARK.toUpperCase()),ARK);
});

test('single-use codes and requests are refused with their reason',()=>{
 for(const bad of [INVOICE,`lightning:${INVOICE}`,`bitcoin:${TB}?lightning=${INVOICE}`,`bitcoin:${TB}?lightning=${INVOICE}&lightning=${LN}`,`bitcoin:${TB}?label=x?lightning=${INVOICE}`])assert.equal(contactAddressError(bad),CONTACT_INVOICE,bad);
 for(const bad of [`bitcoin:${TB}?amount=0.001`,`bitcoin:?ark=${ARK}&assetid=${'ab'.repeat(34)}`,`bitcoin:${TB}?req-pop=x`])assert.equal(contactAddressError(bad),CONTACT_REQUEST,bad);
 for(const bad of [`bitcoin:?label=x?lightning=${LN}`,`bitcoin:?ark=${ARK}&ark=junk`,`bitcoin:?ark=${ARK}&ark=${ARK}`])assert.equal(contactAddressError(bad),CONTACT_UNKNOWN,bad);
 assert.equal(contactAddressError(''),CONTACT_ADDRESS_MISSING);
 for(const bad of ['hello','bitcoin:?label=x'])assert.equal(contactAddressError(bad),CONTACT_UNKNOWN,bad);
});

test('keys match exactly, folding case only where the address ignores it',()=>{
 assert.notDeepEqual(contactKeys(B58),contactKeys(NEAR));
 assert.deepEqual(contactKeys(ARK.toUpperCase()),contactKeys(ARK));
 assert.deepEqual(contactKeys('Alice@Pay.Example'),contactKeys(LN));
 assert.deepEqual(contactKeys('lightning:Alice@Pay.Example'),contactKeys(LN));
 assert.deepEqual(contactKeys(UNIFIED),[SH,ARK]);
 assert.deepEqual(contactKeys(`bitcoin:${TB}?lightning=${INVOICE}`),[TB]);
 assert.deepEqual(contactKeys(`bitcoin:${TB}?lightning=${INVOICE}&lightning=${LN}`),[LN,TB]);
 assert.deepEqual(contactKeys(`bitcoin:${INVOICE}?ark=${ARK}`),[ARK]);
 assert.deepEqual(contactKeys(`bitcoin:?ark=${INVOICE}&shielded=${SH}`),[SH]);
 assert.deepEqual(contactKeys(`bitcoin:${TB}?shielded=${INVOICE}`),[TB]);
});

test('a contact name shows only for an address it holds',()=>{
 const names=contactNames([{address:UNIFIED,name:'Bob',at:1},{address:B58,name:'Carol',at:2}]);
 assert.equal(contactNameOf(names,SH),'Bob');
 assert.equal(contactNameOf(names,ARK.toUpperCase()),'Bob');
 assert.equal(contactNameOf(names,B58),'Carol');
 for(const miss of [NEAR,TB,undefined])assert.equal(contactNameOf(names,miss),undefined);
});

test('names lose control characters and are cut to 40 code points',()=>{
 assert.equal(contactName(' Al\u0000ice​ '),'Alice');
 assert.equal([...contactName('😀'.repeat(50))].length,40);
 assert.equal(contactName(' ​ '),'');
});
