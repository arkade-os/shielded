import type { Hash } from './notes.ts';

// Sparse binary Poseidon tree; indices use arithmetic, not bitwise ops, so depth 32 is safe.
export class DeepTree {
 private nodes = new Map<string, bigint>();
 private log?: [string, bigint | undefined][];
 readonly empty: bigint[];
 constructor(private readonly hash: Hash, readonly depth: number, empty?: bigint[]) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new Error('Unsupported tree depth.');
  this.empty = empty ?? [0n];
  for (let level = this.empty.length - 1; level < depth; level++) this.empty.push(hash([this.empty[level], this.empty[level]]));
 }
 private at(level: number, index: number): bigint { return this.nodes.get(level + ':' + index) ?? this.empty[level]; }
 private check(level: number, index: number): void {
  if (!Number.isInteger(level) || level < 0 || level > this.depth || !Number.isSafeInteger(index) || index < 0 || index >= 2 ** (this.depth - level)) throw new Error('Tree index out of range.');
 }
 root(): bigint { return this.at(this.depth, 0); }
 node(level: number, index: number): bigint { this.check(level, index); return this.at(level, index); }
 path(index: number, fromLevel = 0): bigint[] {
  this.check(fromLevel, index);
  const out: bigint[] = [];
  for (let level = fromLevel, i = index; level < this.depth; level++, i = Math.floor(i / 2)) out.push(this.at(level, i % 2 === 0 ? i + 1 : i - 1));
  return out;
 }
 private write(key: string, value: bigint): void {
  this.log?.push([key, this.nodes.get(key)]);
  this.nodes.set(key, value);
 }
 setAt(level: number, index: number, value: bigint): void {
  this.check(level, index);
  this.write(level + ':' + index, value);
  for (let l = level, i = index, v = value; l < this.depth; l++) {
   const sibling = this.at(l, i % 2 === 0 ? i + 1 : i - 1);
   v = i % 2 === 0 ? this.hash([v, sibling]) : this.hash([sibling, v]);
   i = Math.floor(i / 2);
   this.write((l + 1) + ':' + i, v);
  }
 }
 /** Records writes until rollback(); a later begin() drops the record. */
 begin(): void { this.log = []; }
 rollback(): void {
  for (const [key, value] of (this.log ?? []).reverse()) if (value === undefined) this.nodes.delete(key); else this.nodes.set(key, value);
  this.log = undefined;
 }
 set(index: number, value: bigint): void { this.setAt(0, index, value); }
 scan(visit: (level: number, index: number, value: bigint) => void): void {
  for (const [key, value] of this.nodes) { const at = key.indexOf(':'); visit(Number(key.slice(0, at)), Number(key.slice(at + 1)), value); }
 }
 /** Sets one node and leaves its ancestors stale: only a restore placing every node another tree's scan() visited may use it. */
 place(level: number, index: number, value: bigint): void {
  if (this.log) throw new Error('A restore cannot place nodes inside a transaction.');
  this.check(level, index); this.write(level + ':' + index, value);
 }
 /** The root follows from (level, index) and the siblings on its path: everything a write there reads. */
 consistentAlong(level: number, index: number): boolean {
  let v = this.node(level, index);
  for (let l = level, i = index; l < this.depth; l++, i = Math.floor(i / 2)) {
   const sibling = this.at(l, i % 2 === 0 ? i + 1 : i - 1);
   v = i % 2 === 0 ? this.hash([v, sibling]) : this.hash([sibling, v]);
   if (v !== this.at(l + 1, Math.floor(i / 2))) return false;
  }
  return true;
 }
 /** Every stored node above the leaves is the hash of its children; linear in the stored nodes. */
 consistent(): boolean {
  for (const [key, value] of this.nodes) {
   const at = key.indexOf(':'), level = Number(key.slice(0, at)), index = Number(key.slice(at + 1));
   if (level > 0 && value !== this.hash([this.at(level - 1, 2 * index), this.at(level - 1, 2 * index + 1)])) return false;
  }
  return true;
 }
 clone(): DeepTree {
  const copy = new DeepTree(this.hash, this.depth, this.empty);
  copy.nodes = new Map(this.nodes);
  return copy;
 }
}

export const pathBits = (index: number, depth: number) => Array.from({ length: depth }, (_, level) => BigInt(Math.floor(index / 2 ** level) % 2));
