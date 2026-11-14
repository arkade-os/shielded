import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {DEFAULT_PASSKEY_LABEL,type WebAuthnClient} from '@arkade-os/sdk';
import {PASSKEY_SEED_SALT,PASSKEY_UNLOCK_SALT,createPasskeySeed,passkeyFailure,passkeyRpId,passkeyUserId,restorePasskeySeed,unwrapWalletSecret,wordCountFromUserHandle,wrapWalletSecret,type PasskeyWordCount} from '../packages/protocol/src/passkey.ts';

const RP='shielded.mutinynet.arkade.sh';
const hex=(value:Uint8Array)=>bytesToHex(value);
const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
const saltOf=(extensions:unknown)=>view((extensions as {prf:{eval:{first:BufferSource}}}).prf.eval.first);

interface FakeOptions {prf?:(salt:Uint8Array)=>Uint8Array;handle?:Uint8Array|null;onCreate?:()=>void;onGet?:()=>void}
/** A WebAuthn client returning the DOM credential shape the SDK reads: rawId, getClientExtensionResults().prf and response.userHandle. */
function fakeClient(options:FakeOptions={}){
 const prfOf=options.prf??(salt=>sha256(salt));
 const calls:{kind:'create'|'get';rpId:string;salt:string}[]=[];
 let made:{id:Uint8Array;handle:Uint8Array|null}|undefined;
 const credential=(id:Uint8Array,handle:Uint8Array|null,salt:Uint8Array)=>({
  id:'fake',type:'public-key',rawId:id,response:{userHandle:handle},
  getClientExtensionResults:()=>({prf:{enabled:true,results:{first:prfOf(salt)}}}),
 } as unknown as Credential);
 const client:WebAuthnClient={
  async create(options_){
   const key=options_.publicKey!,salt=saltOf(key.extensions);
   calls.push({kind:'create',rpId:key.rp.id!,salt:hex(salt)});
   options.onCreate?.();
   const userId=view(key.user.id);
   made={id:sha256(userId).slice(0,16),handle:options.handle===undefined?userId:options.handle};
   return credential(made.id,made.handle,salt);
  },
  async get(options_){
   const key=options_.publicKey!,salt=saltOf(key.extensions);
   calls.push({kind:'get',rpId:key.rpId!,salt:hex(salt)});
   options.onGet?.();
   made??={id:sha256(new Uint8Array(1)).slice(0,16),handle:options.handle??null};
   return credential(made.id,made.handle,salt);
  },
 };
 return {client,calls};
}
const dismissed=()=>{throw Object.assign(new Error('dismissed'),{name:'NotAllowedError'});};
const caught=async(run:()=>Promise<unknown>)=>{try{await run();}catch(error){return error;}throw new Error('that call was expected to fail');};

test('a passkey seed restores to the same wallet it created, for 12 and for 24 words',async()=>{
 const masters=new Set<string>();
 for(const wordCount of [12,24] as PasskeyWordCount[]){
  const fake=fakeClient(),made=await createPasskeySeed({rpId:RP,userName:'Shielded',wordCount,client:fake.client});
  const back=await restorePasskeySeed({rpId:RP,client:fake.client});
  assert.equal(made.words.split(' ').length,wordCount);
  assert.deepEqual(back,made,'restore reads the word count from the user handle');
  assert.equal(hex(back.master),hex(made.master));
  assert.equal(fake.calls[0]?.rpId,RP);
  assert.deepEqual([...new Set(fake.calls.map(call=>call.salt))],[hex(PASSKEY_SEED_SALT)]);
  masters.add(hex(made.master));
 }
 assert.equal(masters.size,2,'the same PRF secret gives a different wallet at each word count');
 assert.deepEqual(PASSKEY_SEED_SALT,new TextEncoder().encode(DEFAULT_PASSKEY_LABEL));
});

test('the user handle carries the word count, and a handle from elsewhere restores as 12 words',async()=>{
 const id=passkeyUserId(24);
 assert.equal(id.length,32);
 assert.equal(wordCountFromUserHandle(id),24);
 assert.equal(wordCountFromUserHandle(passkeyUserId(12)),12);
 assert.notEqual(hex(passkeyUserId(12)),hex(passkeyUserId(12)));
 for(const handle of [null,new Uint8Array(32),sha256(new TextEncoder().encode('a passkey made elsewhere')),id.subarray(0,31),Uint8Array.from([...id.subarray(0,2),0x99,...id.subarray(3)])])
  assert.equal(wordCountFromUserHandle(handle),12,'only this format names a count');
 const fake=fakeClient({handle:Uint8Array.from([9,...crypto.getRandomValues(new Uint8Array(31))])});
 await createPasskeySeed({rpId:RP,userName:'Shielded',wordCount:24,client:fake.client});
 const back=await restorePasskeySeed({rpId:RP,client:fake.client});
 assert.equal(back.wordCount,12);
 assert.equal(passkeyRpId('https://shielded.mutinynet.arkade.sh','tauri.localhost'),RP);
 assert.equal(passkeyRpId('',RP),RP);
 assert.equal(passkeyRpId('','localhost'),'localhost');
});

test('a fixed PRF secret derives fixed words and a fixed master secret',async()=>{
 const prf=Uint8Array.from({length:32},(_,index)=>index),fake=fakeClient({prf:()=>prf});
 const twelve=await createPasskeySeed({rpId:RP,userName:'Shielded',client:fake.client});
 assert.equal(twelve.wordCount,12,'twelve words is the default');
 assert.equal(twelve.words,'abandon amount liar amount expire adjust cage candy arch gather drum buyer');
 assert.equal(hex(twelve.master),'9c4939c6f23c1bb13508c83c12036974cdd2f818b14bdf17a7b6e6c875a032d6');
 const full=await createPasskeySeed({rpId:RP,userName:'Shielded',wordCount:24,client:fakeClient({prf:()=>prf}).client});
 assert.equal(full.words,'abandon amount liar amount expire adjust cage candy arch gather drum bullet absurd math era live bid rhythm alien crouch range attend journey unaware');
 assert.equal(hex(full.master),hex(prf),'24 words are the PRF secret itself');
});

test('the unlock wrap uses its own PRF salt, round-trips, and rejects a tampered blob',async()=>{
 const fake=fakeClient(),seed=await createPasskeySeed({rpId:RP,userName:'Shielded',client:fake.client});
 const secret='ab'.repeat(32),{credentialId}=seed;
 const blob=await wrapWalletSecret({rpId:RP,credentialId,secret,client:fake.client});
 assert.equal(await unwrapWalletSecret({rpId:RP,credentialId,blob,client:fake.client}),secret);
 assert.equal(blob.length,1+12+secret.length+16);
 assert.equal(blob[0],1);
 const unlock=fake.calls.filter(call=>call.salt===hex(PASSKEY_UNLOCK_SALT));
 assert.equal(unlock.length,2,'wrap and unwrap each ask for the unlock salt');
 assert.notEqual(hex(PASSKEY_UNLOCK_SALT),hex(PASSKEY_SEED_SALT));
 const again=await wrapWalletSecret({rpId:RP,credentialId,secret,client:fake.client});
 assert.notEqual(hex(again.subarray(1,13)),hex(blob.subarray(1,13)),'a fresh IV each time');
 assert.equal(await unwrapWalletSecret({rpId:RP,credentialId,blob:again,client:fake.client}),secret);
 const torn=Uint8Array.from(blob);torn[torn.length-1]^=1;
 await assert.rejects(unwrapWalletSecret({rpId:RP,credentialId,blob:torn,client:fake.client}));
 const reversioned=Uint8Array.from(blob);reversioned[0]=2;
 await assert.rejects(unwrapWalletSecret({rpId:RP,credentialId,blob:reversioned,client:fake.client}),/lock record/);
 await assert.rejects(unwrapWalletSecret({rpId:RP,credentialId,blob:blob.subarray(0,20),client:fake.client}),/lock record/);
 await assert.rejects(unwrapWalletSecret({rpId:RP,credentialId:Uint8Array.from([...credentialId,7]),blob,client:fake.client}),'the credential id is associated data');
 const seedPrf=fakeClient({prf:()=>sha256(PASSKEY_SEED_SALT)});
 await createPasskeySeed({rpId:RP,userName:'Shielded',client:seedPrf.client});
 await assert.rejects(unwrapWalletSecret({rpId:RP,credentialId,blob,client:seedPrf.client}),'the seed secret cannot open the wrap');
});

test('each passkey failure the SDK raises maps to one outcome the app can act on',async()=>{
 const cancelled=await caught(()=>createPasskeySeed({rpId:RP,userName:'Shielded',client:fakeClient({onCreate:dismissed}).client}));
 assert.equal((cancelled as Error).name,'PasskeyCancelled');
 assert.deepEqual(passkeyFailure(cancelled),{outcome:'cancelled'},'a dismissed prompt created nothing');
 const short=await caught(()=>createPasskeySeed({rpId:RP,userName:'Shielded',client:fakeClient({prf:()=>new Uint8Array(31)}).client}));
 assert.equal((short as Error).name,'PrfUnavailable');
 assert.equal(passkeyFailure(short)?.outcome,'unavailable');
 assert.equal(passkeyFailure(short)?.credentialId?.length,16,'the passkey exists and can be named');
 const restore=await caught(()=>restorePasskeySeed({rpId:RP,client:fakeClient({prf:()=>new Uint8Array(31)}).client}));
 assert.deepEqual(passkeyFailure(restore),{outcome:'unavailable'});
 const unconfirmed=await caught(()=>createPasskeySeed({rpId:RP,userName:'Shielded',client:fakeClient({onGet:dismissed}).client}));
 assert.equal((unconfirmed as Error).name,'PasskeyUnconfirmed');
 assert.equal(passkeyFailure(unconfirmed)?.outcome,'unconfirmed');
 assert.equal(passkeyFailure(unconfirmed)?.credentialId?.length,16);
 for(const other of [new Error('offline'),'nope',null,{name:'NotAllowedError'}])assert.equal(passkeyFailure(other),undefined);
});
