import { base64, hex } from '@scure/base';
import type { RollupEpochRecord, RollupEpochSpend } from '../../src/rollup/epoch-operator.ts';
import type { EpochSpendBody } from '../../src/shielded/epoch-pool.ts';
import type { PoolApi } from '../../src/shielded/pool.ts';
import type { ClientInput } from '../../packages/protocol/src/rollup/client.ts';
import { CHECKPOINT_EVERY, EPOCH_SLOTS, ROLLUP_DOMAIN, type EpochBatchKind } from '../../packages/protocol/src/rollup/constants.ts';
import { EpochState, type EpochSlot } from '../../packages/protocol/src/rollup/epoch.ts';
import type { EpochOwnedNote } from '../../packages/protocol/src/rollup/epoch-account.ts';
import { epochTransfer, type EpochBuiltSpend } from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import { encodeEpochScan } from '../../packages/protocol/src/rollup/epoch-scan.ts';
import { checkpointOf } from '../../packages/protocol/src/rollup/frontier.ts';
import { noteOf, type Hash } from '../../packages/protocol/src/rollup/notes.ts';
import type { RollupRecipient } from '../../packages/protocol/src/rollup/wallet.ts';
import { epochHarness, foldPath } from './epoch.ts';

export interface PoolSpend { slot: EpochSlot; publics: readonly bigint[]; ciphertext?: Uint8Array }
type Transfer = Omit<Parameters<typeof epochTransfer>[1], 'rPrev' | 'rCur' | 'sel'>;
export const posted = (built: EpochBuiltSpend): PoolSpend => ({ slot: built.slot, publics: built.witness.publicSignals, ciphertext: built.ciphertext });
/** What 4b's epoch POST /spends decoder hands the operator: the body names a recovery's origin on its slot alone, and the spend carries it twice, as kindOf requires. */
export const fromBody = (body: EpochSpendBody): Omit<RollupEpochSpend, 'receivedAt'> => {
 const s = body.slot as unknown as Record<string, any>;
 if ('root' in s || (s.rCur === undefined) === (s.origin === undefined) || (s.origin !== undefined && !(Number.isSafeInteger(s.origin) && s.origin >= 0))) throw Object.assign(new Error('Malformed epoch slot.'), { status: 400 });
 const slot: EpochSlot = { anchor: BigInt(s.anchor), ...(s.origin !== undefined ? { origin: s.origin as number } : { rCur: { epoch: s.rCur.epoch as number, root: BigInt(s.rCur.root) } }),
  nullifiers: s.nullifiers.map(BigInt), commitments: [BigInt(s.commitments[0]), BigInt(s.commitments[1])], ctDigest: BigInt(s.ctDigest), groupId: BigInt(s.groupId), groupSize: s.groupSize };
 return { id: body.id, slot, ...(slot.origin !== undefined ? { origin: slot.origin } : {}), publics: body.publics.map(BigInt) as unknown as RollupEpochSpend['publics'], proof: body.proof as RollupEpochSpend['proof'], ciphertext: hex.decode(body.ciphertext) };
};
/** The client circuit's membership line, which CI's stub proofs never check: each input's path folds to R_cur + sel*(R_prev - R_cur). */
export const opens = (hash: Hash, owner: bigint, built: EpochBuiltSpend, notes: EpochOwnedNote[]) => {
 const { path, sel, rPrev, rCur } = built.witness.input as { path: bigint[] | bigint[][]; sel: bigint | bigint[]; rPrev: bigint; rCur: bigint };
 return notes.every((note, k) => foldPath(hash, noteOf(hash, ROLLUP_DOMAIN, note.amount, note.asset, owner, note.rho), note.index, (notes.length === 1 ? path : path[k]) as bigint[]) === ([sel].flat()[k] ? rPrev : rCur));
};

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const recordOf = (kind: EpochBatchKind, spends: readonly PoolSpend[], noteBlockRoot: bigint): RollupEpochRecord => ({
 kind, noteBlockRoot: String(noteBlockRoot),
 slots: spends.map(({ slot, publics, ciphertext }) => ({
  anchor: String(slot.anchor), ...(slot.rCur ? { rCur: { epoch: slot.rCur.epoch, root: String(slot.rCur.root) } } : {}), ...(slot.origin !== undefined ? { origin: slot.origin } : {}),
  nullifiers: slot.nullifiers.map(String), commitments: [String(slot.commitments[0]), String(slot.commitments[1])], ctDigest: String(slot.ctDigest),
  groupId: String(slot.groupId), groupSize: slot.groupSize, publics: publics.map(String), ...(ciphertext ? { ciphertext: hex.encode(ciphertext) } : {}),
 })),
});

/** An in-process epoch pool: an EpochState behind the wire shapes Plan 4b serves, with no service in between; without `leaves` it keeps only what roots and checkpoints read. */
export function epochPool(hash: Hash, epochLen: number, leaves = true) {
 const state = EpochState.genesis(hash, epochLen, leaves), harness = epochHarness(hash);
 const records: RollupEpochRecord[] = [], rotations: boolean[] = [];

 const pad = (kind: EpochBatchKind = 'spend'): PoolSpend => {
  const { slot, publicSignals } = harness.deposit(state, 0n, kind === 'join' ? { inputs: [harness.dummyInput(), harness.dummyInput()] } : {});
  return { slot, publics: publicSignals };
 };
 const transfer = async (o: Transfer): Promise<PoolSpend> => {
  // No proof is checked here, so every note input may claim the current tree.
  const sel = (o.request.inputs ?? (o.request.input ? [o.request.input] : [])).map(() => 0n as const);
  return posted(await epochTransfer(hash, { ...o, rPrev: state.nextAnchorRoot(), rCur: { epoch: state.epoch, root: state.latestRoot() }, sel }));
 };
 const deposit = (to: RollupRecipient, amount: bigint) => transfer({ ask: 0n, nk: 0n, self: to, request: { deposit: amount } });
 const recover = (origin: number, note: ClientInput): PoolSpend => {
  // 4b's /spends parser refuses a recovery that names both origin and rCur, which the harness leaves on the slot.
  const { slot: { rCur, ...slot }, publicSignals } = harness.recovery(state, origin, note);
  return { slot, publics: publicSignals };
 };

 /** Pads `spends` to the kind's width, applies the batch, and publishes its record; `chainOnly` publishes it the way a followed batch is. */
 const land = (kind: EpochBatchKind = 'spend', spends: PoolSpend[] = [], chainOnly = false): RollupEpochRecord => {
  const slots = [...spends, ...Array.from({ length: EPOCH_SLOTS[kind] - spends.length }, () => pad(kind))], n = state.batchCount;
  const result = state.apply(kind, slots.map(s => s.slot));
  const full = { ...recordOf(kind, slots, result.blockRoot), txid: (n + 1).toString(16).padStart(64, '0'), at: 1_700_000_000_000 + 1000 * n };
  rotations.push(result.rotated);
  records.push(chainOnly ? { ...full, slots: full.slots.map(s => ({ anchor: '0', nullifiers: s.nullifiers, commitments: ['0', '0'], ctDigest: '0', groupId: '0', groupSize: 0, publics: s.publics })) } : full);
  return records.at(-1)!;
 };

 // service.ts's key order; every batch is accepted the moment it lands, so live state is the accepted snapshot epochFieldsOf reads.
 const status = () => ({
  version: 1, phase: 'ready', message: 'The rollup pool is open.', minimumFundingSats: 2000,
  pool: {
   token: 'epoch-pool', operator: '', address: '', script: '', batches: records.length, root: String(state.latestRoot()), head: { txid: '00'.repeat(32), vout: 0, value: 0 }, pending: 0, padding: 0,
   ...(records.length ? { lastBatch: { batch: records.length - 1, at: records.at(-1)!.at!, waitedMs: 0, proveMs: 0, publishMs: 0, rotated: rotations.at(-1)! } } : {}),
   reserves: {}, maxReserves: 0,
   epoch: state.epoch, epochLen: state.epochLen, batchesInEpoch: records.length - state.epoch * state.epochLen, prevNoteRoot: String(state.prevNoteRoot),
   erCount: state.archive.count(), rsCount: state.recovered.count(), nullifiers: state.nullifiers.count(), heapBytes: 0,
  },
 });

 const api = (async (path: string) => {
  const url = new URL(path, 'http://pool'), at = /^\/checkpoints\/(\d+)\/(\d+)$/.exec(url.pathname);
  if (url.pathname === '/status') return status();
  if (url.pathname === '/batches' || url.pathname === '/scan') {
   // http.ts's defaults, caps and 400.
   const scan = url.pathname === '/scan', from = Number(url.searchParams.get('from') ?? 0), limit = Math.min(Number(url.searchParams.get('limit') ?? (scan ? 500 : 50)), scan ? 500 : 100);
   if (!Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1) throw Object.assign(new Error('Invalid batch range.'), { status: 400 });
   const total = records.length, to = Math.min(total, from + limit);
   if (!scan) return { from, total, batches: records.slice(from, to) };
   return { from, total, data: base64.encode(encodeEpochScan(records.slice(from, to).map((record, i) => ({ record, root: BigInt(record.noteBlockRoot), rotated: rotations[from + i]! })))) };
  }
  if (url.pathname === '/times') return { every: CHECKPOINT_EVERY, at: records.filter((_, n) => n % CHECKPOINT_EVERY === 0).map(r => r.at ?? 0) };
  // 4b Task 6's list: the operator writes each epoch's file as the epoch closes.
  if (url.pathname === '/archives') return { epochs: Array.from({ length: state.epoch }, (_, e) => e) };
  if (at) {
   const [epoch, blocks] = [Number(at[1]), Number(at[2])];
   if (epoch === state.epoch && blocks > 0 && blocks % CHECKPOINT_EVERY === 0 && blocks <= state.batchCount - epoch * state.epochLen) return { epoch, ...checkpointOf(state.notes, blocks) };
  }
  throw notFound();
 }) as PoolApi;

 return { state, records, harness, pad, transfer, deposit, recover, land, api };
}
