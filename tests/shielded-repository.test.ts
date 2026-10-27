import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InMemoryShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';

const snapshot=(token:string,batch:number):ShieldedSnapshot=>({v:2,token,sent:{'7':{to:'shrol21abc'}},listings:['ab'.repeat(32)],
 account:{v:2,owner:'42',epochLen:64,bornAt:0,epoch:0,batch,blockInEpoch:batch,frontier:{v:1,blocks:batch,top:'9',filled:['1'],tracked:[[0,['2']]]},frozen:[],owned:[],history:[],txids:[]}});

test('the repository stores one snapshot per pool token, reads it back, and keeps tokens apart',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 assert.equal(repo.version,1);
 assert.equal(await repo.getAccount('g2'),undefined,'an unknown token reads as absent, not as an error');
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo.saveAccount('g3',snapshot('g3',1));
 assert.equal((await repo.getAccount('g2'))?.account.batch,3);
 assert.equal((await repo.getAccount('g3'))?.account.batch,1);
 await repo.saveAccount('g2',snapshot('g2',4));
 assert.equal((await repo.getAccount('g2'))?.account.batch,4,'a save replaces the token it names');
 assert.equal((await repo.getAccount('g3'))?.account.batch,1,'and leaves the others alone');
 assert.deepEqual((await repo.getAccount('g2'))?.sent,{'7':{to:'shrol21abc'}});
 assert.deepEqual((await repo.getAccount('g2'))?.listings,['ab'.repeat(32)]);
});

test('clear empties every token, and the repository is usable again after it',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo.clear();
 assert.equal(await repo.getAccount('g2'),undefined);
 await repo.saveAccount('g2',snapshot('g2',5));
 assert.equal((await repo.getAccount('g2'))?.account.batch,5);
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
 mine.account.batch=99;
 assert.equal((await repo.getAccount('g2'))?.account.batch,3);
});

test('disposing the in-memory repository drops its rows, since it only ever cached this process',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 await repo.saveAccount('g2',snapshot('g2',3));
 await repo[Symbol.asyncDispose]();
 assert.equal(await repo.getAccount('g2'),undefined);
});

test('an unparseable row reads as absent, so the next save replaces it',async()=>{
 const repo=new InMemoryShieldedNoteRepository();
 (repo as unknown as {rows:Map<string,string>}).rows.set('g2','{"v":2,"tok');
 assert.equal(await repo.getAccount('g2'),undefined);
 await repo.saveAccount('g2',snapshot('g2',3));
 assert.equal((await repo.getAccount('g2'))?.account.batch,3);
});
