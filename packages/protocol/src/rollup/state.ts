import { BATCH_KIND_BYTE, BATCH_SLOTS, NOTE_DEPTH, NULLIFIER_DEPTH, ROLLUP_DOMAIN, RollupRejection, STATE_TAG, SUBTREE_DEPTH, WINDOW_DEPTH, type BatchKind } from './constants.ts';
import { groupIdOf, sha256le248, statementOf, type Hash } from './notes.ts';
import { RollupNullifiers } from './nullifiers.ts';
import { DeepTree } from './tree.ts';

export interface BatchSlot { root: bigint; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number }
export interface BatchResult { next: RollupState; witness: Record<string, unknown>; publicSignals: bigint[]; binding: Uint8Array; daRoot: bigint }

const le32 = (value: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
export const bindingOf = (kind: BatchKind, oldCommitment: bigint, newCommitment: bigint, daRoot: bigint) =>
 Uint8Array.from([0x53, 0x48, 2, BATCH_KIND_BYTE[kind], BATCH_SLOTS, ...le32(oldCommitment), ...le32(newCommitment), ...le32(daRoot)]);

function validateGroups(hash: Hash, slots: BatchSlot[]): void {
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

export class RollupState {
 private constructor(private readonly hash: Hash, public notes: DeepTree, public nullifiers: RollupNullifiers, public window: DeepTree, public noteCount: number, public batchCount: number) {}
 static genesis(hash: Hash): RollupState {
  return new RollupState(hash, new DeepTree(hash, NOTE_DEPTH), new RollupNullifiers(hash), new DeepTree(hash, WINDOW_DEPTH), 0, 0);
 }
 clone(): RollupState { return new RollupState(this.hash, this.notes.clone(), this.nullifiers.clone(), this.window.clone(), this.noteCount, this.batchCount); }
 commitment(): bigint {
  return this.hash([STATE_TAG, this.notes.root(), BigInt(this.noteCount), this.nullifiers.root(), BigInt(this.nullifiers.count()), this.window.root(), BigInt(this.batchCount), 0n, 0n]);
 }
 windowIndex(root: bigint): number {
  for (let k = 0; k < 2 ** WINDOW_DEPTH; k++) if (this.window.node(0, k) === root) return k;
  return -1;
 }
 latestRoot(): bigint { return this.window.node(0, (this.batchCount + 2 ** WINDOW_DEPTH - 1) % 2 ** WINDOW_DEPTH); }

 apply(kind: BatchKind, slots: BatchSlot[]): BatchResult {
  const m = kind === 'spend' ? 1 : 2;
  if (slots.length !== BATCH_SLOTS) throw new RollupRejection('slot-count', `A batch has exactly ${BATCH_SLOTS} slots.`);
  if (slots.some(slot => slot.nullifiers.length !== m)) throw new RollupRejection('slot-shape', `A ${kind} slot spends ${m} note(s).`);
  if (this.noteCount + 2 ** SUBTREE_DEPTH > 2 ** NOTE_DEPTH) throw new RollupRejection('note-tree-full', 'The note tree is full.');
  if (this.nullifiers.count() + BATCH_SLOTS * m > 2 ** NULLIFIER_DEPTH) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  validateGroups(this.hash, slots);
  const next = this.clone(), oldCommitment = this.commitment(), pubs: bigint[] = [];
  const lists = { pub: [], root: [], nf: [], cm: [], ctDigest: [], groupId: [], groupSize: [], winIdx: [], winPath: [], predIdx: [], pred: [], predPath: [], appendPath: [] } as Record<string, unknown[]>;
  let da = 0n;
  for (const slot of slots) {
   const winIdx = this.windowIndex(slot.root);
   if (winIdx < 0) throw new RollupRejection('stale-root', 'The spend proves against a root outside the 64-batch window.');
   const pub = statementOf(this.hash, { domain: ROLLUP_DOMAIN, ...slot });
   pubs.push(pub);
   lists.pub.push(pub); lists.root.push(slot.root); lists.nf.push(slot.nullifiers); lists.cm.push(slot.commitments);
   lists.ctDigest.push(slot.ctDigest); lists.groupId.push(slot.groupId); lists.groupSize.push(BigInt(slot.groupSize));
   lists.winIdx.push(BigInt(winIdx)); lists.winPath.push(this.window.path(winIdx));
   for (const nullifier of slot.nullifiers) {
    const insertion = next.nullifiers.insert(nullifier);
    lists.predIdx.push(BigInt(insertion.predIdx)); lists.pred.push(insertion.pred);
    lists.predPath.push(insertion.predPath); lists.appendPath.push(insertion.appendPath);
   }
   da = this.hash([da, ...slot.nullifiers, slot.commitments[0], slot.commitments[1], slot.ctDigest]);
  }
  const noteSlot = this.noteCount / 2 ** SUBTREE_DEPTH, windowSlot = this.batchCount % 2 ** WINDOW_DEPTH;
  // Leaf-by-leaf gives the same root as the circuit's subtree splice and keeps wallet paths available.
  slots.flatMap(slot => slot.commitments).forEach((commitment, offset) => next.notes.set(this.noteCount + offset, commitment));
  next.noteCount += 2 ** SUBTREE_DEPTH;
  next.window.set(windowSlot, next.notes.root());
  next.batchCount += 1;
  const binding = bindingOf(kind, oldCommitment, next.commitment(), da);
  const statement = sha256le248(binding);
  const witness = {
   ...lists, statement,
   noteRoot: this.notes.root(), noteCount: BigInt(this.noteCount), noteSlot: BigInt(noteSlot), slotPath: this.notes.path(noteSlot, SUBTREE_DEPTH),
   nfRoot: this.nullifiers.root(), nfCount: BigInt(this.nullifiers.count()),
   winRoot: this.window.root(), batchCount: BigInt(this.batchCount), batchQ: BigInt(Math.floor(this.batchCount / 2 ** WINDOW_DEPTH)),
   winOldLeaf: this.window.node(0, windowSlot), winSlotPath: this.window.path(windowSlot),
  };
  return { next, witness, publicSignals: [...pubs, statement], binding, daRoot: da };
 }
}
