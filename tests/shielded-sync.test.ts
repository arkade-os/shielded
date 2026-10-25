import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import type {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository,type ShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';
import {catchUp,catchUpAfterEvent,idle,WATCHDOG_MS} from '../src/shielded/sync.ts';
import {loadAccount} from '../src/shielded/wallet.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const aliceKeys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),bobKeys=deriveRollupKeys2('22'.repeat(32),'mutinynet'),epochLen=64;
const snapshotOf=(keys=aliceKeys,token='g2'):ShieldedSnapshot=>
 ({v:2,token,account:EpochAccount.owning(hash,keys,{epochLen,bornAt:5}).snapshot(),sent:{'7':{to:'shrol21abc'}},listings:['cd'.repeat(32)]});
const repoOf=(read:()=>Promise<ShieldedSnapshot|undefined>):ShieldedNoteRepository=>
 ({version:1,getAccount:read,saveAccount:async()=>{},clear:async()=>{},[Symbol.asyncDispose]:async()=>{}});

test('a saved snapshot resumes the account, its sent log and its listings',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshotOf());
 const loaded=await loadAccount(hash,aliceKeys,{repository:repo,token:'g2',epochLen,bornAt:0});
 assert.equal(loaded.resumed,true);
 assert.equal(loaded.account.batchCount,0);
 assert.equal(loaded.sent['7']?.to,'shrol21abc');
 assert.deepEqual(loaded.listings,['cd'.repeat(32)]);
 assert.equal(loaded.error,undefined);
});

test('no snapshot starts a fresh account at its birth batch, with no error to report',async()=>{
 const loaded=await loadAccount(hash,aliceKeys,{repository:new InMemoryShieldedNoteRepository(),token:'g2',epochLen,bornAt:9});
 assert.equal(loaded.resumed,false);
 assert.deepEqual(loaded.sent,{});
 assert.deepEqual(loaded.listings,[]);
 assert.equal(loaded.error,undefined);
});

test('a snapshot from another key is refused and the wallet full-syncs instead',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshotOf(bobKeys));
 const loaded=await loadAccount(hash,aliceKeys,{repository:repo,token:'g2',epochLen,bornAt:9});
 assert.equal(loaded.resumed,false);
 assert.match(loaded.error!,/another key/i);
});

test('a wrong-version, wrong-token or unreadable snapshot all fall back to a full sync and report once',async()=>{
 const wrongVersion=repoOf(async()=>({...snapshotOf(),v:1 as unknown as 2}));
 const wrongToken=repoOf(async()=>snapshotOf(aliceKeys,'g3'));
 const throwing=repoOf(async()=>{throw new Error('IndexedDB is unavailable');});
 const undefinedThrow=repoOf(async()=>{throw undefined;});
 for(const repository of [wrongVersion,wrongToken,throwing,undefinedThrow]){
  const loaded=await loadAccount(hash,aliceKeys,{repository,token:'g2',epochLen,bornAt:9});
  assert.equal(loaded.resumed,false,'anything unreadable means a full sync');
  assert.equal(loaded.account.batchCount,0);
  assert.ok(loaded.error,'and the reason is reported once');
 }
 assert.match((await loadAccount(hash,aliceKeys,{repository:throwing,token:'g2',epochLen,bornAt:9})).error!,/IndexedDB is unavailable/);
 assert.match((await loadAccount(hash,aliceKeys,{repository:wrongVersion,token:'g2',epochLen,bornAt:9})).error!,/version 1/);
 assert.match((await loadAccount(hash,aliceKeys,{repository:wrongToken,token:'g2',epochLen,bornAt:9})).error!,/another pool/);
});

test('a wallet with no repository at all still gets a fresh account',async()=>{
 const loaded=await loadAccount(hash,aliceKeys,{token:'g2',epochLen,bornAt:0});
 assert.equal(loaded.resumed,false);
 assert.ok(loaded.account instanceof EpochAccount);
 assert.equal(loaded.error,undefined);
});

const pageOf=(batches:{txid:string}[],from:number,limit:number)=>({total:batches.length,batches:batches.slice(from,from+limit)});

test('catch-up pages from the account cursor and applies each batch once',async()=>{
 const applied:number[]=[],saves:number[]=[],seen:string[]=[];
 const account={batchCount:0,apply:async(b:{txid:string})=>{applied.push(Number(b.txid));(account as {batchCount:number}).batchCount++;return [];}} as unknown as RollupAccount;
 const batches=Array.from({length:7},(_,i)=>({txid:String(i)}));
 let pages=0;
 const api=(async(path:string)=>{pages++;return pageOf(batches,Number(/from=(\d+)/.exec(path)![1]),Number(/limit=(\d+)/.exec(path)![1]));}) as never;
 assert.equal(await catchUp(account,api,(n,batch)=>{saves.push(n);seen.push((batch as {txid:string}).txid);}),7);
 assert.deepEqual(applied,[0,1,2,3,4,5,6]);
 assert.deepEqual(saves,[1,2,3,4,5,6,7],'the hook fires once per applied batch, with the new cursor');
 assert.deepEqual(seen,['0','1','2','3','4','5','6'],'and hands it the batch it applied');
 assert.equal(pages,1,'one page covers them all and the total says so, so no empty page is fetched');
 assert.equal(await catchUp(account,api),0,'a second run at the head applies nothing');
});

test('two overlapping catch-ups apply each batch once, so a duplicate watch event is harmless',async()=>{
 const applied:number[]=[];
 const account={batchCount:0,apply:async(b:{txid:string})=>{await new Promise(r=>setTimeout(r,5));applied.push(Number(b.txid));(account as {batchCount:number}).batchCount++;return [];}} as unknown as RollupAccount;
 const batches=Array.from({length:4},(_,i)=>({txid:String(i)}));
 const api=(async(path:string)=>pageOf(batches,Number(/from=(\d+)/.exec(path)![1]),50)) as never;
 const [a,b,c]=await Promise.all([catchUp(account,api),catchUp(account,api),catchUp(account,api)]);
 assert.deepEqual(applied,[0,1,2,3],'no batch is applied twice');
 assert.equal(a+b+c,4);
});

test('catch-up stops on an empty page even when the total claims more, so a lagging operator cannot spin',async()=>{
 const account={batchCount:0,apply:async()=>[]} as unknown as RollupAccount;
 let pages=0;
 const api=(async()=>{pages++;return {total:99,batches:[]};}) as never;
 assert.equal(await catchUp(account,api),0);
 assert.equal(pages,1);
});

test('a failing page rejects, leaves the cursor where it got to, and does not block the next attempt',async()=>{
 const account={batchCount:0,apply:async()=>{(account as {batchCount:number}).batchCount++;return [];}} as unknown as RollupAccount;
 let calls=0;
 const api=(async()=>{calls++;if(calls===1)return {total:3,batches:[{txid:'0'}]};if(calls===2)throw new Error('The pool did not answer (503).');return {total:1,batches:[]};}) as never;
 await assert.rejects(catchUp(account,api),/did not answer/);
 assert.equal(account.batchCount,1);
 assert.equal(await catchUp(account,api),0,'the single-flight slot is released even on a rejection');
 assert.equal(WATCHDOG_MS,60_000);
});

for(const rejects of [false,true])test(`idle saves after a queued follower finishes behind a ${rejects?'rejected':'successful'} leader`,async()=>{
 const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
 const leaderReady=gate(),followerReady=gate(),finishLeader=gate(),finishFollower=gate();
 let partial=false,saved=false,calls=0;
 const account={batchCount:0,apply:async()=>{
  partial=true;followerReady.resolve();await finishFollower.promise;
  (account as {batchCount:number}).batchCount++;partial=false;return [];
 }} as unknown as RollupAccount;
 const api=(async()=>{
  if(calls++===0){leaderReady.resolve();await finishLeader.promise;if(rejects)throw new Error('leader failed');return {total:0,batches:[]};}
  return {total:1,batches:[{txid:'follower'}]};
 }) as never;
 const leader=catchUp(account,api),checkedLeader=rejects?assert.rejects(leader,/leader failed/):leader;
 await leaderReady.promise;
 const follower=catchUp(account,api),snapshot=idle(account,()=>{saved=true;assert.equal(partial,false);return account.batchCount;});
 await Promise.resolve();assert.equal(saved,false,'the current run is still pending');
 finishLeader.resolve();await followerReady.promise;
 await new Promise(r=>setImmediate(r));
 try{assert.equal(saved,false,'the follower is halfway through apply');}
 finally{finishFollower.resolve();}
 await checkedLeader;assert.equal(await follower,1);assert.equal(await snapshot,1);
 let synchronous=false;const immediate=idle(account,()=>{synchronous=true;return 9;});
 assert.equal(synchronous,true,'the callback shares the final no-running check');assert.equal(await immediate,9);
});

for(const rejects of [false,true])test(`page checkpoints hold the flight through a ${rejects?'rejected':'successful'} leader and its queued follower`,async()=>{
 const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
 const checkpoint=gate(),applying=gate(),finishApply=gate();
 const pages:number[]=[],events:string[]=[];let calls=0,saved=false;
 const mutable={batchCount:0,apply:async()=>{
  if(mutable.batchCount===1){events.push('applying');applying.resolve();await finishApply.promise;}
  mutable.batchCount++;
 }};
 const account=mutable as unknown as RollupAccount;
 const api=(async()=>{calls++;return {total:calls,batches:[{txid:String(calls)}]};}) as never;
 const onPage=async(cursor:number)=>{pages.push(cursor);if(cursor===1){await checkpoint.promise;if(rejects)throw new Error('checkpoint failed');}};
 const leader=catchUp(account,api,undefined,onPage),checkedLeader=rejects?assert.rejects(leader,/checkpoint failed/):leader;
 const follower=catchUp(account,api,undefined,onPage),snapshot=idle(account,()=>{saved=true;return account.batchCount;});
 try{
  await new Promise(r=>setImmediate(r));assert.deepEqual(pages,[1]);assert.equal(calls,1);assert.equal(saved,false);
  checkpoint.resolve();await applying.promise;await new Promise(r=>setImmediate(r));
  assert.equal(saved,false);assert.deepEqual(events,['applying']);
  finishApply.resolve();await checkedLeader;assert.equal(await follower,1);assert.equal(await snapshot,2);assert.deepEqual(pages,[1,2]);
 }finally{checkpoint.resolve();finishApply.resolve();await Promise.allSettled([checkedLeader,follower,snapshot]);}
});

test('a pool event that finds no new batch looks again shortly, until one lands, the delays run out or the wallet stops',async()=>{
 let calls=0;
 assert.equal(await catchUpAfterEvent(async()=>++calls===3?2:0,()=>false,[0,1,1,1]),2);
 assert.equal(calls,3,'it stops at the first catch-up that applies a batch');
 calls=0;
 assert.equal(await catchUpAfterEvent(async()=>{calls++;return 0;},()=>false,[0,1,1]),0);
 assert.equal(calls,3,'it gives up after the last delay and leaves the rest to the watchdog');
 let stopped=false;calls=0;
 assert.equal(await catchUpAfterEvent(async()=>{calls++;stopped=true;return 0;},()=>stopped,[0,1,1]),0);
 assert.equal(calls,1,'a stopped wallet does not look again');
 calls=0;
 assert.equal(await catchUpAfterEvent(async()=>{if(++calls===1)throw new Error('The pool did not answer (502).');return 1;},()=>false,[0,1]),1,'a failed look is retried at the next delay');
});
