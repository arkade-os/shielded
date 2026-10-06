import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Groth16Proof, ProtocolState } from './types.js';

export const STOCK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const STOCK_BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const STOCK_DOMAIN = 20260930001n;
export const STOCK_BINDING_BYTES = 201;
const TAG = Uint8Array.of(0x53, 0x48, 0x01, 0x00);

export type StockOperation = 'transfer' | 'deposit' | 'withdraw' | 'seal';
export interface StockNativeBinding {
  mode: StockOperation;
  checkpointTxidLE: string;
  checkpointVout: number;
  oldState: ProtocolState;
  newState: ProtocolState;
  poolInputBTC: bigint | string | number;
  continuationBTC: bigint | string | number;
  externalFundingBTC?: bigint | string | number;
  payoutOrChangeBTC?: bigint | string | number;
  externalProgram?: string;
  assetPacket?: Uint8Array;
}
export interface StockSettlementProof {
  version: 1;
  profile: 'shielded-stock-btc-v1';
  descriptorProfileId: string;
  operation: StockOperation;
  nativeBinding: string;
  statement: string;
  publicSignals: [string];
  proof: Groth16Proof;
}
export interface StockProofDescriptor {
  backendId: 'groth16-bn254';
  version: 1;
  curve: 'bn128';
  circuitId: 'shielded.stock-btc.v1';
  verifierId: string;
  profileId: string;
  publicSignalCount: 1;
  statementEncoding: 'sha256-le-248';
  domain: string;
}
export interface StockProofBackend {
  readonly id: 'groth16-bn254';
  readonly version: 1;
  describe(verifierKey: unknown, domain: string): StockProofDescriptor;
  prove(witness: Record<string, unknown>, verifierKey: unknown, domain: string): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  verify?(envelope: StockSettlementProof, verifierKey: unknown, domain: string): Promise<boolean>;
}

const fail = (message: string): never => { throw new Error(`Invalid stock native binding: ${message}`); };
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const digest = (value: unknown): string => bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
export function stockProofDescriptor(verifierKey: unknown, domain = STOCK_DOMAIN.toString()): StockProofDescriptor {
  if(domain!==STOCK_DOMAIN.toString())fail('stock circuit domain is immutable.');
  if (!verifierKey || typeof verifierKey !== 'object') fail('missing Groth16 verifier key.');
  const key=verifierKey as Record<string,unknown>;
  if(key.protocol!=='groth16'||key.curve!=='bn128'||key.nPublic!==1||!Array.isArray(key.IC)||key.IC.length!==2)fail('verifier key must be the pinned one-public-input Groth16 BN254 profile.');
  const g1=(point:unknown)=>Array.isArray(point)&&point.length===3&&point.every(value=>canonicalCoordinate(value))&&point[2]==='1';
  const g2=(point:unknown)=>Array.isArray(point)&&point.length===3&&point.every(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(value=>canonicalCoordinate(value)))&&JSON.stringify(point[2])===JSON.stringify(['1','0']);
  if(!g1(key.vk_alpha_1)||!(key.IC as unknown[]).every(g1)||!g2(key.vk_beta_2)||!g2(key.vk_gamma_2)||!g2(key.vk_delta_2))fail('verifier key has malformed Groth16 curve points.');
  const backendId = 'groth16-bn254' as const, version = 1 as const, curve = 'bn128' as const;
  const circuitId = 'shielded.stock-btc.v1' as const, publicSignalCount = 1 as const;
  const verifierId = digest(verifierKey);
  const statementEncoding = 'sha256-le-248' as const;
  const body = { backendId, version, curve, circuitId, verifierId, publicSignalCount, statementEncoding, domain };
  return { ...body, profileId: digest(body) };
}
function canonicalCoordinate(value:unknown):boolean{return typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)<STOCK_BASE_FIELD;}
export function stockProofDescriptorMatches(left: StockProofDescriptor, right: StockProofDescriptor): boolean {
  return !!left && !!right && canonical(left) === canonical(right);
}
function exactHex(value: string, bytes: number, label: string): Uint8Array {
  if (typeof value !== 'string' || !new RegExp(`^(?:[0-9a-f]{2}){${bytes}}$`).test(value)) fail(`${label} must be ${bytes} lowercase hex bytes.`);
  return hexToBytes(value);
}
function uint(value: bigint | string | number | undefined, label: string): bigint {
  if (value === undefined) return 0n;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) fail(`${label} must be an unsigned integer.`);
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be canonical decimal.`);
  let n: bigint;
  try { n = BigInt(value); } catch { return fail(`${label} must be an unsigned integer.`); }
  if (n < 0n || n >= 1n << 64n) fail(`${label} does not fit uint64.`);
  return n;
}
function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { out[i] = Number(value & 255n); value >>= 8n; }
  if (value !== 0n) fail('integer encoding overflow.');
  return out;
}
function fieldLE(value: string, label: string): Uint8Array {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a canonical field element.`);
  const n = BigInt(value);
  if (n >= STOCK_FIELD) fail(`${label} is outside the protocol field.`);
  return le(n, 32);
}

export function stockStateCommitment(hash: (values: bigint[]) => bigint, state: ProtocolState): bigint {
  if (!state || typeof state !== 'object' || !state.reserves) fail('missing protocol state.');
  const field = (value: string, label: string) => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a canonical field element.`);
    const n = BigInt(value);
    if (n >= STOCK_FIELD) fail(`${label} is outside the protocol field.`);
    return n;
  };
  const count = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 256) fail(`${label} is out of range.`);
    return BigInt(value);
  };
  const reserve = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is out of range.`);
    return BigInt(value);
  };
  const committed = hash([
    STOCK_DOMAIN,
    field(state.noteRoot, 'note root'), field(state.spentRoot, 'spent root'), field(state.historyRoot, 'history root'),
    count(state.noteCount, 'note count'), count(state.historyCount, 'history count'),
    (() => { if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision > 1023) fail('revision is out of range.'); return BigInt(state.revision); })(),
    reserve(state.reserves.BTC, 'BTC reserve'), reserve(state.reserves.DEMO, 'DEMO reserve'),
  ]);
  if (committed < 0n || committed >= STOCK_FIELD) fail('state hash is outside the protocol field.');
  return committed;
}

export function encodeStockNativeBinding(binding: StockNativeBinding, hash: (values: bigint[]) => bigint): Uint8Array {
  const modes: Record<StockOperation, number> = { transfer: 0, deposit: 1, withdraw: 2, seal: 3 };
  if (!binding || !Object.hasOwn(modes, binding.mode)) fail('unknown operation.');
  if (!Number.isInteger(binding.checkpointVout) || binding.checkpointVout < 0 || binding.checkpointVout > 0xffffffff) fail('checkpoint vout must fit uint32.');
  if (binding.assetPacket?.length) fail('the first BTC profile cannot include an asset packet.');
  const target = binding.externalProgram ? exactHex(binding.externalProgram, 32, 'external program') : new Uint8Array(32);
  const txid = exactHex(binding.checkpointTxidLE, 32, 'checkpoint txid');
  const parts = [
    TAG, Uint8Array.of(modes[binding.mode]), txid, le(BigInt(binding.checkpointVout), 4),
    fieldLE(String(stockStateCommitment(hash, binding.oldState)), 'old state commitment'),
    fieldLE(String(stockStateCommitment(hash, binding.newState)), 'new state commitment'),
    le(uint(binding.poolInputBTC, 'pool input'), 8), le(uint(binding.continuationBTC, 'continuation'), 8),
    le(uint(binding.externalFundingBTC, 'external funding'), 8), le(uint(binding.payoutOrChangeBTC, 'payout or change'), 8),
    target, sha256(binding.assetPacket ?? new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  if (bytes.length !== STOCK_BINDING_BYTES) fail('internal binding size mismatch.');
  return bytes;
}

export function stockStatementScalar(bindingBytes: Uint8Array): bigint {
  if (!(bindingBytes instanceof Uint8Array) || bindingBytes.length !== STOCK_BINDING_BYTES) fail('binding must be exactly 201 bytes.');
  const digest = sha256(bindingBytes);
  let n = 0n;
  for (let i = 30; i >= 0; i--) n = (n << 8n) | BigInt(digest[i]);
  return n;
}

export function stockBindingHex(bindingBytes: Uint8Array): string { return bytesToHex(bindingBytes); }
