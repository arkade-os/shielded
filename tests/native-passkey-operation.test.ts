import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commitNativeSetup,waitNativePasskeyForeground} from '../app/src/native-passkey-operation.ts';
import {NATIVE_SETUP,pendingNativeSetup,prepareNativeSetup,reconcileNativeSetup} from '../app/src/native-setup-journal.ts';

test('a prompt return waits for page and native activation without accepting another generation',async()=>{
 let visible=false,reads=0,delays=0;
 const expected={phase:'ready' as const,generation:3,mode:'tor' as const};
 await waitNativePasskeyForeground(expected,async()=>{reads++;return expected;},()=>{},()=>visible,async()=>{delays++;visible=true;});
 assert.equal(reads,1);assert.equal(delays,1);
 await assert.rejects(waitNativePasskeyForeground(expected,async()=>({...expected,generation:4}),()=>{},()=>true),/changed/);
});

test('retiring a prompt owner while hidden settles without waiting for native activation',async()=>{
 let live=true,reads=0;
 await assert.rejects(waitNativePasskeyForeground({phase:'ready',generation:3},async()=>{reads++;throw new Error('unexpected');},()=>{if(!live)throw new Error('Retired');},()=>false,async()=>{live=false;}),/Retired/);
 assert.equal(reads,0);
});

const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};
const expected={phase:'ready' as const,generation:3,mode:'tor' as const},secret='11'.repeat(32),other='22'.repeat(32);
test('a different wallet arriving during the prompt is kept without a setup intent or write',async()=>{
 const storage=memory();let writes=0;
 await assert.rejects(commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{},read:async()=>other,write:async()=>{writes++;}}),/already exists/);
 assert.equal(writes,0);assert.equal(storage.getItem(NATIVE_SETUP),null);
});

test('setup rechecks readiness after its vault read and cannot dispatch under a retired owner',async()=>{
 const storage=memory();let reads=0,writes=0;
 await assert.rejects(commitNativeSetup({expected,status:async()=>++reads===1?expected:{...expected,generation:4},current(){},foreground:()=>true,storage,secret,metadata:{},read:async()=>null,write:async()=>{writes++;}}),/changed/);
 assert.equal(writes,0);assert.equal(storage.getItem(NATIVE_SETUP),null);
});

test('a hide queued after the final readiness reply cannot admit a vault write',async()=>{
 const storage=memory();let visible=true,live=true,reads=0,writes=0;
 const saving=commitNativeSetup({expected,status:async()=>{if(++reads===2)queueMicrotask(()=>queueMicrotask(()=>{visible=false;}));return expected;},current(){if(!live)throw new Error('Retired');},foreground:()=>visible,storage,secret,metadata:{},read:async()=>null,write:async()=>{writes++;}});
 await new Promise(resolve=>setImmediate(resolve));
 const snapshot={writes,intent:storage.getItem(NATIVE_SETUP)};live=false;
 await assert.rejects(saving,/Retired/);
 assert.deepEqual(snapshot,{writes:0,intent:null});
});

test('returning after the queued hide completes the same setup intent once',async()=>{
 const storage=memory();let visible=true,reads=0,writes=0;
 const saving=commitNativeSetup({expected,status:async()=>{if(++reads===2)queueMicrotask(()=>queueMicrotask(()=>{visible=false;}));return expected;},current(){},foreground:()=>visible,storage,secret,metadata:{created:123},read:async()=>null,write:async()=>{writes++;}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);assert.equal(storage.getItem(NATIVE_SETUP),null);
 visible=true;await saving;
 assert.equal(writes,1);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');assert.equal(storage.getItem(NATIVE_SETUP),null);
});

test('a write admitted before revocation finishes public metadata without restoring the retired owner',async()=>{
 const storage=memory();let live=true,written=false;
 await commitNativeSetup({expected,status:async()=>expected,current(){if(!live)throw new Error('Retired');},foreground:()=>true,storage,secret,metadata:{created:123},read:async()=>null,write:async()=>{assert.ok(pendingNativeSetup(storage));live=false;written=true;}});
 assert.equal(written,true);assert.equal(storage.getItem(NATIVE_SETUP),null);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
});

test('an ambiguous setup remains fenced for the same seed after a failed vault reply',async()=>{
 const storage=memory();const options={expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},read:async()=>null,write:async()=>{throw new Error('reply lost');}};
 await assert.rejects(commitNativeSetup(options),/reply lost/);const pending=storage.getItem(NATIVE_SETUP);
 await assert.rejects(commitNativeSetup({...options,secret:other,write:async()=>{throw new Error('must not dispatch');}}),/pending/);
 assert.equal(storage.getItem(NATIVE_SETUP),pending);
 let writes=0;await commitNativeSetup({...options,read:async()=>secret,write:async()=>{writes++;}});
 assert.equal(writes,0);assert.equal(storage.getItem(NATIVE_SETUP),null);
});

test('a rejected random setup leaves no unrecoverable intent and a restart can create a fresh wallet',async()=>{
 const storage=memory(),options={expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},recordBeforeWrite:false,read:async()=>null};
 await assert.rejects(commitNativeSetup({...options,write:async()=>{throw new Error('vault locked');}}),/vault locked/);
 assert.equal(pendingNativeSetup(storage),undefined);let vault:string|null=null;
 await commitNativeSetup({...options,secret:other,metadata:{created:456},write:async value=>{vault=value;}});
 assert.equal(vault,other);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'456');assert.equal(pendingNativeSetup(storage),undefined);
});

test('a random setup with a lost acknowledgement reopens the committed seed without allowing replacement',async()=>{
 const storage=memory();let vault:string|null=null,writes=0;
 const options={expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},recordBeforeWrite:false,read:async()=>vault};
 await assert.rejects(commitNativeSetup({...options,write:async value=>{writes++;vault=value;throw new Error('reply lost');}}),/reply lost/);
 assert.equal(vault,secret);assert.equal(pendingNativeSetup(storage),undefined);
 await assert.rejects(commitNativeSetup({...options,secret:other,write:async value=>{writes++;vault=value;}}),/already exists/);
 assert.equal(vault,secret);assert.equal(writes,1);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),null);
});

test('an acknowledged random setup tracks its vault write and metadata commit as one operation',async()=>{
 const source=memory(),storage:Storage={get length(){return source.length;},key:i=>source.key(i),getItem:key=>source.getItem(key),removeItem:key=>source.removeItem(key),clear:()=>source.clear(),setItem(key,value){source.setItem(key,value);}};
 let finish!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let tracked:Promise<void>|undefined,trackedDone=false;
 const saving=commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},recordBeforeWrite:false,read:async()=>null,write:async()=>{assert.equal(pendingNativeSetup(storage),undefined);entered();await held;},onWrite:promise=>{tracked=promise;void promise.then(()=>{assert.equal(pendingNativeSetup(storage),undefined);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');trackedDone=true;});}});
 await started;assert.ok(tracked);assert.equal(trackedDone,false);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),null);
 finish();await saving;await tracked;assert.equal(trackedDone,true);assert.equal(storage.getItem('shielded-rollup-wallet-born-v1'),'new');
});

for(const lateWins of [false,true])test(`a late random setup cannot replace the ${lateWins?'late':'new'} create-only winner`,async()=>{
 const storage=memory();let vault:string|null=null;
 const createOnly=async(value:string)=>{if(vault!==null&&vault!==value)throw new Error('wallet exists');vault=value;};
 const options={expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},recordBeforeWrite:false,read:async()=>vault};
 await assert.rejects(commitNativeSetup({...options,write:async()=>{throw new Error('queued reply lost');}}),/reply lost/);
 const retry=commitNativeSetup({...options,secret:other,metadata:{created:456},write:async value=>{if(lateWins)await createOnly(secret);await createOnly(value);}});
 if(lateWins){await assert.rejects(retry,/exists/);assert.equal(vault,secret);assert.equal(pendingNativeSetup(storage),undefined);}
 else{await retry;await assert.rejects(createOnly(secret),/exists/);assert.equal(vault,other);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'456');}
});

test('optional random metadata cannot bypass an existing recoverable setup intent',async()=>{
 const storage=memory();prepareNativeSetup(storage,secret,{passkey:{version:1,credentialId:'AQID',label:'Default',words:12}});let writes=0;
 await assert.rejects(commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret:other,metadata:{created:456},recordBeforeWrite:false,read:async()=>null,write:async()=>{writes++;}}),/pending/);
 assert.equal(writes,0);assert.equal(pendingNativeSetup(storage)?.passkey?.credentialId,'AQID');
});

test('only fresh random metadata can opt out of the recoverable pre-write intent',async()=>{
 for(const metadata of [{},{created:-1},{created:NaN},{created:123,passkey:{version:1 as const,credentialId:'AQID',label:'Default',words:12 as const}}]){
  const storage=memory();let writes=0;
  await assert.rejects(commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata,recordBeforeWrite:false,read:async()=>null,write:async()=>{writes++;}}),/metadata/);
  assert.equal(writes,0);assert.equal(storage.length,0);
 }
});

test('the tracked random write includes a failed metadata commit and keeps its acknowledged vault recoverable',async()=>{
 const source=memory();let fail=true,vault:string|null=null,tracked:Promise<void>|undefined;
 const storage:Storage={get length(){return source.length;},key:i=>source.key(i),getItem:key=>source.getItem(key),removeItem:key=>source.removeItem(key),clear:()=>source.clear(),setItem(key,value){if(key==='shielded-rollup-wallet-created-v1'&&fail){fail=false;throw new Error('metadata unavailable');}source.setItem(key,value);}};
 await assert.rejects(commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret,metadata:{created:123},recordBeforeWrite:false,read:async()=>null,write:async value=>{vault=value;},onWrite:promise=>{tracked=promise;}}),/metadata unavailable/);
 await assert.rejects(tracked!,/metadata unavailable/);assert.equal(vault,secret);assert.ok(pendingNativeSetup(storage));
 reconcileNativeSetup(storage,vault,false);assert.equal(pendingNativeSetup(storage),undefined);assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
});
