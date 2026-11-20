import type {WebAuthnClient} from '@arkade-os/sdk';
import {bytesToHex} from '@noble/hashes/utils.js';
import {base64urlnopad} from '@scure/base';
import {lockWithHandle,passkeyUserHandle,unlockWithHandle} from '../../packages/protocol/src/passkey.ts';
import {parseMasterSecret,randomRecoveryPhrase} from '../../packages/protocol/src/wallet-keys.ts';
import {BORN,CREATED,PASSKEY_STEPS,SECRET,WALLET_EXISTS,type PageStorage} from './shielded-page.ts';
import {passkeyRecordOf,savePasskey} from './passkey-record.ts';

export const LOCKED='shielded-rollup-wallet-locked-v1';
export const isWindowsBrowser=()=>(navigator as Navigator&{userAgentData?:{platform?:string}}).userAgentData?.platform==='Windows'||/Windows/.test(navigator.userAgent);
/** Where Backup reads the words: a stored secret wins over a lock an interrupted restore left behind. */
export function revealSource(storage:Pick<Storage,'getItem'>):'locked'|'passkey'|'secret'{
 if(!storage.getItem(SECRET)&&storage.getItem(LOCKED)!==null)return 'locked';
 return passkeyRecordOf(storage)?.words===12?'passkey':'secret';
}
export type LockedRecord={version:1;lock:'handle';credentialId:string;words:12|24;blob:string};
const B64=/^[A-Za-z0-9_-]{1,4096}$/;
export function lockedRecordOf(storage:Pick<Storage,'getItem'>):LockedRecord|undefined{
 const raw=storage.getItem(LOCKED);
 if(raw===null)return undefined;
 let value:Partial<LockedRecord>|null=null;
 try{value=JSON.parse(raw);}catch{}
 if(value&&typeof value==='object'&&value.version===1&&value.lock==='handle'&&typeof value.credentialId==='string'&&B64.test(value.credentialId)&&typeof value.blob==='string'&&B64.test(value.blob)&&(value.words===12||value.words===24))return value as LockedRecord;
 throw new Error("The locked wallet record is invalid. Keep this browser's data.");
}
const secretOf=(words:string)=>{const master=parseMasterSecret(words);try{return bytesToHex(master);}finally{master.fill(0);}};
/** `created` is the passkey's own time, so the unlock screen names the passkey as it was saved. Nothing is written until the passkey gives this handle back to unlock's own request; LOCKED goes last, so a torn write never leaves a lock without its date. */
export async function createLockedPageWallet(storage:PageStorage,o:{rpId:string;credentialId:Uint8Array;userHandle:Uint8Array;wordCount:12|24;created?:number;client?:WebAuthnClient}){
 try{
  if(storage.getItem(SECRET)||lockedRecordOf(storage))throw new Error(WALLET_EXISTS);
  const unconfirmed=(cause?:unknown)=>Object.assign(new Error(PASSKEY_STEPS.unconfirmed,{cause}),{name:'PasskeyUnconfirmed',credentialId:o.credentialId});
  const returned=await passkeyUserHandle(o).catch((cause:unknown)=>{throw unconfirmed(cause);});
  const same=returned.length===o.userHandle.length&&returned.every((byte,i)=>byte===o.userHandle[i]);returned.fill(0);
  if(!same)throw unconfirmed();
  const words=randomRecoveryPhrase(o.wordCount),secret=secretOf(words);
  const blob=await lockWithHandle({credentialId:o.credentialId,userHandle:o.userHandle,words});
  if(storage.getItem(SECRET)||lockedRecordOf(storage))throw new Error(WALLET_EXISTS);
  const record:LockedRecord={version:1,lock:'handle',credentialId:base64urlnopad.encode(o.credentialId),words:o.wordCount,blob:base64urlnopad.encode(blob)};
  storage.setItem(BORN,'new');storage.setItem(CREATED,String(o.created??Date.now()));savePasskey(storage);storage.setItem(LOCKED,JSON.stringify(record));
  return {secret,words};
 }finally{o.userHandle.fill(0);}
}
export async function unlockPageWallet(storage:Pick<Storage,'getItem'>,o:{rpId:string;client?:WebAuthnClient}){
 const record=lockedRecordOf(storage),raw=storage.getItem(LOCKED);
 if(!record)throw new Error('This browser has no locked wallet.');
 const credentialId=base64urlnopad.decode(record.credentialId),userHandle=await passkeyUserHandle({rpId:o.rpId,credentialId,client:o.client});
 try{
  const words=await unlockWithHandle({credentialId,userHandle,blob:base64urlnopad.decode(record.blob)});
  if(storage.getItem(SECRET)||storage.getItem(LOCKED)!==raw)throw new Error('This wallet changed in another tab. Reload to continue.');
  return {secret:secretOf(words),words};
 }finally{userHandle.fill(0);}
}
