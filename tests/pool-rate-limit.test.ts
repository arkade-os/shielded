import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {poolApiOf,rollupApi,waitForSpend} from '../src/shielded/pool.ts';

const flush=async()=>{for(let i=0;i<8;i++)await setImmediate();};
const outcome=<T,>(promise:Promise<T>)=>promise.then(value=>({value,error:undefined}),error=>({value:undefined,error}));

test('a rate-limited GET waits for Retry-After seconds before reading again',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const calls:number[]=[];
 const fetcher=(async()=>{calls.push(Date.now());return calls.length===1?new Response('rate limited',{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true});}) as typeof fetch;
 const pending=outcome(poolApiOf('https://seconds.test',fetcher)('/status'));
 await flush();assert.equal(calls.length,1);
 t.mock.timers.tick(1999);await flush();assert.equal(calls.length,1);
 t.mock.timers.tick(1);await flush();
 assert.deepEqual(await pending,{value:{ok:true},error:undefined});assert.deepEqual(calls,[1_000_000,1_002_000]);
});

test('Retry-After dates preserve one POST body and recheck its deadline immediately before retry',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const body={id:'fixed-id',proof:{pi_a:['original']}},requests:{at:number;body:unknown}[]=[],checks:number[]=[];
 const fetcher=(async(_url:unknown,init?:RequestInit)=>{
  requests.push({at:Date.now(),body:init?.body});
  if(requests.length===1){body.id='changed';body.proof.pi_a[0]='changed';return new Response('{}',{status:429,headers:{'Retry-After':new Date(1_065_000).toUTCString()}});}
  return Response.json({ok:true});
 }) as typeof fetch;
 const pending=outcome(rollupApi('/spends',body,fetcher,0,'https://date.test',()=>{checks.push(Date.now());}));
 await flush();t.mock.timers.tick(64_999);await flush();assert.equal(requests.length,1);assert.equal(checks.length,1);
 t.mock.timers.tick(1);await flush();assert.equal((await pending).error,undefined);
 assert.deepEqual(checks,[1_000_000,1_065_000]);
 assert.deepEqual(requests,[{at:1_000_000,body:'{"id":"fixed-id","proof":{"pi_a":["original"]}}'},{at:1_065_000,body:'{"id":"fixed-id","proof":{"pi_a":["original"]}}'}]);
});

test('all clients of a rate-limited origin share its cooldown while other pools continue',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const calls:string[]=[];
 const fetcher=(async(url:unknown)=>{calls.push(String(url));return calls.length===1?new Response('{}',{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true});}) as typeof fetch;
 const first=outcome(poolApiOf('https://shared.test',fetcher)('/spends/a'));
 await flush();
 const sibling=outcome(poolApiOf('https://shared.test/',fetcher)('/status'));
 const other=poolApiOf('https://other.test',fetcher)('/status');
 await flush();assert.equal(calls.length,2);assert.deepEqual(await other,{ok:true});
 t.mock.timers.tick(2000);await flush();
 assert.equal((await first).error,undefined);assert.equal((await sibling).error,undefined);assert.equal(calls.length,4);
});

test('an admission limit leaves admitted status reads and signatures open for the signing round',async t=>{
 for(const legacy of [false,true]){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  let admissions=0,reads=0,signs=0;
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
   if(init?.method==='POST'&&!String(url).endsWith('/sign')){
    admissions++;
    if(admissions===1)return Response.json({error:legacy?'Too many requests from this address; try again in a minute.':'Admission capacity exhausted.',...(legacy?{}:{code:'admission-rate-limit'})},{status:429});
    return Response.json({status:'pending'});
   }
   if(init?.method==='POST'){signs++;return Response.json({status:'signed'});}
   reads++;return Response.json({status:'signing'});
  }) as typeof fetch;
  const api=poolApiOf(`https://admission-${legacy}.test`,fetcher),first=outcome(api('/spends',{id:'first'}));
  await flush();
  const next=outcome(api('/external',{txid:'next'})),read=outcome(api('/spends/admitted')),sign=outcome(api('/spends/admitted/sign',{arkTx:'a',checkpoint:'c'}));
  await flush();assert.equal(admissions,1);assert.equal(reads,1);assert.equal(signs,1);
  assert.equal((await read).error,undefined);assert.equal((await sign).error,undefined);assert.equal(Date.now(),1_000_000);
  t.mock.timers.tick(59_999);await flush();assert.equal(admissions,1);
  t.mock.timers.tick(1);await flush();assert.equal(admissions,3);assert.equal((await first).error,undefined);assert.equal((await next).error,undefined);
  t.mock.timers.reset();
 }
});

test('an edge rate limit on a signature also pauses status reads from that origin',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const calls:string[]=[];
 const fetcher=(async(url:unknown)=>{calls.push(String(url));return calls.length===1?new Response('Cloudflare rate limit',{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true});}) as typeof fetch;
 const api=poolApiOf('https://signature-edge.test',fetcher),signature=outcome(api('/spends/a/sign',{arkTx:'a',checkpoint:'c'}));
 await flush();const status=outcome(api('/spends/a'));await flush();assert.equal(calls.length,1);
 t.mock.timers.tick(2000);await flush();
 assert.equal((await signature).error,undefined);assert.equal((await status).error,undefined);assert.equal(calls.length,3);
});

test('missing and invalid Retry-After headers back off for a minute and retries are bounded',async t=>{
 for(const header of [undefined,'invalid','-2']){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  let calls=0;
  const fetcher=(async()=>{calls++;return new Response('Cloudflare rate limit',{status:429,headers:header===undefined?{}:{'Retry-After':header}});}) as typeof fetch;
  const pending=outcome(poolApiOf(`https://fallback-${header??'missing'}.test`,fetcher)('/status'));
  await flush();assert.equal(calls,1);
  for(let i=1;i<5;i++){t.mock.timers.tick(59_999);await flush();assert.equal(calls,i);t.mock.timers.tick(1);await flush();assert.equal(calls,i+1);}
  assert.equal((await pending).error?.status,429);assert.equal(calls,5);
  t.mock.timers.reset();
 }
});

test('a funding deadline that expires during cooldown prevents a second POST',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let calls=0,checks=0;
 const fetcher=(async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'2'}});}) as typeof fetch;
 const pending=outcome(rollupApi('/spends',{id:'fixed'},fetcher,0,'https://expired.test',()=>{checks++;if(Date.now()>=1_001_000)throw new Error('funding deadline expired');}));
 await flush();assert.equal(calls,1);
 t.mock.timers.tick(2000);await flush();
 assert.match((await pending).error?.message??'',/funding deadline expired/);assert.equal(calls,1);assert.equal(checks,2);
});

test('definitive 400 and 409 refusals are never retried',async()=>{
 for(const status of [400,409]){
  let calls=0;
  const fetcher=(async()=>{calls++;return Response.json({error:'definitive refusal'},{status});}) as typeof fetch;
  await assert.rejects(poolApiOf(`https://refusal-${status}.test`,fetcher)('/spends',{}),(error:{status?:number;message?:string})=>error.status===status&&error.message==='definitive refusal');
  assert.equal(calls,1);
 }
});

test('pending polling slows down but observes a new signing round well inside its 30-second window',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const polls:number[]=[],signed:number[]=[];
 const pending=waitForSpend('a',async()=>{signed.push(Date.now());},(async()=>{
  polls.push(Date.now());return signed.length?{status:'included'}:Date.now()>=1_012_001?{status:'signing',arkTx:'A'}:{status:'pending'};
 }) as never);
 await flush();
 for(let elapsed=1000;elapsed<=22_000;elapsed+=1000){t.mock.timers.tick(1000);await flush();}
 assert.equal((await pending).status,'included');assert.ok(polls.length<=8,String(polls.length));
 assert.ok(signed[0]!>=1_012_001&&signed[0]!<=1_017_001,String(signed[0]));
});
