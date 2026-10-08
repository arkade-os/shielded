import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import express from 'express';
import {ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import type {RollupSpend} from '../src/rollup/batcher.ts';
import {createRollupRouter} from '../src/rollup/http.ts';
import type {RollupService} from '../src/rollup/service.ts';

async function serve(service:Partial<RollupService>|undefined){
 const app=express();app.use('/api/rollup',createRollupRouter(()=>service as RollupService|undefined));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`;
 return {base,close:()=>new Promise(resolve=>server.close(resolve))};
}
const post=(url:string,body:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
const proof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['5','6','1']};
const spend={id:'ab'.repeat(16),slot:{root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0},publics:['1','2','0','0','0'],proof,ciphertext:'00'.repeat(ROLLUP_RECORD_BYTES)};

test('the rollup API is closed until the service exists, and refuses cross-origin writes',async(t)=>{
 const closed=await serve(undefined);t.after(closed.close);
 assert.equal((await fetch(closed.base+'/status')).status,503);
 const open=await serve({ready:()=>true,status:()=>({version:1,phase:'ready',message:'',minimumFundingSats:2000})});t.after(open.close);
 assert.equal((await fetch(open.base+'/status')).status,200);
 assert.equal((await post(open.base+'/spends',spend,'https://evil.example')).status,403);
});

test('proving keys are served from any key directory, including one under a dot-directory',async(t)=>{
 const dir=join(mkdtempSync(join(tmpdir(),'rollup-http-')),'.hidden','keys');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'spend.wasm'),Uint8Array.of(0,0x61,0x73,0x6d));
 const api=await serve({ready:()=>true,keyFile:(name:string)=>name.startsWith('spend.')?join(dir,name):undefined});t.after(api.close);
 const response=await fetch(api.base+'/proving/spend.wasm');
 assert.equal(response.status,200);
 assert.match(response.headers.get('cache-control')??'',/immutable/);
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,0x61,0x73,0x6d]);
 assert.equal((await fetch(api.base+'/proving/batch-spend.zkey')).status,404);
 const missing=await fetch(api.base+'/proving/spend.zkey');
 assert.equal(missing.status,404);
 assert.doesNotMatch(missing.headers.get('cache-control')??'',/immutable/,'a failed key request must not be cached');
});

test('a spend is validated and handed to the operator with field elements as bigints',async(t)=>{
 const submitted:Omit<RollupSpend,'receivedAt'>[]=[];
 const api=await serve({ready:()=>true,submit:async s=>{submitted.push(s);},spend:()=>undefined,sign:()=>{throw new Error('This spend has no open signing round.');},batches:()=>({from:0,total:0,batches:[]})});t.after(api.close);
 assert.equal((await post(api.base+'/spends',{...spend,id:'short'})).status,400);
 assert.equal((await post(api.base+'/spends',{...spend,ciphertext:'00'})).status,400);
 for(const [groupId,groupSize] of [['0',2],['5',0],['5',4],['5','2']] as const)assert.equal((await post(api.base+'/spends',{...spend,slot:{...spend.slot,groupId,groupSize}})).status,400,`group ${groupId}/${groupSize}`);
 assert.equal((await post(api.base+'/spends',{...spend,id:'cd'.repeat(16),slot:{...spend.slot,groupId:'5',groupSize:3}})).status,202);
 assert.deepEqual([submitted[0]!.slot.groupId,submitted[0]!.slot.groupSize],[5n,3]);
 submitted.length=0;
 assert.equal((await post(api.base+'/spends',{...spend,id:'ef'.repeat(16),asset:'XY'})).status,400,'a malformed asset id');
 assert.equal((await post(api.base+'/spends',{...spend,id:'ef'.repeat(16),asset:'aa'.repeat(34)})).status,202);
 assert.equal(submitted[0]!.asset,'aa'.repeat(34));
 submitted.length=0;
 const accepted=await post(api.base+'/spends',{...spend,program:'cd'.repeat(32)});
 assert.equal(accepted.status,202);
 assert.deepEqual(submitted[0]!.slot,{root:7n,nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:0n,groupSize:0});
 assert.deepEqual(submitted[0]!.publics,[1n,2n,0n,0n,0n]);
 assert.equal(submitted[0]!.program!.length,32);
 assert.equal((await fetch(api.base+'/spends/'+spend.id)).status,404);
 assert.equal((await post(api.base+'/spends/'+spend.id+'/sign',{arkTx:'x',checkpoint:'y'})).status,409);
 assert.equal((await fetch(api.base+'/batches?from=-1')).status,400);
});
