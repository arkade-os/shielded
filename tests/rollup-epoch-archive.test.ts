import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { ARCHIVE_DEPTH, EPOCH_NULLIFIER_DEPTH, ER_TAG, NOTE_DEPTH, NULLIFIER_TAG, ROLLUP_FIELD, RollupRejection } from '../packages/protocol/src/rollup/constants.ts';
import { EpochArchive, erLeafIndexOf, type ArchivedEpoch } from '../packages/protocol/src/rollup/epoch-archive.ts';
import type { Hash } from '../packages/protocol/src/rollup/notes.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { DeepTree, pathBits } from '../packages/protocol/src/rollup/tree.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));

const foldPath = (hash: Hash, leaf: bigint, index: number, path: bigint[]) => {
 const bits = pathBits(index, path.length);
 return path.reduce((node, sibling, level) => (bits[level] ? hash([sibling, node]) : hash([node, sibling])), leaf);
};
const epochSet = (...values: bigint[]) => {
 const set = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
 values.forEach(value => set.insert(value));
 return set;
};
const emptyNotes = new DeepTree(hash, NOTE_DEPTH).root();
const rejection = (code: string) => (error: unknown) => error instanceof RollupRejection && error.code === code;

// The pseudo-epoch -1 over NF[0] = {11}, then epoch 0 over NF[0] and NF[1] = {22}.
const archived = () => {
 const archive = new EpochArchive(hash), nf0 = epochSet(11n);
 archive.append(-1, emptyNotes, epochSet(), nf0);
 archive.append(0, 1234n, nf0, epochSet(22n));
 return archive;
};
// Epoch 1 archives a different NF[1] than epoch 0 did, so the overwrite of sets[1] shows in witness(0).
const appendTwo = (archive: EpochArchive) => { archive.append(1, 4321n, epochSet(5n), epochSet(44n)); archive.append(2, 8765n, epochSet(44n), epochSet(66n)); };

test('the first append is the pseudo-epoch at index 0', () => {
 const archive = new EpochArchive(hash), empty = epochSet(), nf0 = epochSet(11n);
 archive.append(-1, emptyNotes, empty, nf0);
 assert.equal(archive.count(), 1);
 assert.equal(erLeafIndexOf(-1), 0);
 assert.equal(archive.tree.node(0, 0), hash([ER_TAG, 0n, emptyNotes, empty.root(), nf0.root()]));
 assert.equal(archive.has(-1), true);
 assert.equal(archive.has(0), false);
 assert.deepEqual(archive.record(-1), { epoch: -1, noteFinal: emptyNotes, nfFinal: empty.root(), nfNextFinal: nf0.root() });
 assert.equal(archive.record(0), undefined);
});

test('a witness carries the archive path and both non-membership proofs', () => {
 const archive = archived(), w = archive.witness(0, 33n);
 assert.deepEqual(w.archived, { epoch: 0, noteFinal: 1234n, nfFinal: epochSet(11n).root(), nfNextFinal: epochSet(22n).root() });
 assert.deepEqual(w.nonMemberA.leaf, [11n, 0n, 0n]);
 assert.deepEqual(w.nonMemberB.leaf, [22n, 0n, 0n]);
 assert.equal(w.erIndex, 1);
 assert.equal(w.erPath.length, ARCHIVE_DEPTH);
 assert.equal(w.nonMemberA.path.length, EPOCH_NULLIFIER_DEPTH);
 // Fold each witness up its own path, as the circuit will; comparing against tree.path() would be circular.
 assert.equal(foldPath(hash, archive.leafOf(0, w.archived.noteFinal, w.archived.nfFinal, w.archived.nfNextFinal), w.erIndex, w.erPath), archive.root());
 assert.equal(foldPath(hash, hash([NULLIFIER_TAG, ...w.nonMemberA.leaf]), w.nonMemberA.index, w.nonMemberA.path), w.archived.nfFinal);
 assert.equal(foldPath(hash, hash([NULLIFIER_TAG, ...w.nonMemberB.leaf]), w.nonMemberB.index, w.nonMemberB.path), w.archived.nfNextFinal);
});

test('consecutive epochs agree on the set between them, and the pseudo-epoch opens at index 0', () => {
 const archive = archived(), pseudo = archive.witness(-1, 33n), first = archive.witness(0, 33n);
 assert.equal(pseudo.erIndex, 0);
 assert.equal(foldPath(hash, archive.leafOf(-1, pseudo.archived.noteFinal, pseudo.archived.nfFinal, pseudo.archived.nfNextFinal), 0, pseudo.erPath), archive.root());
 assert.equal(pseudo.archived.nfNextFinal, first.archived.nfFinal);
 assert.deepEqual(pseudo.nonMemberB, first.nonMemberA);
});

test('a witness for a nullifier present in either archived set is refused', () => {
 const archive = archived();
 assert.throws(() => archive.witness(0, 11n), rejection('double-spend'));
 assert.throws(() => archive.witness(0, 22n), rejection('double-spend'));
});

test('a witness for an unarchived, negative or fractional epoch is refused', () => {
 const archive = archived();
 for (const e of [1, 5, -2, 0.5, NaN]) assert.throws(() => archive.witness(e, 33n), rejection('recover-unarchived'));
});

test('an epoch can only be appended after the one before it', () => {
 const archive = new EpochArchive(hash), empty = epochSet();
 assert.throws(() => archive.append(0, emptyNotes, empty, empty), /next to archive/);
 archive.append(-1, emptyNotes, empty, empty);
 const root = archive.root();
 for (const e of [-1, 1, 0.5, NaN]) assert.throws(() => archive.append(e, emptyNotes, empty, empty), /next to archive/);
 assert.equal(archive.count(), 1);
 assert.equal(archive.root(), root);
});

test('rollback removes what was appended since begin', () => {
 const archive = archived(), root = archive.root(), next = (a: EpochArchive) => a.append(1, 4321n, epochSet(22n), epochSet(44n));
 archive.begin();
 next(archive);
 assert.equal(archive.count(), 3);
 archive.rollback();
 assert.equal(archive.count(), 2);
 assert.equal(archive.root(), root);
 assert.equal(archive.has(1), false);
 assert.throws(() => archive.witness(1, 33n), rejection('recover-unarchived'));
 const direct = archived();
 next(archive); next(direct);
 assert.equal(archive.root(), direct.root());
});

test('rollback undoes two appends and restores the set the first one overwrote', () => {
 const archive = archived(), root = archive.root(), witnesses = () => [-1, 0].map(e => archive.witness(e, 33n)), before = witnesses(), overwritten = archive['sets'].get(1);
 archive.begin();
 appendTwo(archive);
 assert.equal(archive.count(), 4);
 assert.notDeepEqual(archive.witness(0, 33n).nonMemberB, before[1].nonMemberB);
 archive.rollback();
 assert.equal(archive.count(), 2);
 assert.equal(archive.root(), root);
 assert.deepEqual([-1, 0, 1, 2].map(e => archive.has(e)), [true, true, false, false]);
 assert.deepEqual(witnesses(), before);
 assert.equal(archive['sets'].get(1), overwritten);
});

// witness() reads only archived epochs, so a stale entry above them shows only in the maps.
test('rollback restores both maps exactly, and without a begin it changes nothing', () => {
 const archive = archived(), keys = () => [[...archive['records'].keys()], [...archive['sets'].keys()]], before = keys();
 archive.rollback();
 assert.deepEqual(keys(), before);
 archive.begin();
 appendTwo(archive);
 archive.rollback();
 assert.deepEqual(keys(), before);
});

test('begin, append and rollback never walk the archived maps', () => {
 const archive = archived();
 let walks = 0;
 class Counted<V> extends Map<number, V> { [Symbol.iterator]() { walks++; return super[Symbol.iterator](); } }
 archive['records'] = new Counted(archive['records']);
 archive['sets'] = new Counted(archive['sets']);
 archive.begin();
 appendTwo(archive);
 archive.rollback();
 assert.equal(walks, 0);
});

test('a clone does not share appends with the archive it came from', () => {
 const archive = archived(), copy = archive.clone(), root = archive.root();
 copy.append(1, 4321n, epochSet(22n), epochSet(44n));
 assert.equal(copy.count(), 3);
 assert.notEqual(copy.root(), root);
 assert.equal(archive.count(), 2);
 assert.equal(archive.root(), root);
 assert.equal(archive.has(1), false);
});

const restoredFrom = (archive: EpochArchive) => { const copy = new EpochArchive(hash, archive.tree.clone()); copy.restore(archive.list()); return copy; };
const leavesOf = (set: RollupNullifiers) => { const leaves: { value: bigint; nextIndex: number }[] = []; set.scanLeaves((value, nextIndex) => leaves.push({ value, nextIndex })); return leaves; };

test('an archive refuses a frozen set whose root is not the archived one', () => {
 const archive = restoredFrom(archived());
 // NF[1] is pinned only by epoch 0's nfNextFinal, and epoch 2 by nothing.
 for (const [epoch, set] of [[0, epochSet(12n)], [1, epochSet(11n)], [2, epochSet()]] as const) assert.throws(() => archive.load(epoch, set), /does not match/);
 assert.deepEqual([-1, 0, 1].map(e => archive.loaded(e)), [false, false, false]);
 archive.load(-1, epochSet()); archive.load(0, epochSet(11n)); archive.load(1, epochSet(22n));
 assert.deepEqual([-1, 0, 1, 2].map(e => archive.loaded(e)), [true, true, true, false]);
});

test('a recover witness for an epoch whose set is not loaded is a rejection, not a crash', () => {
 const original = archived(), archive = restoredFrom(original);
 assert.deepEqual([archive.count(), archive.root(), archive.list()], [original.count(), original.root(), original.list()]);
 assert.throws(() => archive.witness(0, 33n), rejection('recover-unarchived'));
 archive.load(0, epochSet(11n));
 assert.throws(() => archive.witness(0, 33n), rejection('recover-unarchived'));
 const copy = archive.clone();
 copy.load(1, epochSet(22n));
 assert.deepEqual([archive.loaded(1), copy.witness(0, 33n)], [false, original.witness(0, 33n)]);
});

test('a restored archive refuses records that are not its tree leaves in order', () => {
 const original = archived(), records = original.list(), extra: ArchivedEpoch = { epoch: 1, noteFinal: 1n, nfFinal: 2n, nfNextFinal: 3n };
 for (const bad of [records.slice(1), [...records].reverse(), [records[0], { ...records[1], noteFinal: 1235n }], [...records, extra], records.slice(0, -1)])
  assert.throws(() => new EpochArchive(hash, original.tree.clone()).restore(bad), /tree/);
});

test('fromLeaves rebuilds a set whose root, nonMember and insert match an inserted one', () => {
 const set = epochSet(...Array.from({ length: 63 }, (_, i) => BigInt((37 * i) % 64 + 1))), leaves = leavesOf(set);
 let hashes = 0;
 const rebuilt = RollupNullifiers.fromLeaves(values => { hashes++; return hash(values); }, EPOCH_NULLIFIER_DEPTH, leaves);
 assert.ok(hashes < 4 * (leaves.length + EPOCH_NULLIFIER_DEPTH), `${hashes} hashes`);
 assert.deepEqual([rebuilt.root(), rebuilt.count(), rebuilt.depth], [set.root(), set.count(), EPOCH_NULLIFIER_DEPTH]);
 assert.deepEqual(rebuilt.nonMember(28n), set.nonMember(28n));
 assert.deepEqual(rebuilt.insert(28n), set.insert(28n));
 assert.equal(rebuilt.root(), set.root());
 const edit = (i: number, leaf: Partial<{ value: bigint; nextIndex: number }>) => leaves.map((old, k) => (k === i ? { ...old, ...leaf } : old));
 const max = leaves.findIndex(leaf => leaf.value > 0n && leaf.nextIndex === 0);
 for (const bad of [edit(1, { value: leaves[2].value }), edit(1, { nextIndex: leaves.length })]) assert.throws(() => RollupNullifiers.fromLeaves(hash, EPOCH_NULLIFIER_DEPTH, bad), /sorted list/);
 assert.throws(() => RollupNullifiers.fromLeaves(hash, EPOCH_NULLIFIER_DEPTH, edit(max, { value: leaves[max].value + ROLLUP_FIELD })), /field/);
});
