import { ARCHIVE_DEPTH, ER_TAG, RollupRejection } from './constants.ts';
import type { Hash } from './notes.ts';
import type { NonMemberWitness, RollupNullifiers } from './nullifiers.ts';
import { DeepTree } from './tree.ts';

export interface ArchivedEpoch { epoch: number; noteFinal: bigint; nfFinal: bigint; nfNextFinal: bigint }
export interface RecoverWitness { erIndex: number; erPath: bigint[]; archived: ArchivedEpoch; nonMemberA: NonMemberWitness; nonMemberB: NonMemberWitness }

/** The first rotation archives the pseudo-epoch -1, so the hashed field and the tree index are both epoch + 1; this is the only place the +1 appears. */
export const erLeafIndexOf = (epoch: number) => epoch + 1;

// ponytail: every frozen set stays in memory; load one from its archive file on demand once epochs outgrow RAM.
export class EpochArchive {
 private records = new Map<number, ArchivedEpoch>();
 private sets = new Map<number, RollupNullifiers>();
 private log?: [Map<number, unknown>, number, unknown][];
 constructor(private readonly hash: Hash, readonly tree = new DeepTree(hash, ARCHIVE_DEPTH)) {}
 count(): number { return this.records.size; }
 root(): bigint { return this.tree.root(); }
 has(epoch: number): boolean { return this.records.has(epoch); }
 leafOf(epoch: number, noteFinal: bigint, nfFinal: bigint, nfNextFinal: bigint): bigint {
  return this.hash([ER_TAG, BigInt(erLeafIndexOf(epoch)), noteFinal, nfFinal, nfNextFinal]);
 }
 /** Keeps both sets by reference, NF[e+1] once for archives e and e+1, and clone() shares them too, so a caller must not insert into frozen or frozenNext while the archive holds them. */
 append(epoch: number, noteFinal: bigint, frozen: RollupNullifiers, frozenNext: RollupNullifiers): void {
  const index = erLeafIndexOf(epoch);
  if (index !== this.count()) throw new Error(`Epoch ${epoch} is not the next to archive.`);
  const archived = { epoch, noteFinal, nfFinal: frozen.root(), nfNextFinal: frozenNext.root() };
  this.tree.set(index, this.leafOf(epoch, noteFinal, archived.nfFinal, archived.nfNextFinal));
  this.put(this.records, epoch, archived);
  this.put(this.sets, epoch, frozen); this.put(this.sets, epoch + 1, frozenNext);
 }
 private put<V>(map: Map<number, V>, key: number, value: V): void { this.log?.push([map, key, map.get(key)]); map.set(key, value); }
 witness(epoch: number, nullifier: bigint): RecoverWitness {
  const archived = this.records.get(epoch), frozen = this.sets.get(epoch), frozenNext = this.sets.get(epoch + 1);
  if (!archived) throw new RollupRejection('recover-unarchived', `Epoch ${epoch} is not archived.`);
  if (!frozen || !frozenNext) throw new RollupRejection('recover-unarchived', `Epoch ${epoch} is archived, but its nullifier sets are not loaded.`);
  const erIndex = erLeafIndexOf(epoch);
  return { erIndex, erPath: this.tree.path(erIndex), archived, nonMemberA: frozen.nonMember(nullifier), nonMemberB: frozenNext.nonMember(nullifier) };
 }
 list(): ArchivedEpoch[] { return [...this.records.values()]; }
 /** Takes records read back for this archive's tree; witness() refuses each epoch until load() has installed both of its sets. */
 restore(records: readonly ArchivedEpoch[]): void {
  if (records.some((r, i) => erLeafIndexOf(r.epoch) !== i || this.leafOf(r.epoch, r.noteFinal, r.nfFinal, r.nfNextFinal) !== this.tree.node(0, i))) throw new Error('The archived epochs are not the archive tree\'s leaves in order.');
  this.records = new Map(records.map(r => [r.epoch, r])); this.sets = new Map();
 }
 load(epoch: number, set: RollupNullifiers): void {
  const root = this.records.get(epoch)?.nfFinal ?? this.records.get(epoch - 1)?.nfNextFinal;
  if (root === undefined || set.root() !== root) throw new Error(`The nullifier set for epoch ${epoch} does not match an archived root.`);
  this.sets.set(epoch, set);
 }
 loaded(epoch: number): boolean { return this.sets.has(epoch); }
 clone(): EpochArchive {
  const copy = new EpochArchive(this.hash, this.tree.clone());
  copy.records = new Map(this.records); copy.sets = new Map(this.sets);
  return copy;
 }
 /** Journals appends until rollback(), so a batch that archives nothing costs nothing; a later begin() drops the journal. */
 begin(): void { this.log = []; this.tree.begin(); }
 rollback(): void {
  for (const [map, key, prior] of (this.log ?? []).reverse()) if (prior === undefined) map.delete(key); else map.set(key, prior);
  this.log = undefined;
  this.tree.rollback();
 }
}
