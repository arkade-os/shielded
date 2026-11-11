import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {poolApiOf,rollupApi} from '../src/shielded/pool.ts';
import type {ShieldedSyncProgress} from '../src/shielded/sync-progress.ts';

const flush=async()=>{for(let i=0;i<8;i++)await setImmediate();};

test('pool status retries report pending work and the next attempt without changing retry behavior',async()=>{
 const progress:ShieldedSyncProgress[]=[];let calls=0;
 const fetcher=(async()=>++calls===1?new Response('{}',{status:503}):Response.json({ok:true})) as typeof fetch;
 assert.deepEqual(await rollupApi('/status',undefined,fetcher,0,'https://sync-progress-status.test',undefined,p=>{progress.push(p);}),{ok:true});
 assert.deepEqual(progress,[
  {stage:'request',request:'status',attempt:1},
  {stage:'waiting',request:'status',attempt:2,retryInMs:0,status:503},
  {stage:'request',request:'status',attempt:2},
 ]);
 assert.equal(calls,2);
});

test('history rate-limit waits report the real cooldown before the next request',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const progress:ShieldedSyncProgress[]=[];let calls=0;
 const fetcher=(async()=>++calls===1?new Response('{}',{status:429,headers:{'Retry-After':'2'}}):Response.json({total:0,batches:[]})) as typeof fetch;
 const pending=poolApiOf('https://sync-progress-history.test',fetcher,undefined,p=>{progress.push(p);})('/batches?from=0&limit=50');
 await flush();assert.equal(calls,1);t.mock.timers.tick(2000);await flush();
 assert.deepEqual(await pending,{total:0,batches:[]});
 assert.deepEqual(progress,[
  {stage:'request',request:'history',attempt:1},
  {stage:'waiting',request:'history',attempt:2,retryInMs:2000,status:429},
  {stage:'request',request:'history',attempt:2},
 ]);
});

test('sync observers do not receive private item paths or mutation activity',async()=>{
 const progress:ShieldedSyncProgress[]=[],fetcher=(async()=>Response.json({ok:true})) as typeof fetch;
 const api=poolApiOf('https://sync-progress-items.test',fetcher,undefined,p=>{progress.push(p);});
 await api('/spends/private-item');await api('/spends',{id:'private-item'});
 assert.deepEqual(progress,[]);
 assert.deepEqual(await poolApiOf('https://sync-progress-throw.test',fetcher,undefined,()=>{throw new Error('observer failed');})('/status'),{ok:true});
});

test('asynchronously failing progress observers do not hide the actual pool refusal',async()=>{
 const fetcher=(async()=>Response.json({error:'The pool is not available.'},{status:400})) as typeof fetch;
 await assert.rejects(poolApiOf('https://sync-progress-async.test',fetcher,undefined,async()=>{throw new Error('observer rejected');})('/status'),/The pool is not available/);
 await flush();
});

test('the dispatch fence runs after a progress listener invalidates the pending request',async()=>{
 let active=true,calls=0;
 const fetcher=(async()=>{calls++;return Response.json({ok:true});}) as typeof fetch;
 await assert.rejects(rollupApi('/status',undefined,fetcher,0,'https://sync-progress-fence.test',()=>{if(!active)throw new Error('session paused');},()=>{active=false;}),/session paused/);
 assert.equal(calls,0);
});
