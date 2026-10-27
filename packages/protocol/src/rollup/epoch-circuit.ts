import { randomField, type BuiltSpend, type OwnedNote, type SpendRequest } from './account.ts';
import { clientWitness, inputNullifierOf, type ClientSpend, type ClientWitness } from './client.ts';
import { BTC_ASSET, NOTE_DEPTH, ROLLUP_DOMAIN } from './constants.ts';
import { anchorOf, type EpochAnchorRef, type EpochSlot } from './epoch.ts';
import { destinationFieldOf, outputRhoOf, type Hash } from './notes.ts';
import { ctDigestOf, sealRollupNotes, type RollupNote, type RollupRecipient } from './wallet.ts';

/** Witness keys the epoch circuits compute themselves (D1): supplying one must fail, so the adapter drops them. */
export const EPOCH_DERIVED_FIELDS = ['anchor', 'rotate', 'rotNoteRoot', 'rotNfRoot', 'rotNfCount', 'winNewEpoch', 'erLeaf'] as const;
export const epochBatchInput = (witness: Record<string, unknown>) => Object.fromEntries(Object.entries(witness).filter(([key]) => !(EPOCH_DERIVED_FIELDS as readonly string[]).includes(key)));

export interface EpochClientAnchor { rPrev: bigint; rCur: bigint; sel: bigint[] }
// epoch-spend.circom and epoch-join.circom take the anchor's two roots and a selector per input where spend.circom takes root.
const reanchored = ({ input: { root, ...input }, ...witness }: ClientWitness, at: EpochClientAnchor): ClientWitness =>
 ({ ...witness, input: { ...input, rPrev: at.rPrev, rCur: at.rCur, sel: at.sel.length === 1 ? at.sel[0] : at.sel } });
export const epochClientInput = (hash: Hash, spend: ClientSpend, at: EpochClientAnchor): ClientWitness => {
 if (at.sel.length !== spend.inputs.length) throw new Error('An epoch spend has one sel per input.');
 return reanchored(clientWitness(hash, { ...spend, root: anchorOf(hash, at.rPrev, at.rCur) }), at);
};

/** A padding spend or join: every input is a dummy, which skips membership, so every sel is 0. */
export async function epochPaddingTransfer(hash: Hash, o: { rPrev: bigint; rCur: EpochAnchorRef; self: RollupRecipient; width: 1 | 2 }, random = randomField): Promise<{ witness: ClientWitness; ciphertext: Uint8Array; slot: EpochSlot }> {
 const { witness, ciphertext, slot } = await epochTransfer(hash, { rPrev: o.rPrev, rCur: o.rCur, sel: Array(o.width).fill(0n), ask: random(), nk: random(), self: o.self, request: {}, width: o.width }, random);
 return { witness, ciphertext, slot };
}

export interface EpochBuiltSpend extends BuiltSpend { slot: EpochSlot }
/**
 * The epoch builder for every client slot, padding included: one sel per note input, 0 for any dummy not named. Inputs are told apart by nullifier,
 * because a leaf index repeats in every epoch and the classic index check would refuse a join across two epochs.
 */
export async function epochTransfer(hash: Hash, o: { rPrev: bigint; rCur: EpochAnchorRef; sel: (0n | 1n)[]; ask: bigint; nk: bigint; self: RollupRecipient; request: SpendRequest; paths?: (bigint[] | undefined)[]; width?: 1 | 2; group?: { id: bigint; size: number } }, random = randomField): Promise<EpochBuiltSpend> {
 const { request } = o, asset = request.asset ?? BTC_ASSET, deposit = request.deposit ?? 0n, withdraw = request.withdraw ?? 0n, paid = request.to?.amount ?? 0n;
 const owned = request.inputs ?? (request.input ? [request.input] : []), width = o.width ?? (owned.length === 2 ? 2 : 1);
 if (o.sel.length < owned.length || o.sel.length > width || owned.some((n, k) => !o.paths?.[k] || n.asset !== asset)) throw new Error('A note input needs its path, its sel and the asset it holds.');
 if (width === 2 && (deposit || withdraw || o.group)) throw new Error('A join carries no deposit, withdrawal or group.');
 const inputs = Array.from({ length: width }, (_, k) => owned[k]
  ? { amount: owned[k]!.amount, ask: o.ask, nk: o.nk, rho: owned[k]!.rho, index: owned[k]!.index, path: o.paths![k]! }
  : { amount: 0n, ask: random(), nk: request.dummy?.nk ?? random(), rho: request.dummy?.rho ?? random(), index: 0, path: Array<bigint>(NOTE_DEPTH).fill(0n) });
 if ((withdraw > 0n) !== !!request.program) throw new Error('A withdrawal needs exactly one payout program.');
 const change = inputs.reduce((sum, i) => sum + i.amount, 0n) + deposit - withdraw - paid;
 if (change < 0n || paid < 0n || deposit < 0n || withdraw < 0n) throw new Error('The spend does not balance.');
 const outputs = request.to ? [{ amount: paid, to: request.to.recipient }, { amount: change, to: o.self }] : [{ amount: change, to: o.self }, { amount: 0n, to: o.self }];
 const randoms = [random(), random()], nullifiers = inputs.map(i => inputNullifierOf(hash, ROLLUP_DOMAIN, i));
 if (nullifiers[0] === nullifiers[1]) throw new Error('A join spends two different notes.');
 const notes = outputs.map((out, j) => ({ amount: out.amount, asset, rho: outputRhoOf(hash, ROLLUP_DOMAIN, randoms[j]!, nullifiers, j) })) as [RollupNote, RollupNote];
 const ciphertext = await sealRollupNotes([outputs[0]!.to, outputs[1]!.to], notes);
 const witness = epochClientInput(hash, {
  domain: ROLLUP_DOMAIN, root: 0n, asset, inputs, // root: epochClientInput replaces it with the anchor
  outputs: [{ amount: outputs[0]!.amount, owner: outputs[0]!.to.owner, random: randoms[0]! }, { amount: outputs[1]!.amount, owner: outputs[1]!.to.owner, random: randoms[1]! }],
  deposit, withdraw, destination: request.program ? destinationFieldOf(request.program) : 0n, ctDigest: ctDigestOf(ciphertext), groupId: o.group?.id ?? 0n, groupSize: o.group?.size ?? 0,
 }, { rPrev: o.rPrev, rCur: o.rCur.root, sel: inputs.map((_, k) => o.sel[k] ?? 0n) });
 const { root: anchor, ...rest } = witness.slot;
 return { witness, ciphertext, change, slot: { ...rest, anchor, rCur: o.rCur } };
}

/** A recovery is the ordinary epoch-spend proof with both roots its origin's final one: with the roots equal, sel cannot move the membership root. */
export async function epochRecoverTransfer(hash: Hash, o: { origin: number; noteFinal: bigint; ask: bigint; nk: bigint; self: RollupRecipient; note: OwnedNote; path: bigint[] }, random = randomField): Promise<EpochBuiltSpend> {
 const { slot: { rCur: _, ...slot }, ...built } = await epochTransfer(hash, { rPrev: o.noteFinal, rCur: { epoch: o.origin, root: o.noteFinal }, sel: [0n], ask: o.ask, nk: o.nk, self: o.self, request: { asset: o.note.asset, input: o.note }, paths: [o.path] }, random);
 return { ...built, slot: { ...slot, origin: o.origin } };
}
