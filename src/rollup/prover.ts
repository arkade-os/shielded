import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import * as snarkjs from 'snarkjs';
import {toCircuitInput} from '../../packages/protocol/src/rollup/client.ts';
import type {SnarkProof} from './covenant.ts';

export interface CircuitArtifacts {wasm:string;zkey:string}
export interface RollupProver {prove(input:Record<string,unknown>,expected:readonly bigint[]):Promise<SnarkProof>}

const same=(signals:readonly string[],expected:readonly bigint[])=>signals.length===expected.length&&signals.every((signal,i)=>BigInt(signal)===expected[i]);
const cli=join(dirname(createRequire(import.meta.url).resolve('snarkjs')),'cli.cjs');
export const runChild=async(file:string,args:string[])=>{await promisify(execFile)(file,args,{maxBuffer:16*1024*1024,windowsHide:true});};

/**
 * The snarkjs CLI, or its witness step plus the rapidsnark binary when one is configured; both must reproduce the
 * expected public signals. Proving runs in child processes so a batch never stalls the operator's HTTP signing round.
 */
export function createRollupProver(artifacts:CircuitArtifacts,rapidsnark?:string,run=runChild):RollupProver {
 return {async prove(input,expected){
  const dir=await mkdtemp(join(tmpdir(),'rollup-prove-')),file=(name:string)=>join(dir,name);
  try{
   await writeFile(file('input.json'),JSON.stringify(toCircuitInput(input)));
   if(rapidsnark){
    await run(process.execPath,[cli,'wtns','calculate',artifacts.wasm,file('input.json'),file('witness.wtns')]);
    await run(rapidsnark,[artifacts.zkey,file('witness.wtns'),file('proof.json'),file('public.json')]);
   }else await run(process.execPath,[cli,'groth16','fullprove',file('input.json'),artifacts.wasm,artifacts.zkey,file('proof.json'),file('public.json')]);
   const [proof,publicSignals]=await Promise.all(['proof.json','public.json'].map(async name=>JSON.parse(await readFile(file(name),'utf8'))));
   if(!same(publicSignals,expected))throw new Error('Proof public signals differ from the expected statement.');
   return {pi_a:proof.pi_a,pi_b:proof.pi_b,pi_c:proof.pi_c};
  }finally{await rm(dir,{recursive:true,force:true});}
 }};
}

export async function verifyRollupProof(vkey:unknown,publics:readonly bigint[],proof:SnarkProof):Promise<boolean> {
 return snarkjs.groth16.verify(vkey,publics.map(String),proof);
}
