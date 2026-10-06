import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStockGroth16ProofBackend } from '../packages/protocol/src/stock-proof.ts';
import { loadStockProofArtifacts, type StockArtifactManifest } from '../packages/protocol/src/stock-proof-node.ts';
import { stockProofDescriptor, stockStatementScalar, type StockSettlementProof } from '../packages/protocol/src/stock-native.ts';
import type { Groth16Proof } from '../packages/protocol/src/types.ts';

const g1 = ['1', '2', '1'], g2 = [['1', '2'], ['3', '4'], ['1', '0']];
const key = { protocol: 'groth16', curve: 'bn128', nPublic: 1, vk_alpha_1: g1, vk_beta_2: g2, vk_gamma_2: g2, vk_delta_2: g2, IC: [g1, g1] };
const proof: Groth16Proof = { protocol: 'groth16', curve: 'bn128', pi_a: g1, pi_b: g2, pi_c: g1 };
const native = Uint8Array.from({ length: 201 }, (_, i) => i === 0 ? 83 : i === 1 ? 72 : i === 2 ? 1 : 0);
function envelope(): StockSettlementProof {
 const statement = stockStatementScalar(native).toString();
 return { version: 1, profile: 'shielded-stock-btc-v1', descriptorProfileId: stockProofDescriptor(key).profileId, operation: 'transfer', nativeBinding: Buffer.from(native).toString('hex'), statement, publicSignals: [statement], proof };
}
test('stock verifier rejects changed native identities and profiles before cryptographic verification', async () => {
 let verified = 0;
 const backend = createStockGroth16ProofBackend({ prove: async () => ({ proof, publicSignals: envelope().publicSignals }), verify: async () => { verified++; return true; } });
 assert.equal(await backend.verify(envelope(), key), true);
 assert.equal(verified, 1);
 for (const changed of [
  { ...envelope(), nativeBinding: envelope().nativeBinding.slice(0, 10) + '01' + envelope().nativeBinding.slice(12) },
  { ...envelope(), descriptorProfileId: '00'.repeat(32) },
  { ...envelope(), publicSignals: ['1'] as [string] },
  { ...envelope(), operation: 'seal' as const },
  { ...envelope(), proof: { ...proof, pi_a: ['-1', '2', '1'] } },
 ]) assert.equal(await backend.verify(changed, key), false);
 assert.equal(verified, 1);
 assert.equal(await backend.verify(envelope(), { ...key, nPublic: 2 }), false);
 assert.equal(await backend.verify(envelope(), key, '1'), false);
});
test('stock prover verifies the actual result and returns only the public proof fields', async () => {
 const witness = { native: Array.from(native), spendSecret: 'private-unit-fixture' };
 const engine = { prove: async () => ({ proof: { ...proof, spendSecret: 'must-not-leak' }, publicSignals: envelope().publicSignals, witness }), verify: async () => true };
 const result = await createStockGroth16ProofBackend(engine).prove(witness, key, '20260930001');
 assert.equal(JSON.stringify(result).includes('private-unit-fixture'), false);
 assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
 await assert.rejects(createStockGroth16ProofBackend({ ...engine, verify: async () => false }).prove(witness, key, '20260930001'), /invalid proof/);
 await assert.rejects(createStockGroth16ProofBackend({ ...engine, prove: async () => ({ proof, publicSignals: ['1'] }) }).prove(witness, key, '20260930001'), /different native statement/);
});
test('stock artifact loading fails closed on modified bytes or a different verifier key', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'shielded-stock-pins-'));
 try {
  await mkdir(join(directory, 'stock-combined_js'));
  const data = { 'stock-combined.wasm': Buffer.from('wasm-unit-fixture'), 'stock-combined.zkey': Buffer.from('zkey-unit-fixture'), 'stock-combined.vkey.json': Buffer.from(JSON.stringify(key)) };
  const manifest: StockArtifactManifest = { version: 1, profile: stockProofDescriptor(key), setup: { phase1: 'unit-fixture', phase1Blake2b512: '00'.repeat(64), phase2: 'development-only' }, artifacts: Object.fromEntries(Object.entries(data).map(([name, bytes]) => [name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) };
  for (const [name, bytes] of Object.entries(data)) await writeFile(join(directory, name === 'stock-combined.wasm' ? 'stock-combined_js/stock-combined.wasm' : name), bytes);
  assert.equal((await loadStockProofArtifacts(directory, manifest)).descriptor.profileId, manifest.profile.profileId);
  await assert.rejects(loadStockProofArtifacts(directory, { ...manifest, profile: { ...manifest.profile, verifierId: '00'.repeat(32) } }), /does not match/);
  await writeFile(join(directory, 'stock-combined.zkey'), 'modified-artifact');
  await assert.rejects(loadStockProofArtifacts(directory, manifest), /integrity verification/);
 } finally { await rm(directory, { recursive: true, force: true }); }
});