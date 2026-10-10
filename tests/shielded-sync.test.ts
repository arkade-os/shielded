import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository,type ShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';
import {loadAccount} from '../src/shielded/wallet.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const aliceKeys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),bobKeys=deriveRollupKeys2('22'.repeat(32),'mutinynet');
const snapshotOf=(keys=aliceKeys,token='g2'):ShieldedSnapshot=>
 ({v:1,token,account:RollupAccount.owning(hash,keys,{frontier:true,bornAt:5}).snapshot(),sent:{'7':{to:'shrol21abc'}},listings:['cd'.repeat(32)]});
const repoOf=(read:()=>Promise<ShieldedSnapshot|undefined>):ShieldedNoteRepository=>
 ({version:1,getAccount:read,saveAccount:async()=>{},clear:async()=>{},[Symbol.asyncDispose]:async()=>{}});

test('a saved snapshot resumes the account, its sent log and its listings',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshotOf());
 const loaded=await loadAccount(hash,aliceKeys,{repository:repo,token:'g2',bornAt:0});
 assert.equal(loaded.resumed,true);
 assert.equal(loaded.account.batchCount,0);
 assert.equal(loaded.sent['7']?.to,'shrol21abc');
 assert.deepEqual(loaded.listings,['cd'.repeat(32)]);
 assert.equal(loaded.error,undefined);
});

test('no snapshot starts a fresh account at its birth batch, with no error to report',async()=>{
 const loaded=await loadAccount(hash,aliceKeys,{repository:new InMemoryShieldedNoteRepository(),token:'g2',bornAt:9});
 assert.equal(loaded.resumed,false);
 assert.deepEqual(loaded.sent,{});
 assert.deepEqual(loaded.listings,[]);
 assert.equal(loaded.error,undefined);
});

test('a snapshot from another key is refused and the wallet full-syncs instead',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshotOf(bobKeys));
 const loaded=await loadAccount(hash,aliceKeys,{repository:repo,token:'g2',bornAt:9});
 assert.equal(loaded.resumed,false);
 assert.match(loaded.error!,/another key/i);
});

test('a wrong-version, wrong-token or unreadable snapshot all fall back to a full sync and report once',async()=>{
 const wrongVersion=repoOf(async()=>({...snapshotOf(),v:2 as unknown as 1}));
 const wrongToken=repoOf(async()=>snapshotOf(aliceKeys,'g3'));
 const throwing=repoOf(async()=>{throw new Error('IndexedDB is unavailable');});
 const undefinedThrow=repoOf(async()=>{throw undefined;});
 for(const repository of [wrongVersion,wrongToken,throwing,undefinedThrow]){
  const loaded=await loadAccount(hash,aliceKeys,{repository,token:'g2',bornAt:9});
  assert.equal(loaded.resumed,false,'anything unreadable means a full sync');
  assert.equal(loaded.account.batchCount,0);
  assert.ok(loaded.error,'and the reason is reported once');
 }
 assert.match((await loadAccount(hash,aliceKeys,{repository:throwing,token:'g2',bornAt:9})).error!,/IndexedDB is unavailable/);
 assert.match((await loadAccount(hash,aliceKeys,{repository:wrongVersion,token:'g2',bornAt:9})).error!,/version 2/);
 assert.match((await loadAccount(hash,aliceKeys,{repository:wrongToken,token:'g2',bornAt:9})).error!,/another pool/);
});

test('a wallet with no repository at all still gets a fresh account',async()=>{
 const loaded=await loadAccount(hash,aliceKeys,{token:'g2',bornAt:0});
 assert.equal(loaded.resumed,false);
 assert.ok(loaded.account instanceof RollupAccount);
 assert.equal(loaded.error,undefined);
});
