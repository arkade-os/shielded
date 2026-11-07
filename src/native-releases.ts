import type {RequestHandler} from 'express';
import {NATIVE_RELEASE_ENDPOINT,NATIVE_RELEASE_MANIFEST_URL,type NativeRelease} from './native-release.ts';
import {readNativeReleaseResponse} from './native-release-response.ts';

export function createNativeReleasesHandler({fetchImpl=fetch,now=Date.now}:{fetchImpl?:typeof fetch;now?:()=>number}={}):RequestHandler{
 let cached:{release:NativeRelease;expires:number;staleUntil:number}|undefined,pending:Promise<NativeRelease>|undefined,retryAfter=0;
 const load=async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Native release metadata timed out'));},10_000);});
  try{
   const request=async()=>readNativeReleaseResponse(await fetchImpl(NATIVE_RELEASE_MANIFEST_URL,{method:'GET',signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'follow',headers:{Accept:'application/json'}}));
   const release=await Promise.race([request(),timeout]);
   cached={release,expires:now()+300_000,staleUntil:now()+3_600_000};retryAfter=0;return release;
  }finally{clearTimeout(timer);}
 };
 return (req,res)=>{
  res.set('Cache-Control','no-store');
  if(req.method!=='GET'||req.originalUrl!==NATIVE_RELEASE_ENDPOINT){res.status(404).end();return;}
  if(cached&&cached.expires>now()){res.json(cached.release);return;}
  if(retryAfter>now()){if(cached&&cached.staleUntil>now())res.json(cached.release);else res.status(503).json({error:'Native release metadata unavailable'});return;}
  const current=pending??(pending=load().catch(()=>{
   retryAfter=now()+30_000;
   if(cached&&cached.staleUntil>now())return cached.release;
   throw new Error('Native release metadata unavailable');
  }).finally(()=>{pending=undefined;}));
  void current.then(release=>res.json(release),()=>res.status(503).json({error:'Native release metadata unavailable'}));
 };
}
