import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { BTC_ASSET, ROLLUP_DOMAIN, ROLLUP_FIELD } from '../packages/protocol/src/rollup/constants.ts';
import { toCircuitInput, type ClientInput, type ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { EpochState } from '../packages/protocol/src/rollup/epoch.ts';
import { epochClientInput } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { akOf, noteOf, ownerOf } from '../packages/protocol/src/rollup/notes.ts';
import { epochHarness, foldPath, rPrevFor } from '../tests/fixtures/epoch.ts';

const build = process.argv[2] ?? join(process.cwd(), 'circuits', 'rollup', 'build');
const artifact = (name: string) => ({ wasm: join(build, `${name}_js`, `${name}.wasm`), r1cs: join(build, `${name}.r1cs`) });
const circuits = { 'epoch-spend': artifact('epoch-spend'), 'epoch-join': artifact('epoch-join') };
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

const { fresh, dummyInput, deposit, fill, noteFrom } = epochHarness(hash);
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

const forged: ClientInput = { ...noteA, amount: 10n ** 18n, path: Array(32).fill(0n) };
const T = foldPath(hash, noteOf(hash, ROLLUP_DOMAIN, forged.amount, BTC_ASSET, owner, forged.rho), 0, forged.path);
const sel = ((T - rCur) * invMod(rPrev - rCur, ROLLUP_FIELD) % ROLLUP_FIELD + ROLLUP_FIELD) % ROLLUP_FIELD;
const inflated = epochClientInput(hash, spend([forged]), at([sel])).input;
const inflatedJoin = epochClientInput(hash, spend([noteC, forged]), at([0n, sel])).input;
for (let i = 0; i < 2; i++) state.apply('spend', fill(state));
const strayRoot = epochClientInput(hash, spend([noteA]), at([1n])).input;
await rejects('client spend with a non-boolean sel proving membership in a forged root', 'epoch-spend', inflated, /EpochSpend_\d+ line: 25/);
await rejects('client spend whose note is in neither anchored tree', 'epoch-spend', strayRoot, /EpochSpend_\d+ line: 27/);
await rejects('client join with a non-boolean sel on its second input', 'epoch-join', inflatedJoin, /EpochJoin_\d+ line: 27/);
process.exit(0);
