import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {hex} from '@scure/base';
import type {RollupSpend} from './batcher.ts';
import type {SnarkProof} from './covenant.ts';

/** The coin as the client named it; the store re-resolves it from the indexer rather than keeping transaction bytes. */
export interface CoinRef {txid:string;vout:number;tapTree:string;leaf:string}
export interface EncodedSpend {id:string;slot:{root:string;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number};publics:string[];proof:SnarkProof;ciphertext?:string;asset?:string;program?:string;coin?:CoinRef}
export interface StoredSpend {id:string;status:'pending'|'included'|'dropped';nullifier:string;at:number;batch?:number;txid?:string;reason?:string;spend?:EncodedSpend}

export const encodeSpend=(s:Omit<RollupSpend,'receivedAt'|'coin'>,coin?:CoinRef):EncodedSpend=>({id:s.id,
 slot:{root:String(s.slot.root),nullifiers:s.slot.nullifiers.map(String),commitments:[String(s.slot.commitments[0]),String(s.slot.commitments[1])],ctDigest:String(s.slot.ctDigest),groupId:String(s.slot.groupId),groupSize:s.slot.groupSize},
 publics:s.publics.map(String),proof:s.proof,...(s.ciphertext?{ciphertext:hex.encode(s.ciphertext)}:{}),...(s.asset?{asset:s.asset}:{}),...(s.program?{program:hex.encode(s.program)}:{}),...(coin?{coin}:{})});

export const decodeSpend=(e:EncodedSpend):Omit<RollupSpend,'receivedAt'|'coin'>=>({id:e.id,
 slot:{root:BigInt(e.slot.root),nullifiers:e.slot.nullifiers.map(BigInt),commitments:[BigInt(e.slot.commitments[0]),BigInt(e.slot.commitments[1])],ctDigest:BigInt(e.slot.ctDigest),groupId:BigInt(e.slot.groupId),groupSize:e.slot.groupSize},
 publics:e.publics.map(BigInt) as unknown as RollupSpend['publics'],proof:e.proof,...(e.ciphertext?{ciphertext:hex.decode(e.ciphertext)}:{}),...(e.asset?{asset:e.asset}:{}),...(e.program?{program:hex.decode(e.program)}:{})});

/** One JSON file per spend id, rewritten on every status change. */
export function openSpendStore(directory:string){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const path=(id:string)=>{if(!/^[0-9a-zA-Z_-]{1,64}$/.test(id))throw new Error('A stored spend id is 1 to 64 safe characters.');return join(directory,id+'.json');};
 return {
  save:(record:StoredSpend)=>writeFileSync(path(record.id),JSON.stringify(record),{mode:0o600}),
  remove:(id:string)=>rmSync(path(id),{force:true}),
  load:():StoredSpend[]=>readdirSync(directory).filter(name=>name.endsWith('.json')).flatMap(name=>{try{return [JSON.parse(readFileSync(join(directory,name),'utf8')) as StoredSpend];}catch{return [];}}).sort((a,b)=>a.at-b.at),
 };
}
