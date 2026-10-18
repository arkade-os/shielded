import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {after,test} from 'node:test';
import * as snarkjs from 'snarkjs';
import * as prover from '../app/src/shielded-prover.ts';
import type {BuiltSpend} from '../packages/protocol/src/rollup/account.ts';
import type {RollupPoolStatus} from '../src/shielded/pool.ts';

const flush=async()=>{for(let i=0;i<8;i++)await setImmediate();};
const outcome=<T,>(promise:Promise<T>)=>promise.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
const wasm=readFileSync('tests/fixtures/rollup-toy/covenant-client.wasm'),zkey=readFileSync('tests/fixtures/rollup-toy/covenant-client.zkey');
const input={pub:49n,nf0:11n,nf1:22n,deposit:33n,withdraw:44n,boundaryAsset:55n,destination:66n,w:7n};
const built={witness:{input,slot:{nullifiers:[11n]}}} as unknown as BuiltSpend;
const status=(id:string)=>({proving:{spend:{wasm:id,zkey:id}}}) as RollupPoolStatus;
after(async()=>{await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();});

test('prefetch never consumes or caches an HTTP error body',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});t.mock.method(Math,'random',()=>0);
 const calls=new Map<string,number>();let htmlReads=0;
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{
  const key=String(url),count=(calls.get(key)??0)+1;calls.set(key,count);
  if(count===1){const limited=new Response('<html>blocked</html>',{status:429,headers:{'Retry-After':'9'}});t.mock.method(limited,'arrayBuffer',async()=>{htmlReads++;return new ArrayBuffer(0);});return limited;}
  return new Response(key.includes('.wasm')?wasm:zkey);
 });
 const pool=status('prefetch-limited');prover.prefetchProvingKeys(pool);await flush();assert.equal(htmlReads,0);
 prover.prefetchProvingKeys(pool);assert.deepEqual([...calls.values()],[1,1]);t.mock.timers.tick(9000);await flush();
 assert.deepEqual([...calls.values()],[2,2]);prover.prefetchProvingKeys(pool);await flush();assert.deepEqual([...calls.values()],[2,2]);
});

test('proving waits out a 429 HTML response and supplies only successful file bytes to snarkjs',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});t.mock.method(Math,'random',()=>0);
 let wasmCalls=0,htmlReads=0;const calls:number[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{
  if(String(url).includes('.wasm')){
   calls.push(Date.now());if(++wasmCalls===1){const limited=new Response('<html>rate limited</html>',{status:429,headers:{'Retry-After':'9'}});t.mock.method(limited,'arrayBuffer',async()=>{htmlReads++;return new ArrayBuffer(0);});return limited;}
   return new Response(wasm);
  }
  return new Response(zkey);
 });
 const pending=outcome(prover.browserProver(()=>status('limited')).prove(built,'spend'));await flush();
 assert.equal(wasmCalls,1);assert.equal(htmlReads,0);t.mock.timers.tick(8999);await flush();assert.equal(wasmCalls,1);
 t.mock.timers.tick(1);await flush();t.mock.timers.reset();
 const result=await pending;assert.equal(result.error,undefined);assert.ok(result.value);assert.deepEqual(calls,[1_000_000,1_009_000]);assert.equal(htmlReads,0);
 const key=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')).clientKey;
 assert.equal(await snarkjs.groth16.verify(key,Object.values(input).slice(0,7).map(String),result.value),true);
});

test('an in-flight successful prefetch is reused by proving without another download',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{calls.push(String(url));await gate;return new Response(String(url).includes('.wasm')?wasm:zkey);});
 const pool=status('prefetched');prover.prefetchProvingKeys(pool);await flush();assert.equal(calls.length,2);
 const pending=outcome(prover.browserProver(()=>pool).prove(built,'spend'));await flush();assert.equal(calls.length,2);release();
 const result=await pending;assert.equal(result.error,undefined);assert.ok(result.value);assert.equal(calls.length,2);
 prover.prefetchProvingKeys(pool);await prover.browserProver(()=>pool).prove(built,'spend');assert.equal(calls.length,2);
});

test('definitive HTTP refusals are not retried or cached',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('missing',{status:404}):new Response(wasm));
 await assert.rejects(prover.loadProvingFile('/missing.wasm'),/404/);assert.equal(calls,1);
 assert.deepEqual(await prover.loadProvingFile('/missing.wasm'),new Uint8Array(wasm));assert.equal(calls,2);
});

test('network and server retries are bounded and an exhausted download can be fetched again',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});t.mock.method(Math,'random',()=>0);
 let calls=0,healthy=false;t.mock.method(globalThis,'fetch',async()=>{calls++;if(healthy)return new Response(wasm);if(calls%2)throw new TypeError('Failed to fetch');return new Response('outage',{status:503});});
 const pending=outcome(prover.loadProvingFile('/outage.wasm'));await flush();
 for(const delay of [1000,2000,4000,8000]){t.mock.timers.tick(delay-1);await flush();const before=calls;t.mock.timers.tick(1);await flush();assert.equal(calls,before+1);}
 const result=await pending;assert.ok(result.error);assert.equal(calls,5);healthy=true;
 assert.deepEqual(await prover.loadProvingFile('/outage.wasm'),new Uint8Array(wasm));assert.equal(calls,6);
});

test('Retry-After HTTP dates are honored before another file request',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});t.mock.method(Math,'random',()=>0);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('busy',{status:503,headers:{'Retry-After':new Date(1_010_000).toUTCString()}}):new Response(zkey));
 const pending=outcome(prover.loadProvingFile('/dated.zkey'));await flush();t.mock.timers.tick(9999);await flush();assert.equal(calls,1);
 t.mock.timers.tick(1);await flush();assert.equal((await pending).error,undefined);assert.equal(calls,2);
});

for(const dated of [false,true])test(`a long Retry-After ${dated?'date':'delay'} rejects promptly and blocks prefetch and proving until its deadline`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});t.mock.method(Math,'random',()=>0);
 let calls=0,settled=false;
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{
  if(!String(url).includes('.wasm'))return new Response(zkey);
  return ++calls===1?new Response('limited',{status:429,headers:{'Retry-After':dated?new Date(4_600_000).toUTCString():'3600'}}):new Response(wasm);
 });
 const pool=status(`long-cooldown-${dated}`),wallet=prover.browserProver(()=>pool);
 const pending=outcome(wallet.prove(built,'spend'));void pending.then(()=>{settled=true;});await flush();
 assert.equal(settled,true,'a long cooldown must reject without awaiting its timer');assert.match(String((await pending).error),/retry.*3600.*seconds/i);assert.equal(calls,1);
 prover.prefetchProvingKeys(pool);await assert.rejects(wallet.prove(built,'spend'),/retry/i);assert.equal(calls,1);
 t.mock.timers.tick(3_599_999);await assert.rejects(wallet.prove(built,'spend'),/retry/i);assert.equal(calls,1);
 t.mock.timers.tick(1);const recovered=wallet.prove(built,'spend');await flush();assert.equal(calls,2);t.mock.timers.reset();assert.ok(await recovered);
 prover.prefetchProvingKeys(pool);assert.ok(await wallet.prove(built,'spend'));assert.equal(calls,2);
});
