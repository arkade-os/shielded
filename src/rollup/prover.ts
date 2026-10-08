import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import * as snarkjs from 'snarkjs';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import type {SnarkProof} from './covenant.ts';

export interface CircuitArtifacts {wasm:string;zkey:string}
export interface RollupProver {prove(input:Record<string,unknown>,expected:readonly bigint[]):Promise<SnarkProof>}

const same=(signals:readonly string[],expected:readonly bigint[])=>signals.length===expected.length&&signals.every((signal,i)=>BigInt(signal)===expected[i]);

/** snarkjs in-process, or the rapidsnark binary when one is configured; both must reproduce the expected public signals. */
export function createRollupProver(artifacts:CircuitArtifacts,rapidsnark?:string):RollupProver {
 return {async prove(input,expected){
  if(!rapidsnark){
   const {proof,publicSignals}=await snarkjs.groth16.fullProve(toCircuitInput(input),artifacts.wasm,artifacts.zkey);
   if(!same(publicSignals,expected))throw new Error('Batch proof public signals differ from the state transition.');
   return proof as SnarkProof;
  }
  const dir=await mkdtemp(join(tmpdir(),'rollup-prove-'));
  try{
   await snarkjs.wtns.calculate(toCircuitInput(input),artifacts.wasm,join(dir,'witness.wtns'));
   await promisify(execFile)(rapidsnark,[artifacts.zkey,join(dir,'witness.wtns'),join(dir,'proof.json'),join(dir,'public.json')]);
   const [proof,publicSignals]=await Promise.all(['proof.json','public.json'].map(async name=>JSON.parse(await readFile(join(dir,name),'utf8'))));
   if(!same(publicSignals,expected))throw new Error('Batch proof public signals differ from the state transition.');
   return proof as SnarkProof;
  }finally{await rm(dir,{recursive:true,force:true});}
 }};
}

export async function verifyRollupProof(vkey:unknown,publics:readonly bigint[],proof:SnarkProof):Promise<boolean> {
 return snarkjs.groth16.verify(vkey,publics.map(String),proof);
}
