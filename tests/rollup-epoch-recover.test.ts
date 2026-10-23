import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { BATCH_SLOTS, EPOCH_NULLIFIER_DEPTH, ER_TAG, NULLIFIER_TAG, RECOVERED_DEPTH, SUBTREE_DEPTH } from '../packages/protocol/src/rollup/constants.ts';
import { EpochState, anchorOf, type EpochSlot } from '../packages/protocol/src/rollup/epoch.ts';
import { epochHarness, foldPath, rejection } from './fixtures/epoch.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { dummyInput, deposit, fastSlot, fill, noteFrom, recovery, recoverSlot } = epochHarness(hash);

// epochLen 2: batch 1 makes the note in epoch 0, batch 3 opens epoch 1, and batch 5 opens epoch 2 and archives epoch 0.
const withNote = (batches: number, spendAt = 0) => {
 const state = EpochState.genesis(hash, 2), made = deposit(state, 1000n), note = noteFrom(made);
 state.apply('spend', fill(state, [made.slot]));
 for (let batch = 2; batch <= batches; batch++) state.apply('spend', fill(state, batch === spendAt ? [deposit(state, 0n, { inputs: [note] }).slot] : []));
 return { state, note };
};
const erOpened = (w: Record<string, any>) => foldPath(hash, hash([ER_TAG, w.erIdx[0], w.erNoteFinal[0], w.nfA[0], w.nfB[0]]), Number(w.erIdx[0]), w.erPath[0]);

test('a recover batch has one slot with one nullifier', () => {
 const state = EpochState.genesis(hash, 2), slot = recoverSlot(state, 0, dummyInput());
 for (const slots of [[], [slot, slot]]) assert.throws(() => state.apply('recover', slots), rejection('slot-count'));
 assert.throws(() => state.apply('recover', [{ ...slot, nullifiers: [...slot.nullifiers, 7n] }]), rejection('slot-shape'));
});

test('recovering an epoch-0 note in epoch 2 inserts into RS, not NF', () => {
 const { state, note } = withNote(5);
 const before = state.nullifiers.count(), noteCountBefore = state.noteCount;
 assert.equal(state.epoch, 2);
 const result = state.apply('recover', [recoverSlot(state, 0, note)]);
 assert.equal(state.recovered.count(), 2); // the sentinel plus this one
 assert.equal(state.nullifiers.count(), before);
 assert.equal(state.noteCount, noteCountBefore + 32); // a width-1 batch still fills one block
 assert.equal(state.notes.node(SUBTREE_DEPTH, noteCountBefore / 32), result.blockRoot);
 assert.deepEqual([...result.binding.subarray(0, 5)], [0x53, 0x48, 4, 2, 1]);
 assert.equal(state.recovered.has(note.nullifier), true);
});

test('recovery is refused while the epoch is live', () => {
 const { state, note } = withNote(3);
 assert.equal(state.epoch, 1);
 for (const slot of [0, 1].map(e => recoverSlot(state, e, note))) assert.throws(() => state.apply('recover', [slot]), rejection('recover-unarchived'));
});

test('an unarchived, negative or fractional origin is refused', () => {
 const { state, note } = withNote(5);
 const slots = [...[9, -2, 0.5, NaN].map(e => recoverSlot(state, e, note)), { ...recoverSlot(state, 0, note), origin: undefined }];
 for (const slot of slots) assert.throws(() => state.apply('recover', [slot]), rejection('recover-unarchived'));
 assert.ok(state.apply('recover', [recoverSlot(state, -1, dummyInput())])); // -1 is the archived pseudo-epoch, which only a dummy can open
});

test('a second recovery of the same note is refused', () => {
 const { state, note } = withNote(5);
 state.apply('recover', [recoverSlot(state, 0, note)]);
 assert.throws(() => state.apply('recover', [recoverSlot(state, 0, note)]), rejection('double-spend'));
 state.apply('spend', fill(state));
 assert.equal(state.epoch, 3); // RS is never reset
 assert.throws(() => state.apply('recover', [recoverSlot(state, 0, note)]), rejection('double-spend'));
});

test('a note fast-spent in its own epoch cannot be recovered later', () => {
 const { state, note } = withNote(5, 2);
 assert.throws(() => state.apply('recover', [recoverSlot(state, 0, note)]), rejection('double-spend'));
});

test('a note fast-spent in the next epoch cannot be recovered later', () => {
 const { state, note } = withNote(5, 4);
 assert.throws(() => state.apply('recover', [recoverSlot(state, 0, note)]), rejection('double-spend'));
});

test('a recovered note becomes a fresh fast-path note', () => {
 const { state, note } = withNote(5), recovered = recovery(state, 0, note), output = noteFrom(recovered);
 state.apply('recover', [recovered.slot]);
 assert.ok(state.apply('spend', fill(state, [deposit(state, 0n, { inputs: [output] }).slot])));
 assert.equal(state.nullifiers.has(output.nullifier), true);
});

test('a recover anchor must open against the archived note root of its origin', () => {
 const { state, note } = withNote(5), slot = recoverSlot(state, 0, note);
 for (const anchor of [recoverSlot(state, -1, note).anchor, fastSlot(state).anchor]) assert.throws(() => state.apply('recover', [{ ...slot, anchor }]), rejection('stale-anchor'));
 assert.ok(state.apply('recover', [slot]));
});

test('a recover slot ignores rCur, so the anchor opens noteFinal[e] twice', () => {
 const { state, note } = withNote(5), slot = recoverSlot(state, 0, note), live = state.latestRoot();
 assert.throws(() => state.apply('recover', [{ ...slot, rCur: { epoch: 0, root: live }, anchor: anchorOf(hash, live, live) }]), rejection('stale-anchor'));
 assert.ok(state.apply('recover', [{ ...slot, rCur: { epoch: state.epoch, root: live } }]));
});

test('a recover slot carries no rCur, and a fast-path slot without one is refused', () => {
 const { state, note } = withNote(5), bare = ({ rCur, ...slot }: EpochSlot): EpochSlot => slot;
 const join = () => deposit(state, 0n, { inputs: [dummyInput(), dummyInput()] }).slot;
 assert.throws(() => state.apply('spend', fill(state, [bare(fastSlot(state))])), rejection('window-tag'));
 assert.throws(() => state.apply('join', [bare(join()), ...Array.from({ length: BATCH_SLOTS - 1 }, join)]), rejection('window-tag'));
 const slot = recoverSlot(state, 0, note), withCur = state.clone().apply('recover', [slot]);
 assert.deepEqual(state.apply('recover', [bare(slot)]), withCur);
});

test('a recover batch can be the batch that rotates, and undoLast restores RS and the archive', () => {
 const { state, note } = withNote(4), slot = recoverSlot(state, 0, note);
 const snapshot = () => ({ commitment: state.commitment(), epoch: state.epoch, erCount: state.archive.count(), rsRoot: state.recovered.root(), rsCount: state.recovered.count() });
 const before = snapshot();
 assert.throws(() => state.apply('recover', [recoverSlot(state, 1, note)]), rejection('recover-unarchived'));
 assert.deepEqual(snapshot(), before);
 const first = state.apply('recover', [slot]), w = first.witness as Record<string, any>;
 assert.equal(first.rotated, true);
 assert.equal(state.recovered.has(note.nullifier), true);
 // The slot opens the leaf its own batch's rotation appended, so erPath meets the new archive root, not erRoot.
 assert.equal(erOpened(w), state.archive.root());
 assert.notEqual(erOpened(w), w.erRoot);
 state.undoLast();
 assert.deepEqual(snapshot(), before);
 assert.deepEqual(state.apply('recover', [slot]), first);
});

test('room is checked only in the set a batch inserts into: RS for recover, the post-rotation epoch set otherwise', () => {
 const { state, note } = withNote(5);
 state.nullifiers.count = () => 2 ** EPOCH_NULLIFIER_DEPTH;
 assert.throws(() => state.apply('spend', fill(state)), rejection('nullifier-tree-full'));
 assert.ok(state.apply('recover', [recoverSlot(state, 0, note)]));
 state.recovered.count = () => 2 ** RECOVERED_DEPTH;
 assert.throws(() => state.apply('recover', [recoverSlot(state, 0, dummyInput())]), rejection('nullifier-tree-full'));
 assert.equal(state.apply('spend', fill(state)).rotated, true); // the full epoch set is the one this batch closes
});

test('a recover witness opens the archive leaf, both archived sets and RS', () => {
 const { state, note } = withNote(5), w = state.apply('recover', [recoverSlot(state, 0, note)]).witness as Record<string, any>;
 const fields = 'pub anchor nf cm ctDigest groupId groupSize erIdx erPath erNoteFinal nfA nfB nmaIdx nmaLeaf nmaPath nmbIdx nmbLeaf nmbPath rsPredIdx rsPred rsPredPath rsAppendPath statement noteRoot noteCount noteSlot slotPath nfRoot nfCount rPrev prevNfRoot epoch epochLen erRoot erCount rsRoot rsCount winRoot winNewEpoch batchCount batchQ winOldLeaf winSlotPath epochQ epochR rotate rotNoteRoot rotNfRoot rotNfCount erLeaf erAppendPath';
 assert.deepEqual(Object.keys(w).sort(), fields.split(' ').sort());
 const leaf = (values: bigint[]) => hash([NULLIFIER_TAG, ...values]), [nf] = w.nf[0];
 assert.deepEqual([w.erIdx[0], w.anchor[0]], [1n, anchorOf(hash, w.erNoteFinal[0], w.erNoteFinal[0])]);
 assert.equal(erOpened(w), w.erRoot);
 assert.equal(foldPath(hash, leaf(w.nmaLeaf[0]), Number(w.nmaIdx[0]), w.nmaPath[0]), w.nfA[0]);
 assert.equal(foldPath(hash, leaf(w.nmbLeaf[0]), Number(w.nmbIdx[0]), w.nmbPath[0]), w.nfB[0]);
 assert.equal(foldPath(hash, leaf(w.rsPred[0]), Number(w.rsPredIdx[0]), w.rsPredPath[0]), w.rsRoot);
 assert.equal(foldPath(hash, leaf([nf, w.rsPred[0][1], w.rsPred[0][2]]), Number(w.rsCount), w.rsAppendPath[0]), state.recovered.root());
});
