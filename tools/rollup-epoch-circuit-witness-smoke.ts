import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { BATCH_SLOTS, BTC_ASSET, EPOCH_NULLIFIER_DEPTH, NULLIFIER_TAG, ROLLUP_DOMAIN, ROLLUP_FIELD, type EpochBatchKind } from '../packages/protocol/src/rollup/constants.ts';
import { toCircuitInput, type ClientInput, type ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { EpochState, anchorOf, type EpochSlot } from '../packages/protocol/src/rollup/epoch.ts';
import { EPOCH_DERIVED_FIELDS, epochBatchInput, epochClientInput } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { akOf, groupIdOf, noteOf, ownerOf, statementOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { epochHarness, foldPath, rPrevFor } from '../tests/fixtures/epoch.ts';

const build = process.argv[2] ?? join(process.cwd(), 'circuits', 'rollup', 'build');
const artifact = (name: string) => ({ wasm: join(build, `${name}_js`, `${name}.wasm`), r1cs: join(build, `${name}.r1cs`) });
const circuits = { 'epoch-spend': artifact('epoch-spend'), 'epoch-join': artifact('epoch-join'), 'epoch-batch-spend': artifact('epoch-batch-spend'), 'epoch-batch-join': artifact('epoch-batch-join'), 'epoch-nonmember': artifact('epoch-nonmember') };
type Circuit = keyof typeof circuits;
const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));

async function accepts(label: string, circuit: Circuit, input: Record<string, unknown>, check = false) {
 const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
 await snarkjs.wtns.calculate(toCircuitInput(input), circuits[circuit].wasm, wtns);
 if (check) assert.equal(await snarkjs.wtns.check(circuits[circuit].r1cs, wtns), true, label);
 console.log(`accepted: ${label}`);
}
// `expected` pins the constraint that must fail, so deleting it cannot leave this check green.
async function rejects(label: string, circuit: Circuit, input: Record<string, unknown>, expected: RegExp) {
 await assert.rejects(snarkjs.wtns.calculate(toCircuitInput(input), circuits[circuit].wasm, { type: 'mem' }), (error: unknown) => error instanceof Error && expected.test(error.message), label);
 console.log(`rejected: ${label}`);
}
function invMod(a: bigint, p: bigint) {
 let result = 1n, base = ((a % p) + p) % p;
 for (let e = p - 2n; e > 0n; e >>= 1n, base = base * base % p) if (e & 1n) result = result * base % p;
 return result;
}
// The witness an operator would need if the model let a spent nullifier through; only the circuit is left to refuse it.
function forced(state: EpochState, kind: EpochBatchKind, slots: EpochSlot[]) {
 const has = RollupNullifiers.prototype.has;
 RollupNullifiers.prototype.has = () => false;
 try { const result = state.apply(kind, slots); state.undoLast(); return result; } finally { RollupNullifiers.prototype.has = has; }
}

const { fresh, dummyInput, deposit, fastSlot, fill, noteFrom } = epochHarness(hash);
// The harness owner's ak is not an akOf output, so these notes get a spendable owner; 8n is the harness nk that noteFrom carries.
const ask = 7n, owner = ownerOf(hash, ROLLUP_DOMAIN, akOf(hash, ask), 8n);
const outputs = (amount: bigint): ClientSpend['outputs'] => [{ amount, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }];
const spend = (inputs: ClientInput[], s: Partial<ClientSpend> = {}): ClientSpend =>
 ({ domain: ROLLUP_DOMAIN, root: 0n, asset: BTC_ASSET, inputs, outputs: outputs(inputs.reduce((sum, input) => sum + input.amount, 0n)), deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...s });
const at = (sel: bigint[]) => ({ rPrev: rPrevFor(state), rCur: state.latestRoot(), sel });

// epochLen 2: A lands in epoch 0, batch 3 rotates and lands C in epoch 1, and the next batch is mid-epoch, so rPrev != rCur.
const state = EpochState.genesis(hash, 2), a = deposit(state, 1000n, { outputs: outputs(1000n) });
state.apply('spend', fill(state, [a.slot]));
state.apply('spend', fill(state));
const epoch0 = state.notes, c = deposit(state, 3000n, { outputs: outputs(3000n) });
state.apply('spend', fill(state, [c.slot]));
const noteA: ClientInput = { ...noteFrom(a), ask, path: epoch0.path(0) }, noteC: ClientInput = { ...noteFrom(c), ask, path: state.notes.path(0) };
const rPrev = rPrevFor(state), rCur = state.latestRoot();
assert.notEqual(rPrev, rCur);

const cur = epochClientInput(hash, spend([noteC]), at([0n]));
const prev = epochClientInput(hash, spend([noteA]), at([1n]));
const dep = epochClientInput(hash, spend([dummyInput()], { deposit: 500n, outputs: outputs(500n) }), at([0n]));
const cross = epochClientInput(hash, spend([noteC, noteA]), at([0n, 1n]));
await accepts('client spend of a current-epoch note (sel 0)', 'epoch-spend', cur.input, true);
await accepts('client spend of a previous-epoch note (sel 1)', 'epoch-spend', prev.input);
await accepts('client deposit through a dummy input', 'epoch-spend', dep.input);
await accepts('client join across both live epochs (sel 0 and 1)', 'epoch-join', cross.input, true);
await rejects('client join whose previous-epoch note claims the current tree', 'epoch-join', epochClientInput(hash, spend([noteC, noteA]), at([0n, 0n])).input, /EpochJoin_\d+ line: 29/);

const forged: ClientInput = { ...noteA, amount: 10n ** 18n, path: Array(32).fill(0n) };
const T = foldPath(hash, noteOf(hash, ROLLUP_DOMAIN, forged.amount, BTC_ASSET, owner, forged.rho), 0, forged.path);
const sel = ((T - rCur) * invMod(rPrev - rCur, ROLLUP_FIELD) % ROLLUP_FIELD + ROLLUP_FIELD) % ROLLUP_FIELD;
const inflated = epochClientInput(hash, spend([forged]), at([sel])).input;
const inflatedJoin = epochClientInput(hash, spend([noteC, forged]), at([0n, sel])).input;
for (let i = 0; i < 2; i++) state.apply('spend', fill(state));
const strayRoot = epochClientInput(hash, spend([noteA]), at([1n])).input;
await rejects('client spend with a non-boolean sel proving membership in a forged root', 'epoch-spend', inflated, /EpochSpend_\d+ line: 25/);
await rejects('client deposit whose dummy input carries a non-boolean sel', 'epoch-spend', epochClientInput(hash, spend([dummyInput()], { deposit: 500n, outputs: outputs(500n) }), at([2n])).input, /EpochSpend_\d+ line: 25/);
await rejects('client spend whose note is in neither anchored tree', 'epoch-spend', strayRoot, /EpochSpend_\d+ line: 27/);
await rejects('client join with a non-boolean sel on its second input', 'epoch-join', inflatedJoin, /EpochJoin_\d+ line: 27/);

const joinSlots = (s: EpochState) => Array.from({ length: BATCH_SLOTS }, () => deposit(s, 0n, { inputs: [dummyInput(), dummyInput()] }).slot);
const pool = EpochState.genesis(hash, 4), first = pool.apply('spend', fill(pool));
const [g0, g1] = [fastSlot(pool), fastSlot(pool)], groupId = groupIdOf(hash, [g0.nullifiers[0], g1.nullifiers[0]]);
const grouped = pool.apply('spend', fill(pool, [{ ...g0, groupId, groupSize: 2 }, { ...g1, groupId, groupSize: 2 }]));
const joined = pool.apply('join', joinSlots(pool));
const replayed = forced(state, 'spend', fill(state, [{ ...fastSlot(state), nullifiers: c.slot.nullifiers }]));
// Epoch 2, mid-epoch; slot 1 anchors on the c-1 leaf, so both branches of the window tag run.
const mid = state.apply('spend', fill(state, [fastSlot(state), fastSlot(state, 0n, { epoch: state.epoch - 1, root: state.prevNoteRoot })]));
assert.deepEqual([first, grouped, joined, mid].map(batch => batch.rotated), [false, false, false, false]);
assert.notEqual(mid.witness.rPrev, (mid.witness.rCurRoot as bigint[])[0]);
await accepts('epoch batch spend, mid-epoch, rPrev != rCur', 'epoch-batch-spend', epochBatchInput(mid.witness), true);
await accepts('epoch batch spend, the first batch ever, which must not rotate', 'epoch-batch-spend', epochBatchInput(first.witness));
await accepts('epoch batch spend with a two-slot group', 'epoch-batch-spend', epochBatchInput(grouped.witness));
await accepts('epoch batch join, two nullifiers per slot', 'epoch-batch-join', epochBatchInput(joined.witness));

const midInput = epochBatchInput(mid.witness), { epoch, epochLen, epochQ, epochR, batchCount, batchQ, erAppendPath, nmLeaf } = mid.witness as Record<string, any>;
const slot0 = (key: string, value: unknown) => ({ ...midInput, [key]: [value, ...(midInput[key] as unknown[]).slice(1)] });
const bits = (line: number) => new RegExp(`Num2Bits_\\d+ line: 38\\nError in template EpochRotation_\\d+ line: ${line}\\n`);
// circom 2.2.2 gives an undeclared input size 0, so the calculator says "Too many values", never "Signal not found".
for (const field of EPOCH_DERIVED_FIELDS)
 await rejects(`a batch may not supply ${field}`, 'epoch-batch-spend', { ...midInput, [field]: mid.witness[field] }, new RegExp(`Too many values for input signal ${field}\\n`));
// epochR = epochLen + r keeps the quotient identity true, so only the range check refuses it.
await rejects('epochR at or above EPOCH_LEN', 'epoch-batch-spend', { ...midInput, epochR: epochLen + epochR, epochQ: epochQ - 1n }, /EpochRotation_\d+ line: 31/);
await rejects('epochR out of its 21-bit range', 'epoch-batch-spend', { ...midInput, epochR: 2n ** 21n }, bits(29));
await rejects('epochR zero on a batch that must not rotate', 'epoch-batch-spend', { ...midInput, epochR: 0n }, /EpochRotation_\d+ line: 32/);
await rejects('epochQ off by one', 'epoch-batch-spend', { ...midInput, epochQ: epochQ + 1n }, /EpochRotation_\d+ line: 32/);
await rejects('batchQ off by one', 'epoch-batch-spend', { ...midInput, batchQ: batchQ + 1n }, bits(26));
// Each keeps its identity true through field division or a negative remainder, so only a bit decomposition refuses it.
await rejects('epochR negative, which LessThan(21) alone accepts', 'epoch-batch-spend', { ...midInput, epochR: ROLLUP_FIELD + epochR - epochLen, epochQ: epochQ + 1n }, bits(29));
await rejects('epochQ by field division, which would rotate mid-epoch', 'epoch-batch-spend', { ...midInput, epochR: 0n, epochQ: batchCount * invMod(epochLen, ROLLUP_FIELD) % ROLLUP_FIELD }, bits(30));
await rejects('batchQ by field division, which would write another window slot', 'epoch-batch-spend', { ...midInput, batchQ: invMod(64n, ROLLUP_FIELD) }, bits(27));
await rejects('erCount not equal to epoch', 'epoch-batch-spend', { ...midInput, erCount: epoch + 1n }, /EpochRotation_\d+ line: 36/);
await rejects('a forged archive append path', 'epoch-batch-spend', { ...midInput, erAppendPath: [erAppendPath[0] + 1n, ...erAppendPath.slice(1)] }, /EpochRotation_\d+ line: 48/);
await rejects('a root claimed from the wrong window slot', 'epoch-batch-spend', slot0('winIdx', 5n), /EpochBatch_\d+ line: 97/);
// No window leaf carries a future tag, so membership fires before the tag check can.
await rejects('a window pair tagged with a future epoch', 'epoch-batch-spend', slot0('rCurEpoch', epoch + 1n), /EpochBatch_\d+ line: 97/);

await rejects('a nullifier already in the frozen previous set', 'epoch-batch-spend', epochBatchInput(replayed.witness), /NonMember_\d+ line: 18/);
await rejects('a forged low leaf', 'epoch-batch-spend', slot0('nmLeaf', [nmLeaf[0][0] + 1n, ...nmLeaf[0].slice(1)]), /NonMember_\d+ line: 12/);
await rejects('a low leaf carrying nextIdx 0 with a non-zero nextValue', 'epoch-batch-spend', slot0('nmLeaf', [nmLeaf[0][0], 0n, 1n]), /NonMember_\d+ line: 12/);

// epochLen 4: the fifth batch is the first rotation (erCount 0) and the ninth the second.
pool.apply('spend', fill(pool));
const firstRotation = pool.apply('spend', fill(pool));
for (let i = 0; i < 3; i++) pool.apply('spend', fill(pool));
const secondRotation = pool.apply('spend', fill(pool));
const one = EpochState.genesis(hash, 1);
for (let i = 0; i < 2; i++) one.apply('spend', fill(one));
const len1 = one.apply('spend', fill(one));
// epochLen 2: the fifth batch rotates into epoch 2, so the root of batch 1, tagged epoch 0, is a c-2 leaf the window still holds.
const two = EpochState.genesis(hash, 2);
two.apply('spend', fill(two));
const twoBack = { epoch: two.epoch, root: two.latestRoot() };
for (let i = 0; i < 3; i++) two.apply('spend', fill(two));
const len2 = two.clone().apply('spend', fill(two)), rotatingJoin = two.clone().apply('join', joinSlots(two));
assert.deepEqual([firstRotation, secondRotation, len1, len2, rotatingJoin].map(batch => batch.rotated), Array(5).fill(true));
assert.deepEqual([firstRotation, secondRotation].map(batch => batch.witness.erCount), [0n, 1n]);
await accepts('the first rotation ever: an empty archive and the pseudo-epoch leaf', 'epoch-batch-spend', epochBatchInput(firstRotation.witness), true);
await accepts('a later rotation, archiving epoch 0', 'epoch-batch-spend', epochBatchInput(secondRotation.witness));
await accepts('a rotating join batch, 20 nullifiers from the sentinel', 'epoch-batch-join', epochBatchInput(rotatingJoin.witness), true);
await accepts('EPOCH_LEN 1, where every batch after the first rotates', 'epoch-batch-spend', epochBatchInput(len1.witness));
await accepts('EPOCH_LEN 2', 'epoch-batch-spend', epochBatchInput(len2.witness));
// The model refuses a c-2 slot, so slot 0 is forged: a real pre-batch window leaf, with pub recomputed over the post-rotation anchor.
const reanchor = (witness: Record<string, unknown>) => {
 const input = epochBatchInput(witness) as Record<string, any>, index = two.windowIndex(twoBack);
 const set0 = (key: string, value: unknown) => [value, ...input[key].slice(1)];
 const pub = statementOf(hash, { domain: ROLLUP_DOMAIN, root: anchorOf(hash, rPrevFor(two), twoBack.root), nullifiers: input.nf[0], commitments: input.cm[0], ctDigest: input.ctDigest[0], groupId: input.groupId[0], groupSize: Number(input.groupSize[0]) });
 return { ...input, pub: set0('pub', pub), rCurRoot: set0('rCurRoot', twoBack.root), rCurEpoch: set0('rCurEpoch', BigInt(twoBack.epoch)), winIdx: set0('winIdx', BigInt(index)), winPath: set0('winPath', two.window.path(index)) };
};
await rejects('a rotating spend batch anchoring on a c-2 tagged root', 'epoch-batch-spend', reanchor(len2.witness), /EpochBatch_\d+ line: 99/);
await rejects('a rotating join batch anchoring on a c-2 tagged root', 'epoch-batch-join', reanchor(rotatingJoin.witness), /EpochBatch_\d+ line: 99/);

const set = new RollupNullifiers(hash, EPOCH_NULLIFIER_DEPTH);
for (const value of [10n, 20n, 30n]) set.insert(value);
const low = set.nonMember(25n);
// root is free here, so a forged leaf still opens and the constraint under test is the one that fires.
const harness = (nf: bigint, pred: bigint[]) => ({ nf, root: foldPath(hash, hash([NULLIFIER_TAG, ...pred]), low.index, low.path), idx: BigInt(low.index), pred, path: low.path });
const honest = harness(25n, low.leaf);
assert.equal(honest.root, set.root());
await accepts('the NonMember harness accepts an honest low leaf', 'epoch-nonmember', honest, true);
await rejects('harness: the value is present', 'epoch-nonmember', harness(30n, low.leaf), /NonMember_\d+ line: 18/);
await rejects('harness: the low leaf is above the nullifier', 'epoch-nonmember', harness(15n, low.leaf), /NonMember_\d+ line: 13/);
await rejects('harness: nextIdx 0 with a non-zero nextValue', 'epoch-nonmember', harness(25n, [20n, 0n, 30n]), /NonMember_\d+ line: 16/);
await rejects('harness: a path that does not fold to the root', 'epoch-nonmember', { ...honest, path: [honest.path[0] + 1n, ...honest.path.slice(1)] }, /NonMember_\d+ line: 12/);
process.exit(0);
