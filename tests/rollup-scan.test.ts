import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {NOTE_DEPTH,SUBTREE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import {DeepTree} from '../packages/protocol/src/rollup/tree.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const blockRoot=(leaves:bigint[])=>{let level=Array.from({length:2**SUBTREE_DEPTH},(_,i)=>leaves[i]??0n);while(level.length>1)level=Array.from({length:level.length/2},(_,i)=>hash([level[2*i]!,level[2*i+1]!]));return level[0]!;};

test('a frontier that takes some blocks by root alone keeps the root and tracked paths of one that takes every leaf',()=>{
 const full=new DeepTree(hash,NOTE_DEPTH),lean=new NoteFrontier(hash),tracked:number[]=[];
 let next=1n;
 for(let block=0;block<40;block++){
  const leaves=Array.from({length:22},()=>next++),offsets=block%7===0?[3,20]:[];
  leaves.forEach((leaf,i)=>full.set(block*32+i,leaf));
  if(offsets.length)lean.append(leaves,offsets);else lean.appendRoot(blockRoot(leaves));
  tracked.push(...offsets.map(o=>block*32+o));
  assert.equal(lean.root(),full.root(),`root after block ${block}`);
 }
 for(const index of tracked)assert.deepEqual(lean.path(index),full.path(index),`path of leaf ${index}`);
});
