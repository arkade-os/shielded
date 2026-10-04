// @ts-ignore upstream library has no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore browser export is selected by Vite.
import * as snarkjs from 'snarkjs';
import intentKey from '../../../circuits/build/intent.vkey.json';
import transitionKey from '../../../circuits/build/transition.vkey.json';
import artifactManifest from '../proving-artifacts.json';
import {Kernel,type ProtocolEnvironment} from './core.ts';
import {createGroth16ProofBackend,type ProofBackend} from './proofs.ts';
import {createPinnedArtifactLoader} from './pinned-artifact.ts';
import type {Owner,WalletKeys,PublicRecipient,PublicProtocolCheckpoint} from './types.ts';
import type {Groth16Proof} from './types.ts';
export async function createBrowserClient(options:{owner:Owner;keys?:WalletKeys;recipients?:Record<Owner,PublicRecipient>;checkpoint?:PublicProtocolCheckpoint;token?:string;proofBackend?:ProofBackend<Groth16Proof>}){
 const headers=options.token?{Authorization:'Bearer '+options.token}:undefined;
 const artifact=createPinnedArtifactLoader(fetch,artifactManifest.artifacts,name=>'/api/proving/'+name,headers);
 const proofBackend=options.proofBackend??createGroth16ProofBackend({prove:async(name,witness)=>snarkjs.groth16.fullProve(witness,await artifact(name+'.wasm'),await artifact(name+'.zkey'),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)});
 const env:ProtocolEnvironment={randomBytes:length=>crypto.getRandomValues(new Uint8Array(length)),vkeys:{intent:intentKey,transition:transitionKey},proofs:proofBackend};
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);const client=new Kernel(poseidon,baby,env,'client',options.owner,options.keys,options.recipients);if(options.checkpoint)client.restorePublicCheckpoint(options.checkpoint);return client;
}
