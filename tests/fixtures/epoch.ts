import { BATCH_SLOTS, BTC_ASSET, ROLLUP_DOMAIN, RollupRejection, type RejectionCode } from '../../packages/protocol/src/rollup/constants.ts';
import { clientWitness, inputNullifierOf, type ClientInput, type ClientSpend } from '../../packages/protocol/src/rollup/client.ts';
import { anchorOf, type EpochAnchorRef, type EpochSlot, type EpochState } from '../../packages/protocol/src/rollup/epoch.ts';
import { outputRhoOf, ownerOf, type Hash } from '../../packages/protocol/src/rollup/notes.ts';
import { pathBits } from '../../packages/protocol/src/rollup/tree.ts';

export const rejection = (code: RejectionCode) => (error: unknown) => error instanceof RollupRejection && error.code === code;
export const foldPath = (hash: Hash, leaf: bigint, index: number, path: bigint[]) => {
 const bits = pathBits(index, path.length);
 return path.reduce((node, sibling, level) => (bits[level] ? hash([sibling, node]) : hash([node, sibling])), leaf);
};
export const rPrevFor = (state: EpochState) => state.nextAnchorRoot();

export function epochHarness(hash: Hash) {
 const nk = 8n, owner = ownerOf(hash, ROLLUP_DOMAIN, 7n, nk);
 let counter = 100n;
 const fresh = () => ++counter;
 const dummyInput = () => ({ amount: 0n, ask: fresh(), nk: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
 const deposit = (state: EpochState, amount: bigint, extra: Partial<ClientSpend> = {}, rCur: EpochAnchorRef = { epoch: state.epoch, root: state.latestRoot() }) => {
  const witness = clientWitness(hash, {
   domain: ROLLUP_DOMAIN, root: anchorOf(hash, rPrevFor(state), rCur.root), asset: BTC_ASSET, inputs: [dummyInput()],
   outputs: [{ amount, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }],
   deposit: amount, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...extra,
  });
  const { root: anchor, ...rest } = witness.slot;
  const slot: EpochSlot = { ...rest, anchor, rCur };
  return { ...witness, slot };
 };
 const fastSlot = (state: EpochState, amount = 0n, rCur?: EpochAnchorRef) => deposit(state, amount, {}, rCur).slot;
 const fill = (state: EpochState, first: EpochSlot[] = []) => [...first, ...Array.from({ length: BATCH_SLOTS - first.length }, () => fastSlot(state))];
 const noteFrom = ({ input, slot }: { input: Record<string, unknown>; slot: EpochSlot }, out = 0) => {
  const amount = (input.outAmount as bigint[])[out], rho = outputRhoOf(hash, ROLLUP_DOMAIN, (input.outRandom as bigint[])[out], slot.nullifiers, out);
  return { amount, ask: fresh(), nk, rho, index: 0, path: Array(32).fill(0n), nullifier: inputNullifierOf(hash, ROLLUP_DOMAIN, { amount, nk, rho }) };
 };
 // The root epoch e closed on, or the latest root if e has not closed.
 const noteFinalOf = (state: EpochState, e: number) => state.archive.list().find(archived => archived.epoch === e)?.noteFinal ?? (e === state.epoch - 1 ? state.prevNoteRoot : state.latestRoot());
 const recovery = (state: EpochState, origin: number, note: ClientInput) => {
  const noteFinal = noteFinalOf(state, origin), witness = deposit(state, note.amount, { root: anchorOf(hash, noteFinal, noteFinal), inputs: [note], deposit: 0n }, { epoch: origin, root: noteFinal });
  return { ...witness, slot: { ...witness.slot, origin } };
 };
 const recoverSlot = (state: EpochState, origin: number, note: ClientInput) => recovery(state, origin, note).slot;
 return { owner, fresh, dummyInput, deposit, fastSlot, fill, noteFrom, recovery, recoverSlot };
}
