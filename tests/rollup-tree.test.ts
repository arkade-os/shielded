import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { DeepTree, pathBits } from '../packages/protocol/src/rollup/tree.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const rootFromPath = (leaf: bigint, index: number, path: bigint[]) =>
 path.reduce((node, sibling, level) => (Math.floor(index / 2 ** level) % 2 === 0 ? hash([node, sibling]) : hash([sibling, node])), leaf);

test('depth-32 paths verify for indices past 2^31', () => {
 const tree = new DeepTree(hash, 32), indices = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1];
 for (const index of indices) tree.set(index, BigInt(index) + 1n);
 for (const index of indices) assert.equal(rootFromPath(BigInt(index) + 1n, index, tree.path(index)), tree.root(), `index ${index}`);
 assert.throws(() => tree.set(2 ** 32, 1n), /out of range/);
});

test('path bits are the binary index, least significant first', () => {
 assert.deepEqual(pathBits(6, 4), [0n, 1n, 1n, 0n]);
 assert.deepEqual(pathBits(2 ** 31, 32).slice(30), [0n, 1n]);
});

test('setting a level-5 node equals setting its 32 leaves', () => {
 const byLeaf = new DeepTree(hash, 32), byNode = new DeepTree(hash, 32);
 for (let i = 0; i < 32; i++) byLeaf.set(64 + i, BigInt(i + 1));
 byNode.setAt(5, 2, byLeaf.node(5, 2));
 assert.equal(byNode.root(), byLeaf.root());
 assert.deepEqual(byNode.path(2, 5), byLeaf.path(2, 5));
});

test('clones are independent', () => {
 const tree = new DeepTree(hash, 8);
 tree.set(3, 9n);
 const copy = tree.clone();
 copy.set(4, 1n);
 assert.notEqual(copy.root(), tree.root());
});
