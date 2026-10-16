import { hex } from '@scure/base';
import { BATCH_SLOTS, type BatchKind } from './constants.ts';
import { fromLe, le, recordHints, ROLLUP_RECORD_BYTES } from './wallet.ts';

/** One batch as a restore scans it: enough to tell whether it holds this wallet's notes or spends, and to grow the note frontier. */
export interface ScanBatch { batch: number; txid?: string; at?: number; kind: BatchKind; root: bigint; slots: { ephemeral?: Uint8Array; tags: [number, number]; nullifiers: number[] }[] }
export interface ScannedRecord { kind: BatchKind; txid?: string; at?: number; slots: { nullifiers: string[]; ciphertext?: string }[] }

/** The low 32 bits of a nullifier: a match only means the batch is fetched whole and checked there. */
export const nullifierHint = (nullifier: bigint) => Number(nullifier & 0xffffffffn);
const spends = (kind: BatchKind) => kind === 'join' ? 2 : 1;
const entryBytes = (kind: BatchKind) => 73 + BATCH_SLOTS * (34 + 4 * spends(kind));

/** Per batch: txid, time (f64 ms), kind, block root; per slot: ephemeral key (zero for none), two view tags, nullifier hints. */
export function encodeScan(entries: readonly { record: ScannedRecord; root: bigint }[]): Uint8Array {
 const out = new Uint8Array(entries.reduce((n, e) => n + entryBytes(e.record.kind), 0)), view = new DataView(out.buffer);
 let at = 0;
 for (const { record, root } of entries) {
  if (record.slots.length !== BATCH_SLOTS || record.slots.some(s => s.nullifiers.length !== spends(record.kind))) throw new Error('A batch record has the wrong shape for a scan.');
  if (record.txid) out.set(hex.decode(record.txid), at);
  view.setFloat64(at + 32, record.at ?? 0, true);
  out[at + 40] = record.kind === 'join' ? 1 : 0;
  out.set(le(root, 32), at + 41);
  at += 73;
  for (const slot of record.slots) {
   const bytes = slot.ciphertext ? hex.decode(slot.ciphertext) : undefined;
   if (bytes?.length === ROLLUP_RECORD_BYTES) { const { ephemeral, tags } = recordHints(bytes); out.set(ephemeral, at); out.set(tags, at + 32); }
   at += 34;
   for (const nf of slot.nullifiers) { view.setUint32(at, nullifierHint(BigInt(nf)), true); at += 4; }
  }
 }
 return out;
}

export function decodeScan(bytes: Uint8Array, from: number): ScanBatch[] {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out: ScanBatch[] = [];
 for (let at = 0, batch = from; at < bytes.length; batch++) {
  if (at + 73 > bytes.length || bytes[at + 40]! > 1) throw new Error('Malformed scan page.');
  const kind: BatchKind = bytes[at + 40] === 1 ? 'join' : 'spend', end = at + entryBytes(kind);
  if (end > bytes.length) throw new Error('Malformed scan page.');
  const txid = bytes.subarray(at, at + 32), time = view.getFloat64(at + 32, true), root = fromLe(bytes.subarray(at + 41, at + 73)), slots: ScanBatch['slots'] = [];
  for (let p = at + 73; p < end; p += 34 + 4 * spends(kind)) {
   const ephemeral = bytes.slice(p, p + 32), tags: [number, number] = [bytes[p + 32]!, bytes[p + 33]!];
   slots.push({ ...(ephemeral.some(b => b) ? { ephemeral } : {}), tags, nullifiers: Array.from({ length: spends(kind) }, (_, k) => view.getUint32(p + 34 + 4 * k, true)) });
  }
  out.push({ batch, ...(txid.some(b => b) ? { txid: hex.encode(txid) } : {}), ...(time ? { at: time } : {}), kind, root, slots });
  at = end;
 }
 return out;
}
