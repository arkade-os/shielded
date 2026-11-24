import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {shortValue} from '../app/src/rollup-client.ts';
import {CONTACT_PRIVACY,RECENTS_LINE} from '../app/src/wallet-contacts.ts';
import {ContactPicker,ContactsCard,SaveContactOffer} from '../app/src/WalletContacts.tsx';

const SH='shrol21fwljy697marav7lxj5uspcpncmusg35wxjzf4l3s2fzs5cy0yqzyg8a6jqchj66k4jvtdvg0dez79z4memfsu4m36d8e9nxcpgsuc6clprr5h';
const ARK='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85wps4nhxlv3uxq3ez3gszlwfe62xcpa4tfv0rehdws8ww0g8utrwk48tu0';
const LN='alice@pay.example';
const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const card=(props:{contacts?:{address:string;name:string;at:number}[];recents?:{address:string;at:number}[];recentsOn?:boolean})=>renderToStaticMarkup(createElement(ContactsCard,{storage,contacts:[],recents:[],recentsOn:false,onChange:()=>{},...props}));

test('the empty card explains contacts stay local and recents are off',()=>{
 const html=card({});
 assert.match(html,/Contacts/);assert.ok(html.includes(CONTACT_PRIVACY));assert.match(html,/No contacts yet\./);
 assert.match(html,/<input type="checkbox"\/>Remember recent payees/);assert.doesNotMatch(html,/Clear recents/);
});

test('the card lists each contact with its short address',()=>{
 const html=card({contacts:[{address:SH,name:'Bob',at:1},{address:ARK,name:'Carol',at:2}]});
 for(const text of ['Bob','Carol',shortValue(SH),shortValue(ARK),'Edit','Delete'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/No contacts yet\./);
});

test('recents on shows the line and Clear recents',()=>{
 const html=card({recentsOn:true,recents:[{address:SH,at:1}]});
 assert.match(html,/<input type="checkbox" checked=""\/>Remember recent payees/);
 assert.ok(html.includes(RECENTS_LINE));assert.match(html,/Clear recents/);
});

test('the picker offers saved contacts, then recents',()=>{
 const html=renderToStaticMarkup(createElement(ContactPicker,{contacts:[{address:SH,name:'Bob',at:1}],recents:[{address:ARK,at:2}],onPick:()=>{}}));
 assert.match(html,/aria-label="Pay a contact"/);assert.match(html,/<option value="" disabled=""( selected="")?>Contacts<\/option>/);
 assert.ok(html.includes(`<optgroup label="Saved"><option value="${SH}">Bob · ${shortValue(SH)}</option>`));
 assert.ok(html.includes(`<optgroup label="Recent"><option value="${ARK}">${shortValue(ARK)}</option>`));
 assert.equal(renderToStaticMarkup(createElement(ContactPicker,{contacts:[],recents:[],onPick:()=>{}})),'');
});

test('the picker fills To on each change, so arrow keys walk it, and resets when focus arrives or leaves',()=>{
 const picked:string[]=[],target={value:''},select=ContactPicker({contacts:[{address:SH,name:'Bob',at:1}],recents:[{address:ARK,at:2}],onPick:a=>picked.push(a)})!;
 for(const value of [SH,ARK]){target.value=value;select.props.onChange({target});}
 assert.deepEqual([picked,target.value],[[SH,ARK],ARK]);
 select.props.onBlur({target});assert.equal(target.value,'');
 target.value=SH;select.props.onFocus({target});assert.equal(target.value,'','so the same contact can be picked again');
});

test('the picker takes its own row under To, so it never narrows the field',()=>{
 const css=readFileSync(new URL('../app/src/stock-wallet.css',import.meta.url),'utf8');
 assert.ok(css.includes('.stock-to.has-contacts select{grid-column:1/-1}'));
 assert.doesNotMatch(css,/\.stock-to\.has-contacts\{/,'no fourth column beside To');
});

test('the offer names the address it would save',()=>{
 const html=renderToStaticMarkup(createElement(SaveContactOffer,{address:LN,storage,onSaved:()=>{},onDismiss:()=>{}}));
 assert.ok(html.includes(`Save ${shortValue(LN)} as a contact?`));assert.match(html,/aria-label="Contact name"/);
 assert.match(html,/>Save<\/button>/);assert.match(html,/>Not now<\/button>/);
});
