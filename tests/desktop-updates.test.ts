import assert from 'node:assert/strict';
import test from 'node:test';
import {parseNativeRelease} from '../src/native-release.ts';
import {desktopUpdateBackend,desktopUpdatePackage} from '../app/src/desktop-updates.ts';
import {nativeReleaseFixture} from './fixtures/native-release.ts';

const signature=Buffer.alloc(64,9).toString('base64');
const release=(signed=true)=>{const raw=nativeReleaseFixture();if(signed)for(const item of raw.packages)Object.assign(item,{signature});return parseNativeRelease(raw);};

test('each desktop host picks only its own signed in-app installer',()=>{
 const signed=release();
 assert.match(desktopUpdatePackage(signed,'windows-x86_64')!.file,/-setup\.exe$/);
 assert.match(desktopUpdatePackage(signed,'linux-x86_64')!.file,/\.AppImage$/);
 assert.match(desktopUpdatePackage(signed,'macos-universal')!.file,/-release-Shielded\.app\.zip$/);
 for(const platform of ['android-arm64','ios','freebsd'])assert.equal(desktopUpdatePackage(signed,platform),undefined,platform);
 assert.equal(desktopUpdatePackage(release(false),'windows-x86_64'),undefined);
});

test('a download sends the host exactly the signed fields it accepts',async()=>{
 const calls:{command:string;args:Record<string,unknown>}[]=[];
 Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
 Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{value:{invoke:async(command:string,args:Record<string,unknown>)=>{calls.push({command,args});return {id:'staged',buildNumber:123};},transformCallback:()=>7,unregisterCallback(){}},configurable:true});
 const signed=release(),item=desktopUpdatePackage(signed,'windows-x86_64')!;
 assert.deepEqual(await desktopUpdateBackend().download(4,'request',signed,item,()=>{}),{id:'staged',buildNumber:123});
 const [{command,args}]=calls;
 assert.equal(command,'native_desktop_update_download');
 assert.deepEqual(Object.keys(args).sort(),['generation','onProgress','requestId','update']);
 assert.deepEqual(args.update,{url:item.url,bytes:item.bytes,sha256:item.sha256,commit:signed.commit,buildNumber:signed.buildNumber,signature});
});
