import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { NULLIFIER_TAG, RollupRejection } from '../packages/protocol/src/rollup/constants.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { DeepTree } from '../packages/protocol/src/rollup/tree.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));

test('insertions keep the list sorted and return the circuit witness', () => {
 const set = new RollupNullifiers(hash);
 set.insert(50n);
 set.insert(10n);
 const witness = set.insert(30n);
 assert.deepEqual(witness.pred, [10n, 1n, 50n]);
 assert.equal(witness.predIdx, 2);
 assert.equal(set.count(), 4);
 const mirror = new DeepTree(hash, 32);
 const leaves: [bigint, number, bigint][] = [[0n, 2, 10n], [50n, 0, 0n], [10n, 3, 30n], [30n, 1, 50n]];
 leaves.forEach(([value, next, nextValue], index) => mirror.set(index, hash([NULLIFIER_TAG, value, BigInt(next), nextValue])));
 assert.equal(set.root(), mirror.root());
});

test('re-inserting a spent nullifier is a double spend', () => {
 const set = new RollupNullifiers(hash);
 set.insert(7n);
 assert.throws(() => set.insert(7n), (error: unknown) => error instanceof RollupRejection && error.code === 'double-spend');
 assert.throws(() => set.insert(0n), /outside the field/);
});

test('rollback undoes every insertion since begin', () => {
 const set = new RollupNullifiers(hash), untouched = new RollupNullifiers(hash);
 set.insert(50n); untouched.insert(50n);
 set.begin();
 set.insert(10n); set.insert(70n);
 set.rollback();
 assert.equal(set.root(), untouched.root());
 assert.equal(set.has(10n), false);
 assert.deepEqual(set.insert(30n), untouched.insert(30n));
});

test('clones do not share leaves', () => {
 const set = new RollupNullifiers(hash);
 set.clone().insert(9n);
 assert.equal(set.has(9n), false);
 assert.equal(set.count(), 1);
});
