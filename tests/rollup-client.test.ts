import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { BTC_ASSET, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { clientWitness, toCircuitInput, type ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { noteOf, nullifierOf, outputRhoOf, ownerOf, statementOf } from '../packages/protocol/src/rollup/notes.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const owner = ownerOf(hash, ROLLUP_DOMAIN, 7n);
const base: ClientSpend = {
 domain: ROLLUP_DOMAIN, root: 99n, asset: BTC_ASSET,
 inputs: [{ amount: 100n, spendSecret: 7n, rho: 11n, index: 5, path: Array(32).fill(0n) }],
 outputs: [{ amount: 60n, owner, random: 1n }, { amount: 40n, owner, random: 2n }],
 deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: 3n, groupId: 0n, groupSize: 0,
};

test('a spend slot carries the nullifier and commitments the circuit derives', () => {
 const { slot, publicSignals, input } = clientWitness(hash, base);
 const nf = nullifierOf(hash, ROLLUP_DOMAIN, 7n, 11n);
 assert.deepEqual(slot.nullifiers, [nf]);
 assert.equal(slot.commitments[0], noteOf(hash, ROLLUP_DOMAIN, 60n, BTC_ASSET, owner, outputRhoOf(hash, ROLLUP_DOMAIN, 1n, [nf], 0)));
 assert.deepEqual(publicSignals, [statementOf(hash, { domain: ROLLUP_DOMAIN, ...slot }), 0n, 0n, BTC_ASSET, 0n]);
 assert.equal(input.inAmount, 100n);
 assert.deepEqual((input.bits as bigint[]).slice(0, 3), [1n, 0n, 1n]);
});

test('a join slot has both nullifiers and per-input arrays', () => {
 const second = { amount: 5n, spendSecret: 7n, rho: 12n, index: 6, path: Array(32).fill(0n) };
 const join = clientWitness(hash, { ...base, inputs: [base.inputs[0], second], outputs: [{ amount: 105n, owner, random: 1n }, { amount: 0n, owner, random: 2n }] });
 assert.equal(join.slot.nullifiers.length, 2);
 assert.deepEqual(join.input.inAmount, [100n, 5n]);
 assert.throws(() => clientWitness(hash, { ...base, inputs: [] }), /one input/);
});

test('an internal transfer hides its asset and a boundary leg reveals it', () => {
 assert.equal(clientWitness(hash, { ...base, asset: 77n }).publicSignals[3], 0n);
 const deposit = clientWitness(hash, { ...base, asset: 77n, inputs: [{ ...base.inputs[0], amount: 0n }], deposit: 100n });
 assert.equal(deposit.publicSignals[3], 77n);
 assert.equal(deposit.input.boundaryAsset, 77n);
});

test('circuit inputs are decimal strings', () => {
 assert.deepEqual(toCircuitInput({ a: 5n, b: [1n, [2n]] }), { a: '5', b: ['1', ['2']] });
});
