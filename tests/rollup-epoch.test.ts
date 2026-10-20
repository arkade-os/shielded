import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { ARCHIVE_DEPTH, BATCH_SLOTS, EPOCH_NULLIFIER_DEPTH, EPOCH_TAG, NOTE_DEPTH, RECOVERED_DEPTH, ROLLUP_FIELD, RS_TAG, STATE_TAG } from '../packages/protocol/src/rollup/constants.ts';
import { EpochState, anchorOf, windowLeafOf } from '../packages/protocol/src/rollup/epoch.ts';
import { groupIdOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { bindingOf } from '../packages/protocol/src/rollup/state.ts';
import { DeepTree } from '../packages/protocol/src/rollup/tree.ts';
import { epochHarness, rejection } from './fixtures/epoch.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { fresh, deposit, fastSlot, fill } = epochHarness(hash);

test('genesis validates EPOCH_LEN against the nullifier depth', () => {
 assert.equal(EpochState.genesis(hash, 1_677_721).epochLen, 1_677_721);
 for (const bad of [0, -1, 1.5, NaN, 1_677_722]) assert.throws(() => EpochState.genesis(hash, bad), rejection('epoch-length'));
});

test('a batch appends 32 leaves, writes a tagged window leaf and fills both digest slots', () => {
 const state = EpochState.genesis(hash, 1024);
 const oldCommitment = state.commitment();
 const result = state.apply('spend', fill(state, [deposit(state, 1000n).slot]));
 assert.equal(state.noteCount, 32);
 assert.equal(state.batchCount, 1);
 assert.equal(state.epoch, 0);
 assert.equal(result.rotated, false);
 assert.equal(state.nullifiers.count(), 1 + BATCH_SLOTS);
 assert.equal(state.window.node(0, 0), windowLeafOf(hash, { epoch: 0, root: state.notes.root() }));
 assert.equal(result.binding.length, 133);
 assert.deepEqual([...result.binding.subarray(0, 5)], [0x53, 0x48, 2, 0, BATCH_SLOTS]);
 assert.deepEqual(result.binding, bindingOf('spend', oldCommitment, state.commitment(), result.daRoot, result.blockRoot));
 const emptyNf = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH).root();
 assert.equal(state.epochDigest(), hash([EPOCH_TAG, 0n, 1024n, new DeepTree(hash, NOTE_DEPTH).root(), emptyNf, new DeepTree(hash, ARCHIVE_DEPTH).root(), 0n]));
 assert.equal(state.rsDigest(), hash([RS_TAG, new RollupNullifiers(hash, RECOVERED_DEPTH).root(), 1n]));
 assert.equal(state.commitment(), hash([STATE_TAG, state.notes.root(), 32n, state.nullifiers.root(), BigInt(state.nullifiers.count()), state.window.root(), 1n, state.epochDigest(), state.rsDigest()]));
});

test('the anchor must open against the batch prevNoteRoot', () => {
 const state = EpochState.genesis(hash, 1024);
 state.apply('spend', fill(state));
 const slot = fastSlot(state);
 assert.throws(() => state.apply('spend', fill(state, [{ ...slot, anchor: anchorOf(hash, state.latestRoot(), slot.rCur.root) }])), rejection('stale-anchor'));
 assert.doesNotThrow(() => state.apply('spend', fill(state, [slot])));
});

test('a forged window pair is refused', () => {
 const state = EpochState.genesis(hash, 1024);
 state.apply('spend', fill(state));
 const realRoot = state.latestRoot();
 for (const ref of [{ epoch: 1, root: realRoot }, { epoch: -1, root: realRoot }, { epoch: 0.5, root: realRoot }, { epoch: 0, root: realRoot + 1n }])
  assert.throws(() => state.apply('spend', fill(state, [fastSlot(state, 0n, ref)])), rejection('window-tag'));
 assert.throws(() => state.apply('spend', fill(state, [fastSlot(state, 0n, { epoch: 0, root: realRoot + ROLLUP_FIELD })])), rejection('slot-shape'));
 assert.doesNotThrow(() => state.apply('spend', fill(state, [fastSlot(state, 0n, { epoch: 0, root: realRoot })])));
});

test('an rCur that has rolled out of the 64-slot window is refused, a fresh one is not', () => {
 const state = EpochState.genesis(hash, 128);
 state.apply('spend', fill(state));
 const stale = { epoch: 0, root: state.latestRoot() };
 for (let i = 1; i < 64; i++) state.apply('spend', fill(state));
 assert.equal(state.windowIndex(stale), 0);
 state.apply('spend', fill(state));
 assert.equal(state.windowIndex(stale), -1);
 assert.throws(() => state.apply('spend', fill(state, [fastSlot(state, 0n, stale)])), rejection('window-tag'));
 assert.ok(state.apply('spend', fill(state, [fastSlot(state, 0n, { epoch: 0, root: state.latestRoot() })])));
});

test('undoLast restores the prior commitment, and a failed apply changes nothing', () => {
 const state = EpochState.genesis(hash, 1024);
 state.apply('spend', fill(state));
 const before = state.commitment(), spent = state.nullifiers.count();
 const twin = fastSlot(state);
 assert.throws(() => state.apply('spend', fill(state, [fastSlot(state), twin, twin])), rejection('double-spend'));
 assert.equal(state.commitment(), before);
 assert.equal(state.nullifiers.count(), spent);
 const slots = fill(state), first = state.apply('spend', slots);
 state.undoLast();
 assert.equal(state.commitment(), before);
 assert.deepEqual(state.apply('spend', slots), first);
 state.undoLast();
 assert.throws(() => state.undoLast(), /no batch to undo/);
});

test('the witness carries every circuit field and proves non-membership against the previous set', () => {
 const state = EpochState.genesis(hash, 1024);
 state.apply('spend', fill(state));
 state.batchCount = 2 * 1024 + 2;
 const { witness } = state.apply('spend', fill(state));
 const fields = 'pub anchor rCurRoot rCurEpoch nf cm ctDigest groupId groupSize winIdx winPath predIdx pred predPath appendPath nmIdx nmLeaf nmPath statement noteRoot noteCount noteSlot slotPath nfRoot nfCount rPrev prevNfRoot epoch epochLen erRoot erCount rsRoot rsCount winRoot winNewEpoch batchCount batchQ batchR winOldLeaf winSlotPath';
 assert.deepEqual(Object.keys(witness).sort(), fields.split(' ').sort());
 assert.deepEqual([witness.batchQ, witness.batchR], [2n, 2n]);
 const previous = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
 assert.equal(witness.prevNfRoot, previous.root());
 assert.deepEqual(witness.nmLeaf, Array(BATCH_SLOTS).fill([0n, 0n, 0n]));
 assert.deepEqual(witness.nmPath, Array(BATCH_SLOTS).fill(previous.tree.path(0)));
});

test('a join batch proves both nullifiers of every slot absent and inserts them', () => {
 const state = EpochState.genesis(hash, 1024);
 const input = () => ({ amount: 0n, ask: fresh(), nk: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
 const result = state.apply('join', Array.from({ length: BATCH_SLOTS }, () => deposit(state, 0n, { inputs: [input(), input()] }).slot));
 assert.equal(state.nullifiers.count(), 1 + 2 * BATCH_SLOTS);
 assert.equal((result.witness.nmPath as unknown[]).length, 2 * BATCH_SLOTS);
 assert.deepEqual([...result.binding.subarray(3, 5)], [1, BATCH_SLOTS]);
});

test('a group must fill consecutive slots and commit to its members', () => {
 const state = EpochState.genesis(hash, 1024);
 const [a, b] = [fastSlot(state), fastSlot(state)];
 const groupId = groupIdOf(hash, [a.nullifiers[0], b.nullifiers[0]]);
 assert.doesNotThrow(() => state.apply('spend', fill(state, [{ ...a, groupId, groupSize: 2 }, { ...b, groupId, groupSize: 2 }])));
 state.undoLast();
 assert.throws(() => state.apply('spend', fill(state, [{ ...a, groupId, groupSize: 2 }])), rejection('group-invalid'));
});

test('a clone and an operator state apply a batch exactly as the leaf state does, and the clone shares nothing', () => {
 const state = EpochState.genesis(hash, 1024), spliced = EpochState.genesis(hash, 1024, false);
 const first = fill(state);
 assert.deepEqual(spliced.apply('spend', first), state.apply('spend', first));
 const copy = state.clone(), slots = fill(state);
 assert.deepEqual(copy.apply('spend', slots), state.apply('spend', slots));
 const committed = state.commitment();
 copy.apply('spend', fill(copy));
 assert.equal(state.commitment(), committed);
});
