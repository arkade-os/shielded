import {isBtcAddress,isLightningInvoice,isLnurl,isValidArkAddress} from '@arkade-os/sdk';
import {shieldedTargetOf} from '../../src/shielded/rails.ts';

export interface Contact{address:string;name:string;at:number}
export interface Recent{address:string;at:number}

export const MAX_CONTACT_NAME=40;
export const MAX_CONTACTS=200;
export const MAX_RECENTS=10;
export const CONTACTS_KEY='shielded-contacts-v1';
export const RECENTS_KEY='shielded-recents-v1';
export const RECENTS_ON_KEY='shielded-recents-on-v1';
export const CONTACT_PRIVACY='Contacts stay on this device. They are never sent to the pool or to any server.';
export const CONTACT_NAME_MISSING='Enter a name for this contact.';
export const CONTACT_ADDRESS_MISSING='Enter an address for this contact.';
export const CONTACT_INVOICE='A Lightning invoice can be paid only once, so it cannot be saved as a contact.';
export const CONTACT_REQUEST='This payment link asks for an amount or an asset. Save the address without them.';
export const CONTACT_UNKNOWN='This wallet cannot pay this address. Use a shielded, Arkade, Bitcoin or Lightning address, or an LNURL.';
export const contactDuplicate=(name:string)=>`This address is already saved as “${name}”.`;
export const CONTACT_FULL='This device keeps up to 200 contacts. Delete one to add another.';
export const CONTACT_NOT_SAVED='This device did not save the change. Try again.';
export const RECENTS_LINE='Keeps the last 10 addresses you paid, on this device only. Turning this off deletes them.';

export const contactAddress=(raw:string)=>{
 const text=raw.trim().replace(/^lightning:/i,'');
 return /^[A-Z0-9]+$/.test(text)?text.toLowerCase():text;
};

const unescape=(s:string)=>{try{return decodeURIComponent(s);}catch{return s;}};
/** The legs of a canonical `bitcoin:` URI, read as `payTarget` does: keys lowercased, values decoded. A repeated key keeps every value, and a second `?` splits legs like `&`, so nothing can hide an invoice. */
function uriLegs(text:string):{path:string;legs:Map<string,string[]>;ambiguous:boolean}|undefined{
 if(!/^bitcoin:/i.test(text))return undefined;
 const rest=text.slice(8),at0=rest.indexOf('?'),path=at0<0?rest:rest.slice(0,at0),legs=new Map<string,string[]>();
 for(const pair of at0<0?[]:rest.slice(at0+1).split(/[&?]/)){
  if(!pair)continue;
  const at=pair.indexOf('='),key=(at<0?pair:pair.slice(0,at)).toLowerCase();
  legs.set(key,[...legs.get(key)??[],unescape(at<0?'':pair.slice(at+1))]);
 }
 return {path:unescape(path),legs,ambiguous:at0>=0&&rest.indexOf('?',at0+1)>=0||[...legs.values()].some(v=>v.length>1)};
}
const isInvoice=(v:string)=>isLightningInvoice(v.toLowerCase());
// Base58 is case-sensitive: folding it would let a near-miss address borrow a contact's name.
const keyOf=(v:string)=>isBtcAddress(v)&&!/^(bc|tb|bcrt)1/i.test(v)?v:v.toLowerCase();

export function contactKeys(raw:string):string[]{
 const text=contactAddress(raw),uri=uriLegs(text);
 const values=uri?[...(uri.legs.get('shielded')??[]),...(uri.legs.get('ark')??[]),...(uri.legs.get('lightning')??[]),uri.path]:[text];
 return [...new Set(values.filter(v=>v&&!isInvoice(v)).map(keyOf))];
}

export function contactAddressError(raw:string):string|undefined{
 const text=contactAddress(raw);
 if(!text)return CONTACT_ADDRESS_MISSING;
 const uri=uriLegs(text),lightning=uri?uri.legs.get('lightning')??[]:[text];
 if(isInvoice(text)||lightning.some(isInvoice))return CONTACT_INVOICE;
 if(uri&&[...uri.legs.keys()].some(key=>key==='amount'||key==='assetid'||key.startsWith('req-')))return CONTACT_REQUEST;
 if(uri?.ambiguous)return CONTACT_UNKNOWN;
 const ark=uri?uri.legs.get('ark')??[]:[text],btc=uri?uri.path:text;
 const reusable=shieldedTargetOf(text)!==undefined
  ||ark.some(v=>isValidArkAddress(v.toLowerCase()))
  ||lightning.some(v=>isLnurl(v.toLowerCase()))
  ||(!!btc&&(isBtcAddress(btc)||isBtcAddress(btc.toLowerCase())));
 return reusable?undefined:CONTACT_UNKNOWN;
}

export const contactName=(raw:string)=>[...raw.replace(/[\p{Cc}\p{Cf}]/gu,'').trim()].slice(0,MAX_CONTACT_NAME).join('');

export function contactNames(contacts:readonly Contact[]):Map<string,string>{
 const names=new Map<string,string>();
 for(const {address,name} of contacts)for(const key of contactKeys(address))if(!names.has(key))names.set(key,name);
 return names;
}

export function contactNameOf(names:ReadonlyMap<string,string>,to:string|undefined):string|undefined{
 if(!to)return undefined;
 for(const key of contactKeys(to)){const name=names.get(key);if(name!==undefined)return name;}
 return undefined;
}

type S=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

function readList(storage:S,key:string):unknown[]{
 try{const v=JSON.parse(storage.getItem(key)??'null');return Array.isArray(v)?v:[];}catch{return [];}
}
const write=(storage:S,key:string,value:unknown)=>{try{storage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};
const remove=(storage:S,...keys:string[])=>{try{for(const key of keys)storage.removeItem(key);return true;}catch{return false;}};
const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null;
const validAddress=(v:unknown):v is string=>typeof v==='string'&&contactAddress(v)===v&&contactAddressError(v)===undefined;
const overlaps=(taken:ReadonlySet<string>,keys:readonly string[])=>keys.some(k=>taken.has(k));

export function readContacts(storage:S):Contact[]{
 const out:Contact[]=[],taken=new Set<string>();
 for(const e of readList(storage,CONTACTS_KEY)){
  if(out.length>=MAX_CONTACTS)break;
  if(!isObj(e)||!validAddress(e.address)||typeof e.name!=='string'||typeof e.at!=='number'||!Number.isFinite(e.at))continue;
  const name=contactName(e.name),keys=contactKeys(e.address);
  if(!name||overlaps(taken,keys))continue;
  keys.forEach(k=>taken.add(k));
  out.push({address:e.address,name,at:e.at});
 }
 return out.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||(a.address<b.address?-1:a.address>b.address?1:0));
}

export function saveContact(storage:S,input:{name:string;address:string},previous?:string,now=Date.now()):string|undefined{
 const name=contactName(input.name);
 if(!name)return CONTACT_NAME_MISSING;
 const error=contactAddressError(input.address);
 if(error)return error;
 const address=contactAddress(input.address),keys=contactKeys(address),others=readContacts(storage).filter(c=>c.address!==previous);
 const clash=others.find(c=>overlaps(new Set(keys),contactKeys(c.address)));
 if(clash)return contactDuplicate(clash.name);
 if(previous===undefined&&others.length>=MAX_CONTACTS)return CONTACT_FULL;
 return write(storage,CONTACTS_KEY,[...others,{address,name,at:now}])?undefined:CONTACT_NOT_SAVED;
}

export function deleteContact(storage:S,address:string):boolean{
 return write(storage,CONTACTS_KEY,readContacts(storage).filter(c=>c.address!==address));
}

export function recentsOn(storage:S):boolean{
 try{return storage.getItem(RECENTS_ON_KEY)==='1';}catch{return false;}
}

export function setRecentsOn(storage:S,on:boolean):boolean{
 if(!on)return remove(storage,RECENTS_KEY,RECENTS_ON_KEY);
 try{storage.setItem(RECENTS_ON_KEY,'1');return true;}catch{return false;}
}

export function readRecents(storage:S):Recent[]{
 const out:Recent[]=[],taken=new Set<string>();
 for(const e of readList(storage,RECENTS_KEY)){
  if(out.length>=MAX_RECENTS)break;
  if(!isObj(e)||!validAddress(e.address)||typeof e.at!=='number'||!Number.isFinite(e.at))continue;
  const keys=contactKeys(e.address);
  if(overlaps(taken,keys))continue;
  keys.forEach(k=>taken.add(k));
  out.push({address:e.address,at:e.at});
 }
 return out;
}

export function recordRecent(storage:S,address:string,now=Date.now()):void{
 if(!recentsOn(storage)||contactAddressError(address))return;
 const canonical=contactAddress(address),keys=new Set(contactKeys(canonical));
 write(storage,RECENTS_KEY,[{address:canonical,at:now},...readRecents(storage).filter(r=>!overlaps(keys,contactKeys(r.address)))].slice(0,MAX_RECENTS));
}

export const clearRecents=(storage:S):boolean=>remove(storage,RECENTS_KEY);
