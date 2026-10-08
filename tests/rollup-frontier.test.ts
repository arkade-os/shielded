import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {NOTE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import {DeepTree} from '../packages/protocol/src/rollup/tree.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));

test('a frontier keeps the same root and the same paths for its tracked leaves as the full note tree',()=>{
 const full=new DeepTree(hash,NOTE_DEPTH),frontier=new NoteFrontier(hash);
 assert.equal(frontier.root(),full.root());
 let next=1n;const tracked:number[]=[];
 for(let block=0;block<70;block++){
  const leaves=Array.from({length:22},()=>next++);
  leaves.forEach((leaf,i)=>full.set(block*32+i,leaf));
  const offsets=block%9===0?[0,13,21]:block%4===1?[7]:[];
  frontier.append(leaves,offsets);tracked.push(...offsets.map(o=>block*32+o));
  assert.equal(frontier.root(),full.root(),`root after block ${block}`);
  if(block===40)frontier.untrack(tracked.shift()!);
 }
 for(const index of tracked)assert.deepEqual(frontier.path(index),full.path(index),`path of leaf ${index}`);
 assert.throws(()=>frontier.path(0),/not tracked/,'an untracked leaf has no path');
});
