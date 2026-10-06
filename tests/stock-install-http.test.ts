import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStockInstallApp} from '../src/stock/install-server.ts';
import type {StockSetupStatus} from '../src/stock/install.ts';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'shielded-install-http-'));await writeFile(join(directory,'index.html'),'<main>installation wallet</main>');
 let status:StockSetupStatus={version:1,phase:'waiting-funds',network:'mutinynet',minimumFundingSats:660,fundingAddress:'tark1public-funding-address'};
 const http=createStockInstallApp(()=>status,directory),server=http.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+(server.address() as any).port;
 return {url,activate:http.activate,setStatus:(value:StockSetupStatus)=>{status=value;},close:async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}};
}

test('unfunded installation serves wallet and public funding status without accepting setup writes',async()=>{
 const f=await fixture();try{
  const response=await fetch(f.url+'/api/setup');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{version:1,phase:'waiting-funds',network:'mutinynet',minimumFundingSats:660,fundingAddress:'tark1public-funding-address'});
  assert.equal((await fetch(f.url+'/health')).status,200);assert.equal((await fetch(f.url+'/readyz')).status,503);
  for(const path of ['/','/stock-wallet','/lab']){const page=await fetch(f.url+path,{redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/installation wallet/);}
  const redirect=await fetch(f.url+'/wallet',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/stock-wallet');
  assert.equal((await fetch(f.url+'/api/setup',{method:'POST',body:JSON.stringify({mnemonic:'must-not-be-accepted'})})).status,503);
  assert.equal((await fetch(f.url+'/api/settlements',{method:'POST'})).status,503);
  assert.equal((await fetch(f.url+'/installation/.key')).status,404);assert.equal((await fetch(f.url+'/artifacts/stock-combined.zkey')).status,404);
 }finally{await f.close();}
});

test('blocked setup fails health and readiness, while activated service receives requests',async()=>{
 const f=await fixture();try{
  f.setStatus({version:1,phase:'blocked',network:'mutinynet',minimumFundingSats:660,message:'Setup stopped safely.'});
  assert.equal((await fetch(f.url+'/health')).status,503);assert.equal((await fetch(f.url+'/readyz')).status,503);
  const service=express();service.get('/api/profile',(_req,res)=>res.json({public:true}));service.post('/api/settlements',(_req,res)=>res.json({accepted:true}));f.activate(service);
  assert.equal((await fetch(f.url+'/api/settlements',{method:'POST'})).status,503);
  f.setStatus({version:1,phase:'ready',network:'mutinynet',minimumFundingSats:660,releaseFingerprint:'a'.repeat(64)});
  const page=await fetch(f.url+'/',{redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/installation wallet/);
  assert.equal((await fetch(f.url+'/health')).status,200);assert.equal((await fetch(f.url+'/readyz')).status,200);assert.deepEqual(await (await fetch(f.url+'/api/profile')).json(),{public:true});
  assert.equal((await (await fetch(f.url+'/api/setup')).json() as any).releaseFingerprint,'a'.repeat(64));
 }finally{await f.close();}
});

test('installation qualification refuses synthetic network metadata before reading artifacts or contacting providers',async()=>{
 await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','tools/stock-profile-gate.ts','--installation','--local-only'],{env:{...process.env,SHIELDED_NETWORK:'mutinynet',SHIELDED_ARK_URL:'http://127.0.0.1:1',SHIELDED_EMULATOR_URL:'http://127.0.0.1:1',SHIELDED_STOCK_ARTIFACTS:'/missing-test-artifacts'},timeout:15000}),error=>{
  assert.match((error as any).stderr,/Installation qualification cannot use synthetic local-only network metadata/);return true;
 });
});
