import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { inputNullifierOf, type ClientInput } from '../packages/protocol/src/rollup/client.ts';
import { ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { EpochState, type EpochAnchorRef } from '../packages/protocol/src/rollup/epoch.ts';
import { epochHarness, rejection } from './fixtures/epoch.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { owner, fresh, dummyInput, deposit, fill, noteFrom, recoverSlot } = epochHarness(hash);

// epochLen 4: epoch k is batches 4k+1 to 4k+4, and an epoch-0 note can be recovered from epoch 2.
// Without leaves each block goes in by its root: the same commitments for a third less hashing.
const genesis = () => EpochState.genesis(hash, 4, false);
// The note's rho hashes the dummy's nullifier and the output random, so minting twice with the same pair makes two instances of one nullifier.
const mint = (state: EpochState, dummy = dummyInput(), random = fresh()) => {
 const made = deposit(state, 1000n, { inputs: [dummy], outputs: [{ amount: 1000n, owner, random }, { amount: 0n, owner, random: fresh() }] });
 state.apply('spend', fill(state, [made.slot]));
 return noteFrom(made);
};
const spend = (state: EpochState, note: ClientInput, rCur?: EpochAnchorRef) => state.apply('spend', fill(state, [deposit(state, 0n, { inputs: [note] }, rCur).slot]));
const recover = (state: EpochState, origin: number, note: ClientInput) => state.apply('recover', [recoverSlot(state, origin, note)]);
// Rotations alternate spend and recover batches so both kinds rotate. The other batches idle on a dummy recover slot once
// epoch -1 is archived, a tenth of a spend batch's cost.
const idle = (state: EpochState) => {
 const full = state.batchCount < state.epochLen || (state.batchCount % state.epochLen === 0 && state.epoch % 2 === 0);
 return full ? state.apply('spend', fill(state)) : recover(state, -1, dummyInput());
};
const advance = (state: EpochState, epoch: number) => { while (state.epoch < epoch) idle(state); };

test('same instance: fast in e then fast in e is refused by the insert', () => {
 for (const c of [0, 1]) {
  const state = genesis(), note = mint(state);
  advance(state, c);
  spend(state, note);
  assert.equal(state.nullifiers.has(note.nullifier), true);
  assert.throws(() => spend(state, note), rejection('double-spend'));
 }
});

test('same instance: fast in e then fast in e+1 is refused by NonMember(prevNf)', () => {
 const state = genesis(), note = mint(state);
 spend(state, note);
 advance(state, 1);
 assert.equal(state.nullifiers.has(note.nullifier), false);
 assert.throws(() => spend(state, note), rejection('double-spend'));
});

test('same instance: fast then recovery is refused by the archived sets', () => {
 for (const c of [0, 1]) {
  const state = genesis(), note = mint(state);
  advance(state, c);
  spend(state, note);
  advance(state, 2);
  assert.equal(state.recovered.has(note.nullifier), false);
  assert.throws(() => recover(state, 0, note), rejection('double-spend'));
 }
});

test('same instance: recovery then recovery is refused by RS', () => {
 const state = genesis(), note = mint(state);
 advance(state, 2);
 recover(state, 0, note);
 assert.equal(state.recovered.has(note.nullifier), true);
 assert.equal(state.nullifiers.has(note.nullifier), false);
 for (const c of [2, 3, 4]) {
  advance(state, c);
  assert.throws(() => recover(state, 0, note), rejection('double-spend'));
 }
});

test('same instance: recovery then fast is unreachable', () => {
 const state = genesis(), note = mint(state), noteRoot = state.latestRoot();
 advance(state, 2);
 recover(state, 0, note);
 for (const c of [2, 3]) {
  advance(state, c);
  assert.ok(state.windowIndex({ epoch: 0, root: noteRoot }) >= 0);
  for (const epoch of [0, c - 1, c]) assert.throws(() => spend(state, note, { epoch, root: noteRoot }), rejection('window-tag'));
 }
});

test('replaying a dummy nullifier in the adjacent epoch is refused', () => {
 const state = genesis(), dummy = dummyInput(), random = fresh(), replayed = inputNullifierOf(hash, ROLLUP_DOMAIN, dummy);
 const x = mint(state, dummy, random);
 advance(state, 1);
 assert.equal(state.nullifiers.has(replayed), false);
 assert.throws(() => mint(state, dummy, random), rejection('double-spend'));
 advance(state, 2);
 assert.equal(mint(state, dummy, random).nullifier, x.nullifier);
});

// Bit k of `fast` enables one fast attempt: x in epochs 0 and 1, y in epochs 2 and 3. Both instances are then recovered.
const play = (fast: number) => {
 const state = genesis(), dummy = dummyInput(), random = fresh(), paid = { x: 0, y: 0 };
 const attempt = (who: 'x' | 'y', run: () => unknown) => {
  try { run(); paid[who]++; } catch (error) { assert.ok(rejection('double-spend')(error), `${who} refused for another reason: ${error}`); }
 };
 const x = mint(state, dummy, random);
 if (fast & 1) attempt('x', () => spend(state, x));
 advance(state, 1);
 if (fast & 2) attempt('x', () => spend(state, x));
 advance(state, 2);
 const y = mint(state, dummy, random);
 assert.equal(y.nullifier, x.nullifier);
 if (fast & 4) attempt('y', () => spend(state, y));
 advance(state, 3);
 if (fast & 8) attempt('y', () => spend(state, y));
 advance(state, 4);
 attempt('x', () => recover(state, 0, x));
 attempt('y', () => recover(state, 2, y));
 return paid;
};

test('two instances sharing N pay out at most once each', () => {
 let most = 0;
 for (let fast = 0; fast < 16; fast++) {
  const paid = play(fast);
  assert.ok(paid.x <= 1 && paid.y <= 1, `fast ${fast}: ${JSON.stringify(paid)}`);
  assert.ok(paid.x + paid.y <= 2, `fast ${fast}: ${JSON.stringify(paid)}`);
  most = Math.max(most, paid.x + paid.y);
 }
 assert.equal(most, 2);
});

test('recovering one instance blocks the other recovery through RS', () => {
 for (const [first, second] of [[0, 1], [1, 0]]) {
  const state = genesis(), dummy = dummyInput(), random = fresh();
  const x = mint(state, dummy, random);
  advance(state, 2);
  const y = mint(state, dummy, random);
  assert.equal(y.nullifier, x.nullifier);
  advance(state, 4);
  const recovers =[(s: EpochState) => recover(s, 0, x), (s: EpochState) => recover(s, 2, y)];
  assert.ok(recovers[second](state.clone()));
  recovers[first](state);
  assert.throws(() => recovers[second](state), rejection('double-spend'));
 }
});
