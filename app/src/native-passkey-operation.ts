import type {NativeStatus} from '../../src/native/transport.ts';
import {pendingNativeSetup,prepareNativeSetup,reconcileNativeSetup} from './native-setup-journal.ts';

const changed=()=>new Error('The connection changed. Wait until it is ready and try again.');
export async function waitNativePasskeyForeground(expected:NativeStatus,status:()=>Promise<NativeStatus>,current:()=>void,foreground:()=>boolean,delay:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,50))){
 if(expected.phase!=='ready')throw changed();
 for(;;){
  current();
  if(foreground()){
   const latest=await status();current();
   if(latest.phase!=='ready'||latest.generation!==expected.generation||(latest.mode??'tor')!==(expected.mode??'tor'))throw changed();
   if(foreground()&&latest.foreground!==false)return;
  }
  await delay();
 }
}

export async function commitNativeSetup(o:{expected:NativeStatus;status:()=>Promise<NativeStatus>;current:()=>void;foreground:()=>boolean;storage:Storage;secret:string;metadata:Parameters<typeof prepareNativeSetup>[2];recordBeforeWrite?:boolean;read:()=>Promise<string|null>;write:(secret:string)=>Promise<void>;onWrite?:(promise:Promise<void>)=>void}){
 const recordBeforeWrite=o.recordBeforeWrite!==false,created=o.metadata.created;
 if(!recordBeforeWrite&&(o.metadata.passkey!==undefined||created===undefined||!Number.isSafeInteger(created)||created<0))throw new Error('The native setup metadata is invalid.');
 await waitNativePasskeyForeground(o.expected,o.status,o.current,o.foreground);
 const existing=await o.read();o.current();
 if(existing!==null&&!pendingNativeSetup(o.storage))throw new Error('A wallet already exists on this device. Reopen it before continuing.');
 for(;;){
  await waitNativePasskeyForeground(o.expected,o.status,o.current,o.foreground);o.current();
  if(!o.foreground())continue;
  if(recordBeforeWrite)prepareNativeSetup(o.storage,o.secret,o.metadata);
  else if(pendingNativeSetup(o.storage))throw new Error('Finish the pending setup before creating another wallet.');
  o.current();
  if(o.foreground())break;
 }
 const writing=(async()=>{
  if(existing===null)await o.write(o.secret);
  // A fresh random seed has no recovery phrase yet; missing birth metadata after a lost acknowledgement safely triggers a full scan.
  if(!recordBeforeWrite)prepareNativeSetup(o.storage,o.secret,o.metadata);
  reconcileNativeSetup(o.storage,existing??o.secret,o.metadata.lock!==undefined);
 })();
 o.onWrite?.(writing);await writing;
}
