import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { BATCH_SLOTS, BTC_ASSET, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { assetFieldOf, destinationFieldOf, groupIdOf, nullifierOf, outputRhoOf, ownerOf, statementOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupState, type BatchSlot } from '../packages/protocol/src/rollup/state.ts';
import { clientWitness, toCircuitInput, type ClientInput, type ClientSpend, type ClientWitness } from '../packages/protocol/src/rollup/client.ts';

const build = process.argv[2] ?? join(process.cwd(), 'circuits', 'rollup', 'build');
const artifact = (name: string) => ({ wasm: join(build, `${name}_js`, `${name}.wasm`), r1cs: join(build, `${name}.r1cs`) });
const circuits = { spend: artifact('spend'), join: artifact('join'), 'batch-spend': artifact('batch-spend'), 'batch-join': artifact('batch-join') };
type Circuit = keyof typeof circuits;
const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
let counter = 1000n;
const fresh = () => ++counter;

async function accepts(label: string, circuit: Circuit, input: Record<string, unknown>, check = false) {
 const wtns: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
 await snarkjs.wtns.calculate(toCircuitInput(input), circuits[circuit].wasm, wtns);
 if (check) assert.equal(await snarkjs.wtns.check(circuits[circuit].r1cs, wtns), true, label);
 console.log(`accepted: ${label}`);
}
async function rejects(label: string, circuit: Circuit, input: Record<string, unknown>) {
 await assert.rejects(snarkjs.wtns.calculate(toCircuitInput(input), circuits[circuit].wasm, { type: 'mem' }), Error, label);
 console.log(`rejected: ${label}`);
}

interface Owned { amount: bigint; spendSecret: bigint; rho: bigint; index: number }
const alice = 7n, aliceOwner = ownerOf(hash, ROLLUP_DOMAIN, alice);
const dummyInput = (): ClientInput => ({ amount: 0n, spendSecret: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
const zeroOutputs = (): ClientSpend['outputs'] => [{ amount: 0n, owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }];
const spend = (s: Partial<ClientSpend> & Pick<ClientSpend, 'root' | 'inputs' | 'outputs'>): ClientSpend =>
 ({ domain: ROLLUP_DOMAIN, asset: BTC_ASSET, deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...s });
const padding = (state: RollupState, inputs: number) => clientWitness(hash, spend({ root: state.latestRoot(), inputs: Array.from({ length: inputs }, dummyInput), outputs: zeroOutputs() })).slot;
const owned = (w: ClientWitness, s: ClientSpend, output: 0 | 1, index: number): Owned =>
 ({ amount: s.outputs[output].amount, spendSecret: alice, rho: outputRhoOf(hash, ROLLUP_DOMAIN, s.outputs[output].random, w.slot.nullifiers, output), index });

let state = RollupState.genesis(hash);

// Batch 1: deposits; slots 3 and 4 shield BTC and an asset as one group.
const asset = assetFieldOf(new Uint8Array(34).fill(9));
const groupInputs = [dummyInput(), dummyInput()];
const groupId = groupIdOf(hash, groupInputs.map(input => nullifierOf(hash, ROLLUP_DOMAIN, input.spendSecret, input.rho)));
const deposits = Array.from({ length: BATCH_SLOTS }, (_, i) => spend({
 root: state.latestRoot(), inputs: [i === 3 || i === 4 ? groupInputs[i - 3] : dummyInput()], asset: i === 4 ? asset : BTC_ASSET,
 deposit: BigInt(1000 * (i + 1)), outputs: [{ amount: BigInt(1000 * (i + 1)), owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }],
 ...(i === 3 || i === 4 ? { groupId, groupSize: 2 } : {}),
}));
const depositWitnesses = deposits.map(s => clientWitness(hash, s));
await accepts('client deposit through a dummy input', 'spend', depositWitnesses[0].input, true);
await accepts('client asset deposit inside a group', 'spend', depositWitnesses[4].input);
const batch1 = state.apply('spend', depositWitnesses.map(w => w.slot));
await accepts('batch 1: eleven deposits including a BTC+asset group', 'batch-spend', batch1.witness, true);
const loose: BatchSlot = { ...depositWitnesses[4].slot, groupId: 0n, groupSize: 0 };
const missingMember = structuredClone(batch1.witness) as Record<string, any>;
missingMember.groupId[4] = 0n; missingMember.groupSize[4] = 0n; missingMember.pub[4] = statementOf(hash, { domain: ROLLUP_DOMAIN, ...loose });
await rejects('batch whose group run is missing a member', 'batch-spend', missingMember);
assert.throws(() => state.apply('spend', depositWitnesses.map((w, i) => (i === 4 ? loose : w.slot))), /consecutive slots/);
state = batch1.next;

// Batch 2: a transfer and a withdrawal from batch-1 notes; the rest is operator padding.
const notes = deposits.map((s, slot) => owned(depositWitnesses[slot], s, 0, 2 * slot));
const input = (note: Owned): ClientInput => ({ ...note, path: state.notes.path(note.index) });
const transfer = spend({ root: state.latestRoot(), inputs: [input(notes[0])], outputs: [{ amount: 600n, owner: aliceOwner, random: fresh() }, { amount: 400n, owner: aliceOwner, random: fresh() }] });
const withdrawal = spend({ root: state.latestRoot(), inputs: [input(notes[1])], withdraw: 2000n, destination: destinationFieldOf(new Uint8Array(32).fill(5)), outputs: zeroOutputs() });
const transferWitness = clientWitness(hash, transfer), withdrawalWitness = clientWitness(hash, withdrawal);
await accepts('client transfer', 'spend', transferWitness.input, true);
await accepts('client withdrawal', 'spend', withdrawalWitness.input);
const minted = structuredClone(transferWitness.input) as Record<string, any>;
minted.outAmount[0] = 601n;
await rejects('client output larger than its input', 'spend', minted);
const stray = structuredClone(transferWitness.input) as Record<string, any>;
stray.destination = 5n;
await rejects('client destination without a withdrawal', 'spend', stray);
const batch2Slots = [transferWitness.slot, withdrawalWitness.slot, ...Array.from({ length: BATCH_SLOTS - 2 }, () => padding(state, 1))];
const batch2 = state.apply('spend', batch2Slots);
await accepts('batch 2: transfer, withdrawal and nine padding spends', 'batch-spend', batch2.witness);
const wrongSlot = structuredClone(batch2.witness) as Record<string, any>;
wrongSlot.winIdx[0] = 5n;
await rejects('batch claiming a root from the wrong window slot', 'batch-spend', wrongSlot);
assert.throws(() => batch2.next.apply('spend', batch2Slots.map(slot => ({ ...slot, root: batch2.next.latestRoot() }))), /already spent/);
state = batch2.next;

// Batch 3: consolidate the transfer's two outputs with the join circuit.
const change = [owned(transferWitness, transfer, 0, 32), owned(transferWitness, transfer, 1, 33)];
const merge = spend({ root: state.latestRoot(), inputs: change.map(input), outputs: [{ amount: 1000n, owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }] });
const mergeWitness = clientWitness(hash, merge);
await accepts('client join of 600 and 400 into 1000', 'join', mergeWitness.input, true);
const twice = structuredClone(mergeWitness.input) as Record<string, any>;
for (const key of ['inAmount', 'inRho', 'path', 'bits']) twice[key][1] = twice[key][0];
await rejects('client join spending one note twice', 'join', twice);
const batch3 = state.apply('join', [mergeWitness.slot, ...Array.from({ length: BATCH_SLOTS - 1 }, () => padding(state, 2))]);
await accepts('batch 3: one join and ten padding joins', 'batch-join', batch3.witness);
console.log(`after three batches: ${batch3.next.noteCount} note slots, ${batch3.next.nullifiers.count()} nullifier leaves`);
process.exit(0);
