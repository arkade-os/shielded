import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareNativeSetup,pendingNativeSetup,reconcileNativeSetup,NATIVE_LOCK,NATIVE_SETUP} from '../app/src/native-setup-journal.ts';
import {PASSKEY,type PasskeyRecord} from '../app/src/passkey-record.ts';

const SECRET='shielded-rollup-wallet-secret-v1',BORN='shielded-rollup-wallet-born-v1',CREATED='shielded-rollup-wallet-created-v1';
const secret='11'.repeat(32),other='22'.repeat(32),record:PasskeyRecord={version:1,credentialId:'AQID',label:'Default',words:12};
const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};

test('a setup intent contains only the seed tag and public recovery metadata',()=>{
 const base=memory();prepareNativeSetup(base,secret,{passkey:record,created:123});
 const raw=base.getItem(NATIVE_SETUP)!;
 assert.ok(!raw.includes(secret));assert.equal(base.getItem(SECRET),null);
 assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),['version','tag','passkey','created'].sort());
 assert.deepEqual(pendingNativeSetup(base)?.passkey,record);
 assert.equal(base.getItem(PASSKEY),null);assert.equal(base.getItem('shielded-native-wallet'),null);
});

test('an empty vault preserves the intent and only the same seed can retry it',()=>{
 const base=memory();prepareNativeSetup(base,secret,{passkey:record,created:123});
 const raw=base.getItem(NATIVE_SETUP);
 assert.equal(reconcileNativeSetup(base,null)?.tag,pendingNativeSetup(base)?.tag);
 assert.equal(base.getItem(NATIVE_SETUP),raw);
 assert.throws(()=>prepareNativeSetup(base,other,{created:456}),/pending|match/);
 prepareNativeSetup(base,secret,{passkey:{...record,credentialId:'BAUG'},created:999});
 assert.equal(base.getItem(NATIVE_SETUP),raw,'an idempotent retry retains the original credential and birthday');
});

test('a committed or lost-ack setup applies metadata only to its matching vault',()=>{
 const base=memory();prepareNativeSetup(base,secret,{passkey:record,created:123});
 assert.throws(()=>reconcileNativeSetup(base,other),/match/);assert.ok(base.getItem(NATIVE_SETUP));
 assert.equal(base.getItem('shielded-native-wallet'),null);
 reconcileNativeSetup(base,secret);
 assert.equal(pendingNativeSetup(base),undefined);assert.equal(base.getItem('shielded-native-wallet'),'1');
 assert.equal(base.getItem(BORN),'new');assert.equal(base.getItem(CREATED),'123');
 assert.deepEqual(JSON.parse(base.getItem(PASSKEY)!),record);assert.equal(base.getItem(SECRET),null);
});

test('an interrupted metadata commit is replayed without changing its birthday',()=>{
 const source=memory();let interrupted=true;
 const base:Storage={get length(){return source.length;},key:i=>source.key(i),getItem:key=>source.getItem(key),removeItem:key=>source.removeItem(key),clear:()=>source.clear(),setItem(key,value){if(key===CREATED&&interrupted){interrupted=false;throw new Error('storage unavailable');}source.setItem(key,value);}};
 prepareNativeSetup(base,secret,{passkey:record,created:123});
 assert.throws(()=>reconcileNativeSetup(base,secret),/storage unavailable/);assert.ok(base.getItem(NATIVE_SETUP));
 reconcileNativeSetup(base,secret);assert.equal(base.getItem(CREATED),'123');assert.equal(base.getItem(NATIVE_SETUP),null);
});

test('phrase setup clears stale passkey metadata and restored setup scans its full history',()=>{
 const base=memory();base.setItem(PASSKEY,JSON.stringify(record));base.setItem(`${BORN}:old`,'9');base.setItem(CREATED,'12');
 prepareNativeSetup(base,secret,{});reconcileNativeSetup(base,secret);
 assert.equal(base.getItem(PASSKEY),null);assert.equal(base.getItem(`${BORN}:old`),null);assert.equal(base.getItem(CREATED),null);
});

test('invalid setup records fail closed without exposing their contents',()=>{
 const base=memory();
 for(const value of ['{"secret":"sensitive"',JSON.stringify({version:1,tag:secret,passkey:{...record,words:15}}),JSON.stringify({version:1,tag:secret,created:-1})]){
  base.setItem(NATIVE_SETUP,value);
  assert.throws(()=>pendingNativeSetup(base),error=>error instanceof Error&&/invalid/.test(error.message)&&!error.message.includes('sensitive'));
  assert.equal(base.getItem(NATIVE_SETUP),value);
 }
 assert.throws(()=>prepareNativeSetup(memory(),'bad',{}),/secret/);
});

test('a lock setup journals its word count, and its marker follows the wallet the vault holds',()=>{
 const base=memory();base.setItem(PASSKEY,JSON.stringify(record));
 prepareNativeSetup(base,secret,{created:123,lock:{words:12}});
 assert.deepEqual(JSON.parse(base.getItem(NATIVE_SETUP)!).lock,{words:12});
 reconcileNativeSetup(base,secret);
 assert.deepEqual(JSON.parse(base.getItem(NATIVE_LOCK)!),{version:1,words:12});assert.equal(base.getItem(PASSKEY),null);
 prepareNativeSetup(base,other,{});reconcileNativeSetup(base,other);
 assert.equal(base.getItem(NATIVE_LOCK),null,'a phrase restore over a locked wallet drops its marker');
 for(const options of [{lock:{words:15 as 12}},{passkey:record,lock:{words:12 as const}}])assert.throws(()=>prepareNativeSetup(memory(),secret,options),/metadata/);
 for(const value of [{version:1,tag:secret,lock:{words:15}},{version:1,tag:secret,passkey:record,lock:{words:12}}]){
  base.setItem(NATIVE_SETUP,JSON.stringify(value));assert.throws(()=>pendingNativeSetup(base),/invalid/,'a locked wallet is never a passkey wallet');
 }
});

test('a lock setup with nothing in the vault is dropped, since its phrase lived only in memory',()=>{
 const base=memory();prepareNativeSetup(base,secret,{created:123,lock:{words:24}});
 assert.equal(reconcileNativeSetup(base,null),undefined);assert.equal(base.getItem(NATIVE_SETUP),null);
 prepareNativeSetup(base,secret,{passkey:record,created:123});
 assert.ok(reconcileNativeSetup(base,null),'a passkey setup can still finish with its passkey');
});
