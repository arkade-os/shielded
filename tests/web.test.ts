import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import express from 'express';
import {serveWeb} from '../src/web.ts';

test('the web app is served with the cache rules the app cache relies on',async t=>{
 const web=mkdtempSync(join(tmpdir(),'shielded-web-')),shell='<title>shell</title>';
 mkdirSync(join(web,'assets'));
 for(const [file,body] of [['index.html',shell],['sw.js','// worker'],['assets/a.js','// asset']])writeFileSync(join(web,file),body);
 const data=mkdtempSync(join(tmpdir(),'shielded-data-')),app=express();serveWeb(app,web,data);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.close();rmSync(web,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});});
 const get=async(path:string,method='GET')=>{
  const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,{method});
  return {status:response.status,cache:response.headers.get('cache-control'),body:await response.text()};
 };
 for(const method of ['GET','HEAD']){const {status,cache}=await get('/sw.js',method);assert.deepEqual([status,cache],[200,'private, no-cache'],`${method} /sw.js`);}
 for(const route of ['/','/download','/download/','/index.html','/wallet','/claim','/verify','/watch']){
  const response=await get(route);assert.deepEqual(response,{status:200,cache:'no-cache',body:shell},route);
 }
 assert.match((await get('/assets/a.js')).cache!,/immutable/);
});

test('native downloads serve the verified host copy or redirect to the pinned release asset',async t=>{
 const web=mkdtempSync(join(tmpdir(),'shielded-web-')),data=mkdtempSync(join(tmpdir(),'shielded-data-'));
 const tag='native-mutinynet-aaaaaaaaaaaa-run145-attempt1',file='shielded-mutinynet-android-arm64-release.apk',local=join(data,file);
 writeFileSync(local,'apk-bytes');
 const app=express();serveWeb(app,web,data,{sync:async()=>{},path:(at:string,name:string)=>at===tag&&name===file?local:undefined});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.close();rmSync(web,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});});
 const url=(path:string)=>`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
 const served=await fetch(url(`/downloads/native/${tag}/${file}`));
 assert.equal(served.status,200);assert.equal(await served.text(),'apk-bytes');
 assert.equal(served.headers.get('content-type'),'application/vnd.android.package-archive');
 assert.equal(served.headers.get('content-disposition'),`attachment; filename="${file}"`);assert.match(served.headers.get('cache-control')!,/immutable/);
 const range=await fetch(url(`/downloads/native/${tag}/${file}`),{headers:{Range:'bytes=0-2'}});assert.equal(range.status,206);assert.equal(await range.text(),'apk');
 const other='shielded-mutinynet-windows-x86_64-release.exe',redirect=await fetch(url(`/downloads/native/${tag}/${other}`),{redirect:'manual'});
 assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),`https://github.com/arkade-os/shielded/releases/download/${tag}/${other}`);
 assert.equal(redirect.headers.get('cache-control'),'no-store');
 rmSync(local);
 const pruned=await fetch(url(`/downloads/native/${tag}/${file}`),{redirect:'manual'});
 assert.equal(pruned.status,302);assert.equal(pruned.headers.get('location'),`https://github.com/arkade-os/shielded/releases/download/${tag}/${file}`);assert.equal(pruned.headers.get('cache-control'),'no-store');
 for(const path of [`/downloads/native/not-a-release/${file}`,`/downloads/native/${tag}/..%2F..%2Fsecret`,`/downloads/native/${tag}/.hidden`]){
  const response=await fetch(url(path),{redirect:'manual'});assert.equal(response.status,404,path);
 }
});
