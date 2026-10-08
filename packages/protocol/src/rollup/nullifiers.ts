import { NULLIFIER_DEPTH, NULLIFIER_TAG, ROLLUP_FIELD, RollupRejection } from './constants.ts';
import type { Hash } from './notes.ts';
import { DeepTree } from './tree.ts';

export interface NullifierLeaf { value: bigint; nextIndex: number; nextValue: bigint }
export interface InsertionWitness { predIdx: number; pred: [bigint, bigint, bigint]; predPath: bigint[]; appendPath: bigint[] }

// Indexed (sorted linked list) nullifier set, sentinel at index 0, as circuits/rollup/lib.circom IndexedInsert proves it.
export class RollupNullifiers {
 private tree: DeepTree;
 private leaves: NullifierLeaf[] = [{ value: 0n, nextIndex: 0, nextValue: 0n }];
 // ponytail: sorted array with splice inserts; a B-tree once the set passes ~1e7.
 private sorted: bigint[] = [];
 private index = new Map<bigint, number>();
 private log?: { value: bigint; predIdx: number; pred: NullifierLeaf; at: number; had?: number }[];
 constructor(private readonly hash: Hash) {
  this.tree = new DeepTree(hash, NULLIFIER_DEPTH);
  this.tree.set(0, this.leafHash(this.leaves[0]));
 }
 private leafHash(leaf: NullifierLeaf): bigint { return this.hash([NULLIFIER_TAG, leaf.value, BigInt(leaf.nextIndex), leaf.nextValue]); }
 root(): bigint { return this.tree.root(); }
 count(): number { return this.leaves.length; }
 has(value: bigint): boolean { return this.index.has(value); }
 clone(): RollupNullifiers {
  const copy = new RollupNullifiers(this.hash);
  copy.tree = this.tree.clone();
  copy.leaves = this.leaves.map(leaf => ({ ...leaf }));
  copy.sorted = [...this.sorted];
  copy.index = new Map(this.index);
  return copy;
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
 insert(value: bigint): InsertionWitness {
  if (value <= 0n || value >= ROLLUP_FIELD) throw new RollupRejection('nullifier-range', 'The nullifier is zero or outside the field.');
  if (this.has(value)) throw new RollupRejection('double-spend', 'The nullifier is already spent.');
  if (this.leaves.length >= 2 ** NULLIFIER_DEPTH) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  let at = 0, hi = this.sorted.length;
  while (at < hi) { const mid = (at + hi) >>> 1; if (this.sorted[mid] < value) at = mid + 1; else hi = mid; }
  const predIdx = at === 0 ? 0 : this.index.get(this.sorted[at - 1])!;
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
