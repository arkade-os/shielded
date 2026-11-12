import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import {NATIVE_RELEASE_TAG,nativeReleaseTag,type NativeRelease,type NativeReleasePackage} from './native-release.ts';

const DOWNLOAD_TIMEOUT_MS=30*60_000;

async function sha256File(path:string){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);
 return hash.digest('hex');
}

async function download(fetchImpl:typeof fetch,item:NativeReleasePackage,target:string){
 // A rolling deploy can run two containers on one volume; each download needs its own temp file.
 const part=`${target}.${randomUUID()}.part`,hash=createHash('sha256');let received=0;
 try{
  const response=await fetchImpl(item.url,{redirect:'follow',signal:AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)});
  if(!response.ok||!response.body)throw new Error(`${item.file} returned HTTP ${response.status}`);
  const meter=new Transform({transform(chunk:Buffer,_encoding,done){
   received+=chunk.length;
   if(received>item.bytes){done(new Error(`${item.file} is larger than its release entry`));return;}
   hash.update(chunk);done(null,chunk);
  }});
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream),meter,createWriteStream(part));
  if(received!==item.bytes||hash.digest('hex')!==item.sha256)throw new Error(`${item.file} does not match its release size and SHA-256`);
  await rename(part,target);
 }catch(error){await rm(part,{force:true});throw error;}
}

/** Keeps a verified copy of the current native release on the host volume; only fully verified releases are served. */
export function createNativeReleaseMirror({root,fetchImpl=fetch,warn=(message:string)=>console.warn(message)}:{root:string;fetchImpl?:typeof fetch;warn?:(message:string)=>void}){
 let ready:{tag:string;files:Set<string>}|undefined,wanted:NativeRelease|undefined,current:string|undefined,running:Promise<void>|undefined;
 async function mirror(release:NativeRelease){
  const tag=nativeReleaseTag(release),directory=join(root,tag),files=new Set<string>();
  await mkdir(directory,{recursive:true});
  // Only a killed process leaves a temp file older than the download timeout; a live writer's file is kept.
  for(const name of await readdir(directory))if(name.endsWith('.part')){
   const temp=join(directory,name),found=await stat(temp).catch(()=>undefined);
   if(found&&Date.now()-found.mtimeMs>DOWNLOAD_TIMEOUT_MS)await rm(temp,{force:true});
  }
  for(const item of [...release.packages,...(release.androidUpdate?[release.androidUpdate]:[])]){
   const target=join(directory,item.file);
   const held=await stat(target).then(found=>found.size===item.bytes,()=>false);
   if(!held||await sha256File(target)!==item.sha256)await download(fetchImpl,item,target);
   files.add(item.file);
  }
  ready={tag,files};
  for(const name of await readdir(root))if(name!==tag&&NATIVE_RELEASE_TAG.test(name))await rm(join(root,name),{recursive:true,force:true});
 }
 return {
  sync(release:NativeRelease):Promise<void>{
   const tag=nativeReleaseTag(release);
   if(tag!==ready?.tag&&tag!==current)wanted=release;
   if(!wanted)return running??Promise.resolve();
   return running??=(async()=>{
    try{
     while(wanted){
      const next=wanted;wanted=undefined;current=nativeReleaseTag(next);
      await mirror(next).catch(error=>warn(`Native release mirror: ${error instanceof Error?error.message:String(error)}`));
      current=undefined;
     }
    }finally{running=undefined;}
   })();
  },
  path(tag:string,file:string):string|undefined{
   return ready?.tag===tag&&ready.files.has(file)?join(root,tag,file):undefined;
  },
 };
}
export type NativeReleaseMirror=ReturnType<typeof createNativeReleaseMirror>;
