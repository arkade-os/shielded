import { buildRollupTransfer, randomField } from './account.ts';
import { clientWitness, type ClientSpend, type ClientWitness } from './client.ts';
import { anchorOf, type EpochAnchorRef, type EpochSlot } from './epoch.ts';
import type { Hash } from './notes.ts';
import type { RollupRecipient } from './wallet.ts';

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
 const { witness, ciphertext } = await buildRollupTransfer(hash, { root: anchorOf(hash, o.rPrev, o.rCur.root), ask: random(), nk: random(), self: o.self, request: {}, width: o.width }, random);
 const { root: anchor, ...rest } = witness.slot;
 return { witness: reanchored(witness, { rPrev: o.rPrev, rCur: o.rCur.root, sel: Array(o.width).fill(0n) }), ciphertext, slot: { ...rest, anchor, rCur: o.rCur } };
}
