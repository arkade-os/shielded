import { NULLIFIER_DEPTH, NULLIFIER_TAG, ROLLUP_FIELD, RollupRejection } from './constants.ts';
import type { Hash } from './notes.ts';
import { DeepTree } from './tree.ts';

export interface NullifierLeaf { value: bigint; nextIndex: number; nextValue: bigint }
export interface InsertionWitness { predIdx: number; pred: [bigint, bigint, bigint]; predPath: bigint[]; appendPath: bigint[] }

// Indexed (sorted linked list) nullifier set, sentinel at index 0, as circuits/rollup/lib.circom IndexedInsert proves it.
export class RollupNullifiers {
 private tree: DeepTree;
 private leaves: NullifierLeaf[] = [{ value: 0n, nextIndex: 0, nextValue: 0n }];
 private values = new Set<bigint>();
 constructor(private readonly hash: Hash) {
  this.tree = new DeepTree(hash, NULLIFIER_DEPTH);
  this.tree.set(0, this.leafHash(this.leaves[0]));
 }
 private leafHash(leaf: NullifierLeaf): bigint { return this.hash([NULLIFIER_TAG, leaf.value, BigInt(leaf.nextIndex), leaf.nextValue]); }
 root(): bigint { return this.tree.root(); }
 count(): number { return this.leaves.length; }
 has(value: bigint): boolean { return this.values.has(value); }
 clone(): RollupNullifiers {
  const copy = new RollupNullifiers(this.hash);
  copy.tree = this.tree.clone();
  copy.leaves = this.leaves.map(leaf => ({ ...leaf }));
  copy.values = new Set(this.values);
  return copy;
 }
 insert(value: bigint): InsertionWitness {
  if (value <= 0n || value >= ROLLUP_FIELD) throw new Error('Nullifier is outside the field.');
  if (this.values.has(value)) throw new RollupRejection('double-spend', 'The nullifier is already spent.');
  if (this.leaves.length >= 2 ** NULLIFIER_DEPTH) throw new RollupRejection('nullifier-tree-full', 'The nullifier set is full.');
  // ponytail: linear predecessor walk; the operator (Plan 3) needs an ordered index at scale.
  let predIdx = 0;
  while (this.leaves[predIdx].nextIndex !== 0 && this.leaves[predIdx].nextValue < value) predIdx = this.leaves[predIdx].nextIndex;
  const prior = this.leaves[predIdx], count = this.leaves.length;
  const witness: InsertionWitness = { predIdx, pred: [prior.value, BigInt(prior.nextIndex), prior.nextValue], predPath: this.tree.path(predIdx), appendPath: [] };
  this.leaves[predIdx] = { value: prior.value, nextIndex: count, nextValue: value };
  this.tree.set(predIdx, this.leafHash(this.leaves[predIdx]));
  witness.appendPath = this.tree.path(count);
  this.leaves.push({ value, nextIndex: prior.nextIndex, nextValue: prior.nextValue });
  this.tree.set(count, this.leafHash(this.leaves[count]));
  this.values.add(value);
  return witness;
 }
}
