import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
// @ts-ignore upstream library has no declarations.
import { buildPoseidon, buildBabyjub } from 'circomlibjs';
// @ts-ignore upstream library has no declarations.
import * as snarkjs from 'snarkjs';
import { Kernel, type ProtocolEnvironment } from './core.js';
import type { Owner, WalletKeys, PublicRecipient, ProtocolCheckpoint, PublicProtocolCheckpoint } from './types.js';
export * from './core.js';
const BUILD=path.join(fileURLToPath(new URL('../../..',import.meta.url)),'circuits/build');
async function kernel(mode:'legacy'|'client'|'public',options:{owner?:Owner;keys?:WalletKeys;recipients?:Record<Owner,PublicRecipient>;secureKeys?:boolean}){
 for(const name of ['intent','transition'])if(!existsSync(path.join(BUILD,`${name}.zkey`)))throw new Error(`Missing ${name} proof artifacts. Run npm run setup first.`);
 const env:ProtocolEnvironment={randomBytes,vkeys:Object.fromEntries(['intent','transition'].map(name=>[name,JSON.parse(readFileSync(path.join(BUILD,`${name}.vkey.json`),'utf8'))])),prove:(name,witness)=>snarkjs.groth16.fullProve(witness,path.join(BUILD,`${name}_js/${name}.wasm`),path.join(BUILD,`${name}.zkey`),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)};
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);return new Kernel(poseidon,baby,env,mode,options.owner,options.keys,options.recipients,options.secureKeys);
}
export async function createProtocol(options:{checkpoint?:ProtocolCheckpoint;secureKeys?:boolean}={}){const value=await kernel('legacy',options);if(options.checkpoint)value.restoreCheckpoint(options.checkpoint);return value;}
export async function createClientProtocol(options:{owner:Owner;keys?:WalletKeys;recipients?:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint}){const value=await kernel('client',options);if(options.checkpoint)value.restorePublicCheckpoint(options.checkpoint);return value;}
export async function createPublicProtocol(options:{recipients:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint}){const value=await kernel('public',options);if(options.checkpoint)value.restorePublicCheckpoint(options.checkpoint);return value;}
