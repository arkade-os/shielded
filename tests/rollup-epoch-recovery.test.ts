import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import type { RollupEpochRecord } from '../packages/protocol/src/rollup/epoch-record.ts';
import { bearerKeysOf, bearerOf } from '../src/shielded/bearer.ts';
import { epochFreshAccount } from '../src/shielded/epoch-checkpoint.ts';
import { epochProvingUrls, epochTransferBody } from '../src/shielded/epoch-pool.ts';
import { archivesHeld, claimRecovery, needsRecovery } from '../src/shielded/epoch-recovery.ts';
import { epochCatchUp } from '../src/shielded/epoch-sync.ts';
import type { PoolApi } from '../src/shielded/pool.ts';
import { ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { anchorOf } from '../packages/protocol/src/rollup/epoch.ts';
import { EpochAccount } from '../packages/protocol/src/rollup/epoch-account.ts';
import type { EpochBuiltSpend } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { noteOf, statementOf } from '../packages/protocol/src/rollup/notes.ts';
import { rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { rejection } from './fixtures/epoch.ts';
import { epochPool, fromBody, opens } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const alice = (epochLen: number) => EpochAccount.owning(hash, aliceKeys, { epochLen });
const proof = { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['5', '6', '1'] };
const wire = (built: EpochBuiltSpend) => JSON.parse(JSON.stringify(epochTransferBody('ab'.repeat(16), built, proof)));
/** The spend as the pool decodes the body the wallet posts. */
const sent = (built: EpochBuiltSpend) => fromBody(wire(built));
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (const batch of (await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${account.batchCount}&limit=500`)).batches) await account.apply(batch);
};
/** Alice holds 900 at (0, 0) and 400 at (0, 2) of a pool with 4-batch epochs that has landed `batches` batches. */
const stranded = async (batches: number) => {
 const pool = epochPool(hash, 4), account = alice(4);
 pool.land('spend', [await pool.deposit(aliceTo, 900n), await pool.deposit(aliceTo, 400n)]);
 while (pool.state.batchCount < batches) pool.land();
 await replay(account, pool.api);
 return { pool, account, notes: account.notes() };
};

test('a note two epochs old is recovered, and the pool admits the width-1 batch', async () => {
 const { pool, account, notes: [note] } = await stranded(9), recovered = pool.state.recovered.count();
 assert.deepEqual([account.epoch, account.rotatesNext, account.spendable(note!), needsRecovery(note!, account.anchorPlan())], [2, false, false, true]);
 const record = pool.land('recover', [sent(await account.recover(note!, aliceTo))]);
 assert.deepEqual([record.kind, record.slots.length, record.slots[0]!.origin, 'rCur' in record.slots[0]!], ['recover', 1, 0, false]);
 assert.deepEqual([pool.state.recovered.count() - recovered, pool.state.recovered.has(note!.nullifier), pool.state.epoch], [1, true, 2]);
});

test('the recovery slot carries origin and no rCur, and its anchor opens against noteFinal twice', async () => {
 const { pool, account, notes: [note] } = await stranded(9), noteFinal = account.noteFinal(0)!;
 const built = await account.recover(note!, aliceTo), body = wire(built), { rPrev, rCur, sel } = built.witness.input;
 assert.deepEqual([Object.keys(body).sort(), Object.keys(body.slot).sort()], [['ciphertext', 'id', 'proof', 'publics', 'slot'], ['anchor', 'commitments', 'ctDigest', 'groupId', 'groupSize', 'nullifiers', 'origin']]);
 assert.deepEqual([noteFinal, rPrev, rCur, sel, body.slot.anchor], [pool.state.archive.record(0)!.noteFinal, noteFinal, noteFinal, 0n, String(anchorOf(hash, noteFinal, noteFinal))]);
 assert.ok(opens(hash, account.owner, built, [note!]), 'the frozen path folds to noteFinal');
 assert.deepEqual([body.slot.origin, body.slot.nullifiers, body.publics.slice(3), body.slot.groupId, body.slot.groupSize], [0, [String(note!.nullifier)], ['0', '0', '0', '0'], '0', 0], 'no deposit, withdrawal, asset, destination or group');
 const { anchor, nullifiers, commitments, ctDigest } = body.slot;
 assert.equal(String(statementOf(hash, { domain: ROLLUP_DOMAIN, root: BigInt(anchor), nullifiers: nullifiers.map(BigInt), commitments: commitments.map(BigInt), ctDigest: BigInt(ctDigest), groupId: 0n, groupSize: 0 })), body.publics[0], 'admission recomputes the statement over the anchor');
 const spend = fromBody(body), harness = pool.harness.recovery(pool.state, 0, pool.harness.dummyInput()).slot;
 assert.deepEqual([spend.origin, spend.slot.origin, 'rCur' in spend.slot, 'rCur' in built.slot, 'rCur' in harness], [0, 0, false, false, true], 'the harness keeps rCur on its recovery, a test-only shape');
 assert.equal(epochProvingUrls(built, { spend: { wasm: 'w', zkey: 'z' } } as unknown as Parameters<typeof epochProvingUrls>[1]).wasm, '/api/rollup/proving/epoch-spend.wasm?v=w', 'the ordinary epoch-spend circuit and key');
});

test('a second recovery of the same note is refused', async () => {
 const { pool, account, notes: [note] } = await stranded(9);
 const [first, again] = [await account.recover(note!, aliceTo), await account.recover(note!, aliceTo)];
 pool.land('recover', [sent(first)]);
 assert.throws(() => pool.land('recover', [sent(again)]), rejection('double-spend'));
 while (pool.state.batchCount < 13) pool.land();
 assert.equal(pool.state.epoch, 3);
 assert.throws(() => pool.land('recover', [sent(again)]), rejection('double-spend'), 'a rotation later, because RS is never reset (D7)');
 await replay(account, pool.api);
 await assert.rejects(account.recover(note!, aliceTo), /no frozen path/, 'and the wallet no longer holds the note');
});

test('a recovery naming a live epoch is refused', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 for (let n = 0; n < 10; n++) pool.land('spend', [0, 5, 9].includes(n) ? [await pool.deposit(aliceTo, 100n * BigInt(n + 1))] : []);
 await replay(account, pool.api);
 const [old, ...live] = account.notes();
 assert.deepEqual([old!, ...live].map(n => n.epoch), [0, 1, 2]);
 for (const note of live) await assert.rejects(account.recover(note, aliceTo), /still on the fast path/, `epoch ${note.epoch}`);
 const built = await account.recover(old!, aliceTo);
 for (const origin of [1, 2, 3]) assert.throws(() => pool.land('recover', [sent({ ...built, slot: { ...built.slot, origin } })]), rejection('recover-unarchived'), `origin ${origin}`);
 assert.equal(pool.land('recover', [sent(built)]).slots[0]!.origin, 0, 'the same slot naming its own archived epoch is admitted');
});

test('spendable and needsRecovery partition the owned notes at every point around a rotation', async () => {
 const pool = epochPool(hash, 4), account = alice(4), seen: [number, boolean, number[]][] = [];
 for (let n = 0; n < 14; n++) {
  pool.land('spend', [0, 5, 10].includes(n) ? [await pool.deposit(aliceTo, 100n + BigInt(n))] : []);
  await replay(account, pool.api);
  const plan = account.anchorPlan(), late: number[] = [];
  for (const note of account.notes()) {
   const recovering = needsRecovery(note, plan);
   assert.notEqual(recovering, account.spendable(note, plan), `after ${account.batchCount} batches, a note of epoch ${note.epoch}`);
   const built = recovering ? await account.recover(note, aliceTo) : await account.spend({ input: note }, aliceTo);
   assert.ok(opens(hash, account.owner, built, [note]));
   if (!recovering) continue;
   pool.state.clone().apply('recover', [built.slot]);
   late.push(note.epoch);
  }
  seen.push([account.batchCount, plan.rotatesNext, late]);
 }
 assert.deepEqual(seen, [
  [1, false, []], [2, false, []], [3, false, []], [4, true, []], [5, false, []], [6, false, []], [7, false, []],
  [8, true, [0]], [9, false, [0]], [10, false, [0]], [11, false, [0]], [12, true, [0, 1]], [13, false, [0, 1]], [14, false, [0, 1]],
 ]);
});

test('a recovered note is a fresh NT[c] note that spends on the fast path in the same epoch', async () => {
 const { pool, account, notes: [a, b] } = await stranded(8);
 assert.equal(account.rotatesNext, true, 'the first recovery rides the batch that rotates');
 for (const note of [a!, b!]) { pool.land('recover', [sent(await account.recover(note, aliceTo))]); await replay(account, pool.api); }
 const fresh = account.notes();
 assert.deepEqual(fresh.map(n => [n.epoch, n.index, n.amount]), [[2, 0, 900n], [2, 32, 400n]], 'leaves of epoch 2, which the riding batch opened');
 for (const n of fresh) assert.equal(pool.state.notes.node(0, n.index), noteOf(hash, ROLLUP_DOMAIN, n.amount, n.asset, account.owner, n.rho));
 const spend = await account.spend({ input: fresh[0]!, to: { recipient: bobTo, amount: 100n } }, aliceTo);
 assert.deepEqual([spend.witness.input.sel, spend.slot.rCur?.epoch], [0n, 2]);
 assert.ok(opens(hash, account.owner, spend, [fresh[0]!]));
 pool.land('spend', [sent(spend)]);
 await replay(account, pool.api);
 assert.deepEqual([account.epoch, account.balance(), account.notes().map(n => n.epoch)], [2, 1200n, [2, 2]]);
});

test('a claim link claimed two epochs late is recovered to the claimer', async () => {
 const pool = epochPool(hash, 4), minter = alice(4), master = new Uint8Array(32).fill(9);
 const bearer = (nullifier: bigint) => { const keys = bearerKeysOf(bearerOf(master, nullifier)); return rollupRecipientOf(hash, keys.ask, keys.nk, keys.viewSecret); };
 pool.land('spend', [await pool.deposit(aliceTo, 300n), await pool.deposit(aliceTo, 200n)]);
 await replay(minter, pool.api);
 const { spends } = await minter.pay(bearer, 450n, aliceTo), token = { secret: bearerOf(master, spends[0]!.slot.nullifiers[0]!), batch: 1 };
 pool.land('spend', spends.map(sent));
 const link = async () => {
  const keys = bearerKeysOf(token.secret), account = await epochFreshAccount(hash, keys, token.batch, pool.api);
  await epochCatchUp(account, pool.api);
  return { account, self: rollupRecipientOf(hash, keys.ask, keys.nk, keys.viewSecret), notes: account.notes() };
 };
 const onTime = await claimRecovery(hash, await link(), bobTo);
 assert.deepEqual(onTime.map(s => [s.slot.rCur?.epoch, s.slot.origin, s.slot.groupSize]), [[0, undefined, 2], [0, undefined, 2]], 'inside the window, one group, as claimSpends builds it');
 while (pool.state.batchCount < 9) pool.land();
 const late = await claimRecovery(hash, await link(), bobTo);
 assert.deepEqual(late.map(s => [s.slot.origin, 'rCur' in s.slot, s.slot.groupSize]), [[0, false, 0], [0, false, 0]]);
 assert.throws(() => pool.land('recover', late.map(sent)), rejection('slot-count'), 'a recover batch is one slot wide');
 for (const recovery of late) pool.land('recover', [sent(recovery)]);
 const bob = EpochAccount.owning(hash, bobKeys, { epochLen: 4 });
 await replay(bob, pool.api);
 assert.deepEqual([bob.notes().map(n => [n.epoch, n.index, n.amount]), (await link()).notes], [[[2, 32, 300n], [2, 64, 150n]], []]);
});

test('archivesHeld reports partial without blocking a recovery that then succeeds', async () => {
 const { pool, account, notes: [note] } = await stranded(9);
 const listing = (epochs: unknown) => ((path: string, ...rest: [unknown?, (() => void)?]) => path === '/archives' ? Promise.resolve({ epochs }) : pool.api(path, ...rest)) as PoolApi;
 const missing = (() => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))) as PoolApi;
 const bodyless = (() => Promise.resolve(null)) as PoolApi;
 assert.deepEqual(await Promise.all([pool.api, listing([0]), listing([]), listing('0,1'), missing, bodyless].map(api => archivesHeld(api, 0))), ['held', 'partial', 'partial', 'unknown', 'unknown', 'unknown']);
 pool.land('recover', [sent(await account.recover(note!, aliceTo))]);
 await replay(account, pool.api);
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[0, 400n], [2, 900n]]);
});

test('a claim link with no notes left builds nothing, even for an account that cannot anchor', async () => {
 const account = alice(4);
 account['prev'] = undefined;
 assert.throws(() => account.anchorPlan(), /root the previous epoch closed on/);
 assert.deepEqual(await claimRecovery(hash, { account, self: aliceTo, notes: [] }, bobTo), []);
});

test('a recovered asset note publishes no asset and no boundary leg', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 pool.land('spend', [await pool.transfer({ ask: 0n, nk: 0n, self: aliceTo, request: { asset: 7n, deposit: 500n } })]);
 while (pool.state.batchCount < 9) pool.land();
 await replay(account, pool.api);
 const [note] = account.notes(7n), built = await account.recover(note!, aliceTo);
 assert.deepEqual([note!.asset, built.witness.input.asset], [7n, 7n]);
 const record = pool.land('recover', [sent(built)]);
 assert.deepEqual([built.witness.publicSignals.slice(3), record.slots[0]!.publics.slice(3)], [[0n, 0n, 0n, 0n], ['0', '0', '0', '0']]);
});
