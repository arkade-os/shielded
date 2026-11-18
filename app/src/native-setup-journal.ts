import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';
import {PASSKEY,savePasskey,validPasskeyRecord,type PasskeyRecord} from './passkey-record.ts';

export const NATIVE_SETUP='shielded-native-setup-v1';
const BORN='shielded-rollup-wallet-born-v1',CREATED='shielded-rollup-wallet-created-v1',SENT='shielded-rollup-sent-v1';
type Setup={version:1;tag:string;passkey?:PasskeyRecord;created?:number};
const valid=(value:string)=>/^[0-9a-f]{64}$/.test(value);
const tag=(secret:string)=>{if(!valid(secret))throw new Error('Invalid native wallet secret.');return bytesToHex(sha256(hexToBytes(secret)));};
export function pendingNativeSetup(base:Pick<Storage,'getItem'>):Setup|undefined{
 const raw=base.getItem(NATIVE_SETUP);if(raw===null)return;
 try{
  const value=JSON.parse(raw) as Setup;
  if(value?.version!==1||!valid(value.tag)||value.passkey!==undefined&&!validPasskeyRecord(value.passkey)||value.created!==undefined&&(!Number.isSafeInteger(value.created)||value.created<0))throw new Error();
  return value;
 }catch{throw new Error('The native setup record is invalid. Keep the app data.');}
}
export function prepareNativeSetup(base:Pick<Storage,'getItem'|'setItem'>,secret:string,options:{passkey?:PasskeyRecord;created?:number}):Setup{
 const next=tag(secret),pending=pendingNativeSetup(base);
 if(pending){if(pending.tag!==next)throw new Error('The wallet does not match the pending setup. Finish that setup before trying another wallet.');return pending;}
 if(options.passkey!==undefined&&!validPasskeyRecord(options.passkey)||options.created!==undefined&&(!Number.isSafeInteger(options.created)||options.created<0))throw new Error('The native setup metadata is invalid.');
 const record=options.passkey,payload:Setup={version:1,tag:next,...record?{passkey:{version:1,credentialId:record.credentialId,label:record.label,words:record.words}}:{},...options.created===undefined?{}:{created:options.created}};
 base.setItem(NATIVE_SETUP,JSON.stringify(payload));return payload;
}
export function reconcileNativeSetup(base:Storage,secret:string|null):Setup|undefined{
 const pending=pendingNativeSetup(base);if(!pending)return;
 if(secret===null)return pending;
 if(pending.tag!==tag(secret))throw new Error('The vault secret does not match the pending setup. Keep the app data.');
 for(let i=base.length-1;i>=0;i--){const key=base.key(i);if(key&&(key.startsWith(BORN)||key===CREATED||key===SENT||key===PASSKEY))base.removeItem(key);}
 savePasskey(base,pending.passkey);
 if(pending.created!==undefined){base.setItem(BORN,'new');base.setItem(CREATED,String(pending.created));}
 base.setItem('shielded-native-wallet','1');base.removeItem(NATIVE_SETUP);
}
