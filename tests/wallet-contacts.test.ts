import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isBtcAddress,isLightningInvoice,isLnurl,isValidArkAddress} from '@arkade-os/sdk';
import {shieldedTargetOf} from '../src/shielded/rails.ts';
import {CONTACTS_KEY,CONTACT_FULL,CONTACT_NOT_SAVED,MAX_CONTACTS,RECENTS_KEY,RECENTS_ON_KEY,contactDuplicate,deleteContact,readContacts,readRecents,recentsOn,recordRecent,saveContact,setRecentsOn,clearRecents,CONTACT_NAME_MISSING,CONTACT_ADDRESS_MISSING,CONTACT_INVOICE,CONTACT_REQUEST,CONTACT_UNKNOWN,contactAddress,contactAddressError,contactKeys,contactName,contactNameOf,contactNames} from '../app/src/wallet-contacts.ts';

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

const stub=()=>{const m=new Map<string,string>();return {m,getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};};
const locked=(m:Map<string,string>)=>({getItem:(k:string)=>m.get(k)??null,setItem:()=>{throw new Error('locked');},removeItem:()=>{throw new Error('locked');}});
const ln=(i:number)=>`u${i}@pay.example`;

test('a saved contact reads back canonical, and an edit replaces it',()=>{
 const s=stub();
 assert.equal(saveContact(s,{name:' Bob ',address:`lightning:${LN}`},undefined,5),undefined);
 assert.deepEqual(readContacts(s),[{address:LN,name:'Bob',at:5}]);
 assert.equal(saveContact(s,{name:'Robert',address:ARK},LN,7),undefined);
 assert.deepEqual(readContacts(s),[{address:ARK,name:'Robert',at:7}]);
});

test('an address already saved under another name is refused',()=>{
 const s=stub();
 saveContact(s,{name:'Bob',address:UNIFIED});
 assert.equal(saveContact(s,{name:'Eve',address:SH}),contactDuplicate('Bob'));
 assert.equal(saveContact(s,{name:'Bobby',address:UNIFIED},UNIFIED),undefined);
 assert.equal(readContacts(s)[0].name,'Bobby');
});

test('validation order is name, address, duplicate, cap',()=>{
 const s=stub();
 assert.equal(saveContact(s,{name:'​',address:''}),CONTACT_NAME_MISSING);
 assert.equal(saveContact(s,{name:'x',address:INVOICE}),CONTACT_INVOICE);
 assert.equal(s.m.size,0);
});

test('the 201st contact is refused, but an edit at the cap is allowed',()=>{
 const s=stub();
 s.m.set(CONTACTS_KEY,JSON.stringify(Array.from({length:MAX_CONTACTS},(_,i)=>({address:ln(i),name:`n${i}`,at:i}))));
 assert.equal(saveContact(s,{name:'new',address:LN}),CONTACT_FULL);
 assert.equal(saveContact(s,{name:'renamed',address:ln(0)},ln(0)),undefined);
 assert.equal(readContacts(s).length,MAX_CONTACTS);
});

test('corrupt storage reads as the valid part',()=>{
 const s=stub();
 for(const raw of ['{','7','null']){s.m.set(CONTACTS_KEY,raw);assert.deepEqual(readContacts(s),[]);}
 const a={address:UNIFIED,name:'a',at:1},b={address:TB,name:'b',at:2};
 s.m.set(CONTACTS_KEY,JSON.stringify([{address:5},{address:INVOICE,name:'x',at:1},{address:LN,name:'​',at:1},a,{address:SH,name:'dup',at:3},b]));
 assert.deepEqual(readContacts(s),[a,b]);
 s.m.set(CONTACTS_KEY,JSON.stringify(Array.from({length:10000},(_,i)=>({address:ln(i),name:`n${i}`,at:i}))));
 assert.ok(readContacts(s).length<=MAX_CONTACTS);
 assert.deepEqual(readContacts({getItem:()=>{throw new Error('x');},setItem(){},removeItem(){}}),[]);
});

test('contacts sort by name ignoring case, then address',()=>{
 const s=stub();
 s.m.set(CONTACTS_KEY,JSON.stringify([{address:TB,name:'bob',at:1},{address:LN,name:'Bob',at:2},{address:ARK,name:'alice',at:3}]));
 assert.deepEqual(readContacts(s).map(c=>c.address),[ARK,LN,TB]);
});

test('a refused write keeps the stored list',()=>{
 const s=stub();
 saveContact(s,{name:'Bob',address:LN},undefined,1);
 const before=readContacts(s),l=locked(s.m);
 assert.equal(saveContact(l,{name:'Eve',address:ARK}),CONTACT_NOT_SAVED);
 assert.equal(deleteContact(l,LN),false);
 assert.deepEqual(readContacts(s),before);
 assert.equal(deleteContact(s,LN),true);
 assert.deepEqual(readContacts(s),[]);
});

test('recents stay off until turned on, and turning them off deletes them',()=>{
 const s=stub();
 recordRecent(s,LN,1);
 assert.equal(s.m.size,0);
 assert.equal(recentsOn(s),false);
 assert.equal(setRecentsOn(s,true),true);
 for(let i=0;i<11;i++)recordRecent(s,ln(i),i);
 const kept=readRecents(s);
 assert.equal(kept.length,10);
 assert.deepEqual(kept.map(r=>r.address),Array.from({length:10},(_,i)=>ln(10-i)));
 recordRecent(s,`lightning:${ln(5)}`,50);
 assert.deepEqual(readRecents(s)[0],{address:ln(5),at:50});
 assert.equal(readRecents(s).filter(r=>r.address===ln(5)).length,1);
 recordRecent(s,INVOICE,60);
 assert.equal(readRecents(s).length,10);
 assert.equal(clearRecents(s),true);
 assert.equal(s.m.has(RECENTS_KEY),false);
 assert.equal(s.m.get(RECENTS_ON_KEY),'1');
 recordRecent(s,LN,1);
 assert.equal(setRecentsOn(s,false),true);
 assert.equal(s.m.has(RECENTS_KEY),false);
 assert.equal(s.m.has(RECENTS_ON_KEY),false);
 assert.equal(setRecentsOn(locked(s.m),true),false);
});

test('a recent payee counts once whatever form its address took',()=>{
 const s=stub();
 setRecentsOn(s,true);
 recordRecent(s,'Alice@pay.example',1);
 recordRecent(s,'alice@pay.example',2);
 assert.deepEqual(readRecents(s),[{address:'alice@pay.example',at:2}]);
 clearRecents(s);
 recordRecent(s,SH,1);
 recordRecent(s,UNIFIED,2);
 assert.deepEqual(readRecents(s),[{address:UNIFIED,at:2}]);
 s.m.set(RECENTS_KEY,JSON.stringify([{address:UNIFIED,at:2},{address:SH,at:1}]));
 assert.equal(readRecents(s).length,1);
});
