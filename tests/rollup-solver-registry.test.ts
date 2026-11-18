import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {test,type TestContext} from 'node:test';
import express from 'express';
import {createRollupRouter} from '../src/rollup/http.ts';
import type {RollupService} from '../src/rollup/service.ts';
import {SOLVER_REGISTRY_URL,createSolverRegistryMirror} from '../src/rollup/solver-registry.ts';

const INDEX=JSON.stringify({version:1,network:'mutinynet',generated_at:1,solvers:[{name:'ln-solver-mutinynet'}],markets:[]});
async function serve(t:TestContext,router:express.Router){
 const app=express();app.use('/api/rollup',router);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rollup`;
}
async function mirror(t:TestContext,reply:()=>Response|Promise<Response>,options:Partial<Parameters<typeof createSolverRegistryMirror>[0]>={}){
 const calls:{url:string;init:RequestInit}[]=[],warnings:string[]=[];
 const base=await serve(t,createSolverRegistryMirror({fetch:(async(url:string,init:RequestInit)=>{calls.push({url,init});return reply();}) as unknown as typeof fetch,warn:message=>{warnings.push(message);},...options}));
 return {calls,warnings,get:()=>fetch(base+'/solver-registry')};
}

test('the mirror serves the registry bytes from one upstream read, uncached and without following a redirect',async t=>{
 const m=await mirror(t,()=>new Response(INDEX,{headers:{'content-type':'text/plain'}}));
 for(let i=0;i<3;i++){const response=await m.get();assert.deepEqual([response.status,response.headers.get('content-type'),response.headers.get('cache-control'),await response.text()],[200,'application/json','no-store',INDEX]);}
 assert.deepEqual(m.calls.map(({url,init})=>[url,init.redirect]),[[SOLVER_REGISTRY_URL,'error']]);
});

test('a held copy answers at once and is refreshed behind the answer once it is five minutes old',async t=>{
 let clock=0,body=INDEX;const m=await mirror(t,()=>new Response(body),{now:()=>clock});
 assert.equal(await (await m.get()).text(),INDEX);
 clock=5*60_000;body=INDEX.replace('"generated_at":1','"generated_at":2');
 assert.equal(await (await m.get()).text(),INDEX,'the stale-but-held copy answers this read');
 for(let i=0;i<50&&m.calls.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(await (await m.get()).text(),body);assert.equal(m.calls.length,2);
});

test('a failed, oversize or malformed upstream answer is never served, and a good held copy outlives it for a day',async t=>{
 const notJson='Solver registry mirror: the registry is not UTF-8 JSON';
 for(const [reply,warning] of [[()=>new Response('nope',{status:500}),/: HTTP 500$/],[()=>new Response('x'.repeat((128<<10)+1)),/: larger than/],[()=>new Response('{"solvers":[]}'),/: not a solver registry index$/],
  [()=>new Response('not json, nor a secret'),notJson],[()=>new Response(new Uint8Array([0x7b,0x22,0x6d,0xff,0x22,0x3a,0x5b,0x5d,0x7d])),notJson],[()=>Promise.reject(new TypeError('fetch failed')),/: fetch failed$/]] as const){
  const m=await mirror(t,reply);
  const response=await m.get();assert.deepEqual([response.status,response.headers.get('cache-control')],[503,'no-store']);
  assert.equal(m.warnings.length,1);
  if(typeof warning==='string')assert.equal(m.warnings[0],warning,'its own message, which quotes nothing of the body');else assert.match(m.warnings[0]!,warning);
 }
 let clock=0,ok=true;const m=await mirror(t,()=>ok?new Response(INDEX):new Response('nope',{status:502}),{now:()=>clock});
 assert.equal((await m.get()).status,200);ok=false;
 clock=24*60*60_000-1;assert.equal(await (await m.get()).text(),INDEX,'the last good copy serves while the upstream fails');
 clock=24*60*60_000;assert.equal((await m.get()).status,503,'never older than a day');
});

test('a sealed wallet learns from the pool status whether this server carries its Lightning',async t=>{
 const service={ready:()=>true,status:()=>({phase:'ready',message:''})} as unknown as RollupService;
 const plain=await serve(t,createRollupRouter(()=>service)),carrying=await serve(t,createRollupRouter(()=>service,{privateLightning:true}));
 assert.deepEqual(await (await fetch(plain+'/status')).json(),{phase:'ready',message:''});
 assert.deepEqual(await (await fetch(carrying+'/status')).json(),{phase:'ready',message:'',privateLightning:true});
});
