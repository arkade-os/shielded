import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';
import { ROLLUP_DOMAIN } from './constants.ts';
import { ownerOf, sha256le248, type Hash } from './notes.ts';

export interface RollupNote { amount: bigint; asset: bigint; rho: bigint }
export interface RollupRecipient { owner: bigint; viewPublic: Uint8Array }

const ADDRESS_PREFIX = 'shrol';
export const le = (value: bigint, size: number) => Uint8Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
export const fromLe = (bytes: Uint8Array) => bytes.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

export const rollupRecipientOf = (hash: Hash, ask: bigint, nk: bigint, viewSecret: Uint8Array): RollupRecipient =>
 ({ owner: ownerOf(hash, ROLLUP_DOMAIN, ask, nk), viewPublic: x25519.getPublicKey(viewSecret) });
export const rollupAddressOf = (r: RollupRecipient) => bech32m.encode(ADDRESS_PREFIX, bech32m.toWords(Uint8Array.from([...le(r.owner, 32), ...r.viewPublic])), false);
export function parseRollupAddress(address: string): RollupRecipient {
 const { prefix, words } = bech32m.decode(address as `${string}1${string}`, false);
 const bytes = bech32m.fromWords(words);
 if (prefix !== ADDRESS_PREFIX || bytes.length !== 64) throw new Error('Not a shielded rollup address.');
 return { owner: fromLe(bytes.subarray(0, 32)), viewPublic: bytes.subarray(32) };
}

// A spend's record: ephemeral X25519 key, then per output a view tag and AES-GCM(amount 8 || asset 32 || rho 32) with its tag.
const SEALED = 1 + 72 + 16;
export const ROLLUP_RECORD_BYTES = 32 + 2 * SEALED;
export const ctDigestOf = (record: Uint8Array) => sha256le248(record);

// Each (ephemeral key, recipient, output) gets its own key, so a fixed IV never repeats under one key.
async function noteKey(shared: Uint8Array, index: number) {
 const okm = hkdf(sha256, shared, undefined, new TextEncoder().encode(`shielded-rollup-note:${index}`), 33);
 return { tag: okm[0]!, key: await crypto.subtle.importKey('raw', okm.slice(1), 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
const IV = new Uint8Array(12);

export async function sealRollupNotes(to: readonly [RollupRecipient, RollupRecipient], notes: readonly [RollupNote, RollupNote], ephemeral: Uint8Array = x25519.utils.randomSecretKey()): Promise<Uint8Array> {
 const record = new Uint8Array(ROLLUP_RECORD_BYTES);
 record.set(x25519.getPublicKey(ephemeral), 0);
 for (const i of [0, 1] as const) {
  const { tag, key } = await noteKey(x25519.getSharedSecret(ephemeral, to[i].viewPublic), i), n = notes[i];
  const plain = Uint8Array.from([...le(n.amount, 8), ...le(n.asset, 32), ...le(n.rho, 32)]);
  record[32 + i * SEALED] = tag;
  record.set(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, plain)), 33 + i * SEALED);
 }
 return record;
}

export type Ecdh = (ephemeralPublic: Uint8Array) => Promise<Uint8Array>;
/** X25519 under this view secret: WebCrypto where the engine has it, many times faster for a full scan, else the pure-JS curve. */
export async function viewEcdh(viewSecret: Uint8Array): Promise<Ecdh> {
 const slow: Ecdh = async pub => x25519.getSharedSecret(viewSecret, pub);
 try {
  // RFC 8410 PKCS#8 wrapping of a raw X25519 private key.
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20, ...viewSecret]), { name: 'X25519' }, false, ['deriveBits']);
  const fast: Ecdh = async pub => new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: await crypto.subtle.importKey('raw', pub.slice(), { name: 'X25519' }, false, []) } as unknown as AlgorithmIdentifier, key, 256));
  const probe = x25519.getPublicKey(x25519.utils.randomSecretKey()), [a, b] = await Promise.all([fast(probe), slow(probe)]);
  return a.length === b.length && a.every((byte, i) => byte === b[i]) ? fast : slow;
 } catch { return slow; }
}

/** The outputs this view key opens; the caller still checks each against its commitment. */
export async function openRollupNotes(record: Uint8Array, viewSecret: Uint8Array, ecdh?: Ecdh): Promise<(RollupNote | undefined)[]> {
 if (record.length !== ROLLUP_RECORD_BYTES) return [undefined, undefined];
 let shared: Uint8Array;
 try { shared = ecdh ? await ecdh(record.subarray(0, 32)) : x25519.getSharedSecret(viewSecret, record.subarray(0, 32)); } catch { return [undefined, undefined]; }
 return Promise.all([0, 1].map(async i => {
  const { tag, key } = await noteKey(shared, i);
  if (record[32 + i * SEALED] !== tag) return undefined;
  try {
   const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: IV }, key, record.slice(33 + i * SEALED, 32 + (i + 1) * SEALED)));
   return { amount: fromLe(plain.subarray(0, 8)), asset: fromLe(plain.subarray(8, 40)), rho: fromLe(plain.subarray(40, 72)) };
  } catch { return undefined; }
 }));
}
