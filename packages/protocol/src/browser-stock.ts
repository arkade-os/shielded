// Browser-only stock Groth16 client. The operator serves artifacts, but every
// artifact is checked against the release manifest before it reaches snarkjs.
// @ts-ignore the browser build resolves snarkjs' browser entry point.
import * as snarkjs from 'snarkjs';
import {createPinnedArtifactLoader} from './pinned-artifact.ts';
import {createStockGroth16ProofBackend} from './stock-proof.ts';
import {createBrowserClient} from './browser.ts';
import type {Owner,PublicProtocolCheckpoint,WalletKeys} from './types.ts';

export interface StockBrowserProfile {
 verifierKey:unknown;
 provingManifest:{artifacts:Record<string,{size:number;sha256:string}>};
}

export async function createStockBrowserClient(options:{owner:Owner;keys:WalletKeys;profile:StockBrowserProfile;checkpoint?:PublicProtocolCheckpoint;artifact?:(name:string)=>Promise<Uint8Array>}):Promise<Awaited<ReturnType<typeof createBrowserClient>>>{
 const artifact=options.artifact??createPinnedArtifactLoader(fetch,options.profile.provingManifest.artifacts,name=>'/api/proving/'+encodeURIComponent(name));
 const backend=createStockGroth16ProofBackend({
  prove:async witness=>snarkjs.groth16.fullProve(witness,await artifact('stock-combined.wasm'),await artifact('stock-combined.zkey'),undefined,undefined,{singleThread:true}),
  verify:(verifierKey,signals,proof)=>snarkjs.groth16.verify(verifierKey,signals,proof),
 });
 return createBrowserClient({owner:options.owner,keys:options.keys,stockOnly:true,stockProofBackend:backend,stockVerifierKey:options.profile.verifierKey,checkpoint:options.checkpoint});
}
