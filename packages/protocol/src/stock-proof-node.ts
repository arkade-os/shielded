import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-ignore snarkjs has no declarations.
import * as snarkjs from 'snarkjs';
import { createStockGroth16ProofBackend } from './stock-proof.js';
import { stockProofDescriptor, stockProofDescriptorMatches, type StockProofDescriptor } from './stock-native.js';
import type { PinnedArtifactManifest } from './pinned-artifact.js';

export interface StockArtifactManifest {
 version: 1;
 profile: StockProofDescriptor;
 artifacts: PinnedArtifactManifest;
 setup: { phase1: string; phase1Blake2b512: string; phase2: 'development-only' | 'verified-multiparty' };
}
const required = ['stock-combined.wasm', 'stock-combined.zkey', 'stock-combined.vkey.json'] as const;
export async function loadStockProofArtifacts(directory: string, manifest: StockArtifactManifest) {
 if (!manifest || manifest.version !== 1 || !manifest.artifacts || !manifest.setup || !['development-only', 'verified-multiparty'].includes(manifest.setup.phase2)) throw new Error('Invalid stock proving artifact manifest.');
 const bytes = await Promise.all(required.map(async name => {
  const pin = manifest.artifacts[name];
  if (!pin || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > 512 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error('Missing or invalid stock proving artifact pin: ' + name);
  const data = await readFile(join(directory, name === 'stock-combined.wasm' ? 'stock-combined_js/stock-combined.wasm' : name));
  if (data.byteLength !== pin.size || createHash('sha256').update(data).digest('hex') !== pin.sha256) throw new Error('Stock proving artifact failed integrity verification: ' + name);
  return new Uint8Array(data);
 }));
 const verifierKey = JSON.parse(new TextDecoder().decode(bytes[2]));
 const descriptor = stockProofDescriptor(verifierKey);
 if (!stockProofDescriptorMatches(descriptor, manifest.profile)) throw new Error('Stock proving manifest does not match its verifier key.');
 const backend = createStockGroth16ProofBackend({
  prove: witness => snarkjs.groth16.fullProve(witness, bytes[0], bytes[1], undefined, undefined, { singleThread: true }),
  verify: (key, signals, proof) => snarkjs.groth16.verify(key, signals, proof),
 });
 return { backend, verifierKey, descriptor, manifest: structuredClone(manifest) };
}