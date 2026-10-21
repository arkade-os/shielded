import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { BTC_ASSET, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { toCircuitInput, type ClientInput, type ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { EpochState } from '../packages/protocol/src/rollup/epoch.ts';
import { epochBatchInput, epochClientInput } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { akOf, ownerOf, sha256le248 } from '../packages/protocol/src/rollup/notes.ts';
import { le } from '../packages/protocol/src/rollup/wallet.ts';
import { epochHarness } from '../tests/fixtures/epoch.ts';

const keys = 'circuits/rollup/build/keys-epoch-dev', output = 'tools/vm/testdata/rollup-epoch-covenant-snarkjs.json';
const prove = (input: Record<string, unknown>, name: string) => snarkjs.groth16.fullProve(toCircuitInput(input), `${keys}/${name}.wasm`, `${keys}/${name}.zkey`);
const vkey = (name: string) => JSON.parse(readFileSync(`${keys}/${name}.vkey.json`, 'utf8'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { fresh, deposit, fill, noteFrom } = epochHarness(hash);
const ask = 7n, owner = ownerOf(hash, ROLLUP_DOMAIN, akOf(hash, ask), 8n);
const outputs = (amount: bigint): ClientSpend['outputs'] => [{ amount, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }];

// epochLen 2, as the witness smoke's vault: one note spent in epoch 0 and one in epoch 1, so the fifth batch rotates and archives epoch 0.
const vault = EpochState.genesis(hash, 2), epoch0 = vault.notes, minted = Array.from({ length: 3 }, () => deposit(vault, 1000n, { outputs: outputs(1000n) }));
vault.apply('spend', fill(vault, minted.map(made => made.slot)));
const [note, spentIn0, spentIn1] = minted.map(made => noteFrom(made));
const spendNote = (input: ClientInput) => vault.apply('spend', fill(vault, [deposit(vault, 0n, { inputs: [input] }).slot]));
spendNote(spentIn0);
vault.apply('spend', fill(vault));
spendNote(spentIn1);

const noteFinal = epoch0.root(), spend: ClientSpend = { domain: ROLLUP_DOMAIN, root: 0n, asset: BTC_ASSET, inputs: [{ ...note, ask, path: epoch0.path(0) }], outputs: outputs(note.amount), deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0 };
const client = epochClientInput(hash, spend, { rPrev: noteFinal, rCur: noteFinal, sel: [0n] }), { root: anchor, ...slot } = client.slot;
const oldPacket = Uint8Array.from([...le(vault.commitment(), 32), ...le(0n, 32), ...le(0n, 32)]);
const result = vault.apply('recover', [{ ...slot, anchor, rCur: { epoch: 0, root: noteFinal }, origin: 0 }]);
// The leaf hashes this packet into the statement, so its DA and block roots must be the model's, not random bytes as in the genesis-3 toy fixture.
const newPacket = Uint8Array.from([...le(vault.commitment(), 32), ...le(result.daRoot, 32), ...le(result.blockRoot, 32)]);
const slotProof = await prove(client.input, 'epoch-spend'), batch = await prove(epochBatchInput(result.witness), 'epoch-batch-recover');
assert.equal(batch.publicSignals.at(-1), sha256le248(result.binding).toString());
assert.deepEqual([...result.binding], [0x53, 0x48, 4, 2, 1, ...oldPacket.subarray(0, 32), ...newPacket]);
writeFileSync(output, JSON.stringify({ clientKey: vkey('epoch-spend'), batchKey: vkey('epoch-batch-recover'), oldPacket: hex(oldPacket), newPacket: hex(newPacket), payoutProgram: '', slots: [slotProof], batch }, null, 1) + '\n');
console.log('wrote', output);
process.exit(0);
