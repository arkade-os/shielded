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
 const app=express();serveWeb(app,web);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.close();rmSync(web,{recursive:true,force:true});});
 const get=async(path:string,method='GET')=>{
  const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,{method});
  return {status:response.status,cache:response.headers.get('cache-control'),body:await response.text()};
 };
 for(const method of ['GET','HEAD']){const {status,cache}=await get('/sw.js',method);assert.deepEqual([status,cache],[200,'public, max-age=86400'],`${method} /sw.js`);}
 for(const route of ['/','/wallet','/claim','/verify','/watch'])assert.equal((await get(route)).body,shell,route);
 assert.match((await get('/assets/a.js')).cache!,/immutable/);
});
