import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {BATCH_SLOTS,NOTE_DEPTH,ROLLUP_FIELD,SUBTREE_DEPTH,type BatchKind} from '../packages/protocol/src/rollup/constants.ts';
import {checkpointOf} from '../packages/protocol/src/rollup/frontier.ts';
import {RollupState,type BatchSlot} from '../packages/protocol/src/rollup/state.ts';
import type {StockReleasePin} from '../src/stock/journal.ts';
import {decodeSnapshot,encodeSnapshot,readSnapshot,SNAPSHOT_VERSION,writeSnapshot} from '../src/rollup/snapshot.ts';

const hash=(values:bigint[])=>values.reduce((acc,v)=>(acc*1_000_003n+v+1n)%ROLLUP_FIELD,7n);
const pin:StockReleasePin={version:1,network:'local-stock',descriptorProfileId:'11'.repeat(32),programsHash:'22'.repeat(32),artifactsHash:'33'.repeat(32),checkpointHash:'44'.repeat(32),genesisTxid:'55'.repeat(32),serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
let next=0n;
// Scattered, so nullifiers land all over the sorted list rather than only at its end.
const fresh=()=>(++next*0x2f1b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0n)%ROLLUP_FIELD;
const slots=(s:RollupState,kind:BatchKind):BatchSlot[]=>Array.from({length:BATCH_SLOTS},()=>({root:s.latestRoot(),nullifiers:kind==='join'?[fresh(),fresh()]:[fresh()],commitments:[fresh(),fresh()],ctDigest:fresh(),groupId:0n,groupSize:0}));
const grown=(batches:number,leaves=false)=>{const s=RollupState.genesis(hash,leaves);for(let i=0;i<batches;i++){const kind=i%5===4?'join':'spend';s.apply(kind,slots(s,kind));}return s;};

test('a snapshot round-trips through its file byte for byte, and the restored state batches on identically',()=>{
 const state=grown(6),bytes=encodeSnapshot(state,pin),dir=mkdtempSync(join(tmpdir(),'rollup-snapshot-')),path=join(dir,'snapshot.bin');
 assert.equal(readSnapshot(path,hash,pin,6),undefined);
 writeSnapshot(path,bytes);
 assert.deepEqual(readdirSync(dir),['snapshot.bin']);
 const restored=readSnapshot(path,hash,pin,6)!;
 assert.deepEqual(encodeSnapshot(restored,pin),bytes);
 assert.equal(restored.commitment(),state.commitment());
 const next=slots(state,'join');
 assert.deepEqual(restored.apply('join',next),state.apply('join',next));
 let lowest=NOTE_DEPTH;restored.notes.scan(level=>{lowest=Math.min(lowest,level);});
 assert.equal(lowest,SUBTREE_DEPTH,'a restored operator state keeps splicing');
});

test('a snapshot written with every note leaf restores into an operator state that batches on like the leaf state',()=>{
 const full=grown(6,true),restored=decodeSnapshot(encodeSnapshot(full,pin),hash,pin,6)!;
 assert.equal(restored.commitment(),full.commitment());
 const next=slots(full,'spend');
 assert.deepEqual(restored.apply('spend',next),full.apply('spend',next));
});

test('a snapshot that is damaged, foreign, ahead of the archive or malformed is refused',()=>{
 const state=grown(6),good=encodeSnapshot(state,pin),count=state.nullifiers.count();
 const resealed=(edit:(b:Buffer)=>void)=>{const b=Buffer.from(good);edit(b);createHash('sha256').update(b.subarray(0,b.length-32)).digest().copy(b,b.length-32);return b;};
 const leaf=(i:number)=>good.length-32-36*(count-i);
 // Header: magic 0, version 4, depths 6-8, pin 9, batchCount 41, noteCount 45, nfCount 49; the first node's level is at 57, index 58, value 62.
 const cases:Record<string,[Buffer,StockReleasePin?,number?]>={
  empty:[Buffer.alloc(0)],truncated:[good.subarray(0,-1)],'flipped byte':[(()=>{const b=Buffer.from(good);b[200]^=1;return b;})()],
  version:[resealed(b=>{b.writeUInt16LE(SNAPSHOT_VERSION+1,4);})],depth:[resealed(b=>{b[8]=5;})],pin:[good,{...pin,genesisTxid:'ee'.repeat(32)}],'ahead of the archive':[good,pin,5],
  'value outside the field':[resealed(b=>{Buffer.from(ROLLUP_FIELD.toString(16).padStart(64,'0'),'hex').reverse().copy(b,62);})],
  'index out of range':[resealed(b=>{b[57]=NOTE_DEPTH;b.writeUInt32LE(1,58);})],
  'repeated leaf':[resealed(b=>{good.copy(b,leaf(5),leaf(4),leaf(4)+32);})],'note count':[resealed(b=>{b.writeUInt32LE(32*6+1,45);})],
 };
 assert.ok(decodeSnapshot(good,hash,pin,6));
 for(const [name,[bytes,p=pin,batches=6]] of Object.entries(cases))assert.equal(decodeSnapshot(bytes,hash,p,batches),undefined,name);
});

test('a restored note tree serves the same historical checkpoint',()=>{
 const state=grown(70),restored=decodeSnapshot(encodeSnapshot(state,pin),hash,pin,70)!;
 assert.deepEqual(checkpointOf(restored.notes,64),checkpointOf(state.notes,64));
});

test('a snapshot whose trees disagree with their roots where later batches read them is refused',()=>{
 const state=grown(6),restored=()=>decodeSnapshot(encodeSnapshot(state,pin),hash,pin,6)!;
 const older=(s:RollupState)=>{const leaves:{value:bigint;nextIndex:number}[]=[];s.nullifiers.scanLeaves((value,nextIndex)=>leaves.push({value,nextIndex}));return leaves;};
 const cases:Record<string,(s:RollupState)=>void>={
  'note frontier sibling':s=>s.notes.place(6,2,s.notes.node(6,2)+1n),
  'note past the frontier':s=>s.notes.place(5,7,1n),
  'window node':s=>s.window.place(0,1,s.window.node(0,1)+1n),
  'nullifier past the frontier':s=>s.nullifiers.tree.place(0,s.nullifiers.count(),1n),
  'older nullifier leaf':s=>{const leaves=older(s),first=leaves[0]!.nextIndex;leaves[first]={...leaves[first]!,value:leaves[first]!.value-1n};s.nullifiers.scanLeaves=visit=>leaves.forEach(l=>visit(l.value,l.nextIndex));},
 };
 assert.ok(decodeSnapshot(encodeSnapshot(restored(),pin),hash,pin,6));
 for(const [name,edit] of Object.entries(cases)){const s=restored();edit(s);assert.equal(decodeSnapshot(encodeSnapshot(s,pin),hash,pin,6),undefined,name);}
});
