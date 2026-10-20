import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { ARCHIVE_DEPTH, EPOCH_NULLIFIER_DEPTH, ER_TAG, NOTE_DEPTH, NULLIFIER_TAG, RollupRejection } from '../packages/protocol/src/rollup/constants.ts';
import { EpochArchive, erLeafIndexOf } from '../packages/protocol/src/rollup/epoch-archive.ts';
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
