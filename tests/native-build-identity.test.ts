import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeBuildIdentity} from '../app/native-build-identity.ts';

test('browser builds work without Git and do not inspect a repository',()=>{
 let calls=0;
 assert.deepEqual(nativeBuildIdentity({},()=>{calls++;throw new Error('git unavailable');}),{commit:'',buildNumber:0,platform:''});
 assert.equal(calls,0);
});

test('native CI identity uses validated GitHub metadata and never requires local Git',()=>{
 const env={SHIELDED_NATIVE:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_NUMBER:'123',NATIVE_PLATFORM:'windows-x86_64'};
 assert.deepEqual(nativeBuildIdentity(env,()=>{throw new Error('git unavailable');}),{commit:env.GITHUB_SHA,buildNumber:123,platform:'windows-x86_64'});
});

test('native archive and local builds keep unknown identity fields inert',()=>{
 const env={SHIELDED_NATIVE:'1'};
 assert.deepEqual(nativeBuildIdentity(env,()=>{throw new Error('not a repository');}),{commit:'',buildNumber:0,platform:''});
 assert.deepEqual(nativeBuildIdentity({...env,TAURI_ENV_TARGET_TRIPLE:'aarch64-linux-android'},()=>'b'.repeat(40)+'\n'),{commit:'b'.repeat(40),buildNumber:0,platform:'android-arm64'});
 for(const GITHUB_RUN_NUMBER of ['-1','0','1.5','0x10','1e3',String(Number.MAX_SAFE_INTEGER+1)])assert.equal(nativeBuildIdentity({...env,GITHUB_RUN_NUMBER},()=>'b'.repeat(40)).buildNumber,0);
 assert.equal(nativeBuildIdentity({...env,GITHUB_SHA:'A'.repeat(40),NATIVE_PLATFORM:'other'},()=>'invalid').commit,'');
});
