import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InMemoryShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';

const snapshot=(token:string,blocks:number):ShieldedSnapshot=>({v:1,token,sent:{'7':{to:'shrol21abc'}},listings:['ab'.repeat(32)],
 account:{v:1,owner:'42',bornAt:0,blocks,frontier:{v:1,blocks,top:'9',filled:['1'],tracked:[[0,['2']]]},owned:[],history:[],txids:[]}});

test('the repository stores one snapshot per pool token, reads it back, and keeps tokens apart',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 assert.equal(repo.version,1);
 assert.equal(await repo.getAccount('g2'),undefined,'an unknown token reads as absent, not as an error');
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo.saveAccount('g3',snapshot('g3',1));
 assert.equal((await repo.getAccount('g2'))?.account.blocks,3);
 assert.equal((await repo.getAccount('g3'))?.account.blocks,1);
 await repo.saveAccount('g2',snapshot('g2',4));
 assert.equal((await repo.getAccount('g2'))?.account.blocks,4,'a save replaces the token it names');
 assert.equal((await repo.getAccount('g3'))?.account.blocks,1,'and leaves the others alone');
 assert.deepEqual((await repo.getAccount('g2'))?.sent,{'7':{to:'shrol21abc'}});
 assert.deepEqual((await repo.getAccount('g2'))?.listings,['ab'.repeat(32)]);
});

test('clear empties every token, and the repository is usable again after it',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo.clear();
 assert.equal(await repo.getAccount('g2'),undefined);
 await repo.saveAccount('g2',snapshot('g2',5));
 assert.equal((await repo.getAccount('g2'))?.account.blocks,5);
});

test('a snapshot stored under one token is refused when read under another',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshot('g3',3));
 assert.equal(await repo.getAccount('g2'),undefined,'a token mismatch reads as absent, so the wallet full-syncs');
});

test("a stored snapshot is a copy, so a later mutation of the caller's object cannot corrupt it",async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 const mine=snapshot('g2',3);
 await repo.saveAccount('g2',mine);
 mine.account.blocks=99;
 assert.equal((await repo.getAccount('g2'))?.account.blocks,3);
});

test('disposing the in-memory repository drops its rows, since it only ever cached this process',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo[Symbol.asyncDispose]();
 assert.equal(await repo.getAccount('g2'),undefined);
});
