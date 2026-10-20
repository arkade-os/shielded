import { BATCH_SLOTS, BTC_ASSET, ROLLUP_DOMAIN, RollupRejection, type RejectionCode } from '../../packages/protocol/src/rollup/constants.ts';
import { clientWitness, type ClientSpend } from '../../packages/protocol/src/rollup/client.ts';
import { anchorOf, type EpochAnchorRef, type EpochSlot, type EpochState } from '../../packages/protocol/src/rollup/epoch.ts';
import { ownerOf, type Hash } from '../../packages/protocol/src/rollup/notes.ts';

export const rejection = (code: RejectionCode) => (error: unknown) => error instanceof RollupRejection && error.code === code;

export function epochHarness(hash: Hash) {
 const owner = ownerOf(hash, ROLLUP_DOMAIN, 7n, 8n);
 let counter = 100n;
 const fresh = () => ++counter;
 const dummyInput = () => ({ amount: 0n, ask: fresh(), nk: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
 const deposit = (state: EpochState, amount: bigint, extra: Partial<ClientSpend> = {}, rCur: EpochAnchorRef = { epoch: state.epoch, root: state.latestRoot() }) => {
  // The next batch rotates before its slots run, so they open against the root this epoch ends on.
  const rPrev = state.batchCount > 0 && state.batchCount % state.epochLen === 0 ? state.notes.root() : state.prevNoteRoot;
  const witness = clientWitness(hash, {
   domain: ROLLUP_DOMAIN, root: anchorOf(hash, rPrev, rCur.root), asset: BTC_ASSET, inputs: [dummyInput()],
   outputs: [{ amount, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }],
   deposit: amount, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...extra,
  });
  const { root: anchor, ...rest } = witness.slot;
  const slot: EpochSlot = { ...rest, anchor, rCur };
  return { ...witness, slot };
 };
 const fastSlot = (state: EpochState, amount = 0n, rCur?: EpochAnchorRef) => deposit(state, amount, {}, rCur).slot;
 const fill = (state: EpochState, first: EpochSlot[] = []) => [...first, ...Array.from({ length: BATCH_SLOTS - first.length }, () => fastSlot(state))];
 return { owner, fresh, dummyInput, deposit, fastSlot, fill };
}
