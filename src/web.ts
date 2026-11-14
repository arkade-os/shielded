import {join} from 'node:path';
import express,{type Express} from 'express';
import androidSigning from '../src-tauri/android-signing.json' with {type:'json'};
import {NATIVE_DOWNLOAD_PATH,NATIVE_RELEASE_ENDPOINT,NATIVE_RELEASE_TAG,NATIVE_RELEASES_BASE,nativePackageFile} from './native-release.ts';
import {createNativeReleaseMirror,type NativeReleaseMirror} from './native-release-mirror.ts';
import {createNativeReleasesHandler} from './native-releases.ts';

const assetLinks=Buffer.from(JSON.stringify([{relation:['delegate_permission/common.handle_all_urls','delegate_permission/common.get_login_creds'],target:{namespace:'android_app',package_name:androidSigning.packageName,sha256_cert_fingerprints:[androidSigning.certificateSha256.toUpperCase().match(/../g)!.join(':')]}}]));

export function serveWeb(app:Express,web:string,data:string,mirror:NativeReleaseMirror=createNativeReleaseMirror({root:join(data,'native-releases')})):void{
 app.get(NATIVE_RELEASE_ENDPOINT,createNativeReleasesHandler({onRelease:release=>void mirror.sync(release)}));
 app.get(`${NATIVE_DOWNLOAD_PATH}/:tag/:file`,(req,res,next)=>{
  const {tag,file}=req.params;
  if(!NATIVE_RELEASE_TAG.test(tag)||!nativePackageFile(file)){res.status(404).end();return;}
  // Uncached, so the CDN stops redirecting as soon as this host has the file.
  const toGitHub=()=>{res.set('Cache-Control','no-store').redirect(302,`${NATIVE_RELEASES_BASE}/download/${tag}/${file}`);};
  const local=mirror.path(tag,file);
  if(!local){toGitHub();return;}
  res.sendFile(local,{headers:{
   'Cache-Control':'public, max-age=31536000, immutable',
   'Content-Type':file.endsWith('.apk')?'application/vnd.android.package-archive':'application/octet-stream',
   'Content-Disposition':`attachment; filename="${file}"`,
  }},error=>{if(!error)return;if(res.headersSent)next(error);else toGitHub();});
 });
 // setHeader and a Buffer keep the type exactly application/json, as Android documents; res.json would append a charset.
 app.get('/.well-known/assetlinks.json',(_req,res)=>res.setHeader('Content-Type','application/json').setHeader('Cache-Control','public, max-age=3600').send(assetLinks));
 app.get(['/','/download','/index.html','/wallet','/claim','/verify','/watch'],(_req,res)=>res.sendFile('index.html',{root:web,headers:{'Cache-Control':'no-cache'}}));
 app.use('/assets',express.static(join(web,'assets'),{immutable:true,maxAge:'365d'}));
 app.get('/sw.js',(_req,res)=>res.sendFile('sw.js',{root:web,headers:{'Cache-Control':'private, no-cache'}}));
 app.use(express.static(web));
}
