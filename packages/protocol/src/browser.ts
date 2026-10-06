// @ts-ignore upstream library has no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore browser export is selected by Vite.
import * as snarkjs from 'snarkjs';
import artifactManifest from '../proving-artifacts.json';
import {Kernel,type ProtocolEnvironment} from './core.ts';
import {createGroth16ProofBackend,type ProofBackend} from './proofs.ts';
import {createPinnedArtifactLoader} from './pinned-artifact.ts';
import type {Owner,WalletKeys,PublicRecipient,PublicProtocolCheckpoint} from './types.ts';
import type {Groth16Proof} from './types.ts';
import type {StockProofBackend} from './stock-native.ts';
export async function createBrowserClient(options:{owner:Owner;keys?:WalletKeys;recipients?:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint;token?:string;proofBackend?:ProofBackend<Groth16Proof>;stockProofBackend?:StockProofBackend;stockVerifierKey?:unknown;stockOnly?:boolean}){
 const headers=options.token?{Authorization:'Bearer '+options.token}:undefined;
 const artifact=createPinnedArtifactLoader(fetch,artifactManifest.artifacts,name=>'/api/proving/'+name,headers);
 const proofBackend=options.proofBackend??(options.stockOnly?undefined:createGroth16ProofBackend({prove:async(name,witness)=>snarkjs.groth16.fullProve(witness,await artifact(name+'.wasm'),await artifact(name+'.zkey'),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)}));
 const vkeys=options.stockOnly?{}:Object.fromEntries(await Promise.all(['intent','transition'].map(async name=>[name,(await import(`../../../circuits/build/${name}.vkey.json`)).default])));
 const env:ProtocolEnvironment={randomBytes:length=>crypto.getRandomValues(new Uint8Array(length)),vkeys,proofs:proofBackend,stockProof:options.stockProofBackend,stockVerifierKey:options.stockVerifierKey,stockOnly:options.stockOnly};
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);const client=new Kernel(poseidon,baby,env,'client',options.owner,options.keys,options.recipients);if(options.checkpoint)client.restorePublicCheckpoint(options.checkpoint);return client;
}
