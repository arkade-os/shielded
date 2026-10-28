import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {hex} from '@scure/base';
import {recordSlotOf} from '../../packages/protocol/src/rollup/epoch-record.ts';
import type {SnarkProof} from './covenant.ts';
import {slotOf,type RollupEpochSpend} from './epoch-operator.ts';

/** The coin as the client named it; the store re-resolves it from the indexer rather than keeping transaction bytes. */
export interface CoinRef {txid:string;vout:number;tapTree:string;leaf:string}
export interface EncodedEpochSpend {id:string;slot:{anchor:string;rCur?:{epoch:number;root:string};origin?:number;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number};publics:string[];proof:SnarkProof;ciphertext?:string;asset?:string;program?:string;coin?:CoinRef}
export interface StoredSpend {id:string;status:'pending'|'included'|'dropped';nullifier:string;at:number;batch?:number;txid?:string;reason?:string;spend?:EncodedEpochSpend}

export const encodeEpochSpend=(s:Omit<RollupEpochSpend,'receivedAt'|'coin'>,coin?:CoinRef):EncodedEpochSpend=>({id:s.id,slot:recordSlotOf(s.slot),
 publics:s.publics.map(String),proof:s.proof,...(s.ciphertext?{ciphertext:hex.encode(s.ciphertext)}:{}),...(s.asset?{asset:s.asset}:{}),...(s.program?{program:hex.encode(s.program)}:{}),...(coin?{coin}:{})});

/** The spend's origin is its slot's: admission refuses a recovery that names it on only one of the two. */
export const decodeEpochSpend=(e:EncodedEpochSpend):Omit<RollupEpochSpend,'receivedAt'|'coin'>=>({id:e.id,slot:slotOf(e.slot),...(e.slot.origin!==undefined?{origin:e.slot.origin}:{}),
 publics:e.publics.map(BigInt) as unknown as RollupEpochSpend['publics'],proof:e.proof,...(e.ciphertext?{ciphertext:hex.decode(e.ciphertext)}:{}),...(e.asset?{asset:e.asset}:{}),...(e.program?{program:hex.decode(e.program)}:{})});

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
