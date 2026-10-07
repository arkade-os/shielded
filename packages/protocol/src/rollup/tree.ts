import type { Hash } from './notes.ts';

// Sparse binary Poseidon tree; indices use arithmetic, not bitwise ops, so depth 32 is safe.
export class DeepTree {
 private nodes = new Map<string, bigint>();
 readonly empty: bigint[];
 constructor(private readonly hash: Hash, readonly depth: number, empty?: bigint[]) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new Error('Unsupported tree depth.');
  this.empty = empty ?? [0n];
  for (let level = this.empty.length - 1; level < depth; level++) this.empty.push(hash([this.empty[level], this.empty[level]]));
 }
 private at(level: number, index: number): bigint { return this.nodes.get(level + ':' + index) ?? this.empty[level]; }
 private check(level: number, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** (this.depth - level)) throw new Error('Tree index out of range.');
 }
 root(): bigint { return this.at(this.depth, 0); }
 node(level: number, index: number): bigint { this.check(level, index); return this.at(level, index); }
 path(index: number, fromLevel = 0): bigint[] {
  this.check(fromLevel, index);
  const out: bigint[] = [];
  for (let level = fromLevel, i = index; level < this.depth; level++, i = Math.floor(i / 2)) out.push(this.at(level, i % 2 === 0 ? i + 1 : i - 1));
  return out;
 }
 setAt(level: number, index: number, value: bigint): void {
  this.check(level, index);
  this.nodes.set(level + ':' + index, value);
  for (let l = level, i = index, v = value; l < this.depth; l++) {
   const sibling = this.at(l, i % 2 === 0 ? i + 1 : i - 1);
   v = i % 2 === 0 ? this.hash([v, sibling]) : this.hash([sibling, v]);
   i = Math.floor(i / 2);
   this.nodes.set((l + 1) + ':' + i, v);
  }
 }
 set(index: number, value: bigint): void { this.setAt(0, index, value); }
 clone(): DeepTree {
  const copy = new DeepTree(this.hash, this.depth, this.empty);
  copy.nodes = new Map(this.nodes);
  return copy;
 }
}

export const pathBits = (index: number, depth: number) => Array.from({ length: depth }, (_, level) => BigInt(Math.floor(index / 2 ** level) % 2));
