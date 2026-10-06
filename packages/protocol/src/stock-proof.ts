import { hexToBytes } from '@noble/hashes/utils.js';
import { STOCK_BINDING_BYTES, STOCK_DOMAIN, STOCK_FIELD, stockProofDescriptor, stockStatementScalar, type StockProofBackend, type StockSettlementProof } from './stock-native.js';
import type { Groth16Proof } from './types.js';

const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const MODES = ['transfer', 'deposit', 'withdraw', 'seal'] as const;
export interface StockGroth16Engine {
 prove(witness: Record<string, unknown>): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
 verify(verifierKey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
}
export interface VerifyingStockProofBackend extends StockProofBackend {
 verify(envelope: StockSettlementProof, verifierKey: unknown, domain?: string): Promise<boolean>;
}
function coordinate(value: unknown): boolean {
 return typeof value === 'string' && value.length <= 77 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < BASE_FIELD;
}
export function validateStockGroth16Proof(proof: Groth16Proof): void {
 const g1 = (point: unknown) => Array.isArray(point) && point.length === 3 && point.every(coordinate) && point[2] === '1';
 const g2 = (point: unknown) => Array.isArray(point) && point.length === 3 && point.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(coordinate)) && point[2][0] === '1' && point[2][1] === '0';
 if (!proof || proof.protocol !== 'groth16' || proof.curve !== 'bn128' || !g1(proof.pi_a) || !g2(proof.pi_b) || !g1(proof.pi_c)) throw new Error('Malformed stock Groth16 proof.');
}
function signal(value: unknown): value is string {
 return typeof value === 'string' && value.length <= 77 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < STOCK_FIELD;
}
function nativeBytes(native: unknown): Uint8Array {
 if (!Array.isArray(native) || native.length !== STOCK_BINDING_BYTES || native.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('Stock witness has an invalid native binding.');
 return Uint8Array.from(native);
}
export function validateStockProofEnvelope(envelope: StockSettlementProof, verifierKey: unknown, domain = STOCK_DOMAIN.toString()): void {
 const descriptor = stockProofDescriptor(verifierKey, domain);
 if (!envelope || envelope.version !== 1 || envelope.profile !== 'shielded-stock-btc-v1' || envelope.descriptorProfileId !== descriptor.profileId) throw new Error('Stock proof belongs to a different verifier profile.');
 if (typeof envelope.nativeBinding !== 'string' || !/^[0-9a-f]{402}$/.test(envelope.nativeBinding)) throw new Error('Malformed stock native binding.');
 const bytes = hexToBytes(envelope.nativeBinding);
 if (bytes[0] !== 83 || bytes[1] !== 72 || bytes[2] !== 1 || bytes[3] !== 0 || MODES[bytes[4]] !== envelope.operation) throw new Error('Stock proof operation does not match its native binding.');
 if (!signal(envelope.statement) || !Array.isArray(envelope.publicSignals) || envelope.publicSignals.length !== 1 || envelope.publicSignals[0] !== envelope.statement || stockStatementScalar(bytes).toString() !== envelope.statement) throw new Error('Stock proof public statement does not match its native binding.');
 validateStockGroth16Proof(envelope.proof);
}
export function createStockGroth16ProofBackend(engine: StockGroth16Engine): VerifyingStockProofBackend {
 return {
  id: 'groth16-bn254', version: 1, describe: stockProofDescriptor,
  async prove(witness, verifierKey, domain) {
   stockProofDescriptor(verifierKey, domain);
   const expected = stockStatementScalar(nativeBytes(witness.native)).toString();
   const result = await engine.prove(witness);
   validateStockGroth16Proof(result.proof);
   if (!Array.isArray(result.publicSignals) || result.publicSignals.length !== 1 || result.publicSignals[0] !== expected) throw new Error('Stock prover returned a different native statement.');
   const proof: Groth16Proof = { protocol: 'groth16', curve: 'bn128', pi_a: [...result.proof.pi_a], pi_b: result.proof.pi_b.map(pair => [...pair]), pi_c: [...result.proof.pi_c] };
   if (!await engine.verify(verifierKey, [expected], proof)) throw new Error('Stock prover returned an invalid proof for the pinned verifier.');
   return { proof, publicSignals: [expected] };
  },
  async verify(envelope, verifierKey, domain = STOCK_DOMAIN.toString()) {
   try {
    validateStockProofEnvelope(envelope, verifierKey, domain);
    return await engine.verify(verifierKey, [envelope.statement], envelope.proof);
   } catch { return false; }
  },
 };
}