import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {catchUpAfterEvent,epochCatchUp,epochIdle,WATCHDOG_MS} from '../src/shielded/epoch-sync.ts';
import type {PoolApi} from '../src/shielded/pool.ts';
import {InMemoryShieldedNoteRepository,type ShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';
import {loadAccount} from '../src/shielded/wallet.ts';
import {epochPool} from './fixtures/epoch-pool.ts';

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

/** Alice's account caught up on a 4-batch pool that has rotated once, and a repository holding `account` as its snapshot. */
const rotated=async()=>{
 const pool=epochPool(hash,4),account=EpochAccount.owning(hash,aliceKeys,{epochLen:4});
 for(let n=0;n<6;n++)pool.land('spend',n===1?[await pool.deposit(rollupRecipientOf(hash,aliceKeys.ask,aliceKeys.nk,aliceKeys.viewSecret),500n)]:[]);
 await epochCatchUp(account,pool.api);
 const saving=async(snapshot=account.snapshot())=>{const repository=new InMemoryShieldedNoteRepository();await repository.saveAccount('g2',{v:2,token:'g2',account:snapshot,sent:{'7':{to:'shrol21abc'}},listings:[]});return repository;};
 return {pool,account,saving};
};

test('online, a snapshot the pool confirms resumes, and one whose root it refutes syncs from the pool',async()=>{
 const {pool,account,saving}=await rotated(),asked:string[]=[],api=((path:string)=>{asked.push(path);return pool.api(path);}) as PoolApi;
 const resumed=await loadAccount(hash,aliceKeys,{repository:await saving(),token:'g2',epochLen:4,bornAt:0,api});
 assert.deepEqual([resumed.resumed,resumed.error,resumed.account.batchCount,resumed.sent['7']?.to,asked],[true,undefined,6,'shrol21abc',['/status','/batches?from=6&limit=50','/status']]);
 const refuted=await loadAccount(hash,aliceKeys,{repository:await saving({...account.snapshot(),frontier:{...account.snapshot().frontier,top:'1'}}),token:'g2',epochLen:4,bornAt:0,api:pool.api});
 assert.deepEqual([refuted.resumed,refuted.error,refuted.sent],[false,'The saved wallet does not match the pool; syncing from the pool.',{}]);
});

test('online, a snapshot whose previous-epoch root drifted fails loudly rather than resyncing',async()=>{
 const {pool,account,saving}=await rotated();
 const repository=await saving({...account.snapshot(),prevNoteRoot:String(account.prevNoteRoot()!+1n)});
 await assert.rejects(loadAccount(hash,aliceKeys,{repository,token:'g2',epochLen:4,bornAt:0,api:pool.api}),/drifted across a rotation/);
});

test('offline, a snapshot opens unchecked on its own epoch length, and says so',async()=>{
 const {saving}=await rotated(),down=(async()=>{throw new Error('The pool did not answer (network error).');}) as PoolApi;
 const loaded=await loadAccount(hash,aliceKeys,{repository:await saving(),token:'g2',bornAt:0,api:down});
 assert.deepEqual([loaded.resumed,loaded.offline,loaded.account.batchCount,loaded.account.epochLen,loaded.sent['7']?.to],[true,true,6,4,'shrol21abc']);
 assert.match(loaded.error!,/did not answer/);
});

test('a pool still starting up, or one that fails during the check, opens the snapshot unchecked rather than replaying or throwing',async()=>{
 const {pool,saving}=await rotated();
 const starting=(async(path:string)=>path==='/status'?{phase:'starting',message:'The pool is starting.'}:pool.api(path)) as PoolApi;
 const failing=(async(path:string)=>{if(path.startsWith('/batches'))throw new Error('The pool did not answer (network error).');return pool.api(path);}) as PoolApi;
 for(const [api,reason] of [[starting,/not an open epoch pool/],[failing,/did not answer/]] as const){
  const loaded=await loadAccount(hash,aliceKeys,{repository:await saving(),token:'g2',epochLen:4,bornAt:0,api});
  assert.deepEqual([loaded.resumed,loaded.offline,loaded.account.batchCount,loaded.sent['7']?.to],[true,true,6,'shrol21abc']);
  assert.match(loaded.error!,reason);
 }
});

test('epochCatchUp stops on an empty page even when the total claims more, so a lagging operator cannot spin',async()=>{
 let pages=0;
 const api=(async()=>{if(pages++)throw new Error('a second page was asked for');return {total:99,batches:[]};}) as PoolApi;
 assert.equal(await epochCatchUp(EpochAccount.owning(hash,aliceKeys,{epochLen:4}),api),0);
});

const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};

for(const rejects of [false,true])test(`epochIdle saves after a queued follower finishes behind a ${rejects?'rejected':'successful'} leader`,async()=>{
 const leaderReady=gate(),followerReady=gate(),finishLeader=gate(),finishFollower=gate();
 let partial=false,saved=false,calls=0;
 const account={batchCount:0,apply:async()=>{
  partial=true;followerReady.resolve();await finishFollower.promise;
  (account as {batchCount:number}).batchCount++;partial=false;return [];
 }} as unknown as EpochAccount;
 const api=(async()=>{
  if(calls++===0){leaderReady.resolve();await finishLeader.promise;if(rejects)throw new Error('leader failed');return {total:0,batches:[]};}
  return {total:1,batches:[{txid:'follower'}]};
 }) as PoolApi;
 const leader=epochCatchUp(account,api),checkedLeader=rejects?assert.rejects(leader,/leader failed/):leader;
 await leaderReady.promise;
 const follower=epochCatchUp(account,api),snapshot=epochIdle(account,()=>{saved=true;assert.equal(partial,false);return account.batchCount;});
 await Promise.resolve();assert.equal(saved,false,'the current run is still pending');
 finishLeader.resolve();await followerReady.promise;
 await new Promise(r=>setImmediate(r));
 try{assert.equal(saved,false,'the follower is halfway through apply');}
 finally{finishFollower.resolve();}
 await checkedLeader;assert.equal(await follower,1);assert.equal(await snapshot,1);
 let synchronous=false;const immediate=epochIdle(account,()=>{synchronous=true;return 9;});
 assert.equal(synchronous,true,'the callback shares the final no-running check');assert.equal(await immediate,9);
});

for(const rejects of [false,true])test(`page checkpoints hold the flight through a ${rejects?'rejected':'successful'} leader and its queued follower`,async()=>{
 const checkpoint=gate(),applying=gate(),finishApply=gate();
 const pages:number[]=[],events:string[]=[];let calls=0,saved=false;
 const mutable={batchCount:0,apply:async()=>{
  if(mutable.batchCount===1){events.push('applying');applying.resolve();await finishApply.promise;}
  mutable.batchCount++;
 }};
 const account=mutable as unknown as EpochAccount;
 const api=(async()=>{calls++;return {total:calls,batches:[{txid:String(calls)}]};}) as PoolApi;
 const onPage=async(cursor:number)=>{pages.push(cursor);if(cursor===1){await checkpoint.promise;if(rejects)throw new Error('checkpoint failed');}};
 const leader=epochCatchUp(account,api,undefined,onPage),checkedLeader=rejects?assert.rejects(leader,/checkpoint failed/):leader;
 const follower=epochCatchUp(account,api,undefined,onPage),snapshot=epochIdle(account,()=>{saved=true;return account.batchCount;});
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
 assert.equal(WATCHDOG_MS,60_000);
});
