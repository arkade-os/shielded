import { base64urlnopad, bech32m, hex } from '@scure/base';
import { ROLLUP_DOMAIN } from './constants.ts';
import { noteOf, outputRhoOf, ownerOf, type Hash } from './notes.ts';
import { fromLe, le, openRollupNotes, parseRollupAddress, viewEcdh } from './wallet.ts';
import type { BuiltSpend, PublishedBatch } from './account.ts';

export interface DisclosedNote { index: number; amount: bigint; asset: bigint; rho: bigint }
/** Notes paid to one shielded address, opened so anyone can check them against the published batches. */
export interface Disclosure { v: 1; to: string; notes: DisclosedNote[] }

export const encodeDisclosure = (d: Disclosure) =>
 base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 1, to: d.to, notes: d.notes.map(n => [n.index, String(n.amount), String(n.asset), String(n.rho)]) })));
export function decodeDisclosure(text: string): Disclosure {
 const bad = () => new Error('Not a shielded payment disclosure.');
 let raw: { v?: unknown; to?: unknown; notes?: unknown };
 try { raw = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(text.trim()))); } catch { throw bad(); }
 if (raw.v !== 1 || typeof raw.to !== 'string' || !Array.isArray(raw.notes) || raw.notes.length < 1 || raw.notes.length > 3) throw bad();
 parseRollupAddress(raw.to);
 return { v: 1, to: raw.to, notes: raw.notes.map(note => {
  if (!Array.isArray(note) || note.length !== 4 || !Number.isSafeInteger(note[0]) || note[0] < 0 || note.slice(1).some(v => typeof v !== 'string' || !/^\d{1,80}$/.test(v))) throw bad();
  return { index: note[0], amount: BigInt(note[1]), asset: BigInt(note[2]), rho: BigInt(note[3]) };
 }) };
}
/** Whether each disclosed note is exactly the commitment published at its position. */
export async function verifyDisclosure(hash: Hash, d: Disclosure, commitmentAt: (index: number) => string | undefined | Promise<string | undefined>): Promise<boolean[]> {
 const { owner } = parseRollupAddress(d.to);
 return Promise.all(d.notes.map(async n => (await commitmentAt(n.index)) === String(noteOf(hash, ROLLUP_DOMAIN, n.amount, n.asset, owner, n.rho))));
}
/** The note a payment sent to its recipient (output 0), rebuilt from the spend's witness. */
export function sentNoteOf(hash: Hash, spend: BuiltSpend) {
 const input = spend.witness.input as { outAmount: bigint[]; outRandom: bigint[]; asset: bigint };
 return { amount: input.outAmount[0]!, asset: input.asset, rho: outputRhoOf(hash, ROLLUP_DOMAIN, input.outRandom[0]!, spend.witness.slot.nullifiers, 0) };
}

const VIEW_PREFIX = 'shview2', FULL_VIEW_PREFIX = 'shfvk2';
function decodeKey(key: string, prefix: string, size: number, what: string): Uint8Array {
 let decoded: { prefix: string; words: number[] };
 try { decoded = bech32m.decode(key.trim() as `${string}1${string}`, false); } catch { throw new Error(`Not a shielded ${what}.`); }
 const bytes = bech32m.fromWords(decoded.words);
 if (decoded.prefix === prefix.slice(0, -1)) throw new Error(`That is a genesis-1 ${what}; this pool takes ${prefix} keys.`);
 if (decoded.prefix !== prefix || bytes.length !== size) throw new Error(`Not a shielded ${what}.`);
 return bytes;
}
/** Sees every note sent to the owner. Telling which are spent needs the full viewing key; spending needs the spend key. */
export const viewKeyOf = (owner: bigint, viewSecret: Uint8Array) => bech32m.encode(VIEW_PREFIX, bech32m.toWords(Uint8Array.from([...le(owner, 32), ...viewSecret])), false);
export function parseViewKey(key: string): { owner: bigint; viewSecret: Uint8Array } {
 const bytes = decodeKey(key, VIEW_PREFIX, 64, 'view key');
 return { owner: fromLe(bytes.subarray(0, 32)), viewSecret: bytes.slice(32) };
}
/** Adds nk, so the holder also sees spends; it carries ak, not the owner, so a forged nk derives another address. */
export const fullViewKeyOf = (ak: bigint, nk: bigint, viewSecret: Uint8Array) =>
 bech32m.encode(FULL_VIEW_PREFIX, bech32m.toWords(Uint8Array.from([...le(ak, 32), ...le(nk, 32), ...viewSecret])), false);
export function parseFullViewKey(hash: Hash, key: string): { owner: bigint; ak: bigint; nk: bigint; viewSecret: Uint8Array } {
 const bytes = decodeKey(key, FULL_VIEW_PREFIX, 96, 'full viewing key'), ak = fromLe(bytes.subarray(0, 32)), nk = fromLe(bytes.subarray(32, 64));
 return { owner: ownerOf(hash, ROLLUP_DOMAIN, ak, nk), ak, nk, viewSecret: bytes.slice(64) };
}
export interface IncomingNote { batch: number; txid?: string; at?: number; index: number; amount: bigint; asset: bigint; deposit: boolean }
/** Every note a view key opens under its owner, in order: deposits, payments and change alike. Each batch appends 32 leaves. */
export async function incomingNotes(hash: Hash, batches: readonly PublishedBatch[], key: { owner: bigint; viewSecret: Uint8Array }, first = 0): Promise<IncomingNote[]> {
 const found: IncomingNote[] = [], ecdh = await viewEcdh(key.viewSecret);
 for (const [b, batch] of batches.entries()) for (const [i, slot] of batch.slots.entries()) {
  if (!slot.ciphertext) continue;
  const opened = await openRollupNotes(hex.decode(slot.ciphertext), key.viewSecret, ecdh);
  opened.forEach((note, j) => {
   if (!note || note.amount === 0n || String(noteOf(hash, ROLLUP_DOMAIN, note.amount, note.asset, key.owner, note.rho)) !== slot.commitments[j]) return;
   found.push({ batch: first + b, ...(batch.txid ? { txid: batch.txid } : {}), ...(batch.at !== undefined ? { at: batch.at } : {}), index: (first + b) * 32 + 2 * i + j, amount: note.amount, asset: note.asset, deposit: (slot.publics?.[1] ?? '0') !== '0' });
  });
 }
 return found;
}
