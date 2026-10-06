import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedNullifiers, SparseMerkleTree, STOCK_NULLIFIER_CAPACITY } from '../packages/protocol/src/indexed-nullifiers.ts';
import { STOCK_FIELD } from '../packages/protocol/src/stock-native.ts';

const hash = (values: bigint[]) => values.reduce((acc, value) => (acc * 257n + value + 1n) % STOCK_FIELD, 17n);
test('indexed nullifiers accept colliding low bits, preserve ordering and survive restoration', () => {
 let tree = new IndexedNullifiers(hash);
 const initial = tree.root();
 for (const value of ['257', '1', (STOCK_FIELD - 1n).toString(), '513', (STOCK_FIELD - 2n).toString()]) {
  const before = tree.root(), result = tree.insert(value);
  assert.equal(tree.root(), before);
  assert.equal(result.witness.nfCount, tree.count());
  tree = result.next;
 }
 assert.notEqual(tree.root(), initial);
 const restored = new IndexedNullifiers(hash, tree.checkpoint());
 assert.equal(restored.root(), tree.root());
 for (const value of ['1', '257', '513']) assert.equal(restored.has(value), true);
 assert.throws(() => restored.insert('257'), /already spent/);
 assert.throws(() => restored.insert('0'), /zero/);
 const broken = tree.checkpoint();
 broken.leaves[0].nextValue = '257';
 assert.throws(() => new IndexedNullifiers(hash, broken), /ordering/);
});
test('indexed capacity exhaustion preserves every prior nullifier and sparse paths authenticate changed leaves', () => {
 let tracker = new IndexedNullifiers(hash);
 for (let value = 1; value < STOCK_NULLIFIER_CAPACITY; value++) tracker = tracker.insert(String(value)).next;
 const root = tracker.root();
 assert.throws(() => tracker.insert('1000'), /capacity exhausted/);
 assert.equal(tracker.root(), root);
 assert.equal(new IndexedNullifiers(hash, tracker.checkpoint()).has('511'), true);
 const sparse = new SparseMerkleTree(hash, 20);
 sparse.set(1_000_001, 7n);
 let node = 7n, index = 1_000_001;
 for (const sibling of sparse.path(index)) { node = index & 1 ? hash([BigInt(sibling), node]) : hash([node, BigInt(sibling)]); index = Math.floor(index / 2); }
 assert.equal(node, sparse.root());
 assert.throws(() => sparse.set(2 ** 20, 1n), /out of range/);
});