import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// @ts-ignore upstream libraries have no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore upstream library has no declarations.
import * as snarkjs from 'snarkjs';
import {Kernel,type ProtocolEnvironment} from '../../packages/protocol/src/core.ts';
import {createGroth16ProofBackend} from '../../packages/protocol/src/proofs.ts';
import type {Owner,PublicRecipient,PublicProtocolCheckpoint,WalletKeys} from '../../packages/protocol/src/types.ts';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
let context:Promise<{poseidon:any;baby:any;env:Omit<ProtocolEnvironment,'randomBytes'>}>|undefined;
async function fixtureContext(){
 context??=(async()=>{
  const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);
  const build=resolve(root,'circuits/build');
  const vkeys=Object.fromEntries(['intent','transition'].map(name=>[name,JSON.parse(readFileSync(resolve(build,name+'.vkey.json'),'utf8'))]));
  const proofs=createGroth16ProofBackend({prove:(name,witness)=>snarkjs.groth16.fullProve(witness,resolve(build,name+'_js/'+name+'.wasm'),resolve(build,name+'.zkey'),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)});
  return {poseidon,baby,env:{vkeys,proofs}};
 })();
 return context;
}

function fixtureEntropy(label:string){
 let counter=0;
 return (length:number)=>{
  const result=new Uint8Array(length);let offset=0;
  while(offset<length){const block=createHash('sha256').update(`shielded-test-only-kernel-entropy-v1:${label}:${counter++}`).digest();const count=Math.min(block.length,length-offset);result.set(block.subarray(0,count),offset);offset+=count;}
  return result;
 };
}

/** Deterministic Kernel entropy is intentionally exposed only from this test fixture. */
export async function createTestClientProtocol(args:{owner:Owner;keys:WalletKeys;recipients?:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint;entropyLabel:string}){
 const value=await fixtureContext();const env:ProtocolEnvironment={...value.env,randomBytes:fixtureEntropy(args.entropyLabel)};
 const client=new Kernel(value.poseidon,value.baby,env,'client',args.owner,args.keys,args.recipients);
 if(args.checkpoint)client.restorePublicCheckpoint(args.checkpoint);
 return client;
}
