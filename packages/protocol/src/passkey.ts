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
export interface PasskeyFallback extends Error {name:'PasskeyFallback';credentialId:Uint8Array;userHandle:Uint8Array;userName:string;wordCount:PasskeyWordCount;createdAt:number}
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
 try{
  const words=mnemonicFromPrf(prf,wordCount);
  return {credentialId,wordCount,words,master:parseMasterSecret(words)};
 }finally{wipe(prf);}
}

/** `createdAt` is the time `userName` was made from, so a fallback wallet can be dated, and named again, as its passkey. */
export async function createPasskeySeed(o:{rpId:string;userName:string;createdAt?:number;wordCount?:PasskeyWordCount;client?:WebAuthnClient}):Promise<PasskeySeed> {
 const wordCount=o.wordCount??12,createdAt=o.createdAt??Date.now();
 const userHandle=passkeyUserId(wordCount);
 try{
  const {credentialId,prf}=await createPrfPasskey({rp:{id:o.rpId,name:PASSKEY_RP_NAME},userId:userHandle,userName:o.userName,salt:PASSKEY_SEED_SALT,client:o.client});
  return seedOf(credentialId,prf,wordCount);
 }catch(error){
  const {name,reason,credentialId}=error as {name?:string;reason?:string;credentialId?:Uint8Array};
  if(name==='PrfUnavailable'&&reason==='unsupported'&&credentialId)throw Object.assign(new Error("This passkey can't make wallet keys on this device."),{name:'PasskeyFallback',credentialId,userHandle,userName:o.userName,wordCount,createdAt});
  throw error;
 }
}
/** Discoverable recovery reads the handle; persisted word counts may fill a missing handle only for their bound credential. With neither, the restore refuses: guessing 12 would quietly derive another wallet from a 24-word passkey. */
export async function restorePasskeySeed(o:{rpId:string;credentialId?:Uint8Array;wordCount?:PasskeyWordCount;client?:WebAuthnClient}):Promise<PasskeySeed> {
 const expected=o.credentialId?.slice(),hint=o.wordCount;
 if(hint!==undefined&&(!expected?.length||(hint!==12&&hint!==24)))throw new Error('Recovery word count requires a bound passkey credential.');
 const {credentialId,userHandle,prf}=await evaluatePrf({rpId:o.rpId,salt:PASSKEY_SEED_SALT,credentialIds:expected&&[expected],client:o.client});
 // Identity and word-count validation can throw before seedOf takes ownership.
 try{
  const count=wordCountFromUserHandle(userHandle);
  // A handle from elsewhere still means 12 words; only its absence leaves the count unknown.
  if(hint===undefined&&!userHandle?.length)throw Object.assign(new Error('That passkey did not say how many recovery words its wallet has.'),{name:'PasskeyWordsUnknown'});
  if(hint!==undefined){
   if(credentialId.length!==expected!.length||!credentialId.every((byte,i)=>byte===expected![i]))throw new Error('That passkey does not match the recovery credential.');
   const known=userHandle?.length===HANDLE_BYTES&&userHandle[0]===HANDLE_MAGIC[0]&&userHandle[1]===HANDLE_MAGIC[1]&&(userHandle[2]===0x11||userHandle[2]===0x12);
   if(known&&count!==hint)throw new Error('The passkey word count does not match its recovery metadata.');
  }
  return seedOf(credentialId,prf,hint??count);
 }finally{wipe(prf);}
}

const WRAP_VERSION=1,IV_BYTES=12,TAG_BYTES=16,WRAP_INFO=utf8.encode(`${KEY_DOMAIN}:unlock-wrap:v1`);
/** Neither the PRF secret nor this key is ever stored: both live only inside one wrap or unwrap. */
async function wrapKey(o:{rpId:string;credentialId:Uint8Array;client?:WebAuthnClient}) {
 const {prf}=await evaluatePrf({rpId:o.rpId,salt:PASSKEY_UNLOCK_SALT,credentialIds:[o.credentialId],client:o.client});
 const material=hkdf(sha256,prf,KEY_SALT,WRAP_INFO,32);
 wipe(prf);
 const key=await crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt','decrypt']);
 wipe(material);
 return key;
}
async function seal(key:CryptoKey,version:number,credentialId:Uint8Array,secret:string):Promise<Uint8Array> {
 const iv=crypto.getRandomValues(new Uint8Array(IV_BYTES)),plain=utf8.encode(secret),aad=new Uint8Array(1+credentialId.length);
 aad[0]=version;aad.set(credentialId,1);
 const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,plain));
 wipe(plain);
 const blob=new Uint8Array(1+IV_BYTES+sealed.length);
 blob[0]=version;blob.set(iv,1);blob.set(sealed,1+IV_BYTES);
 return blob;
}
/** The key is a thunk so a foreign or torn record is refused before any passkey prompt. */
async function open(keyOf:()=>Promise<CryptoKey>,version:number,credentialId:Uint8Array,blob:Uint8Array):Promise<string> {
 if(blob.length<1+IV_BYTES+TAG_BYTES||blob[0]!==version)throw new Error('That wallet lock record is not one this app wrote.');
 const aad=new Uint8Array(1+credentialId.length);
 aad[0]=version;aad.set(credentialId,1);
 const key=await keyOf();
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(blob.subarray(1,1+IV_BYTES)),additionalData:aad},key,new Uint8Array(blob.subarray(1+IV_BYTES))));
 const secret=new TextDecoder().decode(plain);
 wipe(plain);
 return secret;
}
/** A wallet secret under the passkey's unlock key: `version‖iv‖AES-256-GCM`, with the version and credential id as associated data. */
export async function wrapWalletSecret(o:{rpId:string;credentialId:Uint8Array;secret:string;client?:WebAuthnClient}):Promise<Uint8Array> {
 return seal(await wrapKey(o),WRAP_VERSION,o.credentialId,o.secret);
}
export async function unwrapWalletSecret(o:{rpId:string;credentialId:Uint8Array;blob:Uint8Array;client?:WebAuthnClient}):Promise<string> {
 return open(()=>wrapKey(o),WRAP_VERSION,o.credentialId,o.blob);
}

const HANDLE_LOCK_VERSION=2,HANDLE_LOCK_INFO=utf8.encode(`${KEY_DOMAIN}:handle-lock:v1`);
async function handleKey(userHandle:Uint8Array) {
 const material=hkdf(sha256,userHandle,KEY_SALT,HANDLE_LOCK_INFO,32);
 try{return await crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt','decrypt']);}finally{wipe(material);}
}
/** Locks a recovery phrase under the passkey's user handle, for a passkey with no PRF; `0x02‖iv‖AES-256-GCM`, credential id as associated data. */
export async function lockWithHandle(o:{credentialId:Uint8Array;userHandle:Uint8Array;words:string}):Promise<Uint8Array> {
 return seal(await handleKey(o.userHandle),HANDLE_LOCK_VERSION,o.credentialId,o.words);
}
export async function unlockWithHandle(o:{credentialId:Uint8Array;userHandle:Uint8Array;blob:Uint8Array}):Promise<string> {
 return open(()=>handleKey(o.userHandle),HANDLE_LOCK_VERSION,o.credentialId,o.blob);
}
/** Reads a passkey's user handle with a plain assertion, no PRF. */
export async function passkeyUserHandle(o:{rpId:string;credentialId:Uint8Array;client?:WebAuthnClient}):Promise<Uint8Array> {
 const credentials=o.client??navigator.credentials;
 let cred:Credential|null;
 try{
  cred=await credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:o.rpId,allowCredentials:[{type:'public-key',id:o.credentialId as BufferSource}],userVerification:'required'}});
 }catch(error){
  if((error as {name?:string})?.name==='NotAllowedError')throw Object.assign(new Error('The passkey prompt was dismissed.'),{name:'PasskeyCancelled'});
  throw error;
 }
 if(!cred)throw Object.assign(new Error('The passkey prompt was dismissed.'),{name:'PasskeyCancelled'});
 const raw=new Uint8Array((cred as PublicKeyCredential).rawId);
 if(raw.length!==o.credentialId.length||!raw.every((byte,i)=>byte===o.credentialId[i]))throw new Error('That passkey does not match the recovery credential.');
 const handle=(cred as PublicKeyCredential&{response:AuthenticatorAssertionResponse}).response.userHandle;
 if(!handle?.byteLength)throw Object.assign(new Error('That passkey did not return its lock key.'),{name:'PasskeyHandleMissing'});
 return new Uint8Array(handle);
}

/** What the app does next: retry a cancel, offer a phrase instead of a passkey this device cannot use or cannot count words for, and never re-prompt an unconfirmed one. */
export type PasskeyOutcome='cancelled'|'unavailable'|'unconfirmed'|'uncounted'|'fallback';
const OUTCOMES:Record<string,PasskeyOutcome>={PasskeyCancelled:'cancelled',PrfUnavailable:'unavailable',PasskeyUnconfirmed:'unconfirmed',PasskeyWordsUnknown:'uncounted',PasskeyFallback:'fallback'};
export function passkeyFailure(error:unknown):{outcome:PasskeyOutcome;credentialId?:Uint8Array}|undefined {
 // On the error's own name, not instanceof: a second copy of the SDK would break the class identity and the mapping with it.
 const named=error instanceof Error?OUTCOMES[error.name]:undefined;
 if(!named)return undefined;
 const credentialId=(error as {credentialId?:Uint8Array}).credentialId;
 return credentialId?{outcome:named,credentialId}:{outcome:named};
}
