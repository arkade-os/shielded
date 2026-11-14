import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex as hex} from '@noble/hashes/utils.js';
import {base64urlnopad} from '@scure/base';
import type {WebAuthnClient} from '@arkade-os/sdk';
import {PASSKEY_SEED_SALT,type PasskeyWordCount} from '../packages/protocol/src/passkey.ts';
import {parseMasterSecret} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {BORN,CREATED,PASSKEY,SECRET,createPageWallet,createPasskeyPageWallet,pageCache,passkeyNextStep,passkeyRecordOf,passkeyWords,restorePageWallet,restorePasskeyPageWallet} from '../app/src/shielded-page.ts';
import {WalletBackupCard} from '../app/src/WalletSecurityMenu.tsx';

const RP='shielded.mutinynet.arkade.sh';
const storageOf=()=>{
 const rows=new Map<string,string>();
 return {rows,get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);}};
};
const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
const prfOf=(id:Uint8Array,salt:Uint8Array)=>sha256(Uint8Array.from([...id,...salt]));
type Made={id:Uint8Array;handle:Uint8Array;name:string};
/** Passkeys synced to one account: each client over the same store is another browser signed in to it. */
function syncedPasskeys(prf=prfOf){
 const made:Made[]=[],asked:(string[]|undefined)[]=[];
 const credential=(key:Made,extensions:unknown)=>{
  const salt=view((extensions as {prf:{eval:{first:BufferSource}}}).prf.eval.first);
  return {rawId:key.id,response:{userHandle:key.handle},getClientExtensionResults:()=>({prf:{enabled:true,results:{first:prf(key.id,salt)}}})} as unknown as Credential;
 };
 const client=(fail:{create?:()=>void;get?:()=>void}={}):WebAuthnClient=>({
  async create(options){
   const key=options.publicKey!;fail.create?.();
   const next={id:crypto.getRandomValues(new Uint8Array(16)),handle:view(key.user.id).slice(),name:key.user.name};
   made.push(next);return credential(next,key.extensions);
  },
  async get(options){
   const key=options.publicKey!,allow=key.allowCredentials?.map(entry=>hex(view(entry.id)));asked.push(allow);fail.get?.();
   const pick=made.find(entry=>!allow||allow.includes(hex(entry.id)));
   if(!pick)throw Object.assign(new Error('no passkey'),{name:'NotAllowedError'});
   return credential(pick,key.extensions);
  },
 });
 return {client,made,asked};
}
const dismissed=()=>{throw Object.assign(new Error('dismissed'),{name:'NotAllowedError'});};
const restoreInto=(storage:ReturnType<typeof storageOf>,events:string[])=>({cache:pageCache(new InMemoryShieldedNoteRepository()),storage,stop:async()=>{events.push('stop');},reload:()=>{events.push('reload');}});

test('a passkey wallet stores today’s secret beside its passkey record, and shows its words at their own count',async()=>{
 for(const wordCount of [12,24] as PasskeyWordCount[]){
  const synced=syncedPasskeys(),storage=storageOf();
  const made=await createPasskeyPageWallet(storage,{rpId:RP,wordCount,client:synced.client()});
  const key=synced.made[0]!,prf=prfOf(key.id,PASSKEY_SEED_SALT);
  assert.equal(made.words.split(' ').length,wordCount);
  assert.match(made.secret,/^[0-9a-f]{64}$/);
  assert.equal(storage.getItem(SECRET),made.secret);
  assert.equal(hex(parseMasterSecret(made.words)),made.secret,'the words restore the stored secret');
  assert.deepEqual(JSON.parse(storage.getItem(PASSKEY)!),{version:1,credentialId:base64urlnopad.encode(key.id),label:'Default',words:wordCount});
  assert.deepEqual([...storage.rows.keys()].sort(),[BORN,CREATED,PASSKEY,SECRET].sort());
  assert.match(key.name,/^Shielded wallet · \S/);
  for(const value of storage.rows.values()){
   assert.ok(!value.includes(made.words),'no words at rest');
   if(wordCount===12)assert.ok(!value.includes(hex(prf.subarray(0,16))),'no PRF output or entropy at rest');
  }
  if(wordCount===24)assert.equal(made.secret,hex(prf),'a 24-word secret is its PRF output, as every 24-word secret is its words');
  const card=renderToStaticMarkup(createElement(WalletBackupCard,{words:passkeyRecordOf(storage)!.words,phrase:made.words,reveal:true,onReveal:()=>{},onSaved:()=>{}}));
  assert.match(card,new RegExp(`These ${wordCount} words restore your pool notes`));
  assert.equal([...card.matchAll(/<li>/g)].length,wordCount);
 }
});

test('the passkey restores the same wallet in another browser, at the word count it was made with',async()=>{
 for(const wordCount of [12,24] as PasskeyWordCount[]){
  const synced=syncedPasskeys(),first=storageOf(),second=storageOf(),events:string[]=[];
  const made=await createPasskeyPageWallet(first,{rpId:RP,wordCount,client:synced.client()});
  await restorePasskeyPageWallet({...restoreInto(second,events),rpId:RP,client:synced.client()});
  assert.deepEqual(events,['stop','reload']);
  assert.equal(second.getItem(SECRET),made.secret);
  assert.deepEqual(passkeyRecordOf(second),passkeyRecordOf(first));
  assert.deepEqual(synced.asked,[[hex(synced.made[0]!.id)],undefined],'creation confirms its own passkey; restore offers every passkey for the relying party');
 }
});

test('a 12-word passkey wallet shows its words again only through its own passkey',async()=>{
 const synced=syncedPasskeys(),storage=storageOf();
 const made=await createPasskeyPageWallet(storage,{rpId:RP,wordCount:12,client:synced.client()});
 await createPasskeyPageWallet(storageOf(),{rpId:RP,wordCount:12,client:synced.client()});
 assert.equal(await passkeyWords(storage,{rpId:RP,client:synced.client()}),made.words);
 assert.deepEqual(synced.asked.at(-1),[hex(synced.made[0]!.id)],'the prompt names this wallet’s passkey');
 storage.setItem(PASSKEY,JSON.stringify({...passkeyRecordOf(storage),credentialId:base64urlnopad.encode(synced.made[1]!.id)}));
 await assert.rejects(passkeyWords(storage,{rpId:RP,client:synced.client()}),/does not open this wallet/);
 await assert.rejects(passkeyWords(storageOf(),{rpId:RP,client:synced.client()}),/not made with a passkey/);
});

test('each passkey failure lands on its next step, and leaves nothing stored',async()=>{
 const events:string[]=[],short=syncedPasskeys(()=>new Uint8Array(31));
 const failed=async(run:(storage:ReturnType<typeof storageOf>)=>Promise<unknown>)=>{
  const storage=storageOf(),error=await run(storage).then(()=>{throw new Error('expected a passkey failure');},(cause:unknown)=>cause);
  assert.equal(storage.length,0,'no secret and no passkey record');
  return passkeyNextStep(error)!;
 };
 const cancelled=await failed(storage=>createPasskeyPageWallet(storage,{rpId:RP,wordCount:12,client:syncedPasskeys().client({create:dismissed})}));
 assert.equal(cancelled.retry,true);assert.match(cancelled.message,/nothing was saved/);assert.doesNotMatch(cancelled.message,/delete/);
 const unavailable=await failed(storage=>createPasskeyPageWallet(storage,{rpId:RP,wordCount:12,client:short.client()}));
 assert.equal(unavailable.retry,false);assert.match(unavailable.message,/cannot create a wallet key\. Create or restore a wallet with a recovery phrase/);
 assert.match(unavailable.message,/delete the passkey it made/,'the passkey exists, so say where it can go');
 const unconfirmed=await failed(storage=>createPasskeyPageWallet(storage,{rpId:RP,wordCount:12,client:syncedPasskeys().client({get:dismissed})}));
 assert.equal(unconfirmed.retry,false,'an unconfirmed passkey is never prompted for again');
 assert.match(unconfirmed.message,/made but could not be used.*recovery phrase/);
 const restoreCancelled=await failed(storage=>restorePasskeyPageWallet({...restoreInto(storage,events),rpId:RP,client:syncedPasskeys().client({get:dismissed})}));
 assert.equal(restoreCancelled.retry,true);
 const restoreUnavailable=await failed(storage=>restorePasskeyPageWallet({...restoreInto(storage,events),rpId:RP,client:short.client()}));
 assert.equal(restoreUnavailable.retry,false);assert.doesNotMatch(restoreUnavailable.message,/delete/);
 assert.deepEqual(events,[],'a failed restore never stops the page');
 assert.equal(passkeyNextStep(new Error('offline')),undefined);
});

test('a passkey never replaces this browser’s wallet, and a phrase wallet never inherits a passkey record',async()=>{
 const synced=syncedPasskeys(),storage=storageOf(),events:string[]=[];
 await createPasskeyPageWallet(storageOf(),{rpId:RP,wordCount:12,client:synced.client()});
 storage.setItem(SECRET,'ab'.repeat(32));
 await assert.rejects(restorePasskeyPageWallet({...restoreInto(storage,events),rpId:RP,client:synced.client()}),/already exists/);
 await assert.rejects(createPasskeyPageWallet(storage,{rpId:RP,wordCount:12,client:synced.client()}),/already exists/);
 assert.equal(synced.made.length,1,'no passkey is made for a browser that has a wallet');
 assert.deepEqual([...storage.rows],[[SECRET,'ab'.repeat(32)]]);assert.deepEqual(events,[]);
 const stale=JSON.stringify({version:1,credentialId:'AA',label:'Default',words:12}),fresh=storageOf();
 fresh.setItem(PASSKEY,stale);createPageWallet(fresh);assert.equal(fresh.getItem(PASSKEY),null);
 const restored=storageOf();restored.setItem(PASSKEY,stale);
 await restorePageWallet('cd'.repeat(32),restoreInto(restored,events));
 assert.equal(restored.getItem(PASSKEY),null);assert.equal(restored.getItem(SECRET),'cd'.repeat(32));
});
