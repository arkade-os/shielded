import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { BTC_ASSET, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import type { ClientInput, ClientSpend } from '../packages/protocol/src/rollup/client.ts';
import { EpochState, anchorOf } from '../packages/protocol/src/rollup/epoch.ts';
import { EPOCH_DERIVED_FIELDS, epochBatchInput, epochClientInput } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { epochHarness } from './fixtures/epoch.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const { owner, fresh, dummyInput, deposit, fill, noteFrom, recoverSlot } = epochHarness(hash);
const spendOf = (inputs: ClientInput[]): ClientSpend => ({ domain: ROLLUP_DOMAIN, root: 0n, asset: BTC_ASSET, inputs, outputs: [{ amount: 0n, owner, random: fresh() }, { amount: 0n, owner, random: fresh() }], deposit: 0n, withdraw: 0n, destination: 0n, ctDigest: fresh(), groupId: 0n, groupSize: 0 });
const spend1 = spendOf([dummyInput()]), spend2 = spendOf([dummyInput(), dummyInput()]);

test('the batch adapter drops exactly the fields the circuits derive', () => {
 const state = EpochState.genesis(hash, 1024);
 const { witness } = state.apply('spend', fill(state));
 const input = epochBatchInput(witness);
 assert.deepEqual(Object.keys(input).sort(), Object.keys(witness).filter(k => !EPOCH_DERIVED_FIELDS.includes(k as never)).sort());
 for (const field of EPOCH_DERIVED_FIELDS) assert.equal(field in input, false, field);
 assert.equal(input.epochR, witness.epochR);
});

test('the recover adapter keeps the archive and RS openings', () => {
 const state = EpochState.genesis(hash, 2), made = deposit(state, 1000n), note = noteFrom(made);
 state.apply('spend', fill(state, [made.slot]));
 for (let batch = 2; batch <= 5; batch++) state.apply('spend', fill(state));
 const input = epochBatchInput(state.apply('recover', [recoverSlot(state, 0, note)]).witness);
 for (const key of ['erIdx', 'erPath', 'erNoteFinal', 'nfA', 'nfB', 'nmaLeaf', 'nmbLeaf', 'rsPredIdx', 'rsAppendPath']) assert.ok(key in input, key);
 assert.equal('rCurRoot' in input, false);
});

test('the client input carries rPrev, rCur and one sel per input', () => {
 const one = epochClientInput(hash, spend1, { rPrev: 7n, rCur: 9n, sel: [1n] });
 assert.equal('root' in one.input, false);
 assert.deepEqual([one.input.rPrev, one.input.rCur, one.input.sel], [7n, 9n, 1n]);
 assert.equal(one.slot.root, anchorOf(hash, 7n, 9n));
 const two = epochClientInput(hash, spend2, { rPrev: 7n, rCur: 9n, sel: [0n, 1n] });
 assert.deepEqual(two.input.sel, [0n, 1n]);
 assert.throws(() => epochClientInput(hash, spend2, { rPrev: 7n, rCur: 9n, sel: [0n] }));
});
