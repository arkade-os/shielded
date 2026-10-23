import { hex } from '@scure/base';
import { EPOCH_NULLIFIERS, EPOCH_SLOTS, type EpochBatchKind } from './constants.ts';
import { nullifierHint } from './scan.ts';
import { fromLe, le, recordHints, ROLLUP_RECORD_BYTES } from './wallet.ts';

/** One batch as an epoch restore scans it: the classic fields, plus where the batch sits in its epoch and whether it opened one. */
export interface EpochScanBatch { batch: number; epoch: number; blockInEpoch: number; txid?: string; at?: number; kind: EpochBatchKind; rotated: boolean; root: bigint; slots: { ephemeral?: Uint8Array; tags: [number, number]; nullifiers: number[] }[] }
export interface EpochScannedRecord { kind: EpochBatchKind; txid?: string; at?: number; slots: { nullifiers: string[]; ciphertext?: string }[] }

export const EPOCH_SCAN_FLAG_ROTATED = 4;
const KINDS = ['spend', 'join', 'recover'] as const;
const MALFORMED = 'Malformed epoch scan page.';
const entryBytes = (kind: EpochBatchKind) => 73 + EPOCH_SLOTS[kind] * (34 + 4 * EPOCH_NULLIFIERS[kind]);

/** Whether the global, 0-based batch opens a new epoch, as EpochState.rotatesNext decides it before applying that batch. */
export const rotatesAt = (batch: number, epochLen: number) => batch > 0 && batch % epochLen === 0;

/** The classic entry, with its kind byte widened to flags: bits 0-1 the kind, bit 2 rotated, the rest zero; a slot is 34 bytes plus a hint per nullifier. */
export function encodeEpochScan(entries: readonly { record: EpochScannedRecord; root: bigint; rotated: boolean }[]): Uint8Array {
 const out = new Uint8Array(entries.reduce((n, e) => n + entryBytes(e.record.kind), 0)), view = new DataView(out.buffer);
 let at = 0;
 for (const { record, root, rotated } of entries) {
  const { kind } = record;
  if (record.slots.length !== EPOCH_SLOTS[kind] || record.slots.some(s => s.nullifiers.length !== EPOCH_NULLIFIERS[kind])) throw new Error('A batch record has the wrong shape for a scan.');
  if (record.txid) out.set(hex.decode(record.txid), at);
  view.setFloat64(at + 32, record.at ?? 0, true);
  out[at + 40] = KINDS.indexOf(kind) | (rotated ? EPOCH_SCAN_FLAG_ROTATED : 0);
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

export function decodeEpochScan(bytes: Uint8Array, from: number, epochLen: number): EpochScanBatch[] {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out: EpochScanBatch[] = [];
 for (let at = 0, batch = from; at < bytes.length; batch++) {
  const flags = bytes[at + 40]!, kind = KINDS[flags & 3], rotated = (flags & EPOCH_SCAN_FLAG_ROTATED) !== 0;
  if (at + 73 > bytes.length || !kind || flags & 0xf8 || rotated !== rotatesAt(batch, epochLen)) throw new Error(MALFORMED);
  const end = at + entryBytes(kind), m = EPOCH_NULLIFIERS[kind];
  if (end > bytes.length) throw new Error(MALFORMED);
  const txid = bytes.subarray(at, at + 32), time = view.getFloat64(at + 32, true), root = fromLe(bytes.subarray(at + 41, at + 73)), slots: EpochScanBatch['slots'] = [];
  for (let p = at + 73; p < end; p += 34 + 4 * m) {
   const ephemeral = bytes.slice(p, p + 32), tags: [number, number] = [bytes[p + 32]!, bytes[p + 33]!];
   slots.push({ ...(ephemeral.some(b => b) ? { ephemeral } : {}), tags, nullifiers: Array.from({ length: m }, (_, k) => view.getUint32(p + 34 + 4 * k, true)) });
  }
  const epoch = Math.floor(batch / epochLen);
  out.push({ batch, epoch, blockInEpoch: batch - epoch * epochLen, ...(txid.some(b => b) ? { txid: hex.encode(txid) } : {}), ...(time ? { at: time } : {}), kind, rotated, root, slots });
  at = end;
 }
 return out;
}
