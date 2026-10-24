import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64 } from '@scure/base';
import { buildPoseidon } from 'circomlibjs';
import type { RollupEpochRecord } from '../src/rollup/epoch-operator.ts';
import type { PoolApi } from '../src/shielded/pool.ts';
import type { SpendRequest } from '../packages/protocol/src/rollup/account.ts';
import { BTC_ASSET, CHECKPOINT_EVERY, NOTE_DEPTH, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { EpochAccount, type EpochOwnedNote } from '../packages/protocol/src/rollup/epoch-account.ts';
import type { EpochBuiltSpend } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { decodeEpochScan } from '../packages/protocol/src/rollup/epoch-scan.ts';
import { NoteFrontier } from '../packages/protocol/src/rollup/frontier.ts';
import { destinationFieldOf, groupIdOf, noteOf } from '../packages/protocol/src/rollup/notes.ts';
import { rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { foldPath } from './fixtures/epoch.ts';
import { epochPool, opens, posted, type PoolSpend } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const zeros = Array<bigint>(NOTE_DEPTH).fill(0n);
type Pool = ReturnType<typeof epochPool>;

const alice = (epochLen: number) => EpochAccount.owning(hash, aliceKeys, { epochLen });
/** Whether the account holds a path for the note that folds to its live root: the proof that the leaf was tracked, not just found. */
const tracked = (account: EpochAccount, note: EpochOwnedNote) =>
 foldPath(hash, noteOf(hash, ROLLUP_DOMAIN, note.amount, note.asset, account.owner, note.rho), note.index, account['frontier'].path(note.index)) === account.latestRoot();
const fromAlice = (pool: Pool, request: SpendRequest, group?: { id: bigint; size: number }) =>
 pool.transfer({ ask: aliceKeys.ask, nk: aliceKeys.nk, self: aliceTo, request, paths: [zeros, zeros], ...(group ? { group } : {}) });
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (const batch of (await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${account.batchCount}&limit=500`)).batches) await account.apply(batch);
};
/** Follows /scan the way a restore does and returns the batches it had to fetch whole. */
const replayScan = async (account: EpochAccount, api: PoolApi, epochLen: number) => {
 const applied: number[] = [], page = await api<{ from: number; data: string }>(`/scan?from=${account.batchCount}&limit=500`);
 for (const entry of decodeEpochScan(base64.decode(page.data), page.from, epochLen)) {
  if (!await account.concerns(entry)) { account.skip(entry); continue; }
  const [batch] = (await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${entry.batch}&limit=1`)).batches;
  await account.apply(batch!);
  applied.push(entry.batch);
 }
 return applied;
};

test('leaf indices restart at each rotation and the note keeps its epoch', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 for (let n = 0; n < 5; n++) pool.land();
 pool.land('spend', [pool.pad(), pool.pad(), pool.pad(), await pool.deposit(aliceTo, 1000n)]);
 await replay(account, pool.api);
 const [note] = account.notes();
 assert.deepEqual([note!.epoch, note!.index, account.epoch, account.blockInEpoch], [1, 32 + 2 * 3 + 0, 1, 2]);
 assert.equal(pool.state.notes.node(0, note!.index), noteOf(hash, ROLLUP_DOMAIN, note!.amount, note!.asset, account.owner, note!.rho));
 assert.equal(account.latestRoot(), pool.state.latestRoot());
});

test('a rotating batch\'s own block lands in the new epoch', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 assert.equal(account.prevNoteRoot(), pool.state.prevNoteRoot);
 for (let n = 0; n < 4; n++) pool.land();
 const closing = pool.state.latestRoot();
 pool.land('spend', [await pool.deposit(aliceTo, 700n)]);
 await replay(account, pool.api);
 const [note] = account.notes();
 assert.deepEqual([account.epoch, account.blockInEpoch, note!.epoch, note!.index], [1, 1, 1, 0]);
 assert.equal(account.prevNoteRoot(), closing);
 assert.equal(account.prevNoteRoot(), pool.state.prevNoteRoot);
 assert.equal(account.latestRoot(), pool.state.latestRoot());
});

test('an account replaying /batches and one replaying /scan reach the same root', async () => {
 const pool = epochPool(hash, 4), whole = alice(4), scanned = alice(4);
 for (let n = 0; n < 9; n++) pool.land('spend', n === 5 ? [await pool.deposit(aliceTo, 500n)] : []);
 await replay(whole, pool.api);
 assert.deepEqual(await replayScan(scanned, pool.api, 4), [5]);
 for (const account of [whole, scanned]) {
  assert.deepEqual([account.batchCount, account.epoch, account.blockInEpoch, account.latestRoot(), account.prevNoteRoot()], [9, 2, 1, pool.state.latestRoot(), pool.state.prevNoteRoot]);
 }
 assert.deepEqual(scanned.notes(), whole.notes());
 assert.equal(whole.balance(), 500n);
 assert.deepEqual([...scanned.txids], pool.records.map(r => r.txid));
 assert.deepEqual([...whole.txids], pool.records.map(r => r.txid));
});

test('a chain-only record is appended by its block root and finds no note', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 pool.land('spend', [await pool.deposit(aliceTo, 1000n)]);
 await replay(account, pool.api);
 assert.ok(tracked(account, account.notes()[0]!), 'a full record carries noteBlockRoot too, and its leaves are still tracked');
 const bare = pool.land('spend', [await fromAlice(pool, { input: account.notes()[0]!, to: { recipient: bobTo, amount: 300n } })], true);
 assert.ok(bare.slots.every(s => s.commitments[0] === '0' && s.commitments[1] === '0'));
 await replay(account, pool.api);
 assert.deepEqual([account.notes().length, account.balance(), account.batchCount, account.latestRoot()], [0, 0n, 2, pool.state.latestRoot()]);
});

test('a record whose commitments do not rebuild its noteBlockRoot is refused', async () => {
 const pool = epochPool(hash, 4), account = alice(4), record = pool.land('spend', [await pool.deposit(aliceTo, 1000n)]), [first, second] = record.slots;
 const forged = { ...record, slots: [{ ...first!, commitments: ['1', first!.commitments[1]] as [string, string] }, ...record.slots.slice(1)] };
 const swapped = { ...record, slots: [second!, first!, ...record.slots.slice(2)] };
 const lifted = { ...record, noteBlockRoot: String(BigInt(record.noteBlockRoot) + 1n) };
 for (const bad of [forged, swapped, lifted]) {
  await assert.rejects(account.apply(bad), /commitments do not rebuild the block root the pool published/);
  assert.deepEqual([account.batchCount, account.latestRoot(), account.txids.size], [0, alice(4).latestRoot(), 0]);
 }
 assert.equal((await account.apply(record)).length, 1);
 assert.deepEqual([...account.txids], [record.txid]);
});

test('notes and balances are kept per asset', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 pool.land('spend', [await pool.deposit(aliceTo, 100n), await pool.transfer({ ask: 0n, nk: 0n, self: aliceTo, request: { deposit: 40n, asset: 7n } })]);
 await replay(account, pool.api);
 assert.deepEqual([account.balance(), account.balance(7n), account.notes().length, account.notes(7n).length], [100n, 40n, 1, 1]);
});

test('a scan page whose rotation flag disagrees with the account\'s own count is refused', async () => {
 const pool = epochPool(hash, 4);
 for (let n = 0; n < 6; n++) pool.land();
 const entries = decodeEpochScan(base64.decode((await pool.api<{ data: string }>('/scan?from=0&limit=6')).data), 0, 4);
 for (const [epochLen, stopsAt] of [[8, 4], [2, 2]] as const) {
  const account = alice(epochLen);
  assert.throws(() => entries.forEach(entry => account.skip(entry)), /That scan page does not follow this account/);
  assert.equal(account.batchCount, stopsAt);
 }
 assert.throws(() => alice(4).skip({ ...entries[0]!, epoch: 1 }), /does not follow this account/);
 assert.throws(() => alice(4).skip(entries[1]!), /does not follow batch 0/);
});

test('spends, receives and merges land in history with their epoch', async () => {
 const pool = epochPool(hash, 4), account = alice(4), program = new Uint8Array(32).fill(0xab), stranger = { amount: 400n, asset: 0n, rho: 11n, index: 0, nullifier: 0n };
 const land = async (kind: 'spend' | 'join', ...spends: PoolSpend[]) => { pool.land(kind, spends); await replay(account, pool.api); };
 await land('spend', await pool.deposit(aliceTo, 1000n));
 await land('spend');
 await land('spend', await pool.transfer({ ask: 7n, nk: 8n, self: bobTo, request: { input: stranger, to: { recipient: aliceTo, amount: 150n } }, paths: [zeros] }));
 await land('spend');
 await land('spend', await fromAlice(pool, { input: account.notes()[0]!, to: { recipient: bobTo, amount: 300n } }));
 assert.deepEqual(account.notes().map(n => [n.epoch, n.index]), [[0, 64], [1, 1]], 'sorted by epoch, then index');
 await land('join', await fromAlice(pool, { inputs: [account.notes()[0]!, account.notes()[1]!] }));
 await land('spend', await fromAlice(pool, { input: account.notes()[0]!, withdraw: 100n, program }));
 assert.deepEqual(account.history.map(e => [e.kind, e.batch, e.epoch, e.amounts.map(a => a.amount)]), [
  ['shield', 0, 0, [1000n]], ['receive', 2, 0, [150n]], ['send', 4, 1, [300n]], ['merge', 5, 1, []], ['withdraw', 6, 1, [100n]],
 ]);
 assert.deepEqual(account.history.map(e => [e.txid, e.at]), [0, 2, 4, 5, 6].map(n => [pool.records[n]!.txid, pool.records[n]!.at]));
 assert.equal(account.history.at(-1)!.destination, destinationFieldOf(program));
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[1, 750n]]);
 assert.equal(account.latestRoot(), pool.state.latestRoot());
});

test('a renewal lands in history as renew and a recovery as recover, while a join stays merge', async () => {
 const pool = epochPool(hash, 2), account = alice(2), land = async (kind: 'spend' | 'join' | 'recover' = 'spend', ...spends: PoolSpend[]) => { pool.land(kind, spends); await replay(account, pool.api); };
 await land('spend', await pool.deposit(aliceTo, 500n), await pool.deposit(aliceTo, 300n), await pool.deposit(aliceTo, 200n));
 const [first, second, third] = account.notes();
 await land('join', posted(await account.join([second!, third!], aliceTo)));
 await land('spend', posted(await account.spend({ input: first! }, aliceTo)));
 await land();
 await land();
 const joined = account.notes().find(n => n.epoch === 0)!;
 await land('recover', posted(await account.recover(joined, aliceTo)));
 assert.deepEqual(account.history.slice(3).map(e => [e.kind, e.batch, e.amounts, e.spent, e.created.map(n => [n.epoch, n.amount])]), [
  ['merge', 1, [], [second!.nullifier, third!.nullifier], [[0, 500n]]], ['renew', 2, [], [first!.nullifier], [[1, 500n]]], ['recover', 5, [], [joined.nullifier], [[2, 500n]]],
 ]);
});

test('a grouped payment is one history entry spanning its slots', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 pool.land('spend', [await pool.deposit(aliceTo, 600n), await pool.deposit(aliceTo, 300n)]);
 await replay(account, pool.api);
 const [a, b] = account.notes(), group = { id: groupIdOf(hash, [a!.nullifier, b!.nullifier]), size: 2 };
 pool.land('spend', [await fromAlice(pool, { input: a!, to: { recipient: bobTo, amount: 600n } }, group), await fromAlice(pool, { input: b!, to: { recipient: bobTo, amount: 250n } }, group)]);
 await replay(account, pool.api);
 assert.deepEqual(account.history.slice(2).map(e => [e.kind, e.slots, e.amounts.map(x => x.amount)]), [['send', [0, 1], [850n]]]);
});

test('a record of the wrong shape is refused before it can read as chain-only', async () => {
 const pool = epochPool(hash, 4), account = alice(4), record = pool.land('spend', [await pool.deposit(aliceTo, 100n)]);
 const wrong = [{ ...record, slots: [] }, { ...record, slots: record.slots.slice(1) }, { ...record, kind: 'recover' as const }, { ...record, kind: 'join' as const }];
 for (const bad of wrong) await assert.rejects(account.apply(bad), /wrong shape/);
 assert.equal(account.batchCount, 0);
});

test('a note whose commitment is not in the block is not the wallet\'s', async () => {
 const pool = epochPool(hash, 4), account = alice(4), record = pool.land('spend', [await pool.deposit(aliceTo, 100n)]);
 const phantom = { ...record, slots: record.slots.map((s, i) => i === 1 ? { ...s, ciphertext: record.slots[0]!.ciphertext } : s) };
 assert.deepEqual((await account.apply(phantom)).map(n => n.index), [0]);
 assert.equal(account.balance(), 100n);
});

test('a recover batch of the wallet\'s own note is one slot, found by its nullifier hint', async () => {
 const pool = epochPool(hash, 4), whole = alice(4), scanned = alice(4);
 pool.land('spend', [await pool.deposit(aliceTo, 900n)]);
 for (let n = 1; n < 9; n++) pool.land();
 await replay(whole, pool.api);
 const [note] = whole.notes();
 const record = pool.land('recover', [pool.recover(0, { amount: note!.amount, ask: aliceKeys.ask, nk: aliceKeys.nk, rho: note!.rho, index: note!.index, path: zeros })]);
 assert.deepEqual([record.slots.length, record.slots[0]!.origin, record.slots[0]!.rCur], [1, 0, undefined]);
 await replay(whole, pool.api);
 assert.deepEqual(await replayScan(scanned, pool.api, 4), [0, 9]);
 for (const account of [whole, scanned]) assert.deepEqual([account.balance(), account.batchCount, account.latestRoot()], [0n, 10, pool.state.latestRoot()]);
 const [entry] = decodeEpochScan(base64.decode((await pool.api<{ data: string }>('/scan?from=9&limit=1')).data), 9, 4);
 assert.deepEqual([await alice(4).concerns(entry!), await alice(4).concerns(entry!, [note!.nullifier])], [false, true]);
});

test('spending a note of an earlier epoch leaves a live note at the same index tracked', async () => {
 const pool = epochPool(hash, 2), account = alice(2);
 pool.land('spend', [await pool.deposit(aliceTo, 500n)]);
 pool.land();
 pool.land('spend', [await pool.deposit(aliceTo, 600n)]);
 await replay(account, pool.api);
 const [old, live] = account.notes();
 assert.deepEqual([old!.epoch, live!.epoch, old!.index, live!.index], [0, 1, 0, 0]);
 pool.land('spend', [await fromAlice(pool, { input: old!, to: { recipient: bobTo, amount: 100n } })]);
 await replay(account, pool.api);
 assert.equal(account.notes().some(n => n.nullifier === old!.nullifier), false);
 assert.ok(tracked(account, live!));
});

test('a wallet born at batch 3 neither asks for nor opens a record before it', async () => {
 const pool = epochPool(hash, 4), young = EpochAccount.owning(hash, aliceKeys, { epochLen: 4, bornAt: 3 });
 pool.land('spend', [await pool.deposit(aliceTo, 100n)]);
 pool.land();
 pool.land();
 pool.land('spend', [await pool.deposit(aliceTo, 200n)]);
 const entries = decodeEpochScan(base64.decode((await pool.api<{ data: string }>('/scan?from=0&limit=4')).data), 0, 4);
 assert.deepEqual([await young.concerns(entries[0]!), await alice(4).concerns(entries[0]!), await young.concerns(entries[3]!)], [false, true, true]);
 await replay(young, pool.api);
 assert.deepEqual(young.notes().map(n => n.amount), [200n]);
});

test('a replica cannot skip, and an epoch length the pool could not have is refused', async () => {
 const pool = epochPool(hash, 4), replica = EpochAccount.owning(hash, aliceKeys, { epochLen: 4, replica: true });
 pool.land();
 const [entry] = decodeEpochScan(base64.decode((await pool.api<{ data: string }>('/scan?from=0&limit=1')).data), 0, 4);
 assert.deepEqual([replica.canSkip, alice(4).canSkip], [false, true]);
 assert.throws(() => replica.skip(entry!), /needs every batch whole/);
 for (const epochLen of [0, -1, 1.5, NaN, 2 ** 20 + 1]) assert.throws(() => alice(epochLen), /positive whole number of batches/, String(epochLen));
});

test('the fake pool answers in the shapes Plan 4b pins', async () => {
 const pool = epochPool(hash, CHECKPOINT_EVERY);
 for (let n = 0; n < CHECKPOINT_EVERY; n++) pool.land();
 const { state, api } = pool, status = (await api<{ pool: Record<string, unknown> }>('/status')).pool;
 assert.deepEqual([status.batches, status.root, status.prevNoteRoot, status.epoch, status.epochLen, status.batchesInEpoch, status.erCount, status.rsCount],
  [CHECKPOINT_EVERY, String(state.latestRoot()), String(state.prevNoteRoot), 0, CHECKPOINT_EVERY, CHECKPOINT_EVERY, 0, 1]);
 const checkpoint = await api<{ epoch: number; blocks: number; filled: string[] }>(`/checkpoints/0/${CHECKPOINT_EVERY}`);
 assert.deepEqual([checkpoint.epoch, checkpoint.blocks, checkpoint.filled.length], [0, CHECKPOINT_EVERY, 27]);
 assert.equal(NoteFrontier.at(hash, checkpoint).root(), state.latestRoot());
 for (const path of ['/checkpoints/0/63', '/checkpoints/1/64', '/checkpoints/0/128', `/checkpoints/${CHECKPOINT_EVERY}`, '/nope']) await assert.rejects(api(path), { status: 404 }, path);
 for (const path of ['/batches?from=-1', '/batches?from=1.5', '/scan?limit=0']) await assert.rejects(api(path), { status: 400 }, path);
 assert.deepEqual([(await api<{ batches: unknown[] }>('/batches')).batches.length, (await api<{ batches: unknown[] }>('/batches?from=10&limit=500')).batches.length], [50, CHECKPOINT_EVERY - 10]);
 assert.deepEqual(await api('/times'), { every: CHECKPOINT_EVERY, at: [pool.records[0]!.at] });
});

test('a join of (epoch 0, index 0) and (epoch 1, index 0) is built and admitted', async () => {
 const pool = epochPool(hash, 2), account = alice(2);
 pool.land('spend', [await pool.deposit(aliceTo, 500n)]);
 pool.land();
 pool.land('spend', [await pool.deposit(aliceTo, 600n)]);
 await replay(account, pool.api);
 const [old, cur] = account.notes();
 assert.deepEqual([old!.epoch, old!.index, cur!.epoch, cur!.index], [0, 0, 1, 0], 'one leaf index in two epochs');
 await assert.rejects(account.join([cur!, cur!], aliceTo), /two different notes/);
 const joined = await account.join([old!, cur!], aliceTo);
 assert.deepEqual(joined.witness.input.sel, [1n, 0n]);
 assert.ok(opens(hash, account.owner, joined, [old!, cur!]));
 pool.land('join', [posted(joined)]);
 await replay(account, pool.api);
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[1, 1100n]]);
});

test('pay, consolidate, depositAsset and withdrawAsset build spends the pool admits, across a rotation', async () => {
 const pool = epochPool(hash, 4), account = alice(4), program = new Uint8Array(32).fill(0xab);
 const land = async (spends: EpochBuiltSpend[]) => { pool.land(spends[0]!.slot.nullifiers.length === 2 ? 'join' : 'spend', spends.map(posted)); await replay(account, pool.api); };
 pool.land('spend', [...await Promise.all([100n, 200n, 300n, 400n, 500n].map(amount => pool.deposit(aliceTo, amount))), await pool.transfer({ ask: 0n, nk: 0n, self: aliceTo, request: { deposit: 40n, asset: 7n } })]);
 await replay(account, pool.api);
 await land(await account.withdrawAsset(7n, 30n, program, aliceTo));
 await land(await account.depositAsset(9n, 25n, 330n, aliceTo));
 await land((await account.pay(bobTo, 450n, aliceTo)).spends);
 const joined = await account.pay(bobTo, 600n, aliceTo, new Set(), BTC_ASSET, { join: true });
 await land(joined.spends);
 const grouped = await account.pay(bobTo, 340n, aliceTo);
 await land(grouped.spends);
 await land([(await account.consolidate(aliceTo, BTC_ASSET, new Set(), 2))!.built]);
 assert.deepEqual([joined.kind, grouped.kind, grouped.spends.length, account.epoch], ['join', 'spend', 3, 1]);
 assert.deepEqual([account.balance(), account.balance(7n), account.balance(9n), account.notes().length], [110n, 10n, 25n, 2]);
});
