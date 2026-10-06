import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStockApp} from '../src/stock/http.ts';

async function fixture(action:()=>Promise<unknown>=async()=>({ok:true})){
 const directory=await mkdtemp(join(tmpdir(),'shielded-stock-http-'));await writeFile(join(directory,'index.html'),'<main>stock wallet fixture</main>');
 const archive={protocol:{profile:'profile',state:{noteCount:0}},participants:{owner:{}},phase:17,head:{txid:'00'.repeat(32)}};
 const coordinator={status:()=>({archive,pin:{},blocked:false}),archive:()=>archive,genesis:()=>({public:true}),registrationProfile:'00'.repeat(32),prepare:action,seal:action,reconcile:action,abort:action};
 const app=createStockApp(coordinator as any,{profile:{} as any,network:{} as any,manifest:{setup:{phase2:'development-only'},artifacts:{}} as any,checkpointTapscript:'',artifactDirectory:directory,webRoot:directory,adminToken:'fixture-operator-token'});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const port=(server.address() as any).port,url='http://127.0.0.1:'+port;
 return {url,close:async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}};
}
test('stock deployment serves the wallet route and public release without exposing arbitrary artifact paths',async()=>{
 const f=await fixture();try{
  const page=await fetch(f.url+'/stock-wallet');assert.equal(page.status,200);assert.match(await page.text(),/stock wallet fixture/);
  const profile=await (await fetch(f.url+'/api/profile')).json() as any;assert.equal(profile.setup,'development-only');assert.deepEqual(profile.genesis,{public:true});
  assert.equal((await fetch(f.url+'/api/proving/unknown.zkey')).status,404);
 }finally{await f.close();}
});
test('stock HTTP rejects private keys, cross-origin writes, and unauthorized aborts before dispatch',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;});try{
  const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(f.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/prepare',{spendSecret:'never-send'})).status,400);
  assert.equal((await post('/api/prepare',{}, {Origin:'https://different.invalid'})).status,403);
  assert.equal((await post('/api/abort',{})).status,401);assert.equal(calls,0);
  assert.equal((await post('/api/abort',{}, {Authorization:'Bearer fixture-operator-token'})).status,200);assert.equal(calls,1);
 }finally{await f.close();}
});
test('stock HTTP reserves one write through the complete asynchronous settlement',async()=>{
 let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const f=await fixture(async()=>{calls++;entered();await gate;return {ok:true};});
 try{
  const post=()=>fetch(f.url+'/api/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const first=post();await started;assert.equal((await post()).status,409);assert.equal(calls,1);release();assert.equal((await first).status,200);
  assert.equal((await post()).status,200);assert.equal(calls,2);
 }finally{release();await f.close();}
});
