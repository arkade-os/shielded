import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createNativeReleaseMirror} from '../src/native-release-mirror.ts';
import {nativeReleaseTag,parseNativeRelease,type NativeRelease} from '../src/native-release.ts';
import {androidUpdateFixture,nativeReleaseFixture} from './fixtures/native-release.ts';

const sha=(body:string)=>createHash('sha256').update(body).digest('hex');
function release(build:number):{release:NativeRelease;bodies:Map<string,string>}{
 const base=nativeReleaseFixture(),commit=String(build%10).repeat(40),tag=`native-mutinynet-${commit.slice(0,12)}-run${build}-attempt1`;
 const raw={...base,commit,buildNumber:build,releaseUrl:base.releaseUrl.replace(/native-mutinynet-[^/]+$/,tag),packages:base.packages.map(item=>({...item,url:item.url.replace(/native-mutinynet-[^/]+\//,`${tag}/`)}))};
 const parsed=parseNativeRelease({...raw,androidUpdate:androidUpdateFixture(raw)}),bodies=new Map<string,string>();
 const withBodies=[...parsed.packages,parsed.androidUpdate!].map(item=>{const body=`${build}:${item.file}`;bodies.set(item.url,body);return {...item,bytes:Buffer.byteLength(body),sha256:sha(body)};});
 const {bytes,sha256}=withBodies.at(-1)!;
 return {release:{...parsed,packages:withBodies.slice(0,-1),androidUpdate:{...parsed.androidUpdate!,bytes,sha256}},bodies};
}
function server(bodies:Map<string,string>,tamper?:string){
 const calls:string[]=[];
 const fetchImpl:typeof fetch=async input=>{const url=String(input);calls.push(url);const body=bodies.get(url);return body===undefined?new Response(null,{status:404}):new Response(url===tamper?body.toUpperCase():body);};
 return {calls,fetchImpl};
}

test('the host serves only files it verified against the current release',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const {release:current,bodies}=release(145),{calls,fetchImpl}=server(bodies),mirror=createNativeReleaseMirror({root,fetchImpl,warn:()=>{}});
 const tag=nativeReleaseTag(current),apk=current.androidUpdate!;
 assert.equal(mirror.path(tag,apk.file),undefined);
 await mirror.sync(current);
 for(const item of [...current.packages,apk])assert.equal(readFileSync(mirror.path(tag,item.file)!,'utf8'),bodies.get(item.url));
 assert.equal(calls.length,10);assert.equal(mirror.path(tag,'other.apk'),undefined);assert.equal(mirror.path('native-mutinynet-000000000000-run1-attempt1',apk.file),undefined);
 await mirror.sync(current);assert.equal(calls.length,10);
});

test('a download that differs from its release entry is never served',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const {release:current,bodies}=release(145),bad=current.packages[2]!,{fetchImpl}=server(bodies,bad.url),warnings:string[]=[];
 const mirror=createNativeReleaseMirror({root,fetchImpl,warn:message=>warnings.push(message)}),tag=nativeReleaseTag(current);
 await mirror.sync(current);
 assert.equal(mirror.path(tag,current.packages[0]!.file),undefined);assert.match(warnings.join('\n'),/does not match its release size and SHA-256/);
 assert.deepEqual(readdirSync(join(root,tag)).filter(name=>name.endsWith('.part')),[]);assert.equal(existsSync(join(root,tag,bad.file)),false);
});

test('a newer release replaces the old copy once it is complete, and a restart reuses verified files',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const first=release(145),second=release(146),bodies=new Map([...first.bodies,...second.bodies]),{calls,fetchImpl}=server(bodies);
 const mirror=createNativeReleaseMirror({root,fetchImpl,warn:()=>{}});
 await mirror.sync(first.release);await mirror.sync(second.release);
 const oldTag=nativeReleaseTag(first.release),newTag=nativeReleaseTag(second.release),file=second.release.packages[0]!.file;
 assert.equal(existsSync(join(root,oldTag)),false);assert.equal(mirror.path(oldTag,first.release.packages[0]!.file),undefined);assert.ok(mirror.path(newTag,file));
 const fetched=calls.length,restarted=createNativeReleaseMirror({root,fetchImpl,warn:()=>{}});
 await restarted.sync(second.release);assert.equal(calls.length,fetched);assert.ok(restarted.path(newTag,file));
});

test('a failing concurrent writer on the same volume cannot remove another download in progress',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const {release:current,bodies}=release(145),first=current.packages[0]!,body=Buffer.from(bodies.get(first.url)!),half=body.subarray(0,body.length>>1);
 let resume!:()=>void;const resumed=new Promise<void>(yes=>{resume=yes;});
 const stalled:typeof fetch=async input=>String(input)!==first.url?new Response(bodies.get(String(input))):new Response(new ReadableStream({async start(controller){controller.enqueue(half);await resumed;controller.enqueue(body.subarray(half.length));controller.close();}}));
 const failing:typeof fetch=async input=>new Response(new ReadableStream({start(controller){controller.enqueue(half);controller.error(new Error('connection reset'));}}));
 const writer=createNativeReleaseMirror({root,fetchImpl:stalled,warn:()=>{}}),tag=nativeReleaseTag(current);
 const writing=writer.sync(current);
 for(let tries=0;!(existsSync(join(root,tag))&&readdirSync(join(root,tag)).some(name=>name.endsWith('.part')));tries++){assert.ok(tries<10_000);await new Promise(resolve=>setImmediate(resolve));}
 await createNativeReleaseMirror({root,fetchImpl:failing,warn:()=>{}}).sync(current);
 resume();await writing;
 assert.equal(readFileSync(writer.path(tag,first.file)!,'utf8'),bodies.get(first.url));
 assert.deepEqual(readdirSync(join(root,tag)).filter(name=>name.endsWith('.part')),[]);
});
test('temp files left by a killed container are cleaned up, while a live download is left alone',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const {release:current,bodies}=release(145),{fetchImpl}=server(bodies),tag=nativeReleaseTag(current),directory=join(root,tag);
 mkdirSync(directory,{recursive:true});
 const stale=join(directory,'orphan.part'),live=join(directory,'live.part'),hourAgo=new Date(Date.now()-60*60_000);
 writeFileSync(stale,'killed');utimesSync(stale,hourAgo,hourAgo);writeFileSync(live,'in progress');
 const mirror=createNativeReleaseMirror({root,fetchImpl,warn:()=>{}});
 await mirror.sync(current);
 assert.equal(existsSync(stale),false);assert.equal(existsSync(live),true);
 writeFileSync(stale,'killed after the first pass');utimesSync(stale,hourAgo,hourAgo);
 await mirror.sync(current);
 assert.equal(existsSync(stale),false);assert.equal(existsSync(live),true);
});
