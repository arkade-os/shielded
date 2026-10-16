import {createHash} from 'node:crypto';
import {closeSync,fsyncSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {Extension,Transaction} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {NOTE_DEPTH,NULLIFIER_DEPTH,ROLLUP_FIELD,SUBTREE_DEPTH,WINDOW_DEPTH} from '../../packages/protocol/src/rollup/constants.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupNullifiers} from '../../packages/protocol/src/rollup/nullifiers.ts';
import {RollupState} from '../../packages/protocol/src/rollup/state.ts';
import {DeepTree} from '../../packages/protocol/src/rollup/tree.ts';
import {stockJournalFingerprint,type StockReleasePin} from '../stock/journal.ts';
import {ROLLUP_STATE_PACKET} from './covenant.ts';

export const SNAPSHOT_VERSION=1;
const MAGIC=Buffer.from('SHRS'),HEADER=4+2+3+32+3*4,SHIFTS=[0n,64n,128n,192n],U64=(1n<<64n)-1n;
const put=(out:Buffer,value:bigint,at:number)=>{SHIFTS.forEach((s,i)=>out.writeBigUInt64LE((value>>s)&U64,at+8*i));return at+32;};
const get=(bytes:Buffer,at:number)=>SHIFTS.reduce((value,s,i)=>value|(bytes.readBigUInt64LE(at+8*i)<<s),0n);
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest();
const fingerprint=(pin:StockReleasePin)=>Buffer.from(stockJournalFingerprint(pin),'hex');

/** Every node of every tree, not a frontier: the pool serves historical checkpoints off the note tree's inner nodes. */
export function encodeSnapshot(state:RollupState,pin:StockReleasePin):Buffer {
 const trees=[state.notes,state.nullifiers.tree,state.window],sizes=trees.map(tree=>{let n=0;tree.scan(()=>n++);return n;}),leaves=state.nullifiers.count();
 const out=Buffer.alloc(HEADER+sizes.reduce((sum,n)=>sum+4+37*n,0)+4+36*leaves+32);
 let at=out.writeUInt16LE(SNAPSHOT_VERSION,MAGIC.copy(out));
 for(const depth of [NOTE_DEPTH,NULLIFIER_DEPTH,WINDOW_DEPTH])at=out.writeUInt8(depth,at);
 at+=fingerprint(pin).copy(out,at);
 for(const n of [state.batchCount,state.noteCount,leaves])at=out.writeUInt32LE(n,at);
 trees.forEach((tree,k)=>{at=out.writeUInt32LE(sizes[k]!,at);tree.scan((level,index,value)=>{at=out.writeUInt32LE(index,out.writeUInt8(level,at));at=put(out,value,at);});});
 at=out.writeUInt32LE(leaves,at);
 state.nullifiers.scanLeaves((value,nextIndex)=>{at=out.writeUInt32LE(nextIndex,put(out,value,at));});
 sha256(out.subarray(0,at)).copy(out,at);
 return out;
}

/** The operator state a snapshot holds, which splices note subtrees and so serves no note path, or undefined for anything unusable; it never throws and never returns part of a state. */
export function decodeSnapshot(bytes:Buffer,hash:Hash,pin:StockReleasePin,batches:number):RollupState|undefined {
 try{
  const body=bytes.length-32;
  if(body<HEADER+16||!bytes.subarray(0,4).equals(MAGIC)||bytes.readUInt16LE(4)!==SNAPSHOT_VERSION||bytes[6]!==NOTE_DEPTH||bytes[7]!==NULLIFIER_DEPTH||bytes[8]!==WINDOW_DEPTH)return undefined;
  if(!sha256(bytes.subarray(0,body)).equals(bytes.subarray(body))||!bytes.subarray(9,41).equals(fingerprint(pin)))return undefined;
  const [batchCount,noteCount,nfCount]=[41,45,49].map(offset=>bytes.readUInt32LE(offset)) as [number,number,number];
  if(batchCount>batches||noteCount!==2**SUBTREE_DEPTH*batchCount||nfCount<1)return undefined;
  let at=HEADER;
  const u32=()=>{at+=4;return bytes.readUInt32LE(at-4);};
  const field=()=>{const value=get(bytes,at);at+=32;if(value>=ROLLUP_FIELD)throw new Error('A snapshot value is outside the field.');return value;};
  // A node past a tree's frontier would be read as a sibling by a later write, where only an empty subtree may be.
  const fill=(tree:DeepTree,end:number)=>{for(let n=u32();n>0;n--){const level=bytes.readUInt8(at++),index=u32();if(index*2**level>=end)throw new Error('A snapshot node lies past its frontier.');tree.place(level,index,field());}return tree;};
  const notes=fill(new DeepTree(hash,NOTE_DEPTH),noteCount),nullifiers=new RollupNullifiers(hash);fill(nullifiers.tree,nfCount);
  const window=fill(new DeepTree(hash,WINDOW_DEPTH),Math.min(batchCount,2**WINDOW_DEPTH));
  if(u32()!==nfCount)return undefined;
  const leaves=Array.from({length:nfCount},()=>({value:field(),nextIndex:u32()}));
  if(at!==body)return undefined;
  // New notes only ever append, so the next block's path is all the note tree must vouch for; the other two are checked whole.
  if(!notes.consistentAlong(SUBTREE_DEPTH,batchCount)||!window.consistent()||!nullifiers.tree.consistent())return undefined;
  nullifiers.loadLeaves(leaves);
  return RollupState.restore(hash,{notes,nullifiers,window,noteCount,batchCount},false);
 }catch{return undefined;}
}

/** Replaces the file whole: a crash leaves the previous snapshot or this one, never a mix. */
export function writeSnapshot(path:string,bytes:Uint8Array):void {
 const fd=openSync(path+'.tmp','w');
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(path+'.tmp',path);
}

/** The state commitment in a pool head's state packet, or undefined when the transaction carries no readable one. */
export function headCommitment(sourceTxHex:string):bigint|undefined {
 try{
  const packet=Extension.fromTx(Transaction.fromRaw(hex.decode(sourceTxHex),{allowUnknownOutputs:true})).getPacketByType(ROLLUP_STATE_PACKET)?.serialize();
  return packet?.length===64?get(Buffer.from(packet),0):undefined;
 }catch{return undefined;}
}

export function readSnapshot(path:string,hash:Hash,pin:StockReleasePin,batches:number):RollupState|undefined {
 let bytes:Buffer;
 try{bytes=readFileSync(path);}catch{return undefined;}
 return decodeSnapshot(bytes,hash,pin,batches);
}
