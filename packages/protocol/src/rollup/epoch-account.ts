import { hex } from '@scure/base';
import type { RollupEpochRecord } from '../../../../src/rollup/epoch-operator.ts';
import { randomField, type RollupKeys, type SnapshotEntry, type SnapshotNote, type SpendRequest } from './account.ts';
import { BTC_ASSET, EPOCH_NULLIFIERS, EPOCH_SLOTS, MAX_EPOCH_LEN, ROLLUP_DOMAIN, SUBTREE_DEPTH, type EpochBatchKind } from './constants.ts';
import type { EpochAnchorRef } from './epoch.ts';
import { epochRecoverTransfer, epochTransfer, type EpochBuiltSpend } from './epoch-circuit.ts';
import { rotatesAt, type EpochScanBatch } from './epoch-scan.ts';
import { NoteFrontier, type FrontierCheckpoint, type FrontierSnapshot } from './frontier.ts';
import { akOf, groupIdOf, noteOf, nullifierOf, ownerOf, type Hash } from './notes.ts';
import { nullifierHint } from './scan.ts';
import { openRollupNotes, rollupViewTag, viewEcdh, type Ecdh, type RollupNote, type RollupRecipient } from './wallet.ts';

export interface EpochOwnedNote extends RollupNote { epoch: number; index: number; nullifier: bigint }
export interface EpochHistoryEntry { kind: 'shield' | 'receive' | 'send' | 'withdraw' | 'merge' | 'renew' | 'recover'; batch: number; epoch: number; txid?: string; at?: number; amounts: { asset: bigint; amount: bigint }[]; spent: bigint[]; created: EpochOwnedNote[]; destination?: bigint; slots: number[] }
/** The anchor the next batch will accept, and the selector each input needs. Mirrors the operator's admission check exactly. */
export interface EpochAnchorPlan { rPrev: bigint; rCur: EpochAnchorRef; liveEpoch: number; rotatesNext: boolean }
export interface EpochSpendRequest extends Omit<SpendRequest, 'input' | 'inputs'> { input?: EpochOwnedNote; inputs?: [EpochOwnedNote, EpochOwnedNote] }
/** A closed epoch's final note root and the final paths of the notes still held in it, by leaf index. */
export interface FrozenEpoch { epoch: number; noteFinal: string; paths: [number, string[]][] }
export interface SnapshotEpochNote extends SnapshotNote { epoch: number }
export interface SnapshotEpochEntry extends Omit<SnapshotEntry, 'kind' | 'created'> { kind: EpochHistoryEntry['kind']; epoch: number; created: SnapshotEpochNote[] }
export interface EpochAccountSnapshot {
 v: 2; owner: string; epochLen: number; bornAt: number; epoch: number; batch: number; blockInEpoch: number;
 prevNoteRoot?: string; frontier: FrontierSnapshot; frozen: FrozenEpoch[]; owned: SnapshotEpochNote[]; history: SnapshotEpochEntry[]; txids: string[];
}

/** A note must be renewed during the epoch after the one that created it, or it falls to recovery. */
export type RenewalPlan = { kind: 'join'; due: [EpochOwnedNote, EpochOwnedNote]; deadlineBatch: number } | { kind: 'spend'; due: [EpochOwnedNote]; deadlineBatch: number };
export const RENEWAL_TAIL = 0.1; // never schedule in the last tenth of the epoch
export const RENEWAL_FLOOR = 1 - RENEWAL_TAIL; // past this, renew at once rather than lose the note

const BLOCK = 2 ** SUBTREE_DEPTH, CARRIER_SATS = 330n, CONSOLIDATE_ABOVE = 8;
const noteOut = (n: EpochOwnedNote): SnapshotEpochNote => ({ amount: String(n.amount), asset: String(n.asset), rho: String(n.rho), index: n.index, nullifier: String(n.nullifier), epoch: n.epoch });
const noteIn = (n: SnapshotEpochNote): EpochOwnedNote => ({ amount: BigInt(n.amount), asset: BigInt(n.asset), rho: BigInt(n.rho), index: n.index, nullifier: BigInt(n.nullifier), epoch: n.epoch });
const byAmount = (a: EpochOwnedNote, b: EpochOwnedNote) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);
const uniform = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
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
 private readonly frozen = new Map<number, { noteFinal: bigint; paths: Map<number, bigint[]> }>();
 private prev: bigint | undefined;
 private count = 0;
 private current = 0;
 private ecdh?: Promise<Ecdh>;
 private schedule = { epoch: -1, targets: new Map<bigint, number>() };
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
 /** Whether the next batch rotates this account. One started at (epoch, 0) already holds that epoch's empty tree, so the pool's rotating batch only appends: read this, never rotatesAt(batchCount), which says true there. */
 get rotatesNext(): boolean { return Math.floor(this.count / this.epochLen) > this.current; }
 private get liveEpoch(): number { return this.current + Number(this.rotatesNext); }
 /** The current epoch's note root; before any batch, the empty tree's. */
 latestRoot(): bigint { return this.frontier.root(); }
 /** The root the previous epoch closed on; at epoch 0 the pool's genesis value, the empty tree's; undefined until a start supplies it or a rotation teaches it. */
 prevNoteRoot(): bigint | undefined { return this.prev; }
 /** The path frozen when the note's epoch closed. That tree never changes again, so the path serves a sel=1 spend and a recovery alike. */
 frozenPath(note: EpochOwnedNote): bigint[] | undefined { const path = this.frozen.get(note.epoch)?.paths.get(note.index); return path && [...path]; }
 /** The root an epoch closed on, kept while the account holds a note of it; the previous epoch's is prevNoteRoot. */
 noteFinal(epoch: number): bigint | undefined { return this.frozen.get(epoch)?.noteFinal ?? (epoch === this.current - 1 ? this.prev : undefined); }

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
  if (entry.rotated !== rotatesAt(this.count, this.epochLen) || entry.epoch !== Math.floor(this.count / this.epochLen)) throw new Error('That scan page does not follow this account.');
  if (entry.txid) this.txids.add(entry.txid);
  if (this.rotatesNext) this.rotate();
  this.frontier.appendRoot(entry.root);
  this.count++;
 }

 async apply(batch: RollupEpochRecord): Promise<EpochOwnedNote[]> {
  const { kind, slots } = batch;
  if (slots.length !== EPOCH_SLOTS[kind] || slots.some(slot => slot.nullifiers.length !== EPOCH_NULLIFIERS[kind])) throw new Error('A batch record has the wrong shape.');
  const number = this.count, rotated = this.rotatesNext, epoch = this.current + Number(rotated), base = (rotated ? 0 : this.blockInEpoch) * BLOCK;
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
  // A note of an earlier epoch is held by its frozen path; its index may name a live leaf of this epoch too.
  for (const note of spent.flat()) if (note.epoch === this.current) this.frontier.untrack(note.index); else this.thaw(note);
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

 /** Before the rotating batch's block lands: the closing tree's root, and the final path of every note still held in it. */
 private rotate(): void {
  const held = [...this.owned.values()].filter(n => n.epoch === this.current);
  if (held.length) this.frozen.set(this.current, { noteFinal: this.frontier.root(), paths: new Map(held.map(n => [n.index, this.frontier.path(n.index)])) });
  this.prev = this.frontier.root();
  this.frontier = new NoteFrontier(this.hash);
  this.current++;
 }
 private thaw(note: EpochOwnedNote): void {
  const frozen = this.frozen.get(note.epoch);
  if (frozen?.paths.delete(note.index) && !frozen.paths.size) this.frozen.delete(note.epoch);
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
   const kind = batch.kind === 'join' ? 'merge' : batch.kind === 'recover' ? 'recover' : spent.length === 1 ? 'renew' : undefined;
   return kind && { kind, ...base, amounts: [] };
  }
  return created.length ? { kind: 'receive', ...base, amounts: sum(created.map(n => ({ asset: n.asset, amount: n.amount }))) } : undefined;
 }

 notes(asset = BTC_ASSET): EpochOwnedNote[] { return [...this.owned.values()].filter(n => n.asset === asset).sort((a, b) => a.epoch - b.epoch || a.index - b.index); }
 balance(asset = BTC_ASSET): bigint { return this.notes(asset).reduce((sum, n) => sum + n.amount, 0n); }

 snapshot(): EpochAccountSnapshot {
  return {
   v: 2, owner: String(this.owner), epochLen: this.epochLen, bornAt: this.bornAt, epoch: this.current, batch: this.count, blockInEpoch: this.blockInEpoch,
   ...(this.prev === undefined ? {} : { prevNoteRoot: String(this.prev) }), frontier: this.frontier.snapshot(),
   frozen: [...this.frozen].map(([epoch, { noteFinal, paths }]) => ({ epoch, noteFinal: String(noteFinal), paths: [...paths].map(([index, path]): [number, string[]] => [index, path.map(String)]) })),
   owned: [...this.owned.values()].map(noteOut), txids: [...this.txids],
   history: this.history.map(e => ({ kind: e.kind, batch: e.batch, epoch: e.epoch, ...(e.txid ? { txid: e.txid } : {}), ...(e.at !== undefined ? { at: e.at } : {}), amounts: e.amounts.map((a): [string, string] => [String(a.asset), String(a.amount)]), spent: e.spent.map(String), created: e.created.map(noteOut), ...(e.destination !== undefined ? { destination: String(e.destination) } : {}), slots: e.slots })),
  };
 }
 /** `epochLen` is the pool's: a snapshot of another epoch length would rotate at the wrong batches. */
 static fromSnapshot(hash: Hash, keys: { ask: bigint; nk: bigint; viewSecret: Uint8Array }, s: EpochAccountSnapshot, epochLen: number): EpochAccount {
  if (s.v !== 2) throw new Error(`Unknown epoch account snapshot version ${s.v}.`);
  if (s.epochLen !== epochLen) throw new Error(`That snapshot is of ${s.epochLen}-batch epochs, and this pool's are ${epochLen}; sync from the pool instead.`);
  const account = EpochAccount.owning(hash, keys, { epochLen, bornAt: s.bornAt });
  if (String(account.owner) !== s.owner) throw new Error('That snapshot belongs to another key; sync from the pool instead.');
  account.frontier = NoteFrontier.fromSnapshot(hash, s.frontier);
  account.count = s.batch; account.current = s.epoch; account.prev = s.prevNoteRoot === undefined ? undefined : BigInt(s.prevNoteRoot);
  for (const f of s.frozen) account.frozen.set(f.epoch, { noteFinal: BigInt(f.noteFinal), paths: new Map(f.paths.map(([index, path]) => [index, path.map(BigInt)])) });
  for (const note of s.owned.map(noteIn)) account.owned.set(note.nullifier, note);
  for (const txid of s.txids) account.txids.add(txid);
  for (const e of s.history) account.history.push({ kind: e.kind, batch: e.batch, epoch: e.epoch, ...(e.txid ? { txid: e.txid } : {}), ...(e.at !== undefined ? { at: e.at } : {}), amounts: e.amounts.map(([asset, amount]) => ({ asset: BigInt(asset), amount: BigInt(amount) })), spent: e.spent.map(BigInt), created: e.created.map(noteIn), ...(e.destination !== undefined ? { destination: BigInt(e.destination) } : {}), slots: e.slots });
  return account;
 }
 /** Starts with no notes on the current epoch's checkpoint; at `blocks` 0, on the empty tree of an epoch whose rotating batch has yet to land. */
 static atCheckpoint(hash: Hash, keys: { ask: bigint; nk: bigint; viewSecret: Uint8Array }, o: { epochLen: number; checkpoint: FrontierCheckpoint & { epoch: number }; prevNoteRoot?: bigint; bornAt: number }): EpochAccount {
  const { epoch, blocks } = o.checkpoint, batch = epoch * o.epochLen + blocks;
  if (o.bornAt < batch) throw new Error('A checkpoint past the birth batch would skip its notes.');
  if (blocks === 0 && o.prevNoteRoot !== undefined) throw new Error('A checkpoint at blocks 0 is the empty tree of an epoch whose rotating batch has not landed, so it has no previous-epoch root to seed.');
  const account = EpochAccount.owning(hash, keys, { epochLen: o.epochLen, bornAt: o.bornAt });
  account.frontier = NoteFrontier.at(hash, o.checkpoint);
  account.count = batch; account.current = epoch; account.prev = o.prevNoteRoot;
  return account;
 }

 anchorPlan(): EpochAnchorPlan {
  const { rotatesNext } = this, rPrev = rotatesNext ? this.latestRoot() : this.prev;
  if (rPrev === undefined) throw new Error('This account has not learned the root the previous epoch closed on, so it cannot anchor a spend.');
  return { rPrev, rCur: { epoch: this.current, root: this.latestRoot() }, liveEpoch: this.liveEpoch, rotatesNext };
 }
 selFor(note: EpochOwnedNote, plan: EpochAnchorPlan): 0n | 1n { return note.epoch === plan.liveEpoch ? 0n : 1n; }
 /** False once the next batch archives the note's epoch, one batch before the note leaves the window. */
 spendable(note: EpochOwnedNote, plan = this.anchorPlan()): boolean { return note.epoch >= plan.liveEpoch - 1; }
 private usable(asset: bigint, inFlight: ReadonlySet<bigint>): EpochOwnedNote[] {
  const plan = this.anchorPlan();
  return this.notes(asset).filter(n => !inFlight.has(n.nullifier) && this.spendable(n, plan));
 }
 /** consolidate's order, which renewal shares: smallest first, the notes `first` names ahead of the rest. Sorts in place. */
 private smallestFirst(notes: EpochOwnedNote[], first: (note: EpochOwnedNote) => boolean = () => false): EpochOwnedNote[] {
  return notes.sort((a, b) => Number(first(b)) - Number(first(a)) || byAmount(a, b));
 }

 async spend(request: EpochSpendRequest, self: RollupRecipient, random = randomField, group?: { id: bigint; size: number }): Promise<EpochBuiltSpend> {
  if (this.keys.ask === undefined) throw new Error('This wallet holds a full viewing key, not the spend authority.');
  const plan = this.anchorPlan(), owned = request.inputs ?? (request.input ? [request.input] : []);
  if (!owned.every(n => this.spendable(n, plan))) throw new Error('That note is off the fast path; it needs a recovery.');
  const paths = owned.map(n => (n.epoch === this.current ? this.frontier.path(n.index) : this.frozenPath(n)));
  return epochTransfer(this.hash, { rPrev: plan.rPrev, rCur: plan.rCur, sel: owned.map(n => this.selFor(n, plan)), ask: this.keys.ask, nk: this.keys.nk, self, request, paths, ...(group ? { group } : {}) }, random);
 }
 join(inputs: [EpochOwnedNote, EpochOwnedNote], self: RollupRecipient, to?: SpendRequest['to']): Promise<EpochBuiltSpend> {
  return this.spend({ asset: inputs[0].asset, inputs, ...(to ? { to } : {}) }, self);
 }
 /** A note off the fast path becomes a fresh note of the live epoch: one width-1 slot that names its origin and opens against that epoch's final root twice. */
 async recover(note: EpochOwnedNote, self: RollupRecipient, random = randomField): Promise<EpochBuiltSpend> {
  if (this.keys.ask === undefined) throw new Error('This wallet holds a full viewing key, not the spend authority.');
  if (note.epoch >= this.liveEpoch - 1) throw new Error('That note is still on the fast path; spend it instead.');
  const noteFinal = this.noteFinal(note.epoch), path = this.frozenPath(note);
  if (noteFinal === undefined || !path) throw new Error('This wallet holds no frozen path for that note, so it cannot recover it.');
  return epochRecoverTransfer(this.hash, { origin: note.epoch, noteFinal, ask: this.keys.ask, nk: this.keys.nk, self, note, path }, random);
 }
 async consolidate(self: RollupRecipient, asset = BTC_ASSET, inFlight: ReadonlySet<bigint> = new Set(), above = CONSOLIDATE_ABOVE): Promise<{ inputs: [EpochOwnedNote, EpochOwnedNote]; built: EpochBuiltSpend } | undefined> {
  const notes = this.smallestFirst(this.usable(asset, inFlight));
  if (notes.length <= above) return undefined;
  const inputs: [EpochOwnedNote, EpochOwnedNote] = [notes[0]!, notes[1]!];
  return { inputs, built: await this.join(inputs, self) };
 }
 /**
  * The renewal to submit now, if any. A note on its last fast-path epoch goes at a random batch of that epoch, joined with the smallest
  * other due note when there is one. Each note's target is drawn the first time it is seen; `now` is not read, the schedule counts batches.
  */
 renewalDue(o: { now?: () => number; random?: () => number; inFlight?: ReadonlySet<bigint>; asset?: bigint } = {}): RenewalPlan | undefined {
  // trap: `at`, not blockInEpoch, which reads epochLen at the rotating tick and would renew every due note at once.
  const { epochLen, liveEpoch: live } = this, at = this.count - live * epochLen, last = Math.floor(RENEWAL_FLOOR * epochLen);
  const due = this.notes(o.asset).filter(n => n.epoch === live - 1);
  if (!due.length) return undefined;
  if (this.schedule.epoch !== live) this.schedule = { epoch: live, targets: new Map() };
  const { targets } = this.schedule, from = Math.min(at, last), draw = o.random ?? uniform;
  // trap: a wallet opened late sees every due note at once; drawn over the whole window, most targets are already past and it renews in a burst.
  for (const n of due) if (!targets.has(n.nullifier)) targets.set(n.nullifier, from + Math.floor(draw() * (last - from)));
  if (due.some(n => o.inFlight?.has(n.nullifier))) return undefined;
  const ready = (n: EpochOwnedNote) => at >= targets.get(n.nullifier)!;
  const [head, partner] = this.smallestFirst(due, ready), deadlineBatch = (live + 1) * epochLen - 1;
  if (!ready(head!)) return undefined;
  return partner ? { kind: 'join', due: [head!, partner], deadlineBatch } : { kind: 'spend', due: [head!], deadlineBatch };
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
