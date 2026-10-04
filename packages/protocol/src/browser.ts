// @ts-ignore upstream library has no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore browser export is selected by Vite.
import * as snarkjs from 'snarkjs';
import intentKey from '../../../circuits/build/intent.vkey.json';
import transitionKey from '../../../circuits/build/transition.vkey.json';
import {Kernel,type ProtocolEnvironment} from './core.ts';
import type {Owner,WalletKeys,PublicRecipient,PublicProtocolCheckpoint} from './types.ts';
export async function createBrowserClient(options:{owner:Owner;keys?:WalletKeys;recipients?:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint;token?:string}){
 const headers=options.token?{Authorization:'Bearer '+options.token}:undefined;
 const cached=new Map<string,Promise<Uint8Array>>();
 const artifact=(name:string)=>{let value=cached.get(name);if(!value){value=fetch('/api/proving/'+name,{headers}).then(async response=>{if(!response.ok)throw new Error('Proving artifact unavailable');return new Uint8Array(await response.arrayBuffer());});cached.set(name,value);}return value;};
 const env:ProtocolEnvironment={randomBytes:length=>crypto.getRandomValues(new Uint8Array(length)),vkeys:{intent:intentKey,transition:transitionKey},prove:async(name,witness)=>snarkjs.groth16.fullProve(witness,await artifact(name+'.wasm'),await artifact(name+'.zkey'),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)};
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);const client=new Kernel(poseidon,baby,env,'client',options.owner,options.keys,options.recipients);if(options.checkpoint)client.restorePublicCheckpoint(options.checkpoint);return client;
}
