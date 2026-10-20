import { ANCHOR_TAG, EPOCH_KIND_BYTE, EPOCH_NULLIFIER_DEPTH, EPOCH_NULLIFIERS, EPOCH_SLOTS, EPOCH_TAG, NOTE_DEPTH, RECOVERED_DEPTH, ROLLUP_DOMAIN, ROLLUP_FIELD, RS_TAG, RollupRejection, STATE_TAG, SUBTREE_DEPTH, WIN_TAG, WINDOW_DEPTH, type EpochBatchKind } from './constants.ts';
import { EpochArchive } from './epoch-archive.ts';
import { groupIdOf, sha256le248, statementOf, type Hash } from './notes.ts';
import { RollupNullifiers } from './nullifiers.ts';
import { bindingOf } from './state.ts';
import { DeepTree } from './tree.ts';

export interface EpochAnchorRef { epoch: number; root: bigint }
export interface EpochSlot { anchor: bigint; rCur: EpochAnchorRef; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number; origin?: number }
export interface EpochBatchResult { witness: Record<string, unknown>; publicSignals: bigint[]; binding: Uint8Array; daRoot: bigint; blockRoot: bigint; rotated: boolean }

export const anchorOf = (hash: Hash, rPrev: bigint, rCur: bigint) => hash([ANCHOR_TAG, rPrev, rCur]);
export const windowLeafOf = (hash: Hash, ref: EpochAnchorRef) => hash([WIN_TAG, BigInt(ref.epoch), ref.root]);
export const epochBindingOf = (kind: EpochBatchKind, oldCommitment: bigint, newCommitment: bigint, daRoot: bigint, blockRoot: bigint) => {
 const binding = bindingOf('spend', oldCommitment, newCommitment, daRoot, blockRoot);
 binding.set([EPOCH_KIND_BYTE[kind], EPOCH_SLOTS[kind]], 3);
 return binding;
};

function validateGroups(hash: Hash, slots: EpochSlot[]): void {
 const bad = (why: string) => new RollupRejection('group-invalid', why);
 for (let i = 0; i < slots.length; i++) {
  const { groupId, groupSize } = slots[i];
  if (![0, 2, 3].includes(groupSize) || (groupId === 0n) !== (groupSize === 0)) throw bad('A group has two or three members and a nonzero id.');
  if (groupId === 0n || (i > 0 && slots[i - 1].groupId === groupId)) continue;
  const members = slots.slice(i, i + groupSize);
  if (members.length !== groupSize || members.some(member => member.groupId !== groupId || member.groupSize !== groupSize) || slots[i + groupSize]?.groupId === groupId) throw bad('Group members must fill consecutive slots exactly.');
  if (groupIdOf(hash, members.map(member => member.nullifiers[0])) !== groupId) throw bad('The group id does not commit to its members.');
 }
}

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
  if (!Number.isSafeInteger(epochLen) || epochLen < 1 || 1 + EPOCH_SLOTS.join * EPOCH_NULLIFIERS.join * epochLen > 2 ** EPOCH_NULLIFIER_DEPTH) throw new RollupRejection('epoch-length', 'An epoch is a positive whole number of batches whose nullifiers fit one epoch set.');
  return new EpochState(hash, epochLen, leaves);
 }
 get prevNfRoot(): bigint { return this.prevNf.root(); }
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
  if (kind === 'recover') throw new Error('Recover batches are not implemented.');
  const width = EPOCH_SLOTS[kind], m = EPOCH_NULLIFIERS[kind];
  if (slots.length !== width) throw new RollupRejection('slot-count', `A batch has exactly ${width} slots.`);
  if (slots.some(slot => slot.nullifiers.length !== m)) throw new RollupRejection('slot-shape', `A ${kind} slot spends ${m} note(s).`);
  if (this.noteCount + 2 ** SUBTREE_DEPTH > 2 ** NOTE_DEPTH) throw new RollupRejection('note-tree-full', 'The note tree is full.');
  if (this.nullifiers.count() + width * m > 2 ** EPOCH_NULLIFIER_DEPTH) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  validateGroups(this.hash, slots);
  const inField = (v: bigint) => v >= 0n && v < ROLLUP_FIELD;
  if (slots.some(slot => slot.commitments.length !== 2 || !slot.commitments.every(inField) || !inField(slot.anchor) || !inField(slot.rCur.root) || !inField(slot.ctDigest))) throw new RollupRejection('slot-shape', 'A slot has two field-element commitments.');
  const oldCommitment = this.commitment(), pubs: bigint[] = [], noteCount = this.noteCount, batchCount = this.batchCount;
  const noteSlot = noteCount / 2 ** SUBTREE_DEPTH, windowSlot = batchCount % 2 ** WINDOW_DEPTH;
  const before = {
   noteRoot: this.notes.root(), noteCount: BigInt(noteCount), noteSlot: BigInt(noteSlot), slotPath: this.notes.path(noteSlot, SUBTREE_DEPTH),
   nfRoot: this.nullifiers.root(), nfCount: BigInt(this.nullifiers.count()),
   rPrev: this.prevNoteRoot, prevNfRoot: this.prevNfRoot, epoch: BigInt(this.epoch), epochLen: BigInt(this.epochLen),
   erRoot: this.archive.root(), erCount: BigInt(this.archive.count()), rsRoot: this.recovered.root(), rsCount: BigInt(this.recovered.count()),
   winRoot: this.window.root(), batchCount: BigInt(batchCount), batchQ: BigInt(Math.floor(batchCount / this.epochLen)), batchR: BigInt(batchCount % this.epochLen),
   winOldLeaf: this.window.node(0, windowSlot), winSlotPath: this.window.path(windowSlot),
  };
  const parts = [this.notes, this.nullifiers, this.window];
  for (const part of parts) part.begin();
  this.undo = () => { for (const part of parts) part.rollback(); this.noteCount = noteCount; this.batchCount = batchCount; this.undo = undefined; };
  try {
   const lists = { pub: [], anchor: [], rCurRoot: [], rCurEpoch: [], nf: [], cm: [], ctDigest: [], groupId: [], groupSize: [], winIdx: [], winPath: [], predIdx: [], pred: [], predPath: [], appendPath: [], nmIdx: [], nmLeaf: [], nmPath: [] } as Record<string, unknown[]>;
   let da = 0n;
   for (const slot of slots) {
    const { anchor, rCur } = slot;
    // The tag test runs first: windowLeafOf cannot hash a fractional epoch.
    const winIdx = rCur.epoch === this.epoch || rCur.epoch === this.epoch - 1 ? this.windowIndex(rCur) : -1;
    if (winIdx < 0) throw new RollupRejection('window-tag', 'The spend anchors on a root that is not a window leaf of a live epoch.');
    if (anchor !== anchorOf(this.hash, this.prevNoteRoot, rCur.root)) throw new RollupRejection('stale-anchor', 'The anchor does not open against this batch\'s previous-epoch root.');
    const pub = statementOf(this.hash, { domain: ROLLUP_DOMAIN, ...slot, root: anchor });
    pubs.push(pub);
    lists.pub.push(pub); lists.anchor.push(anchor); lists.rCurRoot.push(rCur.root); lists.rCurEpoch.push(BigInt(rCur.epoch));
    lists.nf.push(slot.nullifiers); lists.cm.push(slot.commitments);
    lists.ctDigest.push(slot.ctDigest); lists.groupId.push(slot.groupId); lists.groupSize.push(BigInt(slot.groupSize));
    lists.winIdx.push(BigInt(winIdx)); lists.winPath.push(this.window.path(winIdx));
    for (const nullifier of slot.nullifiers) {
     const absent = this.prevNf.nonMember(nullifier), insertion = this.nullifiers.insert(nullifier);
     lists.nmIdx.push(BigInt(absent.index)); lists.nmLeaf.push(absent.leaf); lists.nmPath.push(absent.path);
     lists.predIdx.push(BigInt(insertion.predIdx)); lists.pred.push(insertion.pred);
     lists.predPath.push(insertion.predPath); lists.appendPath.push(insertion.appendPath);
    }
    da = this.hash([da, ...slot.nullifiers, slot.commitments[0], slot.commitments[1], slot.ctDigest]);
   }
   const commitments = slots.flatMap(slot => slot.commitments);
   let level = Array.from({ length: 2 ** SUBTREE_DEPTH }, (_, i) => commitments[i] ?? 0n);
   while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => this.hash([level[2 * i], level[2 * i + 1]]));
   const blockRoot = level[0];
   if (this.leaves) commitments.forEach((commitment, offset) => this.notes.set(noteCount + offset, commitment));
   else this.notes.setAt(SUBTREE_DEPTH, noteSlot, blockRoot);
   this.noteCount += 2 ** SUBTREE_DEPTH;
   this.window.set(windowSlot, windowLeafOf(this.hash, { epoch: this.epoch, root: this.notes.root() }));
   this.batchCount += 1;
   const binding = epochBindingOf(kind, oldCommitment, this.commitment(), da, blockRoot);
   const statement = sha256le248(binding);
   return { witness: { ...lists, statement, ...before, winNewEpoch: BigInt(this.epoch) }, publicSignals: [...pubs, statement], binding, daRoot: da, blockRoot, rotated: false };
  } catch (error) { this.undo(); throw error; }
 }

 undoLast(): void {
  if (!this.undo) throw new Error('There is no batch to undo.');
  this.undo();
 }
}
