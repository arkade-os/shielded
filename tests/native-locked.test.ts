import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {bytesToHex} from '@noble/hashes/utils.js';
import {base64urlnopad} from '@scure/base';
import {invoke} from '@tauri-apps/api/core';
import {createPasskeySeed,type PasskeyFallback} from '../packages/protocol/src/passkey.ts';
import {parseMasterSecret} from '../packages/protocol/src/wallet-keys.ts';
import {nativePasskeys} from '../app/src/native-passkeys.ts';
import {commitNativeSetup} from '../app/src/native-passkey-operation.ts';
import {NATIVE_LOCK,NATIVE_SETUP,nativeLockOf,pendingNativeSetup,reconcileNativeSetup} from '../app/src/native-setup-journal.ts';
import {PASSKEY} from '../app/src/passkey-record.ts';
import {passkeyFailureView,passkeyUserName} from '../app/src/shielded-page.ts';
import {deviceLockFallback,lockedPhrase,lockedReadBack,lockedSecretCache,lockedSecretCreate,masterOfEntropy,newLockedSecret,readNativeSecret,restoreOverLock} from '../app/src/native-locked.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:WalletOnboarding}=await import('../app/src/WalletOnboarding.tsx');

type Vault={plain:string|null;locked:string|null;lock:boolean;gone:boolean;cancel:number;weak:number;failPlain:boolean;failClear:boolean;calls:string[];prompts:number};
let vault:Vault;
const use=(o:Partial<Vault>={})=>vault={plain:null,locked:null,lock:true,gone:false,cancel:0,weak:0,failPlain:false,failClear:false,calls:[],prompts:0,...o};
// Tauri rejects with the plugin's bare string, never an Error.
const prompt=()=>{vault.prompts++;if(vault.cancel){vault.cancel--;throw 'cancelled';}};
const commands:Record<string,(args:{value?:string})=>unknown>={
 secret_get:()=>vault.plain,
 secret_create:({value})=>{if(vault.failPlain)throw 'Secure wallet storage unavailable';vault.plain=value!;},
 vault_kind:()=>vault.plain!==null?'plain':vault.locked!==null?'locked':'none',
 device_lock_available:()=>vault.lock,
 locked_secret_create:({value})=>{prompt();vault.locked=value!;},
 locked_secret_get:()=>{if(vault.locked===null)return null;if(vault.gone)throw 'lock-gone';prompt();if(vault.weak){vault.weak--;throw 'weak-biometric';}return vault.locked;},
 locked_secret_clear:()=>{if(vault.failClear)throw 'Secure wallet storage unavailable';vault.locked=null;},
};
Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{value:{invoke:async(command:string,args:{value?:string})=>{const name=command.replace('plugin:shielded-platform|','');vault.calls.push(name);return commands[name]!(args);}},configurable:true});

const PLAIN='11'.repeat(32),expected={phase:'ready' as const,generation:3,mode:'tor' as const};
const getSecret=()=>invoke<string|null>('plugin:shielded-platform|secret_get');
const createSecret=(value:string)=>invoke<void>('plugin:shielded-platform|secret_create',{value});
const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const src=(file:string)=>readFileSync(new URL(`../app/src/${file}`,import.meta.url),'utf8');
const open=(cache=lockedSecretCache(),hold:{current?:Error}={},storage=memory(),read:{locked?:boolean}={})=>readNativeSecret(getSecret,cache,hold,storage,read);
type Made=ReturnType<typeof newLockedSecret>;
const commit=(storage:Storage,made:Made,write=()=>lockedSecretCreate(made.entropy))=>commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret:made.master,metadata:{created:123,lock:{words:made.words.split(' ').length as 12|24}},read:()=>lockedReadBack(made.master),write});
const wayOut=(storage:Storage,phrase:string)=>commitNativeSetup({expected,status:async()=>expected,current(){},foreground:()=>true,storage,secret:bytesToHex(parseMasterSecret(phrase)),metadata:{},read:getSecret,write:value=>restoreOverLock(()=>createSecret(value))});

test('a locked wallet prompts once at open and not on reconnect, Tor switch or reload',async()=>{
 const made=newLockedSecret(12),cache=lockedSecretCache();use({locked:made.entropy});
 for(let i=0;i<4;i++)assert.equal(await open(cache),made.master);
 assert.equal(vault.prompts,1);
 const shared=lockedSecretCache();await Promise.all([open(shared),open(shared)]);
 assert.equal(vault.prompts,2,'two opens at once share one prompt');
 const late=deferred<string>(),superseded=lockedSecretCache(),first=superseded.read(()=>late.promise);
 late.resolve(made.entropy);await first;assert.equal(await open(superseded),made.master);
 assert.equal(vault.prompts,2,'an answer that reaches a retired open still serves the next one');
 const native=src('NativeWallet.tsx');
 assert.match(native,/^const lockedSecret=lockedSecretCache\(\);$/m);
 assert.match(native,/openNativeVault\([\s\S]*?\(\)=>readNativeSecret\(getSecret,lockedSecret,unlockHeld,localStorage,read\),generationGuard/,'every open reads through the one cache');
 assert.equal(native.match(/lockedSecret\.forget\(\)/g)?.length,3,'only Lock and the two resets forget it: pause, suspend, the Tor switch and reload keep it');
});

test('Lock forgets the secret so the next open prompts',async()=>{
 const made=newLockedSecret(24),cache=lockedSecretCache();use({locked:made.entropy});
 await open(cache);cache.forget();assert.equal(await open(cache),made.master);assert.equal(vault.prompts,2);
 cache.forget();const late=deferred<string>(),asked=cache.read(()=>late.promise);cache.forget();late.resolve(made.entropy);
 assert.equal(await asked,made.entropy,'the open that asked still gets its answer');
 await open(cache);assert.equal(vault.prompts,3,'a Lock during the prompt keeps the next open locked');
 const native=src('NativeWallet.tsx');
 assert.match(native,/aria-label="Lock wallet" onClick=\{\(\)=>\{manualLock\.current=true;lockedSecret\.forget\(\);setConfirmDirect\(false\);void pause\(\);\}\}/);
 assert.match(native,/const finishReset=useCallback\(\(\)=>\{\s*if\(openingOperation\.current\)return openingOperation\.current;\s*lockedSecret\.forget\(\);/);
 assert.match(native,/const clearWallet=useCallback\(async\(\)=>\{\s*if\(transition\.current\|\|creating\.current\)throw new Error\('[^']*'\);\s*lockedSecret\.forget\(\);/);
});

test('a cancelled unlock waits for the user before it prompts again',async()=>{
 const made=newLockedSecret(12),cache=lockedSecretCache(),hold:{current?:Error}={};use({locked:made.entropy,cancel:1});
 await assert.rejects(open(cache,hold),{name:'NativeUnlock',gone:false});
 await assert.rejects(open(cache,hold),{name:'NativeUnlock'});
 assert.equal(vault.prompts,1,'a resume or Tor switch shows the unlock screen again, not the prompt');
 hold.current=undefined;assert.equal(await open(cache,hold),made.master);assert.equal(vault.prompts,2,'a refused read is never kept');
 assert.match(src('NativeWallet.tsx'),/onUnlock:\(\)=>\{unlockHeld\.current=undefined;void open\(\);\}/);
});

test('a weak biometric that cannot release the key asks for the PIN or fingerprint and keeps the unlock screen',async()=>{
 const made=newLockedSecret(12),cache=lockedSecretCache(),hold:{current?:Error}={};use({locked:made.entropy,weak:1});
 await assert.rejects(open(cache,hold),{name:'NativeUnlock',gone:false,message:'Unlock with your PIN or fingerprint.'});
 hold.current=undefined;assert.equal(await open(cache,hold),made.master,'a retry with the PIN or a fingerprint opens it');assert.equal(vault.prompts,2);
});

test('the fallback setup journal never holds the entropy or the master',async()=>{
 const made=newLockedSecret(12),storage=memory();use();
 assert.equal(made.words.split(' ').length,12);
 assert.equal(made.master,bytesToHex(parseMasterSecret(made.words)));assert.equal(masterOfEntropy(made.entropy),made.master);
 const leaked=()=>Array.from({length:storage.length},(_,i)=>storage.getItem(storage.key(i)!)!).some(value=>[made.entropy,made.master,made.words].some(secret=>value.includes(secret)));
 await commit(storage,made,async()=>{
  const {tag,...journal}=JSON.parse(storage.getItem(NATIVE_SETUP)!);
  assert.match(tag,/^[0-9a-f]{64}$/);assert.deepEqual(journal,{version:1,created:123,lock:{words:12}});
  assert.equal(leaked(),false);await lockedSecretCreate(made.entropy);
 });
 assert.equal(leaked(),false);assert.equal(vault.locked,made.entropy);
 assert.equal(vault.prompts,1);assert.deepEqual(vault.calls.filter(call=>call.startsWith('locked_')),['locked_secret_create'],'the read-back never decrypts');
 assert.equal(pendingNativeSetup(storage),undefined);assert.deepEqual(nativeLockOf(storage),{words:12});
 assert.equal(storage.getItem(PASSKEY),null,'Backup never treats it as a PRF wallet');assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
 const native=src('NativeWallet.tsx');
 assert.match(native,/metadata=\{created:offer\.createdAt,lock:\{words:offer\.wordCount\}\}/);
 assert.match(native,/recordBeforeWrite:restore\|\|withPasskey\|\|!!offer,read:locked\?\(\)=>lockedReadBack\(secret\):getSecret/);
 assert.match(native,/return lockedSecretCreate\(made\.entropy\)\.then\(\(\)=>\{void lockedSecret\.read\(async\(\)=>made\.entropy\);setupWords\.current=made\.words;\}\);/,'the open after Continue reuses its prompt');
 assert.match(native,/userName:passkeyUserName\(at\),createdAt:at/,'the wallet is dated as its passkey is named');
});

test('an interrupted fallback setup reconciles by tag with one prompt',async()=>{
 const made=newLockedSecret(24),storage=memory();use();
 await assert.rejects(commit(storage,made,async()=>{await lockedSecretCreate(made.entropy);throw new Error('app killed');}),/app killed/);
 assert.deepEqual(pendingNativeSetup(storage)?.lock,{words:24});assert.equal(nativeLockOf(storage),undefined);
 const prompts=vault.prompts,secret=await open(lockedSecretCache(),{},storage);
 assert.equal(secret,made.master);assert.equal(vault.prompts-prompts,1);
 reconcileNativeSetup(storage,secret,true);
 assert.equal(pendingNativeSetup(storage),undefined);assert.deepEqual(nativeLockOf(storage),{words:24});assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
 assert.match(src('NativeWallet.tsx'),/const pending=reconcileNativeSetup\(localStorage,secret,!!read\.locked\);/);
});

test('a cancelled lock prompt leaves nothing that blocks a new setup',async()=>{
 const made=newLockedSecret(12),storage=memory();use({cancel:1});
 await assert.rejects(commit(storage,made),error=>error==='cancelled');
 assert.ok(pendingNativeSetup(storage)?.lock);
 const secret=await open();assert.equal(secret,null);
 assert.equal(reconcileNativeSetup(storage,secret,false),undefined);assert.equal(pendingNativeSetup(storage),undefined);
 const next=newLockedSecret(12);await commit(storage,next);assert.equal(vault.locked,next.entropy);
 assert.match(src('NativeWallet.tsx'),/if\(offer\)\{setupAllowed\.current=false;setSetup\(false\);\}/,'a failed Continue reopens, which drops or reconciles its journal');
});

test('no device lock means no fallback',async()=>{
 const fallback=()=>Object.assign(new Error('no PRF'),{name:'PasskeyFallback',credentialId:Uint8Array.of(1,2,3),userHandle:new Uint8Array(32).fill(7),userName:'Shielded wallet · Nov 20, 2026, 9:00 PM',wordCount:12 as const,createdAt:5});
 use({lock:false});const refused=fallback();
 assert.equal(await deviceLockFallback(refused),undefined);
 assert.ok(refused.userHandle.every(byte=>byte===0),'native never uses the handle');
 assert.match(passkeyFailureView(refused,'create').message!,/recovery phrase instead\. You can delete the passkey “Shielded wallet · Nov 20, 2026, 9:00 PM”/);
 use();const offered=fallback();assert.equal(await deviceLockFallback(offered),offered);
 use();assert.equal(await deviceLockFallback(new Error('offline')),undefined);assert.deepEqual(vault.calls,[]);
 const native=src('NativeWallet.tsx');
 assert.match(native,/const lockOffer=restore\|\|offer\?undefined:await deviceLockFallback\(cause\);/);
 assert.match(native,/passkeyFailureView\(cause,restore\?'restore':'create'\)/);
 assert.match(native,/\{setup&&fallbackName&&<PasskeyFallbackSheet platform=\{LOCK_PLATFORM\} windowsWarning=\{false\}/);
});

test('a native passkey that reports PRF off at creation reaches the device-lock offer',async()=>{
 const calls:string[]=[],id=base64urlnopad.encode(Uint8Array.of(4,5,6));
 const client=nativePasskeys(async command=>{calls.push(command);return JSON.stringify({id,rawId:id,type:'public-key',clientExtensionResults:{prf:{enabled:false}}});});
 const offer=await createPasskeySeed({rpId:'shielded.mutinynet.arkade.sh',userName:passkeyUserName(77),createdAt:77,wordCount:24,client}).then(()=>assert.fail('a wallet was made'),(cause:unknown)=>cause as PasskeyFallback);
 assert.equal(offer.name,'PasskeyFallback');assert.equal(offer.createdAt,77);assert.equal(offer.wordCount,24);assert.equal(offer.userName,passkeyUserName(77));
 assert.deepEqual([...offer.credentialId],[4,5,6]);assert.equal(offer.userHandle.length,32);
 assert.deepEqual(calls,['plugin:shielded-platform|passkey_create'],'no confirming prompt for a passkey that said no');
 use();assert.equal(await deviceLockFallback(offer),offer);assert.ok(offer.userHandle.every(byte=>byte===0));
});

test('lock-gone leads to the recovery-phrase way out',async()=>{
 const made=newLockedSecret(12);use({locked:made.entropy,gone:true});
 await assert.rejects(open(),(error:Error&{gone?:boolean})=>error.name==='NativeUnlock'&&error.gone===true&&!/lock-gone/.test(error.message)&&/recovery phrase/.test(error.message));
 assert.equal(vault.prompts,0);
 const unlock=(gone:boolean)=>renderToStaticMarkup(createElement(WalletOnboarding,{transport:'tor',setup:true,busy:false,phase:'',error:'',phrase:'',onPhraseChange(){},onCreate(){},onRestore(){},onReconnect(){},torHealth:{status:{phase:'ready',generation:1},check:'ok'},unlock:{label:'this phone’s fingerprint or PIN',gone,onUnlock(){},onUsePhrase(){}}}));
 assert.match(unlock(true),/<button[^>]*autofocus=""[^>]*>Use recovery phrase instead<\/button>/);
 assert.doesNotMatch(unlock(false),/autofocus/);assert.match(unlock(false),/Use this phone’s fingerprint or PIN to open this wallet\./);
 assert.match(src('NativeWallet.tsx'),/if\(cause instanceof Error&&cause\.name==='NativeUnlock'\)\{connectionPending\.current=false;setupAllowed\.current=true;setSetup\(true\);setUnlock\(\{gone:/);
});

test('the way out writes the plain secret before clearing the locked one',async()=>{
 const made=newLockedSecret(12);use({locked:made.entropy});
 await restoreOverLock(()=>createSecret(PLAIN));
 assert.deepEqual(vault.calls,['secret_create','locked_secret_clear']);assert.equal(vault.plain,PLAIN);assert.equal(vault.locked,null);
 use({locked:made.entropy,failPlain:true});
 await assert.rejects(restoreOverLock(()=>createSecret(PLAIN)));
 assert.deepEqual(vault.calls,['secret_create']);assert.equal(vault.locked,made.entropy,'a failed restore keeps the locked wallet');
 use({locked:made.entropy,failClear:true});
 await restoreOverLock(()=>createSecret(PLAIN));assert.equal(await open(),PLAIN,'a stale lock left behind loses to the restored wallet');
 const native=src('NativeWallet.tsx');
 assert.match(native,/restore\?restoreOverLock\(\(\)=>createSecret\(value\)\):createSecret\(value\)/);
 assert.equal(native.match(/clearSecret/g)?.length,3,'secret_clear stays the wallet reset, never the way out');
});

test('a way out whose write failed gives way to the locked wallet at its next unlock',async()=>{
 const made=newLockedSecret(12),other=newLockedSecret(24),CREATED='shielded-rollup-wallet-created-v1';
 for(const phrase of [made.words,other.words]){
  const storage=memory();use({locked:made.entropy,failPlain:true});
  storage.setItem(NATIVE_LOCK,JSON.stringify({version:1,words:12}));storage.setItem(CREATED,'123');
  await assert.rejects(wayOut(storage,phrase));assert.ok(pendingNativeSetup(storage)&&!pendingNativeSetup(storage)!.lock);
  const read:{locked?:boolean}={},secret=await open(lockedSecretCache(),{},storage,read);
  assert.equal(secret,made.master);assert.equal(reconcileNativeSetup(storage,secret,!!read.locked),undefined,'the locked wallet opens');
  assert.deepEqual(nativeLockOf(storage),{words:12},'Backup still asks the device lock');assert.equal(storage.getItem(CREATED),'123');
 }
 const gone=memory();use({locked:made.entropy,failPlain:true,gone:true});
 await assert.rejects(wayOut(gone,other.words));
 await assert.rejects(open(lockedSecretCache(),{},gone),{name:'NativeUnlock',gone:true});
 vault.failPlain=false;await wayOut(gone,made.words);assert.equal(vault.plain,made.master,'a lock that is gone never blocks another phrase');
 const long=newLockedSecret(24),bare=memory();use({locked:long.entropy});
 await open(lockedSecretCache(),{},bare);assert.deepEqual(nativeLockOf(bare),{words:24},'the marker follows the vault');
});

test('a restore with the phrase of an interrupted lock setup ends plain, without the lock marker',async()=>{
 const made=newLockedSecret(12),storage=memory();use();
 await assert.rejects(commit(storage,made,async()=>{await lockedSecretCreate(made.entropy);throw new Error('reply lost');}),/reply lost/);
 assert.deepEqual(pendingNativeSetup(storage)?.lock,{words:12});
 await wayOut(storage,made.words);
 assert.equal(vault.plain,made.master);assert.equal(vault.locked,null);assert.equal(pendingNativeSetup(storage),undefined);
 assert.equal(nativeLockOf(storage),undefined,'Backup takes the plain path');assert.equal(storage.getItem('shielded-rollup-wallet-created-v1'),'123');
 storage.setItem(NATIVE_LOCK,JSON.stringify({version:1,words:12}));
 const read:{locked?:boolean}={},secret=await open(lockedSecretCache(),{},storage,read);reconcileNativeSetup(storage,secret,!!read.locked);
 assert.equal(secret,made.master);assert.equal(nativeLockOf(storage),undefined,'an open of a plain vault drops a stale marker');
});

test('a later Backup reveal prompts once and shows the stored words',async()=>{
 const made=newLockedSecret(12);use({locked:made.entropy});
 assert.equal(await lockedPhrase(made.master),made.words);assert.equal(vault.prompts,1);
 await assert.rejects(lockedPhrase(PLAIN),/another wallet/);
 const wallet=src('RollupWallet.tsx');
 assert.match(wallet,/nativeLock\?await lockedPhrase\(secret,before\):/,'a locked native wallet never tries PRF');
 assert.match(wallet,/source==='locked'\|\|nativeLock\?passkeyPhrase:/,'nor shows words before that prompt');
 assert.match(wallet,/useState\(setupPhrase\?\?''\)/,'the setup words reach the first backup without a prompt');
 const native=src('NativeWallet.tsx');
 assert.match(native,/setupPhrase=\{view\.session\.words\}/);
 assert.match(native,/const pause=useCallback\(\(\)=>\{[\s\S]*?const previous=active\.current;active\.current=undefined;setupWords\.current=undefined;if\(previous\)previous\.words=undefined;[\s\S]*?\},\[clearResume,cancelSetup\]\);/,'a pause drops the setup words');
});
