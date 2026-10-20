import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { ARCHIVE_DEPTH, BATCH_SLOTS, EPOCH_NULLIFIER_DEPTH, EPOCH_NULLIFIERS, EPOCH_SLOTS, EPOCH_TAG, ER_TAG, NOTE_DEPTH, RECOVERED_DEPTH, ROLLUP_FIELD, RS_TAG, STATE_TAG, SUBTREE_DEPTH, type EpochBatchKind } from '../packages/protocol/src/rollup/constants.ts';
import { EpochState, anchorOf, windowLeafOf, type EpochBatchResult } from '../packages/protocol/src/rollup/epoch.ts';
import { groupIdOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { bindingOf } from '../packages/protocol/src/rollup/state.ts';
import { DeepTree } from '../packages/protocol/src/rollup/tree.ts';
import { epochHarness, rejection } from './fixtures/epoch.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { dummyInput, deposit, fastSlot, fill, recoverSlot } = epochHarness(hash);
const slotsFor = (state: EpochState, kind: EpochBatchKind) => kind === 'spend' ? fill(state)
 : kind === 'join' ? Array.from({ length: BATCH_SLOTS }, () => deposit(state, 0n, { inputs: [dummyInput(), dummyInput()] }).slot)
 : [recoverSlot(state, 0, dummyInput())];
const nullifiersOf = (result: EpochBatchResult) => result.witness.nf as bigint[][];
const chainOf = (full: EpochState, kind: EpochBatchKind) => { const result = full.apply(kind, slotsFor(full, kind)); return [kind, nullifiersOf(result), result.blockRoot] as const; };

test('genesis bounds EPOCH_LEN at 2^20, which keeps an epoch inside one nullifier set', () => {
 assert.equal(EpochState.genesis(hash, 2 ** 20).epochLen, 2 ** 20);
 for (const bad of [0, -1, 1.5, NaN, 2 ** 20 + 1]) assert.throws(() => EpochState.genesis(hash, bad), rejection('epoch-length'));
 assert.ok(1 + EPOCH_SLOTS.join * EPOCH_NULLIFIERS.join * 2 ** 20 <= 2 ** EPOCH_NULLIFIER_DEPTH);
});

test('a batch appends 32 leaves, writes a tagged window leaf and fills both digest slots', () => {
 const state = EpochState.genesis(hash, 1024);
 assert.equal(state.window.node(0, 63), windowLeafOf(hash, { epoch: 0, root: new DeepTree(hash, NOTE_DEPTH).root() }));
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
 state.batchCount = 3 * 64 + 5;
 const { witness } = state.apply('spend', fill(state));
 const fields = 'pub anchor rCurRoot rCurEpoch nf cm ctDigest groupId groupSize winIdx winPath predIdx pred predPath appendPath nmIdx nmLeaf nmPath statement noteRoot noteCount noteSlot slotPath nfRoot nfCount rPrev prevNfRoot epoch epochLen erRoot erCount rsRoot rsCount winRoot winNewEpoch batchCount batchQ winOldLeaf winSlotPath epochQ epochR rotate rotNoteRoot rotNfRoot rotNfCount erLeaf erAppendPath';
 assert.deepEqual(Object.keys(witness).sort(), fields.split(' ').sort());
 assert.equal(witness.batchQ, 3n);
 assert.deepEqual([witness.epochQ, witness.epochR, witness.rotate], [0n, 197n, 0n]);
 assert.deepEqual([witness.rotNoteRoot, witness.rotNfRoot, witness.rotNfCount], [witness.noteRoot, witness.nfRoot, witness.nfCount]);
 assert.equal(witness.erLeaf, hash([ER_TAG, 0n, witness.rPrev as bigint, witness.prevNfRoot as bigint, witness.nfRoot as bigint]));
 const previous = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
 assert.equal(witness.prevNfRoot, previous.root());
 assert.deepEqual(witness.nmLeaf, Array(BATCH_SLOTS).fill([0n, 0n, 0n]));
 assert.deepEqual(witness.nmPath, Array(BATCH_SLOTS).fill(previous.tree.path(0)));
});

test('a join batch proves both nullifiers of every slot absent and inserts them', () => {
 const state = EpochState.genesis(hash, 1024);
 const result = state.apply('join', Array.from({ length: BATCH_SLOTS }, () => deposit(state, 0n, { inputs: [dummyInput(), dummyInput()] }).slot));
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
 const state = EpochState.genesis(hash, 2), spliced = EpochState.genesis(hash, 2, false);
 for (const rotates of [false, false, true]) {
  const slots = fill(state), result = state.apply('spend', slots);
  assert.equal(result.rotated, rotates);
  assert.deepEqual(spliced.apply('spend', slots), result);
 }
 const copy = state.clone(), slots = fill(state);
 assert.deepEqual(copy.apply('spend', slots), state.apply('spend', slots));
 const kept = () => ({ commitment: state.commitment(), erRoot: state.archive.root(), erCount: state.archive.count(), prevNfRoot: state.prevNfRoot, rsRoot: state.recovered.root(), rsCount: state.recovered.count() });
 const before = kept(), rotating = fill(copy), result = copy.apply('spend', rotating);
 assert.equal(result.rotated, true);
 assert.deepEqual(kept(), before);
 assert.deepEqual(state.apply('spend', rotating), result);
 const recovering = [recoverSlot(copy, 0, dummyInput())], unrecovered = kept(), recovered = copy.apply('recover', recovering);
 assert.deepEqual(kept(), unrecovered);
 assert.deepEqual(state.apply('recover', recovering), recovered);
});

test('rotation fires on every positive multiple of EPOCH_LEN and never otherwise', () => {
 const state = EpochState.genesis(hash, 4);
 const rotated = Array.from({ length: 12 }, () => state.apply('spend', fill(state)).rotated);
 assert.deepEqual(rotated, [false, false, false, false, true, false, false, false, true, false, false, false]);
 assert.equal(state.epoch, 2);
 assert.equal(state.noteCount, 32 * 4); // epoch 2 spans the 9th to the 12th batch
 assert.equal(state.batchCount, 12);
});

test('the first rotation archives the pseudo-epoch and the second archives epoch 0', () => {
 const state = EpochState.genesis(hash, 4);
 for (let i = 0; i < 4; i++) state.apply('spend', fill(state));
 const noteFinalOfEpoch0 = state.notes.root(), nfFinalOfEpoch0 = state.nullifiers.root();
 state.apply('spend', fill(state));
 assert.equal(state.archive.count(), 1);
 assert.equal(state.archive.has(-1), true);
 assert.equal(state.archive.has(0), false);
 const empty = { noteFinal: new DeepTree(hash, NOTE_DEPTH).root(), nfFinal: new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH).root() };
 assert.deepEqual(state.archive.witness(-1, 999n).archived, { epoch: -1, ...empty, nfNextFinal: nfFinalOfEpoch0 });
 for (let i = 0; i < 4; i++) state.apply('spend', fill(state));
 assert.equal(state.archive.has(0), true);
 assert.equal(state.archive.witness(0, 999n).archived.noteFinal, noteFinalOfEpoch0);
});

test('rotation freezes the previous roots and empties the current trees', () => {
 const state = EpochState.genesis(hash, 4);
 for (let i = 0; i < 4; i++) state.apply('spend', fill(state));
 const beforeRotation = { noteRoot: state.notes.root(), nfRoot: state.nullifiers.root() };
 const { rotated, blockRoot } = state.apply('spend', fill(state));
 assert.equal(rotated, true);
 assert.equal(state.prevNoteRoot, beforeRotation.noteRoot);
 assert.equal(state.prevNfRoot, beforeRotation.nfRoot);
 assert.equal(state.nullifiers.count(), 1 + BATCH_SLOTS); // sentinel plus this batch only
 assert.equal(state.noteCount, 32);
 const expected = new DeepTree(hash, NOTE_DEPTH);
 expected.setAt(SUBTREE_DEPTH, 0, blockRoot);
 assert.equal(state.notes.root(), expected.root());
});

test('a rotating batch opens the old state, appends the archive leaf and starts its slots from the fresh trees', () => {
 const state = EpochState.genesis(hash, 4);
 for (let i = 0; i < 8; i++) state.apply('spend', fill(state));
 const old = { noteRoot: state.notes.root(), nfRoot: state.nullifiers.root(), rPrev: state.prevNoteRoot, prevNfRoot: state.prevNfRoot, erRoot: state.archive.root(), erPath: state.archive.tree.path(1) };
 const { witness } = state.apply('spend', fill(state));
 assert.deepEqual([witness.epochQ, witness.epochR, witness.rotate, witness.epoch, witness.winNewEpoch], [2n, 0n, 1n, 1n, 2n]);
 assert.deepEqual([witness.noteRoot, witness.nfRoot, witness.rPrev, witness.prevNfRoot, witness.erRoot, witness.erCount], [old.noteRoot, old.nfRoot, old.rPrev, old.prevNfRoot, old.erRoot, 1n]);
 const empty = new DeepTree(hash, NOTE_DEPTH);
 assert.deepEqual([witness.rotNoteRoot, witness.rotNfRoot, witness.rotNfCount, witness.noteSlot], [empty.root(), new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH).root(), 1n, 0n]);
 assert.deepEqual(witness.slotPath, empty.path(0, SUBTREE_DEPTH));
 assert.equal(witness.erLeaf, hash([ER_TAG, 1n, old.rPrev, old.prevNfRoot, old.nfRoot]));
 assert.equal(witness.erLeaf, state.archive.tree.node(0, 1));
 assert.deepEqual(witness.erAppendPath, old.erPath);
});

test('a nullifier already in the frozen previous set is refused', () => {
 const state = EpochState.genesis(hash, 4), input = dummyInput();
 state.apply('spend', fill(state, [deposit(state, 0n, { inputs: [input] }).slot]));
 for (let i = 0; i < 4; i++) state.apply('spend', fill(state));
 assert.equal(state.epoch, 1);
 const replay = deposit(state, 0n, { inputs: [input] }).slot;
 assert.equal(state.nullifiers.has(replay.nullifiers[0]), false);
 assert.throws(() => state.apply('spend', fill(state, [replay])), rejection('double-spend'));
});

test('a c-2 tagged root still inside the window is refused', () => {
 const state = EpochState.genesis(hash, 4);
 state.apply('spend', fill(state));
 const twoEpochsBack = state.latestRoot();
 for (let i = 0; i < 8; i++) state.apply('spend', fill(state));
 assert.equal(state.epoch, 2);
 const ref = { epoch: state.epoch - 2, root: twoEpochsBack };
 assert.ok(state.windowIndex(ref) >= 0);
 assert.throws(() => state.apply('spend', fill(state, [fastSlot(state, 0n, ref)])), rejection('window-tag'));
});

test('an anchor built before a rotation is stale after it', () => {
 const state = EpochState.genesis(hash, 4);
 state.apply('spend', fill(state));
 const slot = fastSlot(state, 5n);
 assert.deepEqual(Array.from({ length: 4 }, () => state.apply('spend', fill(state)).rotated), [false, false, false, true]);
 assert.throws(() => state.apply('spend', fill(state, [slot])), rejection('stale-anchor'));
});

test('undoLast across a rotation restores the previous epoch whole', () => {
 const state = EpochState.genesis(hash, 4);
 for (let i = 0; i < 7; i++) state.apply('spend', fill(state));
 const spent = fastSlot(state);
 state.apply('spend', fill(state, [spent]));
 const { notes, nullifiers } = state;
 const snapshot = () => ({ commitment: state.commitment(), epoch: state.epoch, noteCount: state.noteCount, prevNoteRoot: state.prevNoteRoot, prevNfRoot: state.prevNfRoot, count: state.nullifiers.count(), erRoot: state.archive.root(), erCount: state.archive.count() });
 const before = snapshot(), twin = fastSlot(state);
 assert.throws(() => state.apply('spend', fill(state, [twin, twin])), rejection('double-spend'));
 assert.deepEqual(snapshot(), before);
 const slots = fill(state), first = state.apply('spend', slots);
 assert.equal(first.rotated, true);
 state.undoLast();
 assert.equal(state.notes, notes);
 assert.equal(state.nullifiers, nullifiers);
 assert.equal(state.nullifiers.has(spent.nullifiers[0]), true);
 assert.deepEqual(snapshot(), before);
 assert.deepEqual(state.apply('spend', slots), first);
});

test('room is checked in the trees a batch writes, so the batch that closes a full epoch still lands', () => {
 const state = EpochState.genesis(hash, 2);
 state.apply('spend', fill(state));
 state.noteCount = 2 ** 32;
 assert.throws(() => state.apply('spend', fill(state)), rejection('note-tree-full'));
 state.noteCount = 32;
 state.apply('spend', fill(state));
 state.noteCount = 2 ** 32;
 assert.equal(state.apply('spend', fill(state)).rotated, true);
 assert.equal(state.noteCount, 32);
});

test('EPOCH_LEN 1 and 2 rotate every batch or every other batch', () => {
 const one = EpochState.genesis(hash, 1);
 assert.equal(one.apply('spend', fill(one)).rotated, false);
 assert.equal(one.apply('spend', fill(one)).rotated, true);
 assert.equal(one.epoch, 1);
 assert.equal(one.apply('spend', fill(one)).rotated, true);
 assert.equal(one.archive.has(0), true);
 const two = EpochState.genesis(hash, 2);
 assert.deepEqual([0, 1, 2, 3].map(() => two.apply('spend', fill(two)).rotated), [false, false, true, false]);
});

test('the rotating batch refuses a nullifier of the epoch it closes and a c-2 tagged root', () => {
 const state = EpochState.genesis(hash, 4), input = dummyInput();
 state.apply('spend', fill(state));
 const twoEpochsBack = state.latestRoot();
 for (let i = 0; i < 6; i++) state.apply('spend', fill(state));
 state.apply('spend', fill(state, [deposit(state, 0n, { inputs: [input] }).slot]));
 assert.deepEqual([state.epoch, state.batchCount % state.epochLen], [1, 0]);
 assert.throws(() => state.apply('spend', fill(state, [deposit(state, 0n, { inputs: [input] }).slot])), rejection('double-spend'));
 const ref = { epoch: 0, root: twoEpochsBack };
 assert.ok(state.windowIndex(ref) >= 0);
 assert.throws(() => state.apply('spend', fill(state, [fastSlot(state, 0n, ref)])), rejection('window-tag'));
 assert.equal(state.apply('spend', fill(state)).rotated, true);
});

test('undoing a batch after a rotation keeps the archived epoch', () => {
 const state = EpochState.genesis(hash, 2);
 for (let i = 0; i < 3; i++) state.apply('spend', fill(state));
 const kept = () => ({ commitment: state.commitment(), count: state.archive.count() }), before = kept();
 state.apply('spend', fill(state));
 state.undoLast();
 assert.deepEqual(kept(), before);
});

test('a follower reaches the same commitment across three rotations and every kind', () => {
 const full = EpochState.genesis(hash, 4), follower = EpochState.genesis(hash, 4, false);
 // epochLen 4, so batches 1-4 are epoch 0 and the first archived epoch is reachable from batch 9
 const script: EpochBatchKind[] = ['spend', 'join', 'spend', 'spend', 'join', 'spend', 'spend', 'join', 'spend', 'recover', 'spend', 'join', 'recover'];
 for (const kind of script) {
  const result = full.apply(kind, slotsFor(full, kind));
  assert.equal(follower.applyFromChain(kind, nullifiersOf(result), result.blockRoot), full.commitment());
  assert.equal(follower.epoch, full.epoch);
 }
 assert.ok(full.epoch >= 3);
 assert.equal(follower.archive.root(), full.archive.root());
 assert.equal(follower.recovered.root(), full.recovered.root());
});

test('a follower rotates before it checks room, then checks the set its kind inserts into', () => {
 const full = EpochState.genesis(hash, 3), follower = EpochState.genesis(hash, 3, false);
 for (let i = 0; i < 6; i++) follower.applyFromChain(...chainOf(full, 'spend'));
 follower.noteCount = 2 ** 32;
 follower.nullifiers.count = () => 2 ** EPOCH_NULLIFIER_DEPTH;
 assert.equal(follower.applyFromChain(...chainOf(full, 'join')), full.commitment()); // batch 7 rotates, so the full trees are the ones it closes
 follower.nullifiers.count = () => 2 ** EPOCH_NULLIFIER_DEPTH;
 assert.ok(follower.applyFromChain(...chainOf(full, 'recover')));
 const spend = chainOf(full, 'spend');
 assert.throws(() => follower.applyFromChain(...spend), rejection('nullifier-tree-full'));
});

test('a failed applyFromChain changes nothing, and undoLast reverts a rotating one', () => {
 const full = EpochState.genesis(hash, 2), follower = EpochState.genesis(hash, 2, false);
 for (let i = 0; i < 2; i++) follower.applyFromChain(...chainOf(full, 'spend'));
 const before = follower.commitment(), [kind, nullifiers, blockRoot] = chainOf(full, 'spend');
 assert.throws(() => follower.applyFromChain(kind, nullifiers.map(() => nullifiers[0]), blockRoot), rejection('double-spend'));
 assert.equal(follower.commitment(), before);
 assert.equal(follower.applyFromChain(kind, nullifiers, blockRoot), full.commitment());
 assert.equal(follower.epoch, 1);
 follower.undoLast();
 assert.equal(follower.commitment(), before);
 assert.equal(follower.applyFromChain(kind, nullifiers, blockRoot), full.commitment());
});

test('a full archive refuses the batch that would rotate in both apply paths and still takes the others', () => {
 const full = EpochState.genesis(hash, 2), follower = EpochState.genesis(hash, 2, false);
 follower.applyFromChain(...chainOf(full, 'spend'));
 for (const state of [full, follower]) state.archive.count = () => 2 ** ARCHIVE_DEPTH;
 const plain = full.apply('spend', fill(full));
 assert.equal(plain.rotated, false);
 assert.equal(follower.applyFromChain('spend', nullifiersOf(plain), plain.blockRoot), full.commitment());
 const slots = fill(full), rotating = full.clone().apply('spend', slots);
 const kept = (state: EpochState) => ({ commitment: state.commitment(), epoch: state.epoch, noteCount: state.noteCount });
 const before = kept(full);
 assert.equal(rotating.rotated, true);
 assert.throws(() => full.apply('spend', slots), rejection('archive-full'));
 assert.throws(() => follower.applyFromChain('spend', nullifiersOf(rotating), rotating.blockRoot), rejection('archive-full'));
 assert.deepEqual([kept(full), kept(follower)], [before, before]);
});
