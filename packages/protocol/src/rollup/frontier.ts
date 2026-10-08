import { NOTE_DEPTH, SUBTREE_DEPTH } from './constants.ts';
import type { Hash } from './notes.ts';

const BLOCK = 2 ** SUBTREE_DEPTH, UPPER = NOTE_DEPTH - SUBTREE_DEPTH;

/**
 * The note tree as a wallet needs it: the root, plus current paths for the leaves it tracks, as each batch appends a
 * 32-leaf block. Each append costs about 60 hashes, where a full replica pays ~1,500, nullifier tree included.
 */
export class NoteFrontier {
 private readonly zeros: bigint[] = [0n];
 private readonly filled: bigint[] = [];
 private readonly tracked = new Map<number, bigint[]>();
 private blocks = 0;
 private top: bigint;
 constructor(private readonly hash: Hash) {
  for (let l = 0; l < NOTE_DEPTH; l++) this.zeros.push(hash([this.zeros[l]!, this.zeros[l]!]));
  this.top = this.zeros[NOTE_DEPTH]!;
 }
 root(): bigint { return this.top; }

 append(leaves: readonly bigint[], track: readonly number[] = []): void {
  if (leaves.length > BLOCK) throw new Error('A batch appends at most 32 leaves.');
  const block = this.blocks, inner: bigint[][] = [Array.from({ length: BLOCK }, (_, i) => leaves[i] ?? 0n)];
  for (let l = 0; l < SUBTREE_DEPTH; l++) inner.push(Array.from({ length: BLOCK >> (l + 1) }, (_, i) => this.hash([inner[l]![2 * i]!, inner[l]![2 * i + 1]!])));
  const path: bigint[] = [];
  let node = inner[SUBTREE_DEPTH]![0]!;
  for (let u = 0, i = block; u < UPPER; u++, i = Math.floor(i / 2)) {
   path.push(node);
   if (i % 2 === 0) { this.filled[u] = node; node = this.hash([node, this.zeros[SUBTREE_DEPTH + u]!]); }
   else node = this.hash([this.filled[u]!, node]);
  }
  this.top = node;
  // An earlier leaf's path changes in one place only: the right sibling where this block's path joins it.
  for (const [index, siblings] of this.tracked) {
   const u = 31 - Math.clz32(Math.floor(index / BLOCK) ^ block);
   siblings[SUBTREE_DEPTH + u] = path[u]!;
  }
  for (const offset of track) {
   const siblings: bigint[] = [];
   for (let l = 0, i = offset; l < SUBTREE_DEPTH; l++, i = Math.floor(i / 2)) siblings.push(inner[l]![i % 2 === 0 ? i + 1 : i - 1]!);
   for (let u = 0, i = block; u < UPPER; u++, i = Math.floor(i / 2)) siblings.push(i % 2 === 0 ? this.zeros[SUBTREE_DEPTH + u]! : this.filled[u]!);
   this.tracked.set(block * BLOCK + offset, siblings);
  }
  this.blocks++;
 }
 path(index: number): bigint[] {
  const siblings = this.tracked.get(index);
  if (!siblings) throw new Error('That leaf is not tracked.');
  return [...siblings];
 }
 untrack(index: number): void { this.tracked.delete(index); }
}
