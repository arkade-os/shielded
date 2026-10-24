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
 const app=express();app.set('env','test');app.use('/api/rollup',createRollupRouter(()=>service as RollupService|undefined));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`;
 return {base,close:()=>new Promise(resolve=>server.close(resolve))};
}
const post=(url:string,body:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
const proof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['5','6','1']};
const spend={id:'ab'.repeat(16),slot:{root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0},publics:['1','2','0','0','0','0','0'],proof,ciphertext:'00'.repeat(ROLLUP_RECORD_BYTES)};

test('the rollup API is closed until the service exists, and refuses cross-origin writes',async(t)=>{
 const closed=await serve(undefined);t.after(closed.close);
 assert.equal((await fetch(closed.base+'/status')).status,503);
 const lastBatch={batch:3,at:1,waitedMs:2,proveMs:4,publishMs:5};
 const open=await serve({ready:()=>true,status:()=>({version:1,phase:'ready',message:'',minimumFundingSats:2000,pool:{lastBatch}} as never)});t.after(open.close);
 const answered=await fetch(open.base+'/status');
 assert.equal(answered.status,200);
 assert.deepEqual((await answered.json()).pool.lastBatch,lastBatch,'the last batch\'s timings reach the status endpoint');
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
 const api=await serve({ready:()=>true,submit:async s=>{submitted.push(s as Omit<RollupSpend,'receivedAt'>);},spend:()=>undefined,sign:()=>{throw new Error('This spend has no open signing round.');},batches:()=>({from:0,total:0,batches:[]})});t.after(api.close);
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
 assert.deepEqual(submitted[0]!.publics,[1n,2n,0n,0n,0n,0n,0n]);
 assert.equal(submitted[0]!.program!.length,32);
 assert.equal((await fetch(api.base+'/spends/'+spend.id)).status,404);
 assert.equal((await post(api.base+'/spends/'+spend.id+'/sign',{arkTx:'x',checkpoint:'y'})).status,409);
 assert.equal((await fetch(api.base+'/batches?from=-1')).status,400);
});

test('a batch record from another prover is checked for shape and handed to the operator to verify against the chain',async(t)=>{
 const calls:unknown[]=[];
 const api=await serve({ready:()=>true,external:async(txid:string,slots:unknown)=>{calls.push([txid,slots]);return {batch:4,txid};}});t.after(api.close);
 const slot={root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0,ciphertext:'00'.repeat(ROLLUP_RECORD_BYTES)};
 assert.equal((await post(api.base+'/external',{txid:'zz',slots:[slot]})).status,400);
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,nullifiers:['11','12','13']}]})).status,400,'a slot spends one note or two');
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,ciphertext:'00'}]})).status,400,'a note record has its fixed size');
 const accepted=await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[slot,{...slot,ciphertext:undefined}]});
 assert.deepEqual(await accepted.json(),{batch:4,txid:'ab'.repeat(32)});
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,nullifiers:['11','12']}]})).status,200,'a join slot spends two');
 assert.deepEqual(calls,[['ab'.repeat(32),[slot,{root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0}]],['ab'.repeat(32),[{...slot,nullifiers:['11','12']}]]]);
});

test('each address gets a budget of submissions per minute; reads and deposit signatures are not counted',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 let submitted=0;
 const api=await serve({ready:()=>true,status:()=>({version:1,phase:'ready',message:'',minimumFundingSats:2000}),submit:async()=>{submitted++;},sign:()=>{throw new Error('This spend has no open signing round.');}});t.after(api.close);
 const codes:number[]=[];
 for(let i=0;i<60;i++)codes.push((await post(api.base+'/spends',{...spend,id:String(i).padStart(32,'0')})).status);
 t.mock.timers.tick(45_501);
 const limited=await post(api.base+'/spends',{...spend,id:'e'.repeat(32)});codes.push(limited.status);
 assert.deepEqual([codes.slice(0,60).every(c=>c===202),codes[60]],[true,429]);
 assert.equal(limited.headers.get('Retry-After'),'15');
 assert.deepEqual(await limited.json(),{error:'Too many requests from this address; try again in a minute.',code:'admission-rate-limit'});
 assert.equal(submitted,60);
 assert.equal((await fetch(api.base+'/status')).status,200,'reads stay open');
 assert.equal((await post(api.base+'/spends/'+spend.id+'/sign',{arkTx:'x',checkpoint:'y'})).status,409,'a signature still reaches its round');
 t.mock.timers.tick(14_499);
 const boundary=await post(api.base+'/spends',spend);
 assert.equal(boundary.status,429);assert.equal(boundary.headers.get('Retry-After'),'1');
 t.mock.timers.tick(1);
 assert.equal((await post(api.base+'/spends',spend)).status,202);
});

test('checkpoints are served only for the batch counts the operator vouches for',async(t)=>{
 const asked:number[]=[];
 const api=await serve({ready:()=>true,checkpoint:(blocks:number)=>{asked.push(blocks);return blocks===128?{blocks,filled:['5']}:undefined;}});t.after(api.close);
 const found=await fetch(api.base+'/checkpoints/128');
 assert.equal(found.status,200);
 assert.deepEqual(await found.json(),{blocks:128,filled:['5']});
 for(const path of ['/checkpoints/192','/checkpoints/0','/checkpoints/abc','/checkpoints/-64','/checkpoints/0128','/checkpoints/99999999999'])assert.equal((await fetch(api.base+path)).status,404,path);
 assert.deepEqual(asked,[128,192],'a malformed number never reaches the operator');
});

test('an epoch checkpoint is asked for by two whole numbers, and neither route reaches the other\'s handler',async(t)=>{
 const asked:[number,number][]=[],askedOne:number[]=[],found={epoch:3,blocks:128,filled:['5']};
 const api=await serve({ready:()=>true,checkpointAt:(epoch:number,blocks:number)=>{asked.push([epoch,blocks]);return epoch===3&&blocks===128?found:undefined;},checkpoint:(blocks:number)=>{askedOne.push(blocks);return undefined;}});t.after(api.close);
 const answered=await fetch(api.base+'/checkpoints/3/128');
 assert.deepEqual([answered.status,answered.headers.get('cache-control'),await answered.json()],[200,'no-store',found]);
 for(const path of ['/checkpoints/3/192','/checkpoints/0/0'])assert.equal((await fetch(api.base+path)).status,404,path);
 const refused=await fetch(api.base+'/checkpoints/4/128');
 assert.deepEqual([refused.status,refused.headers.get('cache-control'),typeof (await refused.json()).error],[404,'no-store','string']);
 for(const path of ['/checkpoints/03/128','/checkpoints/3/0128','/checkpoints/-3/128','/checkpoints/3/-128','/checkpoints/x/128','/checkpoints/3/x','/checkpoints/12345678901/128','/checkpoints/3/12345678901'])assert.equal((await fetch(api.base+path)).status,404,path);
 assert.deepEqual(asked,[[3,128],[3,192],[0,0],[4,128]],'a malformed number never reaches the service');
 assert.equal((await fetch(api.base+'/checkpoints/128')).status,404);
 assert.deepEqual([asked.length,askedOne],[4,[128]],'the one-segment form keeps its own handler');
});

test('a scan is asked for a global batch range of at most 500, and a malformed range never reaches the service',async(t)=>{
 const asked:[number,number][]=[];
 const api=await serve({ready:()=>true,scan:(from:number,limit:number)=>{asked.push([from,limit]);return {from,total:0,data:''};}});t.after(api.close);
 for(const query of ['from=-1','from=1.5','from=x','limit=0','limit=-3','limit=x'])assert.equal((await fetch(api.base+'/scan?'+query)).status,400,query);
 assert.equal((await fetch(api.base+'/scan?from=64&limit=9999')).status,200);
 assert.equal((await fetch(api.base+'/scan?from=3&limit=7')).status,200);
 assert.deepEqual(asked,[[64,500],[3,7]]);
});

test('a classic pool\'s scan is answered 200, uncached, with the service\'s scan verbatim',async(t)=>{
 const asked:[number,number][]=[];const scan={from:2,total:3,data:'AAEC'};
 const api=await serve({ready:()=>true,scan:(from:number,limit:number)=>{asked.push([from,limit]);return scan;}});t.after(api.close);
 const answered=await fetch(api.base+'/scan?from=2');
 assert.equal(answered.status,200);
 assert.equal(answered.headers.get('cache-control'),'no-store');
 assert.deepEqual(await answered.json(),scan);
 assert.deepEqual(asked,[[2,500]]);
});

test('spends admitted at once are capped across all addresses, and the cap frees as checks finish',async(t)=>{
 let release=()=>{};const held=new Promise<void>(r=>{release=r;});let admitted=0;
 const api=await serve({ready:()=>true,submit:async s=>{if(s.id==='d'.repeat(32))throw new Error('Invalid client proof.');admitted++;await held;}});t.after(api.close);
 try{
  assert.equal((await post(api.base+'/spends',{...spend,id:'d'.repeat(32)})).status,400);
  const posts=Array.from({length:8},(_,i)=>post(api.base+'/spends',{...spend,id:String(i).padStart(32,'a')}));
  for(let i=0;i<400&&admitted<8;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(admitted,8,'a refused check gave its place back');
  const refused=await post(api.base+'/spends',{...spend,id:'f'.repeat(32)});
  assert.equal(refused.status,503,'a ninth check waits for one of eight to finish');
  release();
  assert.deepEqual((await Promise.all(posts)).map(r=>r.status),Array(8).fill(202));
  assert.equal((await post(api.base+'/spends',{...spend,id:'e'.repeat(32)})).status,202);
 }finally{release();}
});

const systemError=(syscall:string,path:string)=>Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`),{errno:-2,code:'ENOENT',syscall,path});
const unreadable=systemError('scandir','/data/operator/nullifiers'),missing=systemError('open','/data/operator/batches/65.json');
const refused=new Error('Batch 65\'s recorded block root is not the one the live note tree holds.');
const raise=(error:Error)=>()=>{throw error;};
for(const [path,status,error,shown,service] of [
 ['/storage',503,unreadable,'Storage figures are unavailable.',{storage:raise(unreadable)}],
 ['/archives',500,unreadable,'The archive files could not be read.',{archiveEpochs:raise(unreadable)}],
 ['/archives/epoch-0.nf',500,unreadable,'The archive files could not be read.',{archiveFile:raise(unreadable)}],
 ['/scan',500,refused,refused.message,{epochPool:true,scan:raise(refused)}],
] as const)test(`${path} answers a JSON error, uncached, when its service call throws`,async t=>{
 const log=t.mock.method(console,'error',()=>{}),api=await serve({ready:()=>true,...service});t.after(api.close);
 const answer=await fetch(api.base+path);
 assert.deepEqual([answer.status,answer.headers.get('content-type')?.split(';')[0],answer.headers.get('cache-control'),await answer.json()],[status,'application/json','no-store',{error:shown}]);
 assert.deepEqual(log.mock.calls.map(call=>String(call.arguments[0]).includes(error.message)),[true],'the real error is logged once');
});

test('an epoch /scan that cannot read a batch record answers a fixed error, not the path',async t=>{
 const log=t.mock.method(console,'error',()=>{}),api=await serve({ready:()=>true,epochPool:true,scan:raise(missing)});t.after(api.close);
 const answer=await fetch(api.base+'/scan');
 assert.deepEqual([answer.status,answer.headers.get('cache-control'),await answer.json()],[500,'no-store',{error:'The batch records could not be read.'}]);
 assert.deepEqual(log.mock.calls.map(call=>String(call.arguments[0]).includes(missing.message)),[true],'the real error is logged once');
});

test('a classic pool\'s /scan that throws is still answered by Express, not as JSON',async t=>{
 const api=await serve({ready:()=>true,scan:raise(refused)});t.after(api.close);
 const answer=await fetch(api.base+'/scan');
 assert.deepEqual([answer.status,answer.headers.get('content-type')?.split(';')[0]],[500,'text/html']);
});
