import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));

test('a frontier survives a snapshot round-trip, root and tracked paths alike',()=>{
 const a=new NoteFrontier(hash);
 a.append([1n,2n,3n],[0,2]);
 a.append([4n,5n],[1]);
 const b=NoteFrontier.fromSnapshot(hash,a.snapshot());
 assert.equal(b.root(),a.root());
 for(const index of [0,2,33])assert.deepEqual(b.path(index),a.path(index));
 a.append([6n],[]);b.append([6n],[]);
 assert.equal(b.root(),a.root());
 assert.deepEqual(b.path(0),a.path(0));
});

test('an empty frontier round-trips to the same root, and a future version is refused',()=>{
 const a=new NoteFrontier(hash);
 assert.equal(NoteFrontier.fromSnapshot(hash,a.snapshot()).root(),a.root());
 assert.throws(()=>NoteFrontier.fromSnapshot(hash,{...a.snapshot(),v:2 as unknown as 1}),/version/i);
});
