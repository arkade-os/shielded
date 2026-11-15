import type {WebAuthnClient} from '@arkade-os/sdk';
import {base64urlnopad} from '@scure/base';
import {invoke} from '@tauri-apps/api/core';

interface ResponseJSON {id:string;type:string;rawId:string;response?:{userHandle?:string|null};clientExtensionResults?:{prf?:{enabled?:boolean;results?:{first:string}}}}
type Call=(command:string,args:{request:string})=>Promise<string>;
type Context={signal?:AbortSignal;current?:()=>void;before?:()=>Promise<void>;foreground?:()=>boolean};
export type NativePasskeySupport={available:boolean;reason?:string};
export const nativePasskeySupport=()=>invoke<NativePasskeySupport>('plugin:shielded-platform|passkey_support');

const CANCELLED='Passkey cancelled',UNAVAILABLE='Passkey unavailable';
const view=(value:unknown)=>value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):undefined;
const encode=(_key:string,value:unknown)=>{const bytes=view(value);return bytes?base64urlnopad.encode(bytes):value;};
const decode=(value:string)=>base64urlnopad.decode(value.replace(/=+$/,''));

function credential(json:string){
 try{
  if(json.length>65536)throw new Error();
  const c=JSON.parse(json) as ResponseJSON,prf=c.clientExtensionResults?.prf,handle=c.response?.userHandle;
  if(c.type!=='public-key'||typeof c.id!=='string'||!c.rawId||decode(c.rawId).length>1024)throw new Error();
  const outputs={prf:prf&&{enabled:prf.enabled,results:prf.results&&{first:decode(prf.results.first)}}};
  return {id:c.id,type:c.type,rawId:decode(c.rawId),response:{userHandle:handle?decode(handle):null},getClientExtensionResults:()=>outputs};
 }catch{throw new Error(UNAVAILABLE);}// V8's parse errors quote nearby input, which here is the PRF secret.
}

/** Native WebAuthn JSON for the SDK. `before` waits for foreground before every prompt, including registration's confirming assertion. */
export function nativePasskeys(call:Call=invoke,context:Context={}):WebAuthnClient{
 const check=()=>{if(context.signal?.aborted)throw new DOMException('The passkey prompt was cancelled.','NotAllowedError');context.current?.();};
 const ceremony=async(command:string,publicKey:unknown)=>{
  check();
  do{await context.before?.();check();if(context.foreground&&!context.foreground()&&!context.before)throw new DOMException('Return to Shielded to use your passkey.','NotAllowedError');}while(context.foreground&&!context.foreground());
  let json:string;
  try{json=await new Promise<string>((resolve,reject)=>{
   const abort=()=>reject(new DOMException('The passkey prompt was cancelled.','NotAllowedError'));
   context.signal?.addEventListener('abort',abort,{once:true});
   void call(`plugin:shielded-platform|${command}`,{request:JSON.stringify(publicKey,encode)}).then(resolve,reject).finally(()=>context.signal?.removeEventListener('abort',abort));
  });}
  catch(error){if(error instanceof DOMException&&error.name==='NotAllowedError')throw error;throw error===CANCELLED?new DOMException('The passkey prompt was cancelled.','NotAllowedError'):new Error(UNAVAILABLE);}
  check();
  const result=credential(json),allowed=(publicKey as PublicKeyCredentialRequestOptions).allowCredentials;
  if(command==='passkey_get'&&allowed?.length&&!allowed.some(item=>{const id=view(item.id);return id&&id.length===result.rawId.length&&id.every((byte,i)=>byte===result.rawId[i]);}))throw new Error(UNAVAILABLE);
  return result;
 };
 return {create:options=>ceremony('passkey_create',options.publicKey),get:options=>ceremony('passkey_get',options.publicKey)};
}
