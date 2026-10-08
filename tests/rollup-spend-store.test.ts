import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {RollupSpend} from '../src/rollup/batcher.ts';
import {decodeSpend,encodeSpend,openSpendStore} from '../src/rollup/spend-store.ts';

const spend:Omit<RollupSpend,'receivedAt'>={id:'ab'.repeat(16),slot:{root:7n,nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:99n,groupSize:2},
 publics:[1n,2n,0n,0n,0n],proof:{pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['5','6','1']},ciphertext:Uint8Array.of(1,2,3),program:new Uint8Array(32).fill(4),asset:'cc'.repeat(34)};

test('a stored spend decodes to the spend that was admitted, and keeps the coin it named',()=>{
 const coin={txid:'dd'.repeat(32),vout:1,tapTree:'aa',leaf:'bb'};
 const stored=JSON.parse(JSON.stringify(encodeSpend(spend,coin)));
 assert.deepEqual(stored.coin,coin);
 assert.deepEqual(decodeSpend(stored),spend);
 const plain={id:spend.id,slot:{...spend.slot,groupId:0n,groupSize:0},publics:spend.publics,proof:spend.proof};
 assert.deepEqual(decodeSpend(JSON.parse(JSON.stringify(encodeSpend(plain)))),plain);
});

test('the store keeps one record per spend, replaces it on update, and lists them oldest first',()=>{
 const store=openSpendStore(join(mkdtempSync(join(tmpdir(),'rollup-spends-')),'spends'));
 store.save({id:'b',status:'pending',nullifier:'2',at:20,spend:encodeSpend(spend)});
 store.save({id:'a',status:'pending',nullifier:'1',at:10});
 store.save({id:'b',status:'included',nullifier:'2',at:20,batch:3,txid:'t'});
 assert.deepEqual(store.load().map(r=>[r.id,r.status,r.spend===undefined]),[['a','pending',true],['b','included',true]]);
 store.remove('a');
 assert.deepEqual(store.load().map(r=>r.id),['b']);
 assert.throws(()=>store.save({id:'../escape',status:'pending',nullifier:'3',at:1}),/id/);
});
