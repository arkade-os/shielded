import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {poolApiOf,rollupApi,waitForSpend,type SpendStatus} from '../src/shielded/pool.ts';
import {PRIVATE_SPEND_POLL_MS,PRIVATE_VERDICT_EVERY,markPrivateFetch,markSealedFetch} from '../src/shielded/network-privacy.ts';
import {SealedFetchError} from '../src/shielded/sealed-fetch.ts';

const flush=async()=>{for(let i=0;i<8;i++)await setImmediate();};
const outcome=<T,>(promise:Promise<T>)=>promise.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
// Draws are never zero, so a delay left unjittered sits exactly on its base and fails a strict bound.
const paced=(t:TestContext)=>{const delays:number[]=[];let n=0;t.mock.method(Math,'random',()=>(++n%9+1)/10);t.mock.method(globalThis,'setTimeout',((run:()=>void,ms:number)=>{if(delays.push(ms)>50)throw new Error('The poll never ended.');run();}) as never);return delays;};

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

test('a JSON null rate-limit response still retries and shares the origin cooldown',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let calls=0;
 const fetcher=(async()=>{calls++;return calls===1?Response.json(null,{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true});}) as typeof fetch;
 const api=poolApiOf('https://null-limit.test',fetcher),first=outcome(api('/spends',{id:'fixed'}));
 await flush();const sibling=outcome(api('/status'));await flush();assert.equal(calls,1);
 t.mock.timers.tick(1999);await flush();assert.equal(calls,1);
 t.mock.timers.tick(1);await flush();
 assert.deepEqual(await first,{value:{ok:true},error:undefined});assert.deepEqual(await sibling,{value:{ok:true},error:undefined});assert.equal(calls,3);
});

test('a JSON null refusal retains its HTTP status and successful JSON is returned unchanged',async()=>{
 const refusing=(async()=>Response.json(null,{status:400})) as typeof fetch;
 await assert.rejects(poolApiOf('https://null-refusal.test',refusing)('/spends',{}),(error:{status?:number;message?:string})=>error.status===400&&error.message==='The pool answered 400.');
 for(const value of [null,false,7,['original']]){
  const fetcher=(async()=>Response.json(value)) as typeof fetch;
  assert.deepEqual(await poolApiOf('https://raw-success.test',fetcher)('/status'),value);
 }
});

test('a GET that never answers is abandoned after a minute and read again, while a POST is never timed out',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const signals:(AbortSignal|null|undefined)[]=[];
 const fetcher=(async(_url:string,init?:RequestInit)=>{signals.push(init?.signal);
  if(signals.length>1)return Response.json({ok:true});
  return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason)));
 }) as typeof fetch;
 const pending=outcome(rollupApi('/status',undefined,fetcher,0,'https://hung.test'));
 await flush();t.mock.timers.tick(59_999);await flush();assert.equal(signals.length,1);
 t.mock.timers.tick(1);await flush();t.mock.timers.tick(0);await flush();
 assert.deepEqual(await pending,{value:{ok:true},error:undefined});assert.equal(signals.length,2);
 await rollupApi('/spends',{id:'fixed'},fetcher,0,'https://hung.test');assert.equal(signals[2],undefined);
});

test('a successful answer whose body cannot be read is read again, never taken as an empty result',async()=>{
 let calls=0;
 const fetcher=(async()=>++calls===1?new Response('{"batches":[',{status:200}):Response.json({batches:[]})) as typeof fetch;
 assert.deepEqual(await rollupApi('/batches?from=0&limit=50',undefined,fetcher,0,'https://truncated.test'),{batches:[]});
 assert.equal(calls,2);
 let posts=0;
 const admitted=(async()=>{posts++;return new Response('{"id":"fixed","sta',{status:202});}) as typeof fetch;
 assert.deepEqual(await rollupApi('/spends',{id:'fixed'},admitted,0,'https://truncated.test'),{});
 assert.equal(posts,1,'an admitted POST is never resent; the caller reconciles it by id');
});

test('a past Retry-After date waits a minute while numeric zero retains the one-second minimum',async t=>{
 for(const [name,header,delay] of [['past',new Date(999_000).toUTCString(),60_000],['zero','0',1000]] as const){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  let calls=0;
  const fetcher=(async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'Retry-After':header}}):Response.json({ok:true});}) as typeof fetch;
  const pending=outcome(poolApiOf(`https://retry-${name}.test`,fetcher)('/status'));
  await flush();t.mock.timers.tick(delay-1);await flush();assert.equal(calls,1);
  t.mock.timers.tick(1);await flush();assert.deepEqual(await pending,{value:{ok:true},error:undefined});assert.equal(calls,2);
  t.mock.timers.reset();
 }
});

test('a positive Retry-After of one hour is honored without shortening it',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let calls=0;
 const fetcher=(async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'Retry-After':'3600'}}):Response.json({ok:true});}) as typeof fetch;
 const pending=outcome(poolApiOf('https://long-backoff.test',fetcher)('/status'));
 await flush();t.mock.timers.tick(3_599_999);await flush();assert.equal(calls,1);
 t.mock.timers.tick(1);await flush();assert.deepEqual(await pending,{value:{ok:true},error:undefined});assert.equal(calls,2);
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

test('a sealed read gives up on a 502 at once, without waiting or asking again',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let calls=0,settled=false;
 const fetcher=markSealedFetch(markPrivateFetch((async()=>{calls++;return new Response('',{status:502});}) as typeof fetch));
 const pending=outcome(rollupApi('/batches?from=0&limit=12',undefined,fetcher,1000,'https://sealed-502.test')).then(result=>{settled=true;return result;});
 await flush();
 assert.equal(settled,true);assert.equal(calls,1);assert.equal((await pending).error?.status,502);
});

test('a private read that is not sealed still repeats a 502, as does a direct one, and a sealed read still repeats a 503',async t=>{
 for(const [label,priv,sealed,status] of [['private 502',true,false,502],['direct 502',false,false,502],['sealed 503',true,true,503]] as const){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  let calls=0;
  const raw=(async()=>{calls++;return new Response('',{status});}) as typeof fetch,fetcher=sealed?markSealedFetch(markPrivateFetch(raw)):priv?markPrivateFetch(raw):raw;
  const pending=outcome(rollupApi('/batches?from=0&limit=12',undefined,fetcher,1000,'https://sealed-502.test'));
  await flush();assert.equal(calls,1,label);
  for(let i=1;i<5;i++){t.mock.timers.tick(1000);await flush();assert.equal(calls,i+1,label);}
  assert.equal((await pending).error?.status,status,label);
  t.mock.timers.reset();
 }
});

test('a sealed read gives up on unavailable at once, and a private read that is not sealed still asks five times',async t=>{
 for(const [label,sealed,calls] of [['sealed',true,1],['private',false,5]] as const){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  let count=0,settled=false;
  const raw=(async()=>{count++;throw new SealedFetchError('unavailable','No relay brought an answer in time.');}) as typeof fetch;
  const pending=outcome(rollupApi('/batches?from=0&limit=12',undefined,sealed?markSealedFetch(markPrivateFetch(raw)):markPrivateFetch(raw),1000,'https://sealed-unavailable.test')).then(result=>{settled=true;return result;});
  await flush();assert.deepEqual([count,settled],[1,sealed],label);
  for(let i=1;i<calls;i++){t.mock.timers.tick(1000);await flush();}
  assert.equal(count,calls,label);assert.equal((await pending).error?.cause?.code,'unavailable',label);
  t.mock.timers.reset();
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

for(const failure of ['503','network','429'] as const)test(`an accepted spend survives exhausted ${failure} status reads without another POST`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const reads:string[]=[];let posts=0,signs=0;
 const fetcher=(async(url:unknown,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return Response.json({status:'pending'});}
  reads.push(String(url));
  if(reads.length<=5){
   if(failure==='network')throw new TypeError('fetch failed');
   return new Response('temporary outage',{status:Number(failure),headers:{'Retry-After':'1'}});
  }
  return Response.json({status:'included',batch:146,txid:'settled'});
 }) as typeof fetch;
 const api=poolApiOf(`https://accepted-${failure}.test`,fetcher);
 await api('/spends',{id:'accepted'});
 const pending=outcome(waitForSpend('accepted',async()=>{signs++;},api,1000,30_000));
 await flush();for(let i=0;i<6;i++){t.mock.timers.tick(1000);await flush();}
 assert.deepEqual(await pending,{value:{status:'included',batch:146,txid:'settled'},error:undefined});
 assert.equal(posts,1);assert.equal(signs,0);assert.equal(reads.length,6);
 assert.ok(reads.every(url=>url.endsWith('/spends/accepted')));
});

test('a status outage preserves the batch already signed and does not sign it twice',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let reads=0,signs=0;
 const fetcher=(async()=>{
  reads++;
  if(reads>=2&&reads<=6)return new Response('unavailable',{status:503});
  return Response.json(reads<8?{status:'signing',arkTx:'same-batch'}:{status:'included'});
 }) as typeof fetch;
 const pending=outcome(waitForSpend('signed',async()=>{signs++;},poolApiOf('https://signed-outage.test',fetcher)));
 await flush();for(let i=0;i<10;i++){t.mock.timers.tick(1000);await flush();}
 assert.equal((await pending).value?.status,'included');assert.equal(signs,1);assert.equal(reads,8);
});

test('exhausted signature POST failures propagate without repeating the signing callback',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let reads=0,posts=0,signs=0;
 const fetcher=(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return new Response('unavailable',{status:503});}
  reads++;return Response.json({status:'signing',arkTx:'batch'});
 }) as typeof fetch;
 const api=poolApiOf('https://signature-failure.test',fetcher);
 const pending=outcome(waitForSpend('a',async()=>{signs++;await api('/spends/a/sign',{arkTx:'signed'});},api));
 await flush();for(let i=0;i<8;i++){t.mock.timers.tick(1000);await flush();}
 assert.match((await pending).error?.message??'',/503/);assert.equal(signs,1);assert.equal(posts,5);assert.equal(reads,1);
});

test('definitive status refusals and unclassified API errors remain terminal',async()=>{
 for(const status of [400,404,409]){
  let reads=0;
  const fetcher=(async()=>{reads++;return Response.json({error:'definitive refusal'},{status});}) as typeof fetch;
  await assert.rejects(waitForSpend('a',async()=>{},poolApiOf(`https://status-refusal-${status}.test`,fetcher)),(error:{status?:number})=>error.status===status);
  assert.equal(reads,1);
 }
 const unexpected=new TypeError('invalid local state');let reads=0;
 await assert.rejects(waitForSpend('a',async()=>{},async()=>{reads++;throw unexpected;}),error=>error===unexpected);assert.equal(reads,1);
});

test('status outages retain the original polling deadline and never imply the spend was dropped',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 let reads=0;
 const fetcher=(async()=>{reads++;return new Response('unavailable',{status:503});}) as typeof fetch;
 const pending=outcome(waitForSpend('a',async()=>{},poolApiOf('https://status-deadline.test',fetcher),1000,4500));
 await flush();for(let i=0;i<6;i++){t.mock.timers.tick(1000);await flush();}
 assert.match((await pending).error?.message??'',/did not settle in time; the pool may still include it/);assert.equal(reads,5);
});

test('a spend watched by its nullifier returns on the account, asking the pool for no spend id',async t=>{
 paced(t);const asked:string[]=[],landed:(SpendStatus|undefined)[]=[undefined,undefined,{status:'included',txid:'ab'.repeat(32),batch:7}];
 const final=await waitForSpend('a',async()=>{},(async(path:string)=>{asked.push(path);return {status:'pending'};}) as never,PRIVATE_SPEND_POLL_MS,Infinity,async()=>landed.shift());
 assert.deepEqual(final,{status:'included',txid:'ab'.repeat(32),batch:7});assert.deepEqual(asked,[]);
});

test('a nullifier-watched spend asks for a verdict on its fifth round, never on its first',async t=>{
 const delays=paced(t),seen:string[]=[],reason='The operator dropped this spend before it reached a batch; build it again.';
 const final=await waitForSpend('a',async()=>{},(async(path:string)=>{seen.push(path);return {status:'dropped',reason};}) as never,PRIVATE_SPEND_POLL_MS,Infinity,async()=>{seen.push('landed');return undefined;});
 assert.deepEqual(final,{status:'dropped',reason});
 assert.deepEqual(seen,[...Array(PRIVATE_VERDICT_EVERY).fill('landed'),'/spends/a']);
 assert.ok(delays.length===PRIVATE_VERDICT_EVERY&&delays.every(ms=>ms>PRIVATE_SPEND_POLL_MS),delays.join());
});

test('a nullifier-watched spend that stays pending reads its id on rounds 5 and 10, and on no other round',async t=>{
 const seen:string[]=[],stop=new Error('stopped after round 11');let sleeps=0;
 t.mock.method(globalThis,'setTimeout',((run:()=>void)=>{if(++sleeps>2*PRIVATE_VERDICT_EVERY+1)throw stop;run();}) as never);
 await assert.rejects(waitForSpend('a',async()=>{},(async(path:string)=>{seen.push(path);return {status:'pending'};}) as never,PRIVATE_SPEND_POLL_MS,Infinity,async()=>{seen.push('landed');return undefined;}),error=>error===stop);
 const rounds=seen.flatMap((event,i)=>event==='landed'?[]:[seen.slice(0,i).filter(e=>e==='landed').length]);
 assert.deepEqual([seen.filter(e=>e==='landed').length,rounds],[2*PRIVATE_VERDICT_EVERY+1,[PRIVATE_VERDICT_EVERY,2*PRIVATE_VERDICT_EVERY]]);
});

test('a nullifier-watched round is jittered and never backs off',async t=>{
 const delays=paced(t);let rounds=0;
 await waitForSpend('a',async()=>{},(async()=>({status:'pending'})) as never,PRIVATE_SPEND_POLL_MS,Infinity,async()=>++rounds>=8?{status:'included'}:undefined);
 assert.equal(delays.length,8);
 assert.ok(delays.every(ms=>ms>PRIVATE_SPEND_POLL_MS&&ms<=1.25*PRIVATE_SPEND_POLL_MS)&&new Set(delays).size>1,delays.join());
});

test('a nullifier-watched spend asks the pool nothing before its first jittered round, and sees there a spend that landed meanwhile',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const seen:string[]=[],pending=waitForSpend('a',async()=>{},(async(path:string)=>{seen.push(path);return {status:'pending'};}) as never,PRIVATE_SPEND_POLL_MS,Infinity,async()=>{seen.push('landed');return {status:'included',batch:7};});
 await flush();assert.deepEqual(seen,[]);
 t.mock.timers.tick(1.25*PRIVATE_SPEND_POLL_MS);await flush();
 assert.deepEqual(await pending,{status:'included',batch:7});assert.deepEqual(seen,['landed']);
});

test('a direct spend keeps its one-second poll and its backoff',async t=>{
 const delays=paced(t);let reads=0;
 const final=await waitForSpend('a',async()=>{},(async()=>++reads>6?{status:'included'}:{status:'pending'}) as never);
 assert.equal(final.status,'included');assert.equal(reads,7);assert.deepEqual(delays,[1000,2000,4000,5000,5000,5000]);
});
