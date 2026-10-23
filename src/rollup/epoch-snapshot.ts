import {readFileSync} from 'node:fs';
import {ARCHIVE_DEPTH,EPOCH_NULLIFIER_DEPTH,NOTE_DEPTH,RECOVERED_DEPTH,ROLLUP_FIELD,SUBTREE_DEPTH,WINDOW_DEPTH} from '../../packages/protocol/src/rollup/constants.ts';
import {EpochArchive} from '../../packages/protocol/src/rollup/epoch-archive.ts';
import type {EpochState} from '../../packages/protocol/src/rollup/epoch.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupNullifiers} from '../../packages/protocol/src/rollup/nullifiers.ts';
import {DeepTree} from '../../packages/protocol/src/rollup/tree.ts';
import {stockJournalFingerprint,type StockReleasePin} from '../stock/journal.ts';
import {getField,getLeaves,putField,putLeaves,sha256} from './epoch-archive-file.ts';

export const EPOCH_SNAPSHOT_VERSION=1;
const MAGIC=Buffer.from('SHES'),DEPTHS=[NOTE_DEPTH,EPOCH_NULLIFIER_DEPTH,WINDOW_DEPTH,RECOVERED_DEPTH,ARCHIVE_DEPTH],PIN=4+2+DEPTHS.length,COUNTS=PIN+32,HEADER=COUNTS+7*4+2*32;
const fingerprint=(pin:StockReleasePin)=>Buffer.from(stockJournalFingerprint(pin),'hex');

/** The hot state; the previous epoch's frozen set is not in it, only its root, and loads from its archive file. */
export interface EpochSnapshotParts {epoch:number;epochLen:number;noteCount:number;batchCount:number;prevNoteRoot:bigint;prevNfRoot:bigint;notes:DeepTree;nullifiers:RollupNullifiers;window:DeepTree;recovered:RollupNullifiers;archive:EpochArchive}

export function encodeEpochSnapshot(state:EpochState,pin:StockReleasePin):Buffer {
 const trees=[state.notes,state.window,state.archive.tree],sizes=trees.map(tree=>{let n=0;tree.scan(()=>n++);return n;}),records=state.archive.list();
 const out=Buffer.alloc(HEADER+sizes.reduce((sum,n)=>sum+4+37*n,0)+36*(state.nullifiers.count()+state.recovered.count())+96*records.length+32);
 let at=out.writeUInt16LE(EPOCH_SNAPSHOT_VERSION,MAGIC.copy(out));
 for(const depth of DEPTHS)at=out.writeUInt8(depth,at);
 at+=fingerprint(pin).copy(out,at);
 for(const n of [state.batchCount,state.noteCount,state.nullifiers.count(),state.recovered.count(),records.length,state.epoch,state.epochLen])at=out.writeUInt32LE(n,at);
 at=putField(out,state.prevNfRoot,putField(out,state.prevNoteRoot,at));
 trees.forEach((tree,k)=>{at=out.writeUInt32LE(sizes[k]!,at);tree.scan((level,index,value)=>{at=putField(out,value,out.writeUInt32LE(index,out.writeUInt8(level,at)));});});
 at=putLeaves(out,state.recovered,putLeaves(out,state.nullifiers,at));
 for(const r of records)for(const value of [r.noteFinal,r.nfFinal,r.nfNextFinal])at=putField(out,value,at);
 sha256(out.subarray(0,at)).copy(out,at);
 return out;
}

/** The hot state a snapshot holds, or undefined for anything unusable; it never throws and never returns part of a state. */
export function decodeEpochSnapshot(bytes:Buffer,hash:Hash,pin:StockReleasePin,batches:number):EpochSnapshotParts|undefined {
 try{
  const body=bytes.length-32;
  if(body<HEADER||!bytes.subarray(0,4).equals(MAGIC)||bytes.readUInt16LE(4)!==EPOCH_SNAPSHOT_VERSION||DEPTHS.some((depth,i)=>bytes[6+i]!==depth))return undefined;
  if(!sha256(bytes.subarray(0,body)).equals(bytes.subarray(body))||!bytes.subarray(PIN,COUNTS).equals(fingerprint(pin)))return undefined;
  let at=COUNTS;
  const u32=()=>{at+=4;return bytes.readUInt32LE(at-4);};
  const field=()=>{const value=getField(bytes,at);at+=32;if(value>=ROLLUP_FIELD)throw new Error('A snapshot value is outside the field.');return value;};
  const [batchCount,noteCount,nfCount,rsCount,erCount,epoch,epochLen]=Array.from({length:7},u32) as [number,number,number,number,number,number,number];
  // The note tree restarts at every rotation, so it holds only the blocks of the batches since the current epoch began.
  const epochBatches=batchCount-epochLen*epoch;
  if(batchCount>batches||epoch!==(batchCount?Math.floor((batchCount-1)/epochLen):0)||noteCount!==2**SUBTREE_DEPTH*epochBatches)return undefined;
  const prevNoteRoot=field(),prevNfRoot=field();
  const fill=(tree:DeepTree,end:number)=>{for(let n=u32();n>0;n--){const level=bytes.readUInt8(at++),index=u32();if(level>tree.depth||index*2**level>=end)throw new Error('A snapshot node lies above its tree or past its frontier.');tree.place(level,index,field());}return tree;};
  // Genesis seeds the window ring at its last slot, so the whole ring is its frontier.
  const notes=fill(new DeepTree(hash,NOTE_DEPTH),noteCount),window=fill(new DeepTree(hash,WINDOW_DEPTH),2**WINDOW_DEPTH),tree=fill(new DeepTree(hash,ARCHIVE_DEPTH),erCount);
  const set=(depth:number,count:number)=>{const leaves=getLeaves(bytes,at,count);at+=36*count;return RollupNullifiers.fromLeaves(hash,depth,leaves);};
  const nullifiers=set(EPOCH_NULLIFIER_DEPTH,nfCount),recovered=set(RECOVERED_DEPTH,rsCount);
  const records=Array.from({length:erCount},(_,i)=>({epoch:i-1,noteFinal:field(),nfFinal:field(),nfNextFinal:field()}));
  if(at!==body||!notes.consistentAlong(SUBTREE_DEPTH,epochBatches)||!window.consistent()||!tree.consistent())return undefined;
  const archive=new EpochArchive(hash,tree);archive.restore(records);
  return {epoch,epochLen,noteCount,batchCount,prevNoteRoot,prevNfRoot,notes,nullifiers,window,recovered,archive};
 }catch{return undefined;}
}

export function readEpochSnapshot(path:string,hash:Hash,pin:StockReleasePin,batches:number):EpochSnapshotParts|undefined {
 let bytes:Buffer;
 try{bytes=readFileSync(path);}catch{return undefined;}
 return decodeEpochSnapshot(bytes,hash,pin,batches);
}
