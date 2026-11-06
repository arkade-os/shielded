import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import express from 'express';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import type {RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {createRollupRouter} from '../src/rollup/http.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import type {RollupService} from '../src/rollup/service.ts';

/** `remote` replaces the socket address of every request this server sees; the test socket itself is always loopback. */
async function serve(service:Partial<RollupService>|undefined,options?:Parameters<typeof createRollupRouter>[1],remote?:string){
 const app=express();app.set('env','test');
 if(remote)app.use((req,_res,next)=>{Object.defineProperty(req.socket,'remoteAddress',{value:remote,configurable:true});next();});
 app.use('/api/rollup',createRollupRouter(()=>service as RollupService|undefined,options));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`;
 return {base,close:()=>new Promise(resolve=>server.close(resolve))};
}
const post=(url:string,body:unknown,origin?:string,headers?:Record<string,string>)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{}),...headers},body:JSON.stringify(body)});
const proof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['5','6','1']};
const spend={id:'ab'.repeat(16),slot:{anchor:'7',rCur:{epoch:0,root:'8'},nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0},publics:['1','2','0','0','0','0','0'],proof,ciphertext:'00'.repeat(ROLLUP_RECORD_BYTES)};

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

test('a listed origin may read and write cross-origin; every other origin is still refused',async(t)=>{
 const status=()=>({version:1,phase:'ready',message:'',pool:{}} as never);
 const closed=await serve({ready:()=>true,status});t.after(closed.close);
 assert.equal((await fetch(closed.base+'/status',{headers:{origin:'https://app.example'}})).headers.get('access-control-allow-origin'),null);
 const submitted:unknown[]=[];
 const api=await serve({ready:()=>true,status,submit:async s=>{submitted.push(s);},spend:()=>undefined},{allowedOrigins:['https://app.example/']});t.after(api.close);
 const preflight=await fetch(api.base+'/spends',{method:'OPTIONS',headers:{origin:'https://app.example','access-control-request-method':'POST','access-control-request-headers':'content-type'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://app.example');
 assert.match(preflight.headers.get('access-control-allow-headers')??'',/content-type/);assert.match(preflight.headers.get('access-control-allow-methods')??'',/POST/);
 const read=await fetch(api.base+'/status',{headers:{origin:'https://app.example'}});
 assert.equal(read.headers.get('access-control-allow-origin'),'https://app.example');assert.match(read.headers.get('access-control-expose-headers')??'',/Retry-After/i);
 const write=await post(api.base+'/spends',spend,'https://app.example');
 assert.equal(write.status,202);assert.equal(submitted.length,1);assert.equal(write.headers.get('access-control-allow-origin'),'https://app.example');
 const refused=await post(api.base+'/spends',spend,'https://evil.example');
 assert.equal(refused.status,403);assert.equal(refused.headers.get('access-control-allow-origin'),null);
 assert.match(refused.headers.get('vary')??'',/origin/i);assert.match((await fetch(api.base+'/status')).headers.get('vary')??'',/origin/i);
 assert.throws(()=>createRollupRouter(()=>undefined,{allowedOrigins:['not an origin']}),/Invalid URL/);
 assert.throws(()=>createRollupRouter(()=>undefined,{allowedOrigins:['file:///x']}),/not an http\(s\) origin/);
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
 const submitted:Omit<RollupEpochSpend,'receivedAt'>[]=[];
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
 assert.deepEqual(submitted[0]!.slot,{anchor:7n,rCur:{epoch:0,root:8n},nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:0n,groupSize:0});
 assert.deepEqual(submitted[0]!.publics,[1n,2n,0n,0n,0n,0n,0n]);
 assert.equal(submitted[0]!.program!.length,32);
 assert.equal((await fetch(api.base+'/spends/'+spend.id)).status,404);
 assert.equal((await post(api.base+'/spends/'+spend.id+'/sign',{arkTx:'x',checkpoint:'y'})).status,409);
 assert.equal((await fetch(api.base+'/batches?from=-1')).status,400);
});

test('a batch record from another prover is checked for shape and handed to the operator to verify against the chain',async(t)=>{
 const calls:unknown[]=[];
 const api=await serve({ready:()=>true,external:async(txid:string,slots:unknown)=>{calls.push([txid,slots]);return {batch:4,txid};}});t.after(api.close);
 const slot={anchor:'7',rCur:{epoch:0,root:'8'},nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0,ciphertext:'00'.repeat(ROLLUP_RECORD_BYTES)},{ciphertext:_,...bare}=slot;
 assert.equal((await post(api.base+'/external',{txid:'zz',slots:[slot]})).status,400);
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,nullifiers:['11','12','13']}]})).status,400,'a slot spends one note or two');
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,ciphertext:'00'}]})).status,400,'a note record has its fixed size');
 const accepted=await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[slot,{...slot,ciphertext:undefined}]});
 assert.deepEqual(await accepted.json(),{batch:4,txid:'ab'.repeat(32)});
 assert.equal((await post(api.base+'/external',{txid:'ab'.repeat(32),slots:[{...slot,nullifiers:['11','12']}]})).status,200,'a join slot spends two');
 assert.deepEqual(calls,[['ab'.repeat(32),[slot,bare]],['ab'.repeat(32),[{...slot,nullifiers:['11','12']}]]]);
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

const TOKEN='per-process-token',claim={'x-shielded-gateway':TOKEN};

test('gateway traffic on loopback skips the per-address POST limit',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 for(const remote of [undefined,'::1','::ffff:127.0.0.1']){
  let submitted=0;
  const api=await serve({ready:()=>true,submit:async()=>{submitted++;}},{gatewayToken:TOKEN},remote);t.after(api.close);
  for(let i=0;i<61;i++)assert.equal((await post(api.base+'/spends',spend,undefined,claim)).status,202,`${remote??'127.0.0.1'} POST ${i+1}`);
  assert.equal(submitted,61);
  assert.equal((await post(api.base+'/spends',{...spend,id:'short'},undefined,claim)).status,400,'the route still validates');
  assert.equal((await post(api.base+'/spends',spend,'https://evil.example',claim)).status,403,'the origin check still applies');
 }
 const starting=await serve(undefined,{gatewayToken:TOKEN});t.after(starting.close);
 assert.equal((await post(starting.base+'/spends',spend,undefined,claim)).status,503,'the starting check still applies');
});

test('a wrong or forwarded gateway claim is limited like any other address',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 const cases:[string,Record<string,string>,Parameters<typeof createRollupRouter>[1],string?][]=[
  ['a wrong token of the right length',{'x-shielded-gateway':'x'.repeat(TOKEN.length)},{gatewayToken:TOKEN}],
  ['a wrong token of another length',{'x-shielded-gateway':'x'},{gatewayToken:TOKEN}],
  ['no token',{},{gatewayToken:TOKEN}],
  ['the right token, forwarded',{...claim,'x-forwarded-for':'198.51.100.7'},{gatewayToken:TOKEN}],
  ['the right token, from a non-loopback address',claim,{gatewayToken:TOKEN},'203.0.113.9'],
  ['a router with no token set',claim,{}],
  ['a router with an empty token',{'x-shielded-gateway':''},{gatewayToken:''}],
 ];
 for(const [name,headers,options,remote] of cases){
  const api=await serve({ready:()=>true,submit:async()=>{}},options,remote);t.after(api.close);
  const codes:number[]=[];for(let i=0;i<61;i++)codes.push((await post(api.base+'/spends',spend,undefined,headers)).status);
  assert.deepEqual([codes.slice(0,60).every(code=>code===202),codes[60]],[true,429],name);
 }
});

test('what the gateway forwards to the pool is admitted past the per-address limit',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,app=express(),server=app.listen(0,'127.0.0.1');
 await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,suite=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
 app.use('/api/rollup',createOhttpGateway({key,upstreams:[],poolOrigin:'https://pool.example',poolLoopback:origin,gatewayToken:TOKEN,rate:1000}));
 app.use('/api/rollup',createRollupRouter(()=>({ready:()=>true,submit:async()=>{}}) as unknown as RollupService,{gatewayToken:TOKEN}));
 const client=new OHTTPClient(suite,KeyConfig.select(suite,KeyConfig.parseMultiple(key.config)),{maxMessageSize:5<<20});
 for(let i=0;i<61;i++){
  const {init,context}=await client.encapsulateRequest(new Request('https://pool.example/api/rollup/spends',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(spend)}));
  assert.equal((await context.decapsulateResponse(await fetch(origin+'/api/rollup/ohttp',init))).status,202,`sealed POST ${i+1}`);
 }
});

test('without the gateway mounted, its two paths answer 404',async t=>{
 const api=await serve({ready:()=>true});t.after(api.close);
 assert.equal((await fetch(api.base+'/ohttp-keys')).status,404);
 assert.equal((await fetch(api.base+'/ohttp',{method:'POST',headers:{'content-type':'message/ohttp-req'},body:new Uint8Array(8)})).status,404);
});

test('a one-segment /checkpoints/:blocks answers 404 for every count, and reaches no service method',async(t)=>{
 const api=await serve({ready:()=>true});t.after(api.close);
 for(const path of ['/checkpoints/64','/checkpoints/128','/checkpoints/0','/checkpoints/abc'])assert.equal((await fetch(api.base+path)).status,404,path);
});

test('an epoch checkpoint is asked for by two whole numbers, and a malformed number never reaches the service',async(t)=>{
 const asked:[number,number][]=[],found={epoch:3,blocks:128,filled:['5']};
 const api=await serve({ready:()=>true,checkpointAt:(epoch:number,blocks:number)=>{asked.push([epoch,blocks]);return epoch===3&&blocks===128?found:undefined;}});t.after(api.close);
 const answered=await fetch(api.base+'/checkpoints/3/128');
 assert.deepEqual([answered.status,answered.headers.get('cache-control'),await answered.json()],[200,'no-store',found]);
 for(const path of ['/checkpoints/3/192','/checkpoints/0/0'])assert.equal((await fetch(api.base+path)).status,404,path);
 const refused=await fetch(api.base+'/checkpoints/4/128');
 assert.deepEqual([refused.status,refused.headers.get('cache-control'),typeof (await refused.json()).error],[404,'no-store','string']);
 for(const path of ['/checkpoints/03/128','/checkpoints/3/0128','/checkpoints/-3/128','/checkpoints/3/-128','/checkpoints/x/128','/checkpoints/3/x','/checkpoints/12345678901/128','/checkpoints/3/12345678901'])assert.equal((await fetch(api.base+path)).status,404,path);
 assert.deepEqual(asked,[[3,128],[3,192],[0,0],[4,128]],'a malformed number never reaches the service');
});

test('a scan is asked for a global batch range of at most 500, and a malformed range never reaches the service',async(t)=>{
 const asked:[number,number][]=[];
 const api=await serve({ready:()=>true,scan:(from:number,limit:number)=>{asked.push([from,limit]);return {from,total:0,data:''};}});t.after(api.close);
 for(const query of ['from=-1','from=1.5','from=x','limit=0','limit=-3','limit=x'])assert.equal((await fetch(api.base+'/scan?'+query)).status,400,query);
 assert.equal((await fetch(api.base+'/scan?from=64&limit=9999')).status,200);
 assert.equal((await fetch(api.base+'/scan?from=3&limit=7')).status,200);
 assert.deepEqual(asked,[[64,500],[3,7]]);
});

test('a scan is answered 200, uncached, with the service\'s scan verbatim',async(t)=>{
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
 ['/scan',500,refused,refused.message,{scan:raise(refused)}],
] as const)test(`${path} answers a JSON error, uncached, when its service call throws`,async t=>{
 const log=t.mock.method(console,'error',()=>{}),api=await serve({ready:()=>true,...service});t.after(api.close);
 const answer=await fetch(api.base+path);
 assert.deepEqual([answer.status,answer.headers.get('content-type')?.split(';')[0],answer.headers.get('cache-control'),await answer.json()],[status,'application/json','no-store',{error:shown}]);
 assert.deepEqual(log.mock.calls.map(call=>String(call.arguments[0]).includes(error.message)),[true],'the real error is logged once');
});

test('an epoch /scan that cannot read a batch record answers a fixed error, not the path',async t=>{
 const log=t.mock.method(console,'error',()=>{}),api=await serve({ready:()=>true,scan:raise(missing)});t.after(api.close);
 const answer=await fetch(api.base+'/scan');
 assert.deepEqual([answer.status,answer.headers.get('cache-control'),await answer.json()],[500,'no-store',{error:'The batch records could not be read.'}]);
 assert.deepEqual(log.mock.calls.map(call=>String(call.arguments[0]).includes(missing.message)),[true],'the real error is logged once');
});
