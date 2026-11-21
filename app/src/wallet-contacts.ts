import {isBtcAddress,isLightningInvoice,isLnurl,isValidArkAddress} from '@arkade-os/sdk';
import {shieldedTargetOf} from '../../src/shielded/rails.ts';

export interface Contact{address:string;name:string;at:number}
export interface Recent{address:string;at:number}

export const MAX_CONTACT_NAME=40;
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
/** The legs of a canonical `bitcoin:` URI, read as `payTarget` does: keys lowercased, values decoded. */
function uriLegs(text:string):{path:string;legs:Map<string,string>}|undefined{
 if(!/^bitcoin:/i.test(text))return undefined;
 const [path='',query='']=text.slice(8).split('?');
 return {path:unescape(path),legs:new Map(query.split('&').filter(Boolean).map(pair=>{const at=pair.indexOf('=');return [(at<0?pair:pair.slice(0,at)).toLowerCase(),unescape(at<0?'':pair.slice(at+1))];}))};
}
const isInvoice=(v:string)=>isLightningInvoice(v.toLowerCase());
// Base58 is case-sensitive: folding it would let a near-miss address borrow a contact's name.
const keyOf=(v:string)=>isBtcAddress(v)&&!/^(bc|tb|bcrt)1/i.test(v)?v:v.toLowerCase();

export function contactKeys(raw:string):string[]{
 const text=contactAddress(raw),uri=uriLegs(text);
 const values=uri?[uri.legs.get('shielded'),uri.legs.get('ark'),uri.legs.get('lightning'),uri.path]:[text];
 return [...new Set(values.filter((v):v is string=>!!v&&!isInvoice(v)).map(keyOf))];
}

export function contactAddressError(raw:string):string|undefined{
 const text=contactAddress(raw);
 if(!text)return CONTACT_ADDRESS_MISSING;
 const uri=uriLegs(text),lightning=uri?uri.legs.get('lightning'):text;
 if(isInvoice(text)||(lightning&&isInvoice(lightning)))return CONTACT_INVOICE;
 if(uri&&[...uri.legs.keys()].some(key=>key==='amount'||key==='assetid'||key.startsWith('req-')))return CONTACT_REQUEST;
 const ark=uri?uri.legs.get('ark'):text,btc=uri?uri.path:text;
 const reusable=shieldedTargetOf(text)!==undefined
  ||(!!ark&&isValidArkAddress(ark.toLowerCase()))
  ||(!!lightning&&isLnurl(lightning.toLowerCase()))
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
