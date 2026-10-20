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

type EpochModelRules = { fastReach?: 1 | 2; fastChecks?: 0 | 1; recNext?: boolean; recRs?: boolean; recMinAge?: 1 | 2 };
type ModelState = [c: number, nf: string[][], rs: string[], inst: [number, string][], spent: boolean[]];
const withValue = (set: string[], n: string) => [...new Set([...set, n])].sort();

const exploreEpochModel = ({ epochs, instances, values, dummies, fastReach = 1, fastChecks = 1, recNext = true, recRs = true, recMinAge = 2 }: { epochs: number; instances: number; values: readonly string[]; dummies: boolean } & EpochModelRules): { violation?: string; states: number } => {
 const fast = (c: number, n: string, nf: string[][]) => !nf.slice(Math.max(0, c - fastChecks), c + 1).some((set) => set.includes(n));
 const put = (nf: string[][], c: number, n: string) => nf.map((set, k) => k === c ? withValue(set, n) : set);
 const start: ModelState = [0, Array.from({ length: epochs }, () => []), [], [], []];
 // A Map iterates in insertion order and visits keys added meanwhile, so it is both the visited set and the BFS queue.
 const seen = new Map([[JSON.stringify(start), start]]);
 const add = (state: ModelState) => { const key = JSON.stringify(state); if (!seen.has(key)) seen.set(key, state); };
 for (const [c, nf, rs, inst, spent] of seen.values()) {
  if (c + 1 < epochs) add([c + 1, nf, rs, inst, spent]);
  // Creation inserts nothing: the slot's own dummy nullifier is another value, so a free create only over-approximates the attacker.
  if (inst.length < instances) for (const n of values) add([c, nf, rs, [...inst, [c, n]], [...spent, false]]);
  if (dummies) for (const n of values) if (fast(c, n, nf)) add([c, put(nf, c, n), rs, inst, spent]);
  for (const [i, [e, n]] of inst.entries()) {
   const paths: ('fast' | 'recover')[] = [];
   if (c - fastReach <= e && e <= c && fast(c, n, nf)) paths.push('fast');
   if (e <= c - recMinAge && !nf[e].includes(n) && !(recNext && nf[e + 1].includes(n)) && !(recRs && rs.includes(n))) paths.push('recover');
   for (const path of paths) {
    if (spent[i]) return { violation: `instance ${i} (epoch ${e}, nf ${n}) accepted twice at epoch ${c} via ${path}; nf=${JSON.stringify(nf)} rs=${JSON.stringify(rs)} inst=${JSON.stringify(inst)}`, states: seen.size };
    const done = spent.map((was, j) => was || j === i);
    add(path === 'fast' ? [c, put(nf, c, n), rs, inst, done] : [c, nf, withValue(rs, n), inst, done]);
   }
  }
 }
 return { states: seen.size };
};

const EPOCH_MODEL_MUTANTS: ({ name: string } & EpochModelRules)[] = [
 { name: 'fast path skips NF[c-1]', fastChecks: 0 },
 { name: 'grace band: fast path reaches NT[c-2]', fastReach: 2 },
 { name: 'recovery skips nfFinal[e+1]', recNext: false },
 { name: 'recovery skips RS', recRs: false },
 { name: 'recovery may name a live epoch (e = c-1)', recMinAge: 1 },
];

test('no instance is accepted twice under any interleaving, at the reference state counts', () => {
 for (const [opts, states] of [[{ epochs: 6, instances: 3, values: ['A', 'B'], dummies: false }, 26_598], [{ epochs: 4, instances: 2, values: ['A', 'B'], dummies: true }, 10_582]] as const) {
  const result = exploreEpochModel(opts);
  assert.equal(result.violation, undefined);
  assert.equal(result.states, states);
 }
});

test('every rule mutant is caught by the model check', () => {
 for (const { name, ...rules } of EPOCH_MODEL_MUTANTS)
  assert.ok(exploreEpochModel({ epochs: 6, instances: 3, values: ['A', 'B'], dummies: false, ...rules }).violation, name);
});
