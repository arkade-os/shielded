import assert from 'node:assert/strict';
import {test} from 'node:test';
import {base64urlnopad} from '@scure/base';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {WebAuthnClient} from '@arkade-os/sdk';
import {createPasskeySeed,restorePasskeySeed,type PasskeyWordCount} from '../packages/protocol/src/passkey.ts';
import {nativePasskeys} from '../app/src/native-passkeys.ts';
import {saveNativeSetup} from '../app/src/native-setup.ts';
import {commitNativeSetup,waitNativePasskeyForeground} from '../app/src/native-passkey-operation.ts';
import {pendingNativeSetup,prepareNativeSetup} from '../app/src/native-setup-journal.ts';
import {passkeyRecord,passkeyRecordOf} from '../app/src/passkey-record.ts';

const RP='shielded.mutinynet.arkade.sh',expected={phase:'ready' as const,generation:3,mode:'tor' as const};
const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const encode=(value:Uint8Array)=>base64urlnopad.encode(value);

for(const wordCount of [12,24] as PasskeyWordCount[])test(`native ${wordCount}-word creation waits for activation before its one confirming prompt and restores in a browser`,async()=>{
 const storage=memory(),calls:string[]=[],hidden=deferred<void>(),activate=deferred<void>(),controller=new AbortController();
 const id=Uint8Array.of(1,2,3),prf=new Uint8Array(32).fill(7);let handle=new Uint8Array(),foreground=true,vault:string|null=null,words='';
 const current=()=>{if(controller.signal.aborted)throw new Error('Retired');};
 const before=()=>waitNativePasskeyForeground(expected,async()=>expected,current,()=>foreground,async()=>{hidden.resolve();await activate.promise;});
 const client=nativePasskeys(async(command,args)=>{
  const request=JSON.parse(args.request);calls.push(command);
  if(command.endsWith('passkey_create')){
   handle=Uint8Array.from(base64urlnopad.decode(request.user.id));foreground=false;
   return JSON.stringify({id:encode(id),rawId:encode(id),type:'public-key',clientExtensionResults:{prf:{enabled:true}}});
  }
  assert.deepEqual(request.allowCredentials.map((entry:{id:string})=>entry.id),[encode(id)]);
  return JSON.stringify({id:encode(id),rawId:encode(id),type:'public-key',response:{userHandle:encode(handle)},clientExtensionResults:{prf:{results:{first:encode(prf)}}}});
 },{signal:controller.signal,current,before});
 const setup=saveNativeSetup(expected,async()=>expected,()=>!controller.signal.aborted,async()=>{
  const seed=await createPasskeySeed({rpId:RP,userName:'test wallet',wordCount,client});
  try{words=seed.words;return bytesToHex(seed.master);}finally{seed.master.fill(0);}
 },async secret=>commitNativeSetup({expected,status:async()=>expected,current,foreground:()=>foreground,storage,secret,metadata:{passkey:{version:1,credentialId:encode(id),label:'Default',words:wordCount},created:123},read:async()=>vault,write:async value=>{assert.ok(pendingNativeSetup(storage));assert.equal(vault,null);vault=value;}}));
 await hidden.promise;assert.deepEqual(calls,['plugin:shielded-platform|passkey_create']);assert.equal(vault,null);assert.equal(storage.length,0);
 foreground=true;activate.resolve();await setup;
 assert.deepEqual(calls,['plugin:shielded-platform|passkey_create','plugin:shielded-platform|passkey_get']);
 const browser:WebAuthnClient={create:async()=>{throw new Error('restore must not create');},get:async()=>({rawId:id,response:{userHandle:handle},getClientExtensionResults:()=>({prf:{results:{first:prf.slice()}}})}) as unknown as Credential};
 const restored=await restorePasskeySeed({rpId:RP,client:browser});
 try{assert.equal(bytesToHex(restored.master),vault);assert.equal(restored.words,words);assert.equal(restored.wordCount,wordCount);assert.deepEqual(passkeyRecordOf(storage),passkeyRecord(restored));}finally{restored.master.fill(0);}
 for(let i=0;i<storage.length;i++){const value=storage.getItem(storage.key(i)!)!;assert.ok(!value.includes(vault!)&&!value.includes(words));}
});

test('cancelling a native registration owner settles before its late provider reply and never confirms it',async()=>{
 const reply=deferred<string>(),entered=deferred<void>(),controller=new AbortController(),calls:string[]=[];
 const client=nativePasskeys(async command=>{calls.push(command);entered.resolve();return reply.promise;},{signal:controller.signal});
 const setup=createPasskeySeed({rpId:RP,userName:'test wallet',client});
 await entered.promise;controller.abort();await assert.rejects(setup,error=>error instanceof Error&&error.name==='PasskeyCancelled');
 reply.resolve(JSON.stringify({id:'AQID',rawId:'AQID',type:'public-key',clientExtensionResults:{prf:{enabled:true}}}));
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['plugin:shielded-platform|passkey_create']);
});

test('a pending 24-word native setup finishes with the same credential when its provider omits the handle',async()=>{
 const storage=memory(),id=Uint8Array.of(1,2,3),prf=new Uint8Array(32).fill(7),calls:string[]=[];let vault:string|null=null;
 const client=nativePasskeys(async(command,args)=>{
  calls.push(command);
  if(command.endsWith('passkey_get'))assert.deepEqual(JSON.parse(args.request).allowCredentials.map((entry:{id:string})=>entry.id),[encode(id)]);
  return JSON.stringify({id:encode(id),rawId:encode(id),type:'public-key',response:{userHandle:null},clientExtensionResults:{prf:{enabled:true,results:{first:encode(prf)}}}});
 });
 const made=await createPasskeySeed({rpId:RP,userName:'test wallet',wordCount:24,client}),secret=bytesToHex(made.master);
 prepareNativeSetup(storage,secret,{passkey:passkeyRecord(made),created:123});
 const pending=pendingNativeSetup(storage)!,seed=await restorePasskeySeed({rpId:RP,credentialId:base64urlnopad.decode(pending.passkey!.credentialId),wordCount:pending.passkey!.words,client});
 try{
  await commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret:bytesToHex(seed.master),metadata:{passkey:passkeyRecord(seed),created:999},read:async()=>vault,write:async value=>{vault=value;}});
  assert.equal(vault,secret);assert.equal(seed.words,made.words);assert.equal(pendingNativeSetup(storage),undefined);
  assert.deepEqual(passkeyRecordOf(storage),passkeyRecord(made));assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
  assert.equal(calls.filter(command=>command.endsWith('passkey_create')).length,1);
 }finally{made.master.fill(0);seed.master.fill(0);}
});
