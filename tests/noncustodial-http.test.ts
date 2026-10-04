import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNoncustodialApp} from '../src/noncustodial/server.ts';
import type {PublicCoordinator} from '../src/noncustodial/coordinator.ts';

test('wallet and proving artifacts are served from a hidden managed checkout',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'shielded-http-'));
 const webRoot=join(directory,'.managed','app');await mkdir(webRoot,{recursive:true});await writeFile(join(webRoot,'index.html'),'<!doctype html><title>Wallet fixture</title>');
 const coordinator={profile:()=>({ready:false})} as PublicCoordinator;
 const server=createNoncustodialApp(coordinator,undefined,webRoot).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const wallet=await fetch(url+'/wallet');assert.equal(wallet.status,200);assert.match(wallet.headers.get('content-type')??'',/text\/html/);assert.match(await wallet.text(),/Wallet fixture/);
  const home=await fetch(url+'/',{redirect:'manual'});assert.equal(home.status,302);assert.equal(home.headers.get('location'),'/wallet');
  const artifact=await fetch(url+'/api/proving/intent.wasm');assert.equal(artifact.status,200);assert.deepEqual([...new Uint8Array(await artifact.arrayBuffer()).slice(0,4)],[0,97,115,109]);
  const traversal=await fetch(url+'/api/proving/unknown');assert.equal(traversal.status,404);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});

test('registry mode rejects live dispatch before creating a network adapter',async()=>{
 const {createSdkRuntime}=await import('../src/sdk/runtime.ts');
 const options={network:'mutinynet',registry:{file:'unused-registry.json',recipientPublicKeys:{alice:'',bob:''}},verificationKeys:{},initialState:{}} as any;
 await assert.rejects(createSdkRuntime(options),/not deployed on Mutinynet/);
 delete options.network;options.checkpoint={network:'mutinynet'};
 await assert.rejects(createSdkRuntime(options),/not deployed on Mutinynet/);
});

test('registry mode rejects invalid weight budgets before building resources',async()=>{
 const {createSdkRuntime}=await import('../src/sdk/runtime.ts');
 for(const weightLimit of [0,-1,NaN,Infinity,1.5])await assert.rejects(createSdkRuntime({registry:{file:'unused',recipientPublicKeys:{alice:'',bob:''},weightLimit},verificationKeys:{},initialState:{}} as any),/positive safe integer/);
});
