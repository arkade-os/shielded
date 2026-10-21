import { ANCHOR_TAG, ARCHIVE_DEPTH, EPOCH_BINDING_VERSION, EPOCH_KIND_BYTE, EPOCH_NULLIFIER_DEPTH, EPOCH_NULLIFIERS, EPOCH_SLOTS, EPOCH_TAG, MAX_EPOCH_LEN, NOTE_DEPTH, RECOVERED_DEPTH, ROLLUP_DOMAIN, ROLLUP_FIELD, RS_TAG, RollupRejection, STATE_TAG, SUBTREE_DEPTH, WIN_TAG, WINDOW_DEPTH, type EpochBatchKind } from './constants.ts';
import { EpochArchive } from './epoch-archive.ts';
import { sha256le248, statementOf, type Hash } from './notes.ts';
import { RollupNullifiers } from './nullifiers.ts';
import { bindingOf, validateGroups } from './state.ts';
import { DeepTree } from './tree.ts';

export interface EpochAnchorRef { epoch: number; root: bigint }
export interface EpochSlot { anchor: bigint; rCur: EpochAnchorRef; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number; origin?: number }
export interface EpochBatchResult { witness: Record<string, unknown>; publicSignals: bigint[]; binding: Uint8Array; daRoot: bigint; blockRoot: bigint; rotated: boolean }

export const anchorOf = (hash: Hash, rPrev: bigint, rCur: bigint) => hash([ANCHOR_TAG, rPrev, rCur]);
export const windowLeafOf = (hash: Hash, ref: EpochAnchorRef) => hash([WIN_TAG, BigInt(ref.epoch), ref.root]);
export const epochBindingOf = (kind: EpochBatchKind, oldCommitment: bigint, newCommitment: bigint, daRoot: bigint, blockRoot: bigint) => {
 const binding = bindingOf('spend', oldCommitment, newCommitment, daRoot, blockRoot);
 binding.set([EPOCH_BINDING_VERSION, EPOCH_KIND_BYTE[kind], EPOCH_SLOTS[kind]], 2);
 return binding;
};

export class EpochState {
 epoch = 0;
 notes: DeepTree;
 nullifiers: RollupNullifiers;
 window: DeepTree;
 archive: EpochArchive;
 recovered: RollupNullifiers;
 prevNoteRoot: bigint;
 noteCount = 0;
 batchCount = 0;
 private prevNf: RollupNullifiers;
 private undo?: () => void;
 private constructor(private readonly hash: Hash, readonly epochLen: number, private readonly leaves: boolean) {
  this.notes = new DeepTree(hash, NOTE_DEPTH);
  this.nullifiers = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
  this.window = new DeepTree(hash, WINDOW_DEPTH);
  this.archive = new EpochArchive(hash);
  this.recovered = new RollupNullifiers(hash, RECOVERED_DEPTH);
  this.prevNf = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
  this.prevNoteRoot = this.notes.root();
  // An empty window has no leaf to anchor on, so genesis holds the empty epoch-0 root where the root after 0 batches belongs.
  this.window.set(2 ** WINDOW_DEPTH - 1, windowLeafOf(hash, { epoch: 0, root: this.prevNoteRoot }));
 }
 static genesis(hash: Hash, epochLen: number, leaves = true): EpochState {
  if (!Number.isSafeInteger(epochLen) || epochLen < 1 || epochLen > MAX_EPOCH_LEN) throw new RollupRejection('epoch-length', `An epoch is a positive whole number of batches, at most ${MAX_EPOCH_LEN}.`);
  return new EpochState(hash, epochLen, leaves);
 }
 get prevNfRoot(): bigint { return this.prevNf.root(); }
 private get archiveFull(): boolean { return this.archive.count() >= 2 ** ARCHIVE_DEPTH; }
 clone(): EpochState {
  const copy = new EpochState(this.hash, this.epochLen, this.leaves);
  copy.epoch = this.epoch; copy.notes = this.notes.clone(); copy.nullifiers = this.nullifiers.clone(); copy.window = this.window.clone();
  copy.archive = this.archive.clone(); copy.recovered = this.recovered.clone(); copy.prevNf = this.prevNf.clone();
  copy.prevNoteRoot = this.prevNoteRoot; copy.noteCount = this.noteCount; copy.batchCount = this.batchCount;
  return copy;
 }
 commitment(): bigint {
  return this.hash([STATE_TAG, this.notes.root(), BigInt(this.noteCount), this.nullifiers.root(), BigInt(this.nullifiers.count()), this.window.root(), BigInt(this.batchCount), this.epochDigest(), this.rsDigest()]);
 }
 epochDigest(): bigint {
  return this.hash([EPOCH_TAG, BigInt(this.epoch), BigInt(this.epochLen), this.prevNoteRoot, this.prevNfRoot, this.archive.root(), BigInt(this.archive.count())]);
 }
 rsDigest(): bigint { return this.hash([RS_TAG, this.recovered.root(), BigInt(this.recovered.count())]); }
 windowIndex(ref: EpochAnchorRef): number {
  const leaf = windowLeafOf(this.hash, ref);
  for (let k = 0; k < 2 ** WINDOW_DEPTH; k++) if (this.window.node(0, k) === leaf) return k;
  return -1;
 }
 /** The newest window leaf is always this root tagged with the current epoch. */
 latestRoot(): bigint { return this.notes.root(); }

 apply(kind: EpochBatchKind, slots: EpochSlot[]): EpochBatchResult {
  const width = EPOCH_SLOTS[kind], m = EPOCH_NULLIFIERS[kind];
  if (slots.length !== width) throw new RollupRejection('slot-count', `A batch has exactly ${width} slots.`);
  if (slots.some(slot => slot.nullifiers.length !== m)) throw new RollupRejection('slot-shape', `A ${kind} slot spends ${m} note(s).`);
  validateGroups(this.hash, slots);
  const inField = (v: bigint) => v >= 0n && v < ROLLUP_FIELD;
  if (slots.some(slot => slot.commitments.length !== 2 || !slot.commitments.every(inField) || !inField(slot.anchor) || !inField(slot.rCur.root) || !inField(slot.ctDigest))) throw new RollupRejection('slot-shape', 'A slot has two field-element commitments.');
  const oldCommitment = this.commitment(), pubs: bigint[] = [], { nullifiers, prevNoteRoot, epoch, noteCount, batchCount } = this;
  const windowSlot = batchCount % 2 ** WINDOW_DEPTH, epochR = batchCount % this.epochLen;
  const before = {
   noteRoot: this.notes.root(), noteCount: BigInt(noteCount),
   nfRoot: this.nullifiers.root(), nfCount: BigInt(this.nullifiers.count()),
   rPrev: this.prevNoteRoot, prevNfRoot: this.prevNfRoot, epoch: BigInt(this.epoch), epochLen: BigInt(this.epochLen),
   erRoot: this.archive.root(), erCount: BigInt(this.archive.count()), rsRoot: this.recovered.root(), rsCount: BigInt(this.recovered.count()),
   winRoot: this.window.root(), batchCount: BigInt(batchCount), batchQ: BigInt(Math.floor(batchCount / 2 ** WINDOW_DEPTH)),
   epochQ: BigInt(Math.floor(batchCount / this.epochLen)), epochR: BigInt(epochR),
   // Set on every batch, rotating or not, so a circuit can check the append unconditionally and keep it only when it rotates.
   // A full archive has no free slot: its non-rotating batches carry zeros here, and begin() refuses the one that rotates.
   erLeaf: this.archive.leafOf(epoch - 1, prevNoteRoot, this.prevNfRoot, nullifiers.root()), erAppendPath: this.archiveFull ? Array(ARCHIVE_DEPTH).fill(0n) : this.archive.tree.path(this.archive.count()),
   winOldLeaf: this.window.node(0, windowSlot), winSlotPath: this.window.path(windowSlot),
  };
  try {
   const rotated = this.begin(kind);
   const noteSlot = this.noteCount / 2 ** SUBTREE_DEPTH;
   const start = { rotate: BigInt(rotated), rotNoteRoot: this.notes.root(), rotNfRoot: this.nullifiers.root(), rotNfCount: BigInt(this.nullifiers.count()), noteSlot: BigInt(noteSlot), slotPath: this.notes.path(noteSlot, SUBTREE_DEPTH) };
   const lists: Record<string, unknown[]> = {}, put = (fields: Record<string, unknown>) => { for (const key in fields) (lists[key] ??= []).push(fields[key]); };
   let da = 0n;
   for (const slot of slots) {
    const { anchor, rCur, origin = NaN } = slot, pub = statementOf(this.hash, { domain: ROLLUP_DOMAIN, ...slot, root: anchor });
    pubs.push(pub);
    put({ pub, anchor, nf: slot.nullifiers, cm: slot.commitments, ctDigest: slot.ctDigest, groupId: slot.groupId, groupSize: BigInt(slot.groupSize) });
    if (kind === 'recover') {
     const [nullifier] = slot.nullifiers, { erIndex, erPath, archived: { noteFinal, nfFinal, nfNextFinal }, nonMemberA: a, nonMemberB: b } = this.archive.witness(origin, nullifier);
     if (anchor !== anchorOf(this.hash, noteFinal, noteFinal)) throw new RollupRejection('stale-anchor', 'The anchor does not open against the archived note root.');
     const rs = this.recovered.insert(nullifier);
     put({ erIdx: BigInt(erIndex), erPath, erNoteFinal: noteFinal, nfA: nfFinal, nfB: nfNextFinal, nmaIdx: BigInt(a.index), nmaLeaf: a.leaf, nmaPath: a.path, nmbIdx: BigInt(b.index), nmbLeaf: b.leaf, nmbPath: b.path });
     put({ rsPredIdx: BigInt(rs.predIdx), rsPred: rs.pred, rsPredPath: rs.predPath, rsAppendPath: rs.appendPath });
    } else {
     // The tag test runs first: windowLeafOf cannot hash a fractional epoch.
     const winIdx = rCur.epoch === this.epoch || rCur.epoch === this.epoch - 1 ? this.windowIndex(rCur) : -1;
     if (winIdx < 0) throw new RollupRejection('window-tag', 'The spend anchors on a root that is not a window leaf of a live epoch.');
     if (anchor !== anchorOf(this.hash, this.prevNoteRoot, rCur.root)) throw new RollupRejection('stale-anchor', 'The anchor does not open against this batch\'s previous-epoch root.');
     put({ rCurRoot: rCur.root, rCurEpoch: BigInt(rCur.epoch), winIdx: BigInt(winIdx), winPath: this.window.path(winIdx) });
     for (const nullifier of slot.nullifiers) {
      const absent = this.prevNf.nonMember(nullifier), insertion = this.nullifiers.insert(nullifier);
      put({ nmIdx: BigInt(absent.index), nmLeaf: absent.leaf, nmPath: absent.path, predIdx: BigInt(insertion.predIdx), pred: insertion.pred, predPath: insertion.predPath, appendPath: insertion.appendPath });
     }
    }
    da = this.hash([da, ...slot.nullifiers, slot.commitments[0], slot.commitments[1], slot.ctDigest]);
   }
   const commitments = slots.flatMap(slot => slot.commitments);
   let level = Array.from({ length: 2 ** SUBTREE_DEPTH }, (_, i) => commitments[i] ?? 0n);
   while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => this.hash([level[2 * i], level[2 * i + 1]]));
   const blockRoot = level[0];
   this.seal(blockRoot, commitments);
   const binding = epochBindingOf(kind, oldCommitment, this.commitment(), da, blockRoot);
   const statement = sha256le248(binding);
   return { witness: { ...lists, statement, ...before, ...start, winNewEpoch: BigInt(this.epoch) }, publicSignals: [...pubs, statement], binding, daRoot: da, blockRoot, rotated };
  } catch (error) { this.undoLast(); throw error; }
 }

 /** Advances state from chain data alone to the commitment apply reaches: rotation follows the batch count and the kind routes each nullifier, so no anchor, rCur or origin is needed. */
 applyFromChain(kind: EpochBatchKind, slotNullifiers: bigint[][], blockRoot: bigint): bigint {
  const width = EPOCH_SLOTS[kind], m = EPOCH_NULLIFIERS[kind];
  if (slotNullifiers.length !== width) throw new RollupRejection('slot-count', `A batch has exactly ${width} slots.`);
  if (slotNullifiers.some(nullifiers => nullifiers.length !== m)) throw new RollupRejection('slot-shape', `A ${kind} slot spends ${m} note(s).`);
  try {
   this.begin(kind);
   for (const nullifier of slotNullifiers.flat()) (kind === 'recover' ? this.recovered : this.nullifiers).insert(nullifier);
   this.seal(blockRoot);
   return this.commitment();
  } catch (error) { this.undoLast(); throw error; }
 }

 undoLast(): void {
  if (!this.undo) throw new Error('There is no batch to undo.');
  this.undo();
 }

 /** Journals the batch, then rotates if the batch count says so; room is checked only after rotation, so the batch that closes a full epoch still lands. */
 private begin(kind: EpochBatchKind): boolean {
  const { notes, nullifiers, prevNf, prevNoteRoot, epoch, noteCount, batchCount } = this, rotated = batchCount % this.epochLen === 0 && batchCount > 0;
  // Rotation replaces notes, nullifiers and prevNf, so undo rolls back the captured objects and puts them back.
  const parts = [notes, nullifiers, this.window, this.archive, this.recovered];
  for (const part of parts) part.begin();
  this.undo = () => {
   for (const part of parts) part.rollback();
   this.notes = notes; this.nullifiers = nullifiers; this.prevNf = prevNf; this.prevNoteRoot = prevNoteRoot; this.epoch = epoch; this.noteCount = noteCount; this.batchCount = batchCount; this.undo = undefined;
  };
  if (rotated) {
   if (this.archiveFull) throw new RollupRejection('archive-full', 'The epoch archive is full.');
   this.archive.append(epoch - 1, prevNoteRoot, prevNf, nullifiers);
   this.prevNoteRoot = notes.root(); this.prevNf = nullifiers;
   this.notes = new DeepTree(this.hash, NOTE_DEPTH); this.nullifiers = new RollupNullifiers(this.hash, EPOCH_NULLIFIER_DEPTH);
   this.noteCount = 0; this.epoch += 1;
  }
  if (this.noteCount + 2 ** SUBTREE_DEPTH > 2 ** NOTE_DEPTH) throw new RollupRejection('note-tree-full', 'The note tree is full.');
  const target = kind === 'recover' ? this.recovered : this.nullifiers;
  if (target.count() + EPOCH_SLOTS[kind] * EPOCH_NULLIFIERS[kind] > 2 ** target.depth) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  return rotated;
 }

 private seal(blockRoot: bigint, commitments?: bigint[]): void {
  if (this.leaves && commitments) commitments.forEach((commitment, offset) => this.notes.set(this.noteCount + offset, commitment));
  else this.notes.setAt(SUBTREE_DEPTH, this.noteCount / 2 ** SUBTREE_DEPTH, blockRoot);
  this.noteCount += 2 ** SUBTREE_DEPTH;
  this.window.set(this.batchCount % 2 ** WINDOW_DEPTH, windowLeafOf(this.hash, { epoch: this.epoch, root: this.notes.root() }));
  this.batchCount += 1;
 }
}
