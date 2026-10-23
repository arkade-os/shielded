import { hex } from '@scure/base';
import type { RollupEpochRecord } from '../../../../src/rollup/epoch-operator.ts';
import type { RollupKeys } from './account.ts';
import { BTC_ASSET, EPOCH_NULLIFIERS, EPOCH_SLOTS, MAX_EPOCH_LEN, ROLLUP_DOMAIN, SUBTREE_DEPTH } from './constants.ts';
import { rotatesAt, type EpochScanBatch } from './epoch-scan.ts';
import { NoteFrontier } from './frontier.ts';
import { akOf, noteOf, nullifierOf, ownerOf, type Hash } from './notes.ts';
import { nullifierHint } from './scan.ts';
import { openRollupNotes, rollupViewTag, viewEcdh, type Ecdh, type RollupNote } from './wallet.ts';

export interface EpochOwnedNote extends RollupNote { epoch: number; index: number; nullifier: bigint }
export interface EpochHistoryEntry { kind: 'shield' | 'receive' | 'send' | 'withdraw' | 'merge' | 'renew' | 'recover'; batch: number; epoch: number; txid?: string; at?: number; amounts: { asset: bigint; amount: bigint }[]; spent: bigint[]; created: EpochOwnedNote[]; destination?: bigint; slots: number[] }

const BLOCK = 2 ** SUBTREE_DEPTH;
// trap: every epoch record carries noteBlockRoot, so its presence (the classic test) would read every full batch as chain-only.
const chainOnly = (record: RollupEpochRecord) => record.slots.every(s => s.commitments[0] === '0' && s.commitments[1] === '0');
const blockRootOf = (hash: Hash, leaves: bigint[]) => {
 let level = Array.from({ length: BLOCK }, (_, i) => leaves[i] ?? 0n);
 while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => hash([level[2 * i]!, level[2 * i + 1]!]));
 return level[0]!;
};

/** Replays an epoch pool into one note frontier per live epoch; the note tree restarts at each rotation, so a note is named by (epoch, index). */
export class EpochAccount {
 readonly owner: bigint;
 readonly epochLen: number;
 readonly history: EpochHistoryEntry[] = [];
 readonly txids = new Set<string>();
 private readonly owned = new Map<bigint, EpochOwnedNote>();
 private frontier: NoteFrontier;
 private prev: bigint | undefined;
 private count = 0;
 private current = 0;
 private ecdh?: Promise<Ecdh>;
 private readonly bornAt: number;
 private readonly replica: boolean;
 constructor(private readonly hash: Hash, private readonly keys: RollupKeys, options: { epochLen: number; replica?: boolean; bornAt?: number }) {
  if (!Number.isSafeInteger(options.epochLen) || options.epochLen < 1 || options.epochLen > MAX_EPOCH_LEN) throw new Error(`An epoch is a positive whole number of batches, at most ${MAX_EPOCH_LEN}.`);
  this.epochLen = options.epochLen;
  this.replica = options.replica ?? false;
  this.bornAt = options.bornAt ?? 0;
  this.owner = keys.owner;
  this.frontier = new NoteFrontier(hash);
  this.prev = this.frontier.root();
 }
 static owning(hash: Hash, keys: { ask: bigint; nk: bigint; viewSecret: Uint8Array }, options: { epochLen: number; replica?: boolean; bornAt?: number }): EpochAccount {
  return new EpochAccount(hash, { ...keys, owner: ownerOf(hash, ROLLUP_DOMAIN, akOf(hash, keys.ask), keys.nk) }, options);
 }

 get epoch(): number { return this.current; }
 get batchCount(): number { return this.count; }
 get blockInEpoch(): number { return this.count - this.current * this.epochLen; }
 get canSkip(): boolean { return !this.replica; }
 /** The current epoch's note root; before any batch, the empty tree's. */
 latestRoot(): bigint { return this.frontier.root(); }
 /** The root the previous epoch closed on; at epoch 0 the pool's genesis value, the empty tree's. */
 prevNoteRoot(): bigint | undefined { return this.prev; }

 /** Whether a scanned batch may create or spend this wallet's notes, or spend a `watched` nullifier: only those are fetched whole. */
 async concerns(entry: EpochScanBatch, watched: Iterable<bigint> = []): Promise<boolean> {
  const mine = new Set([...this.owned.keys(), ...watched].map(nullifierHint));
  if (entry.slots.some(slot => slot.nullifiers.some(hint => mine.has(hint)))) return true;
  if (entry.batch < this.bornAt) return false;
  const ecdh = await (this.ecdh ??= viewEcdh(this.keys.viewSecret));
  for (const slot of entry.slots) {
   if (!slot.ephemeral) continue;
   const shared = await ecdh(slot.ephemeral).catch(() => undefined);
   if (shared && slot.tags.some((tag, i) => rollupViewTag(shared, i) === tag)) return true;
  }
  return false;
 }
 /** Passes a scanned batch `concerns` cleared: the epoch's frontier grows by its block root alone, after the rotation if it is one. */
 skip(entry: EpochScanBatch): void {
  if (this.replica) throw new Error('A replica needs every batch whole.');
  if (entry.batch !== this.count) throw new Error(`Scan entry ${entry.batch} does not follow batch ${this.count}.`);
  const rotated = rotatesAt(this.count, this.epochLen);
  if (entry.rotated !== rotated || entry.epoch !== Math.floor(this.count / this.epochLen)) throw new Error('That scan page does not follow this account.');
  if (entry.txid) this.txids.add(entry.txid);
  if (rotated) this.rotate();
  this.frontier.appendRoot(entry.root);
  this.count++;
 }

 async apply(batch: RollupEpochRecord): Promise<EpochOwnedNote[]> {
  const { kind, slots } = batch;
  if (slots.length !== EPOCH_SLOTS[kind] || slots.some(slot => slot.nullifiers.length !== EPOCH_NULLIFIERS[kind])) throw new Error('A batch record has the wrong shape.');
  const number = this.count, rotated = rotatesAt(number, this.epochLen), epoch = this.current + Number(rotated), base = (rotated ? 0 : this.blockInEpoch) * BLOCK;
  const root = BigInt(batch.noteBlockRoot), leaves = slots.flatMap(slot => slot.commitments.map(BigInt)), nullifiers = slots.map(slot => slot.nullifiers.map(BigInt)), legs = slots.map(slot => slot.publics.map(BigInt));
  const bare = chainOnly(batch);
  if (!bare && blockRootOf(this.hash, leaves) !== root) throw new Error('The batch\'s commitments do not rebuild the block root the pool published.');
  const created: EpochOwnedNote[][] = slots.map(() => []);
  if (number >= this.bornAt) for (const [i, slot] of slots.entries()) {
   if (!slot.ciphertext) continue;
   const opened = await openRollupNotes(hex.decode(slot.ciphertext), this.keys.viewSecret, await (this.ecdh ??= viewEcdh(this.keys.viewSecret)));
   opened.forEach((note, j) => {
    // A record can claim anything; only a note whose commitment is in the tree under our owner is ours.
    if (!note || note.amount === 0n || noteOf(this.hash, ROLLUP_DOMAIN, note.amount, note.asset, this.owner, note.rho) !== leaves[2 * i + j]) return;
    created[i]!.push({ ...note, epoch, index: base + 2 * i + j, nullifier: nullifierOf(this.hash, ROLLUP_DOMAIN, this.keys.nk, note.rho) });
   });
  }

  if (batch.txid) this.txids.add(batch.txid);
  const spent = nullifiers.map(list => list.flatMap(nf => { const note = this.owned.get(nf); this.owned.delete(nf); return note ? [note] : []; }));
  if (rotated) this.rotate();
  if (bare) this.frontier.appendRoot(root);
  else this.frontier.append(leaves, created.flat().map(n => n.index - base));
  // An earlier epoch's frontier is gone, and its index could name a different live note.
  for (const note of spent.flat()) if (note.epoch === this.current) this.frontier.untrack(note.index);
  for (const note of created.flat()) this.owned.set(note.nullifier, note);
  this.count++;
  for (let i = 0; i < slots.length;) {
   let end = i + 1;
   while (slots[i]!.groupId !== '0' && slots[end]?.groupId === slots[i]!.groupId) end++;
   const entry = this.entryOf(batch, number, epoch, legs.slice(i, end), i, end, spent.slice(i, end).flat(), created.slice(i, end).flat());
   if (entry) this.history.push(entry);
   i = end;
  }
  return created.flat();
 }

 private rotate(): void {
  this.prev = this.frontier.root();
  this.frontier = new NoteFrontier(this.hash);
  this.current++;
 }

 private entryOf(batch: RollupEpochRecord, number: number, epoch: number, legs: bigint[][], from: number, to: number, spent: EpochOwnedNote[], created: EpochOwnedNote[]): EpochHistoryEntry | undefined {
  const sum = (items: { asset: bigint; amount: bigint }[]) => {
   const totals = new Map<bigint, bigint>();
   for (const { asset, amount } of items) totals.set(asset, (totals.get(asset) ?? 0n) + amount);
   return [...totals].filter(([, amount]) => amount > 0n).map(([asset, amount]) => ({ asset, amount }));
  };
  const base = { batch: number, epoch, slots: Array.from({ length: to - from }, (_, i) => from + i), ...(batch.txid ? { txid: batch.txid } : {}), ...(batch.at !== undefined ? { at: batch.at } : {}), spent: spent.map(n => n.nullifier), created };
  if (created.length && legs.some(p => (p[3] ?? 0n) > 0n)) return { kind: 'shield', ...base, amounts: sum(legs.map(p => ({ asset: p[5] ?? 0n, amount: p[3] ?? 0n }))) };
  const payout = legs.find(p => (p[4] ?? 0n) > 0n);
  if (spent.length && payout) return { kind: 'withdraw', ...base, amounts: sum(legs.map(p => ({ asset: p[5] ?? 0n, amount: p[4] ?? 0n }))), destination: payout[6] ?? 0n };
  if (spent.length) {
   const amounts = sum([...spent.map(n => ({ asset: n.asset, amount: n.amount })), ...created.map(n => ({ asset: n.asset, amount: -n.amount }))]);
   if (amounts.length) return { kind: 'send', ...base, amounts };
   return batch.kind === 'join' ? { kind: 'merge', ...base, amounts: [] } : undefined;
  }
  return created.length ? { kind: 'receive', ...base, amounts: sum(created.map(n => ({ asset: n.asset, amount: n.amount }))) } : undefined;
 }

 notes(asset = BTC_ASSET): EpochOwnedNote[] { return [...this.owned.values()].filter(n => n.asset === asset).sort((a, b) => a.epoch - b.epoch || a.index - b.index); }
 balance(asset = BTC_ASSET): bigint { return this.notes(asset).reduce((sum, n) => sum + n.amount, 0n); }
}
