import { clientWitness, type ClientSpend, type ClientWitness } from './client.ts';
import { anchorOf } from './epoch.ts';
import type { Hash } from './notes.ts';

/** Witness keys the epoch circuits compute themselves (D1): supplying one must fail, so the adapter drops them. */
export const EPOCH_DERIVED_FIELDS = ['anchor', 'rotate', 'rotNoteRoot', 'rotNfRoot', 'rotNfCount', 'winNewEpoch', 'erLeaf'] as const;
export const epochBatchInput = (witness: Record<string, unknown>) => Object.fromEntries(Object.entries(witness).filter(([key]) => !(EPOCH_DERIVED_FIELDS as readonly string[]).includes(key)));

export interface EpochClientAnchor { rPrev: bigint; rCur: bigint; sel: bigint[] }
// epoch-spend.circom and epoch-join.circom take the anchor's two roots and a selector per input where spend.circom takes root.
export const epochClientInput = (hash: Hash, spend: ClientSpend, at: EpochClientAnchor): ClientWitness => {
 if (at.sel.length !== spend.inputs.length) throw new Error('An epoch spend has one sel per input.');
 const { input: { root, ...input }, ...witness } = clientWitness(hash, { ...spend, root: anchorOf(hash, at.rPrev, at.rCur) });
 return { ...witness, input: { ...input, rPrev: at.rPrev, rCur: at.rCur, sel: at.sel.length === 1 ? at.sel[0] : at.sel } };
};
