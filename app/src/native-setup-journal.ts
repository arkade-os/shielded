import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';
import {PASSKEY,savePasskey,validPasskeyRecord,type PasskeyRecord} from './passkey-record.ts';

export const NATIVE_SETUP='shielded-native-setup-v1',NATIVE_LOCK='shielded-native-lock-v1';
const BORN='shielded-rollup-wallet-born-v1',CREATED='shielded-rollup-wallet-created-v1',SENT='shielded-rollup-sent-v1';
type Lock={words:12|24};
type Setup={version:1;tag:string;passkey?:PasskeyRecord;created?:number;lock?:Lock};
const valid=(value:string)=>/^[0-9a-f]{64}$/.test(value);
const validLock=(o:{passkey?:unknown;lock?:Lock})=>o.lock===undefined||o.passkey===undefined&&(o.lock?.words===12||o.lock?.words===24);
const tag=(secret:string)=>{if(!valid(secret))throw new Error('Invalid native wallet secret.');return bytesToHex(sha256(hexToBytes(secret)));};
/** Set only for a wallet whose recovery phrase the device lock holds. */
export function nativeLockOf(base:Pick<Storage,'getItem'>):Lock|undefined{
 const raw=base.getItem(NATIVE_LOCK);if(raw===null)return;
 let words:unknown;try{words=JSON.parse(raw)?.words;}catch{}
 return {words:words===12?12:24};
}
export const setNativeLock=(base:Pick<Storage,'setItem'>,lock:Lock)=>base.setItem(NATIVE_LOCK,JSON.stringify({version:1,words:lock.words}));
/** For a vault holding only the locked entry: any other setup writes the plain entry, so one still pending never landed. */
export function dropStaleSetup(base:Pick<Storage,'getItem'|'removeItem'>){if(!pendingNativeSetup(base)?.lock)base.removeItem(NATIVE_SETUP);}
export function pendingNativeSetup(base:Pick<Storage,'getItem'>):Setup|undefined{
 const raw=base.getItem(NATIVE_SETUP);if(raw===null)return;
 try{
  const value=JSON.parse(raw) as Setup;
  if(value?.version!==1||!valid(value.tag)||value.passkey!==undefined&&!validPasskeyRecord(value.passkey)||value.created!==undefined&&(!Number.isSafeInteger(value.created)||value.created<0)||!validLock(value))throw new Error();
  return value;
 }catch{throw new Error('The native setup record is invalid. Keep the app data.');}
}
export function prepareNativeSetup(base:Pick<Storage,'getItem'|'setItem'>,secret:string,options:{passkey?:PasskeyRecord;created?:number;lock?:Lock}):Setup{
 const next=tag(secret),pending=pendingNativeSetup(base);
 if(pending){
  if(pending.tag!==next)throw new Error('The wallet does not match the pending setup. Finish that setup before trying another wallet.');
  // A retry keeps the first attempt's credential and birthday, but whether it locks is this setup's own write.
  if(pending.lock?.words===options.lock?.words)return pending;
  const reused:Setup={...pending,lock:options.lock&&{words:options.lock.words}};
  if(!validLock(reused))throw new Error('The native setup metadata is invalid.');
  base.setItem(NATIVE_SETUP,JSON.stringify(reused));return reused;
 }
 if(options.passkey!==undefined&&!validPasskeyRecord(options.passkey)||options.created!==undefined&&(!Number.isSafeInteger(options.created)||options.created<0)||!validLock(options))throw new Error('The native setup metadata is invalid.');
 const record=options.passkey,payload:Setup={version:1,tag:next,...record?{passkey:{version:1,credentialId:record.credentialId,label:record.label,words:record.words}}:{},...options.created===undefined?{}:{created:options.created},...options.lock?{lock:{words:options.lock.words}}:{}};
 base.setItem(NATIVE_SETUP,JSON.stringify(payload));return payload;
}
/** `locked`: the vault holds only the locked entry; that alone decides the lock marker. */
export function reconcileNativeSetup(base:Storage,secret:string|null,locked:boolean):Setup|undefined{
 const pending=pendingNativeSetup(base);if(secret!==null&&!locked)base.removeItem(NATIVE_LOCK);if(!pending)return;
 // A lock setup's phrase lived only in memory, so with an empty vault it can never finish.
 if(secret===null){if(!pending.lock)return pending;base.removeItem(NATIVE_SETUP);return;}
 if(pending.tag!==tag(secret))throw new Error('The vault secret does not match the pending setup. Keep the app data.');
 for(let i=base.length-1;i>=0;i--){const key=base.key(i);if(key&&(key.startsWith(BORN)||key===CREATED||key===SENT||key===PASSKEY||key===NATIVE_LOCK))base.removeItem(key);}
 savePasskey(base,pending.passkey);
 if(pending.lock&&locked)setNativeLock(base,pending.lock);
 if(pending.created!==undefined){base.setItem(BORN,'new');base.setItem(CREATED,String(pending.created));}
 base.setItem('shielded-native-wallet','1');base.removeItem(NATIVE_SETUP);
}
