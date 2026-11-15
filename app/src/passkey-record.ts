import {DEFAULT_PASSKEY_LABEL} from '@arkade-os/sdk';
import {base64urlnopad} from '@scure/base';
import type {PasskeySeed,PasskeyWordCount} from '../../packages/protocol/src/passkey.ts';

export const PASSKEY='shielded-rollup-wallet-passkey-v1';
export type PasskeyRecord={version:1;credentialId:string;label:string;words:PasskeyWordCount};
export const passkeyRecord=(seed:PasskeySeed):PasskeyRecord=>({version:1,credentialId:base64urlnopad.encode(seed.credentialId),label:DEFAULT_PASSKEY_LABEL,words:seed.wordCount});
export const savePasskey=(storage:Pick<Storage,'setItem'|'removeItem'>,record?:PasskeyRecord)=>record?storage.setItem(PASSKEY,JSON.stringify({version:1,credentialId:record.credentialId,label:record.label,words:record.words})):storage.removeItem(PASSKEY);
export function validPasskeyRecord(record:unknown):record is PasskeyRecord{
 if(!record||typeof record!=='object')return false;
 const value=record as Partial<PasskeyRecord>;
 return value.version===1&&typeof value.credentialId==='string'&&/^[A-Za-z0-9_-]{1,4096}$/.test(value.credentialId)&&typeof value.label==='string'&&value.label.length<=128&&(value.words===12||value.words===24);
}
export function passkeyRecordOf(storage:Pick<Storage,'getItem'>):PasskeyRecord|undefined{
 try{const record:unknown=JSON.parse(storage.getItem(PASSKEY)??'null');return validPasskeyRecord(record)?record:undefined;}
 catch{return undefined;}
}
