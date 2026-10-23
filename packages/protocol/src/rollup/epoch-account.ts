import { hex } from '@scure/base';
import type { RollupEpochRecord } from '../../../../src/rollup/epoch-operator.ts';
import { randomField, type RollupKeys, type SpendRequest } from './account.ts';
import { BTC_ASSET, EPOCH_NULLIFIERS, EPOCH_SLOTS, MAX_EPOCH_LEN, ROLLUP_DOMAIN, SUBTREE_DEPTH, type EpochBatchKind } from './constants.ts';
import type { EpochAnchorRef } from './epoch.ts';
import { epochTransfer, type EpochBuiltSpend } from './epoch-circuit.ts';
import { rotatesAt, type EpochScanBatch } from './epoch-scan.ts';
import { NoteFrontier } from './frontier.ts';
import { akOf, groupIdOf, noteOf, nullifierOf, ownerOf, type Hash } from './notes.ts';
import { nullifierHint } from './scan.ts';
import { openRollupNotes, rollupViewTag, viewEcdh, type Ecdh, type RollupNote, type RollupRecipient } from './wallet.ts';

export interface EpochOwnedNote extends RollupNote { epoch: number; index: number; nullifier: bigint }
export interface EpochHistoryEntry { kind: 'shield' | 'receive' | 'send' | 'withdraw' | 'merge' | 'renew' | 'recover'; batch: number; epoch: number; txid?: string; at?: number; amounts: { asset: bigint; amount: bigint }[]; spent: bigint[]; created: EpochOwnedNote[]; destination?: bigint; slots: number[] }
/** The anchor the next batch will accept, and the selector each input needs. Mirrors the operator's admission check exactly. */
export interface EpochAnchorPlan { rPrev: bigint; rCur: EpochAnchorRef; liveEpoch: number; rotatesNext: boolean }
export interface EpochSpendRequest extends Omit<SpendRequest, 'input' | 'inputs'> { input?: EpochOwnedNote; inputs?: [EpochOwnedNote, EpochOwnedNote] }

const BLOCK = 2 ** SUBTREE_DEPTH, CARRIER_SATS = 330n, CONSOLIDATE_ABOVE = 8;
const byAmount = (a: EpochOwnedNote, b: EpochOwnedNote) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);
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
 /** The epoch before the current one, kept for its notes' paths: its tree never changes again. */
 private closed?: NoteFrontier;
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
  this.closed = this.frontier;
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

 anchorPlan(): EpochAnchorPlan {
  const rotatesNext = rotatesAt(this.count, this.epochLen), rPrev = rotatesNext ? this.latestRoot() : this.prev;
  if (rPrev === undefined) throw new Error('This account has not learned the root the previous epoch closed on, so it cannot anchor a spend.');
  return { rPrev, rCur: { epoch: this.current, root: this.latestRoot() }, liveEpoch: this.current + Number(rotatesNext), rotatesNext };
 }
 selFor(note: EpochOwnedNote, plan: EpochAnchorPlan): 0n | 1n { return note.epoch === plan.liveEpoch ? 0n : 1n; }
 /** False once the next batch archives the note's epoch, one batch before the note leaves the window. */
 spendable(note: EpochOwnedNote, plan = this.anchorPlan()): boolean { return note.epoch >= plan.liveEpoch - 1; }
 private usable(asset: bigint, inFlight: ReadonlySet<bigint>): EpochOwnedNote[] {
  const plan = this.anchorPlan();
  return this.notes(asset).filter(n => !inFlight.has(n.nullifier) && this.spendable(n, plan));
 }

 async spend(request: EpochSpendRequest, self: RollupRecipient, random = randomField, group?: { id: bigint; size: number }): Promise<EpochBuiltSpend> {
  if (this.keys.ask === undefined) throw new Error('This wallet holds a full viewing key, not the spend authority.');
  const plan = this.anchorPlan(), owned = request.inputs ?? (request.input ? [request.input] : []);
  if (!owned.every(n => this.spendable(n, plan))) throw new Error('That note is off the fast path; it needs a recovery.');
  const paths = owned.map(n => (n.epoch === this.current ? this.frontier : this.closed)?.path(n.index));
  return epochTransfer(this.hash, { rPrev: plan.rPrev, rCur: plan.rCur, sel: owned.map(n => this.selFor(n, plan)), ask: this.keys.ask, nk: this.keys.nk, self, request, paths, ...(group ? { group } : {}) }, random);
 }
 join(inputs: [EpochOwnedNote, EpochOwnedNote], self: RollupRecipient, to?: SpendRequest['to']): Promise<EpochBuiltSpend> {
  return this.spend({ asset: inputs[0].asset, inputs, ...(to ? { to } : {}) }, self);
 }
 async consolidate(self: RollupRecipient, asset = BTC_ASSET, inFlight: ReadonlySet<bigint> = new Set(), above = CONSOLIDATE_ABOVE): Promise<{ inputs: [EpochOwnedNote, EpochOwnedNote]; built: EpochBuiltSpend } | undefined> {
  const notes = this.usable(asset, inFlight).sort(byAmount);
  if (notes.length <= above) return undefined;
  const inputs: [EpochOwnedNote, EpochOwnedNote] = [notes[0]!, notes[1]!];
  return { inputs, built: await this.join(inputs, self) };
 }
 /** Group members must be submitted in the returned order, the order the group id commits to. */
 async pay(recipient: RollupRecipient | ((firstNullifier: bigint) => RollupRecipient), amount: bigint, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set(), asset = BTC_ASSET, prefer: { join?: boolean } = {}): Promise<{ kind: Exclude<EpochBatchKind, 'recover'>; spends: EpochBuiltSpend[] }> {
  const notes = this.usable(asset, inFlight).sort((a, b) => byAmount(b, a));
  const to = (first: EpochOwnedNote) => (typeof recipient === 'function' ? recipient(first.nullifier) : recipient);
  const single = notes.filter(n => n.amount >= amount).pop();
  if (single) return { kind: 'spend', spends: [await this.spend({ asset, input: single, to: { recipient: to(single), amount } }, self)] };
  if (prefer.join && notes.length > 1 && notes[0]!.amount + notes[1]!.amount >= amount) return { kind: 'join', spends: [await this.join([notes[0]!, notes[1]!], self, { recipient: to(notes[0]!), amount })] };
  const chosen: EpochOwnedNote[] = [];
  for (const note of notes) { if (chosen.reduce((sum, n) => sum + n.amount, 0n) >= amount || chosen.length === 3) break; chosen.push(note); }
  if (chosen.length < 2 || chosen.reduce((sum, n) => sum + n.amount, 0n) < amount) throw new Error('No three notes together cover this amount.');
  const group = { id: groupIdOf(this.hash, chosen.map(n => n.nullifier)), size: chosen.length }, payee = to(chosen[0]!);
  let left = amount;
  const legs: EpochBuiltSpend[] = [];
  for (const note of chosen) { const part = note.amount < left ? note.amount : left; left -= part; legs.push(await this.spend({ asset, input: note, to: { recipient: payee, amount: part } }, self, randomField, group)); }
  return { kind: 'spend', spends: legs };
 }
 async depositAsset(asset: bigint, units: bigint, sats: bigint, self: RollupRecipient): Promise<[EpochBuiltSpend, EpochBuiltSpend]> {
  const dummies = [{ nk: randomField(), rho: randomField() }, { nk: randomField(), rho: randomField() }] as const;
  const group = { id: groupIdOf(this.hash, dummies.map(d => nullifierOf(this.hash, ROLLUP_DOMAIN, d.nk, d.rho, true))), size: 2 };
  return [await this.spend({ asset, deposit: units, dummy: dummies[0] }, self, randomField, group), await this.spend({ deposit: sats, dummy: dummies[1] }, self, randomField, group)];
 }
 async withdrawAsset(asset: bigint, units: bigint, program: Uint8Array, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set(), sats = CARRIER_SATS): Promise<[EpochBuiltSpend, EpochBuiltSpend]> {
  if (sats < CARRIER_SATS) throw new Error(`An asset payout carries at least ${CARRIER_SATS} sats.`);
  const smallest = (list: EpochOwnedNote[], amount: bigint) => list.filter(n => n.amount >= amount).sort(byAmount)[0];
  const note = smallest(this.usable(asset, inFlight), units), carrier = smallest(this.usable(BTC_ASSET, inFlight), sats);
  if (!note) throw new Error('No single note of this asset covers the amount.');
  if (!carrier) throw new Error(`Withdrawing an asset needs a BTC note of at least ${sats} sats for its carrier.`);
  const group = { id: groupIdOf(this.hash, [note.nullifier, carrier.nullifier]), size: 2 };
  return [await this.spend({ asset, input: note, withdraw: units, program }, self, randomField, group), await this.spend({ input: carrier, withdraw: sats, program }, self, randomField, group)];
 }
}
