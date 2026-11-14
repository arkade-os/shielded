import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {DEFAULT_PASSKEY_LABEL,createPrfPasskey,evaluatePrf,mnemonicFromPrf,type WebAuthnClient} from '@arkade-os/sdk';
import {KEY_DOMAIN,KEY_SALT,parseMasterSecret} from './wallet-keys.ts';

const utf8=new TextEncoder();
export const PASSKEY_RP_NAME='Shielded' as const;
/** A permanent recovery constant: another seed label derives another wallet from every passkey. It is Breez's, so one passkey gives the same 12 words in both; the unlock label must stay distinct or the wrap key would come from the seed it wraps. */
export const PASSKEY_SEED_SALT=utf8.encode(DEFAULT_PASSKEY_LABEL);
export const PASSKEY_UNLOCK_SALT=utf8.encode('shielded-unlock-v1');
export type PasskeyWordCount=12|24;
export interface PasskeySeed {credentialId:Uint8Array;wordCount:PasskeyWordCount;words:string;master:Uint8Array}

/**
 * A passkey's user handle, 32 bytes: `0x53 0x4b` ('SK'), one byte of `version<<4|count` (`0x11` for
 * 12 words, `0x12` for 24), then 29 random bytes. Restore reads the count back from the handle
 * `evaluatePrf` returns; any other handle is 12 words, and the magic keeps that guess off random bytes.
 */
const HANDLE_MAGIC=[0x53,0x4b] as const,HANDLE_BYTES=32;
export function passkeyUserId(wordCount:PasskeyWordCount):Uint8Array {
 const id=crypto.getRandomValues(new Uint8Array(HANDLE_BYTES));
 id.set([...HANDLE_MAGIC,0x10|wordCount/12],0);
 return id;
}
export function wordCountFromUserHandle(handle:Uint8Array|null|undefined):PasskeyWordCount {
 if(handle?.length!==HANDLE_BYTES||handle[0]!==HANDLE_MAGIC[0]||handle[1]!==HANDLE_MAGIC[1])return 12;
 return handle[2]===0x12?24:12;
}

/** Native passkeys belong to the pool origin's host; the browser build has no pool origin and uses its own hostname. Never a value a URL or deep link can influence. */
export function passkeyRpId(poolOrigin:string,hostname:string):string {
 if(!poolOrigin)return hostname;
 try{return new URL(poolOrigin).hostname;}catch{throw new Error(`The pool origin ${JSON.stringify(poolOrigin)} is not a URL, so passkeys have no relying party.`);}
}

const wipe=(bytes:Uint8Array)=>bytes.fill(0);
function seedOf(credentialId:Uint8Array,prf:Uint8Array,wordCount:PasskeyWordCount):PasskeySeed {
 const words=mnemonicFromPrf(prf,wordCount);
 wipe(prf);
 return {credentialId,wordCount,words,master:parseMasterSecret(words)};
}

export async function createPasskeySeed(o:{rpId:string;userName:string;wordCount?:PasskeyWordCount;client?:WebAuthnClient}):Promise<PasskeySeed> {
 const wordCount=o.wordCount??12;
 const {credentialId,prf}=await createPrfPasskey({rp:{id:o.rpId,name:PASSKEY_RP_NAME},userId:passkeyUserId(wordCount),userName:o.userName,salt:PASSKEY_SEED_SALT,client:o.client});
 return seedOf(credentialId,prf,wordCount);
}
/** Any passkey for this relying party unless `credentialId` names one: the handle says which wallet it is, so another passkey yields another wallet rather than an error. */
export async function restorePasskeySeed(o:{rpId:string;credentialId?:Uint8Array;client?:WebAuthnClient}):Promise<PasskeySeed> {
 const {credentialId,userHandle,prf}=await evaluatePrf({rpId:o.rpId,salt:PASSKEY_SEED_SALT,credentialIds:o.credentialId&&[o.credentialId],client:o.client});
 return seedOf(credentialId,prf,wordCountFromUserHandle(userHandle));
}

const WRAP_VERSION=1,IV_BYTES=12,TAG_BYTES=16,WRAP_INFO=utf8.encode(`${KEY_DOMAIN}:unlock-wrap:v1`);
const wrapAssociated=(credentialId:Uint8Array)=>{const data=new Uint8Array(1+credentialId.length);data[0]=WRAP_VERSION;data.set(credentialId,1);return data;};
/** Neither the PRF secret nor this key is ever stored: both live only inside one wrap or unwrap. */
async function wrapKey(o:{rpId:string;credentialId:Uint8Array;client?:WebAuthnClient}) {
 const {prf}=await evaluatePrf({rpId:o.rpId,salt:PASSKEY_UNLOCK_SALT,credentialIds:[o.credentialId],client:o.client});
 const material=hkdf(sha256,prf,KEY_SALT,WRAP_INFO,32);
 wipe(prf);
 const key=await crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt','decrypt']);
 wipe(material);
 return key;
}
/** A wallet secret under the passkey's unlock key: `version‖iv‖AES-256-GCM`, with the version and credential id as associated data. */
export async function wrapWalletSecret(o:{rpId:string;credentialId:Uint8Array;secret:string;client?:WebAuthnClient}):Promise<Uint8Array> {
 const key=await wrapKey(o),iv=crypto.getRandomValues(new Uint8Array(IV_BYTES));
 const plain=utf8.encode(o.secret);
 const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:wrapAssociated(o.credentialId)},key,plain));
 wipe(plain);
 const blob=new Uint8Array(1+IV_BYTES+sealed.length);
 blob[0]=WRAP_VERSION;blob.set(iv,1);blob.set(sealed,1+IV_BYTES);
 return blob;
}
export async function unwrapWalletSecret(o:{rpId:string;credentialId:Uint8Array;blob:Uint8Array;client?:WebAuthnClient}):Promise<string> {
 if(o.blob.length<1+IV_BYTES+TAG_BYTES||o.blob[0]!==WRAP_VERSION)throw new Error('That wallet lock record is not one this app wrote.');
 const key=await wrapKey(o);
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(o.blob.subarray(1,1+IV_BYTES)),additionalData:wrapAssociated(o.credentialId)},key,new Uint8Array(o.blob.subarray(1+IV_BYTES))));
 const secret=new TextDecoder().decode(plain);
 wipe(plain);
 return secret;
}

/** What the app does next: retry a cancel, offer a phrase instead of a passkey this device cannot use, and never re-prompt an unconfirmed one. */
export type PasskeyOutcome='cancelled'|'unavailable'|'unconfirmed';
const OUTCOMES:Record<string,PasskeyOutcome>={PasskeyCancelled:'cancelled',PrfUnavailable:'unavailable',PasskeyUnconfirmed:'unconfirmed'};
export function passkeyFailure(error:unknown):{outcome:PasskeyOutcome;credentialId?:Uint8Array}|undefined {
 // On the error's own name, not instanceof: a second copy of the SDK would break the class identity and the mapping with it.
 const named=error instanceof Error?OUTCOMES[error.name]:undefined;
 if(!named)return undefined;
 const credentialId=(error as {credentialId?:Uint8Array}).credentialId;
 return credentialId?{outcome:named,credentialId}:{outcome:named};
}
