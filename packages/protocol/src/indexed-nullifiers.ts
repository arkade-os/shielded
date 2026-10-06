import { STOCK_DOMAIN, STOCK_FIELD } from './stock-native.js';

export const STOCK_NULLIFIER_DEPTH = 9;
export const STOCK_NULLIFIER_CAPACITY = 1 << STOCK_NULLIFIER_DEPTH;
export const STOCK_NULLIFIER_TAG = STOCK_DOMAIN + 301n;
export interface IndexedNullifierLeaf { value: string; nextIndex: number; nextValue: string }
export interface IndexedNullifierCheckpoint { version: 1; leaves: IndexedNullifierLeaf[] }
export interface IndexedNullifierWitness {
 nfCount: number;
 nfPredecessorIndex: number;
 nfPredecessor: [string, number, string];
 nfPredecessorPath: string[];
 nfAppendPath: string[];
}
type Hash = (values: bigint[]) => bigint;
function field(value: string): bigint {
 if (typeof value !== 'string' || value.length > 77 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= STOCK_FIELD) throw new Error('Invalid indexed nullifier field.');
 return BigInt(value);
}
export class SparseMerkleTree {
 private nodes = new Map<string, bigint>();
 private readonly empty: bigint[];
 constructor(private readonly hash: Hash, readonly depth: number) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 24) throw new Error('Unsupported sparse tree depth.');
  this.empty = [0n];
  for (let level = 0; level < depth; level++) this.empty.push(hash([this.empty[level], this.empty[level]]));
 }
 private at(level: number, index: number): bigint { return this.nodes.get(level + ':' + index) ?? this.empty[level]; }
 private index(index: number): void { if (!Number.isInteger(index) || index < 0 || index >= 2 ** this.depth) throw new Error('Sparse tree index out of range.'); }
 root(): bigint { return this.at(this.depth, 0); }
 path(index: number): string[] {
  this.index(index);
  return Array.from({ length: this.depth }, (_, level) => this.at(level, Math.floor(index / 2 ** level) ^ 1).toString());
 }
 leaf(index: number): bigint { this.index(index); return this.at(0, index); }
 set(index: number, value: bigint): void {
  this.index(index);
  if (value < 0n || value >= STOCK_FIELD) throw new Error('Sparse tree leaf is outside the field.');
  let node = index;
  this.nodes.set('0:' + node, value);
  for (let level = 0; level < this.depth; level++) {
   const parent = Math.floor(node / 2);
   this.nodes.set((level + 1) + ':' + parent, this.hash([this.at(level, parent * 2), this.at(level, parent * 2 + 1)]));
   node = parent;
  }
 }
 clone(): SparseMerkleTree {
  const result = new SparseMerkleTree(this.hash, this.depth);
  result.nodes = new Map(this.nodes);
  return result;
 }
}
export class IndexedNullifiers {
 private tree: SparseMerkleTree;
 private leaves: IndexedNullifierLeaf[];
 constructor(private readonly hash: Hash, checkpoint?: IndexedNullifierCheckpoint) {
  this.tree = new SparseMerkleTree(hash, STOCK_NULLIFIER_DEPTH);
  this.leaves = checkpoint ? structuredClone(checkpoint.leaves) : [{ value: '0', nextIndex: 0, nextValue: '0' }];
  if (checkpoint && checkpoint.version !== 1) throw new Error('Unsupported indexed nullifier checkpoint.');
  this.validate();
  this.leaves.forEach((leaf, index) => this.tree.set(index, this.leafHash(leaf)));
 }
 private leafHash(leaf: IndexedNullifierLeaf): bigint { return this.hash([STOCK_NULLIFIER_TAG, field(leaf.value), BigInt(leaf.nextIndex), field(leaf.nextValue)]); }
 private validate(): void {
  if (!Array.isArray(this.leaves) || this.leaves.length < 1 || this.leaves.length > STOCK_NULLIFIER_CAPACITY || this.leaves[0]?.value !== '0') throw new Error('Invalid indexed nullifier sentinel or count.');
  const values = new Set<string>();
  for (const [index, leaf] of this.leaves.entries()) {
   field(leaf.value); field(leaf.nextValue);
   if (!Number.isInteger(leaf.nextIndex) || leaf.nextIndex < 0 || leaf.nextIndex >= this.leaves.length || (leaf.nextIndex === 0) !== (leaf.nextValue === '0') || (index > 0 && leaf.value === '0') || values.has(leaf.value)) throw new Error('Invalid indexed nullifier link.');
   if (leaf.nextIndex && (this.leaves[leaf.nextIndex].value !== leaf.nextValue || BigInt(leaf.nextValue) <= BigInt(leaf.value))) throw new Error('Invalid indexed nullifier ordering.');
   values.add(leaf.value);
  }
  const reached = new Set<number>();
  let cursor = 0;
  do {
   if (reached.has(cursor)) throw new Error('Indexed nullifier chain contains a cycle.');
   reached.add(cursor); cursor = this.leaves[cursor].nextIndex;
  } while (cursor !== 0);
  if (reached.size !== this.leaves.length) throw new Error('Indexed nullifier chain has unreachable leaves.');
 }
 root(): bigint { return this.hash([STOCK_NULLIFIER_TAG, this.tree.root(), BigInt(this.leaves.length)]); }
 innerRoot(): bigint { return this.tree.root(); }
 count(): number { return this.leaves.length; }
 has(value: string): boolean { field(value); return this.leaves.some(leaf => leaf.value === value); }
 noopWitness(): IndexedNullifierWitness { const sentinel = this.leaves[0]; return { nfCount: this.leaves.length, nfPredecessorIndex: 0, nfPredecessor: [sentinel.value, sentinel.nextIndex, sentinel.nextValue], nfPredecessorPath: this.tree.path(0), nfAppendPath: Array(STOCK_NULLIFIER_DEPTH).fill('0') }; }
 checkpoint(): IndexedNullifierCheckpoint { return { version: 1, leaves: structuredClone(this.leaves) }; }
 insert(value: string): { next: IndexedNullifiers; witness: IndexedNullifierWitness } {
  const n = field(value);
  if (n === 0n || this.has(value)) throw new Error('Nullifier is zero or already spent.');
  if (this.leaves.length >= STOCK_NULLIFIER_CAPACITY) throw new Error('Indexed nullifier capacity exhausted.');
  let predecessor = 0;
  while (this.leaves[predecessor].nextIndex && BigInt(this.leaves[predecessor].nextValue) < n) predecessor = this.leaves[predecessor].nextIndex;
  const prior = this.leaves[predecessor], count = this.leaves.length;
  const witness: IndexedNullifierWitness = { nfCount: count, nfPredecessorIndex: predecessor, nfPredecessor: [prior.value, prior.nextIndex, prior.nextValue], nfPredecessorPath: this.tree.path(predecessor), nfAppendPath: [] };
  const next = new IndexedNullifiers(this.hash); next.tree = this.tree.clone(); next.leaves = structuredClone(this.leaves);
  next.leaves[predecessor] = { value: prior.value, nextIndex: count, nextValue: value };
  next.tree.set(predecessor, next.leafHash(next.leaves[predecessor]));
  witness.nfAppendPath = next.tree.path(count);
  next.leaves.push({ value, nextIndex: prior.nextIndex, nextValue: prior.nextValue });
  next.tree.set(count, next.leafHash(next.leaves[count]));
  return { next, witness };
 }
}