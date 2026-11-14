import type {WebAuthnClient} from '@arkade-os/sdk';
import {base64urlnopad} from '@scure/base';
import {invoke} from '@tauri-apps/api/core';

interface ResponseJSON {id:string;type:string;rawId:string;response?:{userHandle?:string|null};clientExtensionResults?:{prf?:{enabled?:boolean;results?:{first:string}}}}
type Call=(command:string,args:{request:string})=>Promise<string>;

const CANCELLED='Passkey cancelled',UNAVAILABLE='Passkey unavailable';
const view=(value:unknown)=>value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):undefined;
const encode=(_key:string,value:unknown)=>{const bytes=view(value);return bytes?base64urlnopad.encode(bytes):value;};
const decode=(value:string)=>base64urlnopad.decode(value.replace(/=+$/,''));

function credential(json:string){
 try{
  const c=JSON.parse(json) as ResponseJSON,prf=c.clientExtensionResults?.prf,handle=c.response?.userHandle;
  const outputs={prf:prf&&{enabled:prf.enabled,results:prf.results&&{first:decode(prf.results.first)}}};
  return {id:c.id,type:c.type,rawId:decode(c.rawId),response:{userHandle:handle?decode(handle):null},getClientExtensionResults:()=>outputs};
 }catch{throw new Error(UNAVAILABLE);}// V8's parse errors quote nearby input, which here is the PRF secret.
}

/** The SDK's WebAuthnClient over Android Credential Manager, which speaks WebAuthn's JSON forms rather than DOM objects. */
export function nativePasskeys(call:Call=invoke):WebAuthnClient{
 const ceremony=async(command:string,publicKey:unknown)=>{
  let json:string;
  try{json=await call(`plugin:shielded-platform|${command}`,{request:JSON.stringify(publicKey,encode)});}
  catch(error){throw error===CANCELLED?new DOMException('The passkey prompt was cancelled.','NotAllowedError'):new Error(typeof error==='string'?error:UNAVAILABLE);}
  return credential(json);
 };
 return {create:options=>ceremony('passkey_create',options.publicKey),get:options=>ceremony('passkey_get',options.publicKey)};
}
