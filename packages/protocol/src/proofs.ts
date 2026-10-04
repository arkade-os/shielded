import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Groth16Proof } from './types.js';

export type ProofCircuit = 'intent' | 'transition';
export interface ProofBackendDescriptor {
  backendId: string;
  version: number;
  curve: string;
  circuitId: string;
  verifierId: string;
  profileId: string;
  publicSignalCount: number;
  domain: string;
}
export interface ProofStatement {
  version: 1;
  descriptor: ProofBackendDescriptor;
  publicSignals: string[];
  statementId: string;
}
export interface ProofOutput<Proof> { proof: Proof; publicSignals: string[]; statement: ProofStatement }
export interface ProofBackend<Proof> {
  readonly id: string;
  readonly version: number;
  describe(circuit: ProofCircuit, verifierKey: unknown, domain: string): ProofBackendDescriptor;
  statement(circuit: ProofCircuit, publicSignals: string[], verifierKey: unknown, domain: string): ProofStatement;
  prove(circuit: ProofCircuit, witness: Record<string, unknown>, verifierKey: unknown, domain: string): Promise<ProofOutput<Proof>>;
  verify(statement: ProofStatement, proof: Proof, verifierKey: unknown, domain: string): Promise<boolean>;
}
export interface Groth16Engine {
  prove(circuit: ProofCircuit, witness: Record<string, unknown>): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  verify(verifierKey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
}

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const RELATIONS: Record<ProofCircuit, { id: string; signals: number }> = {
  intent: { id: 'shielded.intent.v1', signals: 25 },
  transition: { id: 'shielded.transition.v1', signals: 30 },
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const digest = (value: unknown): string => bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
const validateSignals = (signals: string[], count: number): void => {
  if (!Array.isArray(signals) || signals.length !== count || signals.some(value => typeof value !== 'string' || value.length > FIELD.toString().length || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= FIELD)) {
    throw new Error('Proof public signals do not match the canonical circuit statement.');
  }
};
const validateProof = (proof: Groth16Proof): void => {
  if (!proof || proof.protocol !== 'groth16' || proof.curve !== 'bn128' || !Array.isArray(proof.pi_a) || !Array.isArray(proof.pi_b) || !Array.isArray(proof.pi_c)) {
    throw new Error('Proof backend returned an unsupported Groth16 encoding.');
  }
};

export function groth16Descriptor(circuit: ProofCircuit, verifierKey: unknown, domain: string): ProofBackendDescriptor {
  const relation = RELATIONS[circuit];
  if (!relation || typeof domain !== 'string' || !domain) throw new Error('Unknown proof relation or domain.');
  const verifierId = digest(verifierKey);
  const backendId = 'groth16-bn254';
  const version = 1;
  const profileId = digest({ backendId, version, curve: 'bn128', circuitId: relation.id, verifierId, publicSignalCount: relation.signals, domain });
  return { backendId, version, curve: 'bn128', circuitId: relation.id, verifierId, profileId, publicSignalCount: relation.signals, domain };
}

export function proofStatement(descriptor: ProofBackendDescriptor, publicSignals: string[]): ProofStatement {
  validateSignals(publicSignals, descriptor.publicSignalCount);
  const body = { version: 1 as const, descriptor, publicSignals: [...publicSignals] };
  return { ...body, statementId: digest(body) };
}

export function proofDescriptorMatches(left: ProofBackendDescriptor, right: ProofBackendDescriptor): boolean {
  return !!left && !!right && canonical(left) === canonical(right);
}

export function createGroth16ProofBackend(engine: Groth16Engine): ProofBackend<Groth16Proof> {
  const descriptor = groth16Descriptor;
  const statementFor = proofStatement;
  return {
    id: 'groth16-bn254',
    version: 1,
    describe: descriptor,
    statement(circuit, publicSignals, verifierKey, domain) {
      return statementFor(descriptor(circuit, verifierKey, domain), publicSignals);
    },
    async prove(circuit, witness, verifierKey, domain) {
      const output = await engine.prove(circuit, witness);
      validateProof(output.proof);
      const d = descriptor(circuit, verifierKey, domain);
      return { proof: output.proof, publicSignals: output.publicSignals, statement: statementFor(d, output.publicSignals) };
    },
    async verify(statement, proof, verifierKey, domain) {
      if (!statement || statement.version !== 1 || !statement.descriptor) return false;
      const circuit = (Object.entries(RELATIONS).find(([, relation]) => relation.id === statement.descriptor.circuitId)?.[0]) as ProofCircuit | undefined;
      if (!circuit) return false;
      const expected = descriptor(circuit, verifierKey, domain);
      if (canonical(statement.descriptor) !== canonical(expected)) return false;
      try {
        const exact = statementFor(expected, statement.publicSignals);
        if (exact.statementId !== statement.statementId) return false;
        validateProof(proof);
        return await engine.verify(verifierKey, exact.publicSignals, proof);
      } catch {
        return false;
      }
    },
  };
}

export function proofStatementMatches(left: ProofStatement, right: ProofStatement): boolean {
  return !!left && !!right && left.version === 1 && right.version === 1 && canonical(left) === canonical(right);
}
