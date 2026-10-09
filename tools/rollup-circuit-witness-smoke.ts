import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { BATCH_SLOTS, BTC_ASSET, ROLLUP_DOMAIN, type BatchKind } from '../packages/protocol/src/rollup/constants.ts';
import { assetFieldOf, destinationFieldOf, groupIdOf, noteOf, nullifierOf, outputRhoOf, ownerOf, statementOf } from '../packages/protocol/src/rollup/notes.ts';
import { RollupNullifiers } from '../packages/protocol/src/rollup/nullifiers.ts';
import { RollupState, type BatchSlot } from '../packages/protocol/src/rollup/state.ts';
import { buildRollupTransfer } from '../packages/protocol/src/rollup/account.ts';
import { x25519 } from '@noble/curves/ed25519.js';
import { clientWitness, inputNullifierOf, toCircuitInput, type ClientInput, type ClientSpend, type ClientWitness } from '../packages/protocol/src/rollup/client.ts';

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
// `expected` pins the constraint that must fail, so deleting it cannot leave this check green.
async function rejects(label: string, circuit: Circuit, input: Record<string, unknown>, expected: RegExp) {
 await assert.rejects(snarkjs.wtns.calculate(toCircuitInput(input), circuits[circuit].wasm, { type: 'mem' }), (error: unknown) => error instanceof Error && expected.test(error.message), label);
 console.log(`rejected: ${label}`);
}
// Builds the witness an operator would need if the model let a spent nullifier through; only the circuit is left to refuse it.
function forced(state: RollupState, kind: BatchKind, slots: BatchSlot[]) {
 const has = RollupNullifiers.prototype.has;
 RollupNullifiers.prototype.has = () => false;
 try { const result = state.apply(kind, slots); state.undoLast(); return result; } finally { RollupNullifiers.prototype.has = has; }
}

interface Owned { amount: bigint; ask: bigint; nk: bigint; rho: bigint; index: number }
const aliceAsk = 7n, aliceNk = 8n, aliceOwner = ownerOf(hash, ROLLUP_DOMAIN, aliceAsk, aliceNk);
const dummyInput = (): ClientInput => ({ amount: 0n, ask: fresh(), nk: fresh(), rho: fresh(), index: 0, path: Array(32).fill(0n) });
const zeroOutputs = (): ClientSpend['outputs'] => [{ amount: 0n, owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }];
const spend = (s: Partial<ClientSpend> & Pick<ClientSpend, 'root' | 'inputs' | 'outputs'>): ClientSpend =>
 ({ domain: ROLLUP_DOMAIN, asset: BTC_ASSET, deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0, ...s });
const padding = (state: RollupState, inputs: number) => clientWitness(hash, spend({ root: state.latestRoot(), inputs: Array.from({ length: inputs }, dummyInput), outputs: zeroOutputs() })).slot;
const owned = (w: ClientWitness, s: ClientSpend, output: 0 | 1, index: number): Owned =>
 ({ amount: s.outputs[output].amount, ask: aliceAsk, nk: aliceNk, rho: outputRhoOf(hash, ROLLUP_DOMAIN, s.outputs[output].random, w.slot.nullifiers, output), index });

let state = RollupState.genesis(hash);

// Batch 1: deposits; slots 3 and 4 shield BTC and an asset as one group.
const asset = assetFieldOf(new Uint8Array(34).fill(9));
const groupInputs = [dummyInput(), dummyInput()];
const groupId = groupIdOf(hash, groupInputs.map(input => inputNullifierOf(hash, ROLLUP_DOMAIN, input)));
const deposits = Array.from({ length: BATCH_SLOTS }, (_, i) => spend({
 root: state.latestRoot(), inputs: [i === 3 || i === 4 ? groupInputs[i - 3] : dummyInput()], asset: i === 4 ? asset : BTC_ASSET,
 deposit: BigInt(1000 * (i + 1)), outputs: [{ amount: BigInt(1000 * (i + 1)), owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }],
 ...(i === 3 || i === 4 ? { groupId, groupSize: 2 } : {}),
}));
const depositWitnesses = deposits.map(s => clientWitness(hash, s));
await accepts('client deposit through a dummy input', 'spend', depositWitnesses[0].input, true);
await accepts('client asset deposit inside a group', 'spend', depositWitnesses[4].input);
assert.equal(depositWitnesses[4].publicSignals[3], asset, 'a deposit publishes its asset');
const hidden = structuredClone(depositWitnesses[4].input) as Record<string, any>;
hidden.boundaryAsset = 0n;
await rejects('client asset deposit hiding its asset', 'spend', hidden, /Spend_\d+ line: 36/);
const batch1 = state.apply('spend', depositWitnesses.map(w => w.slot));
await accepts('batch 1: eleven deposits including a BTC+asset group', 'batch-spend', batch1.witness, true);
const loose: BatchSlot = { ...depositWitnesses[4].slot, groupId: 0n, groupSize: 0 };
const missingMember = structuredClone(batch1.witness) as Record<string, any>;
missingMember.groupId[4] = 0n; missingMember.groupSize[4] = 0n; missingMember.pub[4] = statementOf(hash, { domain: ROLLUP_DOMAIN, ...loose });
await rejects('batch whose group run is missing a member', 'batch-spend', missingMember, /GroupRule_\d+ line: 132/);
assert.throws(() => state.apply('spend', depositWitnesses.map((w, i) => (i === 4 ? loose : w.slot))), /consecutive slots/);

// Batch 2: a transfer, a withdrawal and an internal asset transfer from batch-1 notes; the rest is operator padding.
const notes = deposits.map((s, slot) => owned(depositWitnesses[slot], s, 0, 2 * slot));
const input = (note: Owned): ClientInput => ({ ...note, path: state.notes.path(note.index) });
const transfer = spend({ root: state.latestRoot(), inputs: [input(notes[0])], outputs: [{ amount: 600n, owner: aliceOwner, random: fresh() }, { amount: 400n, owner: aliceOwner, random: fresh() }] });
const withdrawal = spend({ root: state.latestRoot(), inputs: [input(notes[1])], withdraw: 2000n, destination: destinationFieldOf(new Uint8Array(32).fill(5)), outputs: zeroOutputs() });
const assetTransfer = spend({ root: state.latestRoot(), asset, inputs: [input(notes[4])], outputs: [{ amount: 3000n, owner: aliceOwner, random: fresh() }, { amount: 2000n, owner: aliceOwner, random: fresh() }] });
const transferWitness = clientWitness(hash, transfer), withdrawalWitness = clientWitness(hash, withdrawal), assetTransferWitness = clientWitness(hash, assetTransfer);
await accepts('client transfer', 'spend', transferWitness.input, true);
await accepts('client withdrawal', 'spend', withdrawalWitness.input);
await accepts('client asset transfer inside the pool', 'spend', assetTransferWitness.input);
assert.equal(assetTransferWitness.publicSignals[3], 0n, 'an internal transfer keeps its asset private');
const revealed = structuredClone(assetTransferWitness.input) as Record<string, any>;
revealed.boundaryAsset = asset;
await rejects('client internal transfer publishing its asset', 'spend', revealed, /Spend_\d+ line: 36/);
const minted = clientWitness(hash, { ...transfer, outputs: [{ ...transfer.outputs[0], amount: 601n }, transfer.outputs[1]] });
await rejects('client output larger than its input', 'spend', minted.input, /Spend_\d+ line: 34/);
const stray = structuredClone(transferWitness.input) as Record<string, any>;
stray.destination = 5n;
await rejects('client destination without a withdrawal', 'spend', stray, /Spend_\d+ line: 35/);
const batch2Slots = [transferWitness.slot, withdrawalWitness.slot, assetTransferWitness.slot, ...Array.from({ length: BATCH_SLOTS - 3 }, () => padding(state, 1))];
const twin = padding(state, 1);
const sameBatch = forced(state, 'spend', [twin, twin, ...batch2Slots.slice(2)]);
await rejects('batch spending one nullifier in two slots', 'batch-spend', sameBatch.witness, /IndexedInsert_\d+ line: 49/);
const batch2 = state.apply('spend', batch2Slots);
await accepts('batch 2: transfer, withdrawal, asset transfer and eight padding spends', 'batch-spend', batch2.witness);
const wrongSlot = structuredClone(batch2.witness) as Record<string, any>;
wrongSlot.winIdx[0] = 5n;
await rejects('batch claiming a root from the wrong window slot', 'batch-spend', wrongSlot, /Batch_\d+ line: 168/);
const respent = batch2Slots.map(slot => ({ ...slot, root: state.latestRoot() }));
assert.throws(() => state.apply('spend', respent), /already spent/);
await rejects('batch re-spending a nullifier from an earlier batch', 'batch-spend', forced(state, 'spend', respent).witness, /IndexedInsert_\d+ line: 49/);

// A viewing-key holder's freeze attempt: a dummy input carrying the victim's nk and rho.
const victim = notes[2];
const realNullifier = nullifierOf(hash, ROLLUP_DOMAIN, aliceNk, victim.rho);
// The attacker's statement is consistent end to end: its commitments derive from the nullifiers it publishes.
const forge = (s: ClientSpend, nullifiers: bigint[]) => {
 const w = clientWitness(hash, s), input = structuredClone(w.input) as Record<string, any>;
 const commitments = s.outputs.map((out, o) => noteOf(hash, ROLLUP_DOMAIN, out.amount, s.asset, out.owner, outputRhoOf(hash, ROLLUP_DOMAIN, out.random, nullifiers, o))) as [bigint, bigint];
 input.pub = statementOf(hash, { domain: ROLLUP_DOMAIN, ...w.slot, nullifiers, commitments });
 return { w, input };
};
const frozen = forge(spend({ root: state.latestRoot(), inputs: [{ ...dummyInput(), nk: aliceNk, rho: victim.rho }], outputs: zeroOutputs() }), [realNullifier]);
await rejects('dummy spend publishing a real note\'s nullifier', 'spend', frozen.input, /Spend_\d+ line: 42/);
assert.notEqual(frozen.w.slot.nullifiers[0], realNullifier, 'a dummy input must not be able to publish a real note\'s nullifier');
const noAuthority = structuredClone(transferWitness.input) as Record<string, any>;
noAuthority.ask = 999n;
await rejects('client spend with the viewing key but no spend authority', 'spend', noAuthority, /Spend_\d+ line: 24/);
const swappedNk = structuredClone(transferWitness.input) as Record<string, any>;
swappedNk.nk = aliceNk + 1n;
await rejects('client spend with a swapped nullifier key', 'spend', swappedNk, /Spend_\d+ line: 24/);
const forgedNf = structuredClone(transferWitness.input) as Record<string, any>;
forgedNf.pub = statementOf(hash, { domain: ROLLUP_DOMAIN, ...transferWitness.slot, nullifiers: [1n] });
await rejects('client spend publishing a nullifier it did not derive', 'spend', forgedNf, /Spend_\d+ line: 42/);

// Batch 3: consolidate the transfer's two outputs with the join circuit.
const change = [owned(transferWitness, transfer, 0, 32), owned(transferWitness, transfer, 1, 33)];
const merge = spend({ root: state.latestRoot(), inputs: change.map(input), outputs: [{ amount: 1000n, owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }] });
const mergeWitness = clientWitness(hash, merge);
await accepts('client join of 600 and 400 into 1000', 'join', mergeWitness.input, true);
const twice = clientWitness(hash, { ...merge, inputs: [input(change[0]), input(change[0])], outputs: [{ ...merge.outputs[0], amount: 1200n }, merge.outputs[1]] });
await rejects('client join spending one note twice', 'join', twice.input, /Join_\d+ line: 28/);
const joinRevealed = structuredClone(mergeWitness.input) as Record<string, any>;
joinRevealed.boundaryAsset = 5n;
await rejects('client join publishing an asset without a boundary leg', 'join', joinRevealed, /Join_\d+ line: 39/);
const batch3 = state.apply('join', [mergeWitness.slot, ...Array.from({ length: BATCH_SLOTS - 1 }, () => padding(state, 2))]);
await accepts('batch 3: one join and ten padding joins', 'batch-join', batch3.witness);
const pair = spend({ root: state.latestRoot(), inputs: [input(notes[5]), input(notes[6])], outputs: [{ amount: notes[5].amount + notes[6].amount, owner: aliceOwner, random: fresh() }, { amount: 0n, owner: aliceOwner, random: fresh() }] });
const pairWitness = clientWitness(hash, pair);
await accepts('client join of two deposits', 'join', pairWitness.input);
const joinNoAuthority = structuredClone(pairWitness.input) as Record<string, any>;
joinNoAuthority.ask[1] = 999n;
await rejects('client join with the viewing key but no spend authority', 'join', joinNoAuthority, /Join_\d+ line: 25/);
const joinSwappedNk = structuredClone(pairWitness.input) as Record<string, any>;
joinSwappedNk.nk[1] = aliceNk + 1n;
await rejects('client join with a swapped nullifier key', 'join', joinSwappedNk, /Join_\d+ line: 25/);
const joinFrozen = forge({ ...pair, inputs: [input(notes[5]), { ...dummyInput(), nk: aliceNk, rho: victim.rho }], outputs: [{ ...pair.outputs[0], amount: notes[5].amount }, pair.outputs[1]] },
 [nullifierOf(hash, ROLLUP_DOMAIN, aliceNk, notes[5].rho), realNullifier]);
await rejects('dummy join input publishing a real note\'s nullifier', 'join', joinFrozen.input, /Join_\d+ line: 45/);
const aliceSelf = { owner: aliceOwner, viewPublic: x25519.getPublicKey(x25519.utils.randomSecretKey()) };
const ownedOf = (n: Owned) => ({ amount: n.amount, asset: BTC_ASSET, rho: n.rho, index: n.index, nullifier: nullifierOf(hash, ROLLUP_DOMAIN, aliceNk, n.rho) });
const walletJoin = await buildRollupTransfer(hash, { root: state.latestRoot(), ask: aliceAsk, nk: aliceNk, self: aliceSelf, request: { inputs: [ownedOf(notes[5]), ownedOf(notes[6])] }, paths: [state.notes.path(notes[5].index), state.notes.path(notes[6].index)] });
await accepts('wallet-built join of two notes', 'join', walletJoin.witness.input);
await accepts('wallet-built join padding', 'join', (await buildRollupTransfer(hash, { root: state.latestRoot(), ask: fresh(), nk: fresh(), self: aliceSelf, request: {}, width: 2 })).witness.input);
console.log(`after three batches: ${state.noteCount} note slots, ${state.nullifiers.count()} nullifier leaves`);
process.exit(0);
