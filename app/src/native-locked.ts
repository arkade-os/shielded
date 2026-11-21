import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';
import {entropyToMnemonic,mnemonicToEntropy} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {invoke} from '@tauri-apps/api/core';
import {passkeyFailure,type PasskeyFallback} from '../../packages/protocol/src/passkey.ts';
import {parseMasterSecret,randomRecoveryPhrase} from '../../packages/protocol/src/wallet-keys.ts';
import {dropStaleSetup,setNativeLock} from './native-setup-journal.ts';

export type VaultKind='none'|'plain'|'locked';
export const vaultKind=()=>invoke<VaultKind>('plugin:shielded-platform|vault_kind');
export const lockedSecretCreate=(value:string)=>invoke<void>('plugin:shielded-platform|locked_secret_create',{value});
// A record gone between vault_kind and this read can never open, the same as a lock that is gone.
export const lockedSecretGet=()=>invoke<string|null>('plugin:shielded-platform|locked_secret_get').then(value=>value??Promise.reject('lock-gone'));
export const lockedSecretClear=()=>invoke<void>('plugin:shielded-platform|locked_secret_clear');
export const deviceLockAvailable=()=>invoke<boolean>('plugin:shielded-platform|device_lock_available');

export function lockedSecretCache(){
 let held:Promise<Uint8Array>|undefined;
 return {
  read(fetch:()=>Promise<string>):Promise<string>{
   const mine=held??=fetch().then(hexToBytes);
   mine.catch(()=>{if(held===mine)held=undefined;});
   return mine.then(bytesToHex);
  },
  forget(){const old=held;held=undefined;void old?.then(bytes=>bytes.fill(0),()=>{});},
 };
}
export type LockedSecretCache=ReturnType<typeof lockedSecretCache>;
export const masterOfEntropy=(hex:string)=>{
 const entropy=hexToBytes(hex),master=parseMasterSecret(entropyToMnemonic(entropy,wordlist));
 try{return bytesToHex(master);}finally{master.fill(0);entropy.fill(0);}
};
export function newLockedSecret(words:12|24){
 const phrase=randomRecoveryPhrase(words),bytes=mnemonicToEntropy(phrase,wordlist),entropy=bytesToHex(bytes);bytes.fill(0);
 return {words:phrase,entropy,master:masterOfEntropy(entropy)};
}
/** Setup's read-back: the vault reports a locked entry without decrypting it, so it costs no second prompt. */
export const lockedReadBack=async(master:string)=>await vaultKind()==='locked'?master:null;

const UNLOCK:Record<string,string>={
 cancelled:'The device lock request ended before it finished.',
 'lock-gone':'This device’s screen lock was removed or reset, so it can no longer open this wallet. Restore it with its recovery phrase.',
 'weak-biometric':'This phone’s fingerprint or face unlock cannot open the lock. Use your screen-lock PIN, pattern or password.',
};
export const unlockError=(cause:unknown):Error&{gone:boolean}=>cause instanceof Error&&cause.name==='NativeUnlock'?cause as Error&{gone:boolean}
 :Object.assign(new Error(typeof cause==='string'&&UNLOCK[cause]||(cause instanceof Error?cause.message:String(cause))),{name:'NativeUnlock',gone:cause==='lock-gone'});
/** The plain entry wins, as in the vault. A locked one prompts only when the cache is empty, and after a refusal only once the user asks again. */
export async function readNativeSecret(plain:()=>Promise<string|null>,cache:LockedSecretCache,hold:{current?:Error},storage:Storage,read:{locked?:boolean}={}){
 const secret=await plain();
 if(secret!==null||await vaultKind()!=='locked')return secret;
 read.locked=true;
 // The read also drops a non-lock setup record, which can no longer complete while the vault is locked.
 dropStaleSetup(storage);
 const entropy=await cache.read(()=>hold.current?Promise.reject(hold.current):lockedSecretGet()).catch(cause=>{throw hold.current=unlockError(cause);});
 setNativeLock(storage,{words:entropy.length===32?12:24});
 return masterOfEntropy(entropy);
}
/** Native never uses a fallback's user handle, so it is wiped whether or not the device lock can take over. */
export async function deviceLockFallback(cause:unknown){
 if(passkeyFailure(cause)?.outcome!=='fallback')return;
 const offer=cause as PasskeyFallback;offer.userHandle.fill(0);
 return await deviceLockAvailable().catch(()=>false)?offer:undefined;
}
/** The plain entry is written first; a clear that fails leaves only a lock the restored wallet outranks. */
export async function restoreOverLock(write:()=>Promise<void>){await write();await lockedSecretClear().catch(()=>{});}
export async function lockedPhrase(secret:string,before?:()=>Promise<void>){
 await before?.();
 try{
  const entropy=await lockedSecretGet();
  if(masterOfEntropy(entropy)!==secret)throw new Error('The device lock holds another wallet’s recovery phrase.');
  const bytes=hexToBytes(entropy);
  try{return entropyToMnemonic(bytes,wordlist);}finally{bytes.fill(0);}
 }catch(cause){throw unlockError(cause);}
}
