import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {EPOCH_NULLIFIER_DEPTH} from '../../packages/protocol/src/rollup/constants.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupNullifiers} from '../../packages/protocol/src/rollup/nullifiers.ts';

const MAGIC=Buffer.from('SHNA'),VERSION=1,HEADER=4+2+4+4,LEAF=36,SHIFTS=[0n,64n,128n,192n],U64=(1n<<64n)-1n;
export const putField=(out:Buffer,value:bigint,at:number)=>{SHIFTS.forEach((s,i)=>out.writeBigUInt64LE((value>>s)&U64,at+8*i));return at+32;};
export const getField=(bytes:Buffer,at:number)=>SHIFTS.reduce((value,s,i)=>value|(bytes.readBigUInt64LE(at+8*i)<<s),0n);
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest();
/** A set's leaves in index order, 36 bytes each: the value, then its nextIndex. */
export const putLeaves=(out:Buffer,set:RollupNullifiers,at:number)=>{set.scanLeaves((value,nextIndex)=>{at=out.writeUInt32LE(nextIndex,putField(out,value,at));});return at;};
export const getLeaves=(bytes:Buffer,at:number,count:number)=>Array.from({length:count},(_,i)=>({value:getField(bytes,at+LEAF*i),nextIndex:bytes.readUInt32LE(at+LEAF*i+32)}));

export const epochNfArchivePath=(dir:string,epoch:number)=>join(dir,`epoch-${epoch}.nf`);

export function encodeEpochNfArchive(epoch:number,set:RollupNullifiers):Buffer {
 const out=Buffer.alloc(HEADER+LEAF*set.count()+32);
 const at=putLeaves(out,set,out.writeUInt32LE(set.count(),out.writeUInt32LE(epoch,out.writeUInt16LE(VERSION,MAGIC.copy(out)))));
 sha256(out.subarray(0,at)).copy(out,at);
 return out;
}

const decode=(bytes:Buffer,hash:Hash,epoch:number):RollupNullifiers|string=>{
 try{
  const count=bytes.readUInt32LE(10),body=HEADER+LEAF*count;
  if(bytes.length!==body+32)return `it is ${bytes.length} bytes, not the ${body+32} its count of ${count} needs`;
  if(!bytes.subarray(0,4).equals(MAGIC)||bytes.readUInt16LE(4)!==VERSION)return 'it is not a version-1 nullifier archive';
  if(bytes.readUInt32LE(6)!==epoch)return `it is labelled epoch ${bytes.readUInt32LE(6)}`;
  if(!sha256(bytes.subarray(0,body)).equals(bytes.subarray(body)))return 'its checksum does not match';
  return RollupNullifiers.fromLeaves(hash,EPOCH_NULLIFIER_DEPTH,getLeaves(bytes,HEADER,count));
 }catch(error){return (error as Error).message;}
};

/** The frozen set the file rebuilds; one comparison with the root the archive holds refuses every other file, damaged or not. */
export function readEpochNfArchive(path:string,hash:Hash,expect:{epoch:number;root:bigint}):RollupNullifiers {
 const set=decode(readFileSync(path),hash,expect.epoch);
 if(typeof set==='string'||set.root()!==expect.root)throw new Error(`The nullifier archive ${path} does not rebuild the root epoch ${expect.epoch} archived: ${typeof set==='string'?set:'it rebuilds another root'}.`);
 return set;
}
