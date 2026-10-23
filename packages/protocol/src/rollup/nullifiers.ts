import { NULLIFIER_DEPTH, NULLIFIER_TAG, ROLLUP_FIELD, RollupRejection } from './constants.ts';
import type { Hash } from './notes.ts';
import { DeepTree } from './tree.ts';

export interface NullifierLeaf { value: bigint; nextIndex: number; nextValue: bigint }
export interface InsertionWitness { predIdx: number; pred: [bigint, bigint, bigint]; predPath: bigint[]; appendPath: bigint[] }
export interface NonMemberWitness { index: number; leaf: [bigint, bigint, bigint]; path: bigint[] }

// Indexed (sorted linked list) nullifier set, sentinel at index 0, as circuits/rollup/lib.circom IndexedInsert proves it.
export class RollupNullifiers {
 tree: DeepTree;
 private leaves: NullifierLeaf[] = [{ value: 0n, nextIndex: 0, nextValue: 0n }];
 // ponytail: sorted array with splice inserts; a B-tree once the set passes ~1e7.
 private sorted: bigint[] = [];
 private index = new Map<bigint, number>();
 private log?: { value: bigint; predIdx: number; pred: NullifierLeaf; at: number; had?: number }[];
 constructor(private readonly hash: Hash, readonly depth: number = NULLIFIER_DEPTH) {
  this.tree = new DeepTree(hash, depth);
  this.tree.set(0, this.leafHash(this.leaves[0]));
 }
 static fromLeaves(hash: Hash, depth: number, leaves: readonly { value: bigint; nextIndex: number }[]): RollupNullifiers {
  // Poseidon reduces mod p, so a leaf holding v + p rebuilds v's root while has(v) answers false.
  if (leaves.some(({ value }) => value >= ROLLUP_FIELD)) throw new Error('A nullifier leaf is outside the field.');
  const set = new RollupNullifiers(hash, depth), tree = new DeepTree(hash, depth);
  let level = leaves.map(({ value, nextIndex }) => set.leafHash({ value, nextIndex, nextValue: leaves[nextIndex]?.value ?? 0n }));
  for (let l = 0; l <= depth; l++) {
   level.forEach((node, i) => tree.place(l, i, node));
   if (l < depth) level = Array.from({ length: Math.ceil(level.length / 2) }, (_, i) => hash([level[2 * i], level[2 * i + 1] ?? tree.empty[l]]));
  }
  set.tree = tree;
  set.loadLeaves(leaves);
  return set;
 }
 private leafHash(leaf: NullifierLeaf): bigint { return this.hash([NULLIFIER_TAG, leaf.value, BigInt(leaf.nextIndex), leaf.nextValue]); }
 root(): bigint { return this.tree.root(); }
 count(): number { return this.leaves.length; }
 has(value: bigint): boolean { return this.index.has(value); }
 clone(): RollupNullifiers {
  const copy = new RollupNullifiers(this.hash, this.depth);
  copy.tree = this.tree.clone();
  copy.leaves = this.leaves.map(leaf => ({ ...leaf }));
  copy.sorted = [...this.sorted];
  copy.index = new Map(this.index);
  return copy;
 }
 scanLeaves(visit: (value: bigint, nextIndex: number) => void): void { for (const leaf of this.leaves) visit(leaf.value, leaf.nextIndex); }
 /** Restores the leaves over a tree placed node by node, refusing any leaf whose hash is not that tree's leaf. */
 loadLeaves(stored: readonly { value: bigint; nextIndex: number }[]): void {
  const unsorted = () => new Error('The nullifier leaves are not one sorted list from the sentinel.');
  if (stored[0]?.value !== 0n) throw unsorted();
  const sorted: bigint[] = [], index = new Map<bigint, number>();
  for (let at = stored[0].nextIndex; at !== 0; at = stored[at].nextIndex) {
   const value = stored[at]?.value;
   if (value === undefined || value <= (sorted.at(-1) ?? 0n)) throw unsorted();
   sorted.push(value); index.set(value, at);
  }
  if (sorted.length !== stored.length - 1) throw unsorted();
  // In bounds: the walk reached every leaf, so each nextIndex was either followed to a leaf or ended it at 0.
  const leaves = stored.map(({ value, nextIndex }) => ({ value, nextIndex, nextValue: stored[nextIndex].value }));
  if (leaves.some((leaf, i) => this.leafHash(leaf) !== this.tree.node(0, i))) throw new Error('The nullifier leaves do not match the tree.');
  this.leaves = leaves; this.sorted = sorted; this.index = index;
 }
 begin(): void { this.log = []; this.tree.begin(); }
 rollback(): void {
  for (const op of (this.log ?? []).reverse()) {
   this.leaves.pop();
   this.leaves[op.predIdx] = op.pred;
   this.sorted.splice(op.at, 1);
   if (op.had === undefined) this.index.delete(op.value); else this.index.set(op.value, op.had);
  }
  this.log = undefined;
  this.tree.rollback();
 }
 private locate(value: bigint): { at: number; predIdx: number } {
  if (value <= 0n || value >= ROLLUP_FIELD) throw new RollupRejection('nullifier-range', 'The nullifier is zero or outside the field.');
  if (this.has(value)) throw new RollupRejection('double-spend', 'The nullifier is already spent.');
  let at = 0, hi = this.sorted.length;
  while (at < hi) { const mid = (at + hi) >>> 1; if (this.sorted[mid] < value) at = mid + 1; else hi = mid; }
  return { at, predIdx: at === 0 ? 0 : this.index.get(this.sorted[at - 1])! };
 }
 /** The low leaf proving the value absent; the maximum's leaf carries nextIndex 0 and nextValue 0, meaning no upper bound. */
 nonMember(value: bigint): NonMemberWitness {
  const { predIdx } = this.locate(value), low = this.leaves[predIdx];
  return { index: predIdx, leaf: [low.value, BigInt(low.nextIndex), low.nextValue], path: this.tree.path(predIdx) };
 }
 insert(value: bigint): InsertionWitness {
  const { at, predIdx } = this.locate(value);
  if (this.leaves.length >= 2 ** this.depth) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  const prior = this.leaves[predIdx], count = this.leaves.length;
  const witness: InsertionWitness = { predIdx, pred: [prior.value, BigInt(prior.nextIndex), prior.nextValue], predPath: this.tree.path(predIdx), appendPath: [] };
  this.leaves[predIdx] = { value: prior.value, nextIndex: count, nextValue: value };
  this.tree.set(predIdx, this.leafHash(this.leaves[predIdx]));
  witness.appendPath = this.tree.path(count);
  this.leaves.push({ value, nextIndex: prior.nextIndex, nextValue: prior.nextValue });
  this.tree.set(count, this.leafHash(this.leaves[count]));
  this.log?.push({ value, predIdx, pred: prior, at, had: this.index.get(value) });
  this.sorted.splice(at, 0, value);
  this.index.set(value, count);
  return witness;
 }
}
