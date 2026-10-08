import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { BATCH_SLOTS, BTC_ASSET, ROLLUP_DOMAIN, ROLLUP_FIELD, RollupRejection } from '../packages/protocol/src/rollup/constants.ts';
import { clientWitness, type ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { groupIdOf, nullifierOf, ownerOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupState, type BatchSlot } from '../packages/protocol/src/rollup/state.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const owner = ownerOf(hash, ROLLUP_DOMAIN, 7n);
let counter = 100n;
const fresh = () => ++counter;
const dummyInput = () => ({ amount: 0n, spendSecret: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
const deposit = (state: RollupState, amount: bigint, extra: Partial<ClientSpend> = {}) => clientWitness(hash, {
 domain: ROLLUP_DOMAIN, root: state.latestRoot(), asset: BTC_ASSET, inputs: [dummyInput()],
 outputs: [{ amount, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }],
 deposit: amount, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...extra,
});
const fill = (state: RollupState, first: BatchSlot[] = []) => [...first, ...Array.from({ length: BATCH_SLOTS - first.length }, () => deposit(state, 0n).slot)];
const rejection = (code: string) => (error: unknown) => error instanceof RollupRejection && error.code === code;

test('a batch appends 32 leaves, pushes the root into the window and binds both states', () => {
 const state = RollupState.genesis(hash);
 const result = state.apply('spend', fill(state, [deposit(state, 1000n).slot]));
 assert.equal(state.noteCount, 32);
 assert.equal(state.batchCount, 1);
 assert.equal(state.nullifiers.count(), 12);
 assert.equal(state.latestRoot(), state.notes.root());
 assert.equal(result.binding.length, 101);
 assert.deepEqual([...result.binding.subarray(0, 5)], [0x53, 0x48, 2, 0, 11]);
 const digest = createHash('sha256').update(result.binding).digest();
 assert.equal(result.publicSignals.at(-1), BigInt('0x' + Buffer.from(digest.subarray(0, 31)).reverse().toString('hex')));
});

test('undoLast restores the prior state, and a failed apply changes nothing', () => {
 const state = RollupState.genesis(hash);
 state.apply('spend', fill(state));
 const before = state.commitment(), spent = state.nullifiers.count();
 const twin = deposit(state, 1n).slot;
 assert.throws(() => state.apply('spend', fill(state, [deposit(state, 2n).slot, twin, twin])), rejection('double-spend'));
 assert.equal(state.commitment(), before);
 assert.equal(state.nullifiers.count(), spent);
 const slots = fill(state), first = state.apply('spend', slots);
 state.undoLast();
 assert.equal(state.commitment(), before);
 assert.deepEqual(state.apply('spend', slots).publicSignals, first.publicSignals);
 state.undoLast();
 assert.throws(() => state.undoLast(), /no batch to undo/);
});

test('zero or out-of-field nullifiers and malformed commitments are rejections', () => {
 const state = RollupState.genesis(hash);
 const slot = deposit(state, 0n).slot;
 assert.throws(() => state.apply('spend', fill(state, [{ ...slot, nullifiers: [0n] }])), rejection('nullifier-range'));
 assert.throws(() => state.apply('spend', fill(state, [{ ...slot, nullifiers: [ROLLUP_FIELD] }])), rejection('nullifier-range'));
 assert.throws(() => state.apply('spend', fill(state, [{ ...slot, commitments: [...slot.commitments, 1n] as unknown as [bigint, bigint] }])), rejection('slot-shape'));
 assert.throws(() => state.apply('spend', fill(state, [{ ...slot, commitments: [ROLLUP_FIELD, 1n] }])), rejection('slot-shape'));
 assert.equal(state.batchCount, 0);
});

test('a root older than the 64-batch window is stale', () => {
 const state = RollupState.genesis(hash);
 state.apply('spend', fill(state));
 const old = state.latestRoot();
 for (let i = 0; i < 64; i++) state.apply('spend', fill(state));
 assert.throws(() => state.apply('spend', fill(state, [{ ...deposit(state, 0n).slot, root: old }])), rejection('stale-root'));
});

test('a nullifier spent earlier, or twice in one batch, is a double spend', () => {
 const state = RollupState.genesis(hash);
 const first = deposit(state, 5n).slot;
 state.apply('spend', fill(state, [first]));
 assert.throws(() => state.apply('spend', fill(state, [{ ...first, root: state.latestRoot() }])), rejection('double-spend'));
 const twin = deposit(state, 1n).slot;
 assert.throws(() => state.apply('spend', fill(state, [twin, twin])), rejection('double-spend'));
});

test('batch shape and capacity are exact', () => {
 const state = RollupState.genesis(hash);
 assert.throws(() => state.apply('spend', fill(state).slice(1)), rejection('slot-count'));
 assert.throws(() => state.apply('join', fill(state)), rejection('slot-shape'));
 const full = state.clone();
 full.noteCount = 2 ** 32;
 assert.throws(() => full.apply('spend', fill(full)), rejection('note-tree-full'));
});

test('groups must be complete, consecutive and commit to their members', () => {
 const state = RollupState.genesis(hash);
 const inputs = [dummyInput(), dummyInput()];
 const groupId = groupIdOf(hash, inputs.map(input => nullifierOf(hash, ROLLUP_DOMAIN, input.spendSecret, input.rho)));
 const [a, b] = inputs.map(input => deposit(state, 1n, { inputs: [input], groupId, groupSize: 2 }).slot);
 assert.doesNotThrow(() => state.apply('spend', fill(state, [a, b])));
 state.undoLast();
 assert.throws(() => state.apply('spend', fill(state, [a])), rejection('group-invalid'));
 const gap = fill(state, [a]);
 gap.splice(2, 0, b);
 gap.pop();
 assert.throws(() => state.apply('spend', gap), rejection('group-invalid'));
 const forgedId = groupIdOf(hash, [1n, 2n]);
 assert.throws(() => state.apply('spend', fill(state, [{ ...a, groupId: forgedId }, { ...b, groupId: forgedId }])), rejection('group-invalid'));
});

test('a join batch inserts two nullifiers per slot', () => {
 const state = RollupState.genesis(hash);
 const slots = Array.from({ length: BATCH_SLOTS }, () => clientWitness(hash, {
  domain: ROLLUP_DOMAIN, root: state.latestRoot(), asset: BTC_ASSET, inputs: [dummyInput(), dummyInput()],
  outputs: [{ amount: 0n, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }],
  deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0,
 }).slot);
 const result = state.apply('join', slots);
 assert.equal(state.nullifiers.count(), 1 + 2 * BATCH_SLOTS);
 assert.equal(result.binding[3], 1);
});
