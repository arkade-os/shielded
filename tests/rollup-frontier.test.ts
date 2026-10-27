import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {NOTE_DEPTH,ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import {checkpointOf,NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
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

const leaves=(block:number)=>[BigInt(2*block+1),BigInt(2*block+2)];
test('a checkpoint read off a later full tree resumes exactly where a frontier that appended every block would be',()=>{
 const full=new DeepTree(hash,NOTE_DEPTH);
 for(let block=0;block<500;block++)leaves(block).forEach((leaf,i)=>full.set(block*32+i,leaf));
 for(const k of [64,192,448]){
  const replayed=new NoteFrontier(hash);
  for(let block=0;block<k;block++)replayed.append(leaves(block));
  const resumed=NoteFrontier.at(hash,checkpointOf(full,k));
  assert.equal(resumed.root(),replayed.root(),`root at ${k}`);
  for(let block=k;block<k+40;block++){replayed.append(leaves(block),[1]);resumed.append(leaves(block),[1]);}
  assert.equal(resumed.root(),replayed.root(),`root after appending past ${k}`);
  for(let block=k;block<k+40;block++)assert.deepEqual(resumed.path(block*32+1),replayed.path(block*32+1));
 }
 const good=checkpointOf(full,64),leading=(value:string)=>({...good,filled:[value,...good.filled.slice(1)]});
 for(const bad of [{...good,blocks:-64},{...good,blocks:1.5},{...good,filled:good.filled.slice(1)},leading(String(ROLLUP_FIELD)),leading('0x10'),leading('-1'),leading('')])assert.throws(()=>NoteFrontier.at(hash,bad),/Malformed/);
});
