import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import type { RollupEpochRecord } from '../src/rollup/epoch-operator.ts';
import { epochTransferBody } from '../src/shielded/epoch-pool.ts';
import type { PoolApi } from '../src/shielded/pool.ts';
import { BTC_ASSET, NOTE_DEPTH, SUBTREE_DEPTH } from '../packages/protocol/src/rollup/constants.ts';
import { EpochAccount, RENEWAL_FLOOR, RENEWAL_TAIL, type EpochOwnedNote, type RenewalPlan } from '../packages/protocol/src/rollup/epoch-account.ts';
import type { EpochBuiltSpend } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { epochPool, opens, posted } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const alice = (epochLen: number) => EpochAccount.owning(hash, aliceKeys, { epochLen });
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (const batch of (await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${account.batchCount}&limit=500`)).batches) await account.apply(batch);
};
const seeded = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
/** An account `at` batches into epoch `live`, holding [epoch, amount, asset?] notes with no tree behind them. At 0 it is where a real one is when an epoch begins: waiting on the batch that rotates. */
const holding = (epochLen: number, live: number, at: number, notes: [epoch: number, amount: bigint, asset?: bigint][]) => EpochAccount.fromSnapshot(hash, aliceKeys, {
 ...alice(epochLen).snapshot(), epoch: at ? live : live - 1, batch: live * epochLen + at, prevNoteRoot: '1',
 owned: notes.map(([e, amount, asset = BTC_ASSET], i) => ({ amount: String(amount), asset: String(asset), rho: String(i + 1), index: i, nullifier: String(i + 1), epoch: e })),
}, epochLen);
const tenOf = (epoch: number) => Array.from({ length: 10 }, (_, i): [number, bigint] => [epoch, BigInt(100 + i)]);
const amounts = (plan?: RenewalPlan) => plan?.due.map(note => note.amount);
const targetsOf = (account: EpochAccount) => [...account['schedule'].targets.values()];
const renewal = (account: EpochAccount, plan: RenewalPlan) => plan.kind === 'join' ? account.join(plan.due as [EpochOwnedNote, EpochOwnedNote], aliceTo) : account.spend({ input: plan.due[0]! }, aliceTo);

test('a note is due in the epoch after the one that created it, and not before', async () => {
 const pool = epochPool(hash, 4), account = alice(4), seen: unknown[] = [];
 for (let n = 0; n < 9; n++) {
  pool.land('spend', n === 0 || n === 5 ? [await pool.deposit(aliceTo, n ? 300n : 500n)] : []);
  await replay(account, pool.api);
  const plan = account.renewalDue({ random: () => 0 });
  seen.push(plan && [amounts(plan), plan.deadlineBatch]);
 }
 assert.deepEqual(seen, [undefined, undefined, undefined, [[500n], 7], [[500n], 7], [[500n], 7], [[500n], 7], [[300n], 11], [[300n], 11]]);
 assert.equal(targetsOf(account).length, 1, 'the schedule keeps the live epoch\'s targets only');
});

test('two due notes are renewed as one join, and the note count falls', async () => {
 const pool = epochPool(hash, 4), account = alice(4), plans: unknown[] = [], next = () => account.renewalDue({ random: () => 0 });
 pool.land('spend', await Promise.all([300n, 100n, 200n].map(amount => pool.deposit(aliceTo, amount))));
 for (let n = 0; n < 3; n++) pool.land();
 await replay(account, pool.api);
 const counts = [account.notes().length];
 for (let plan = next(); plan; plan = next()) {
  plans.push([plan.kind, amounts(plan)]);
  const built = await renewal(account, plan);
  assert.ok(opens(hash, account.owner, built, plan.due));
  pool.land(plan.kind, [posted(built)]);
  await replay(account, pool.api);
  counts.push(account.notes().length);
 }
 assert.deepEqual(plans, [['join', [100n, 200n]], ['spend', [300n]]]);
 assert.deepEqual([counts, account.balance(), account.notes().map(n => n.epoch)], [[3, 2, 2], 600n, [1, 1]]);
});

test('with a seeded random, ten due notes get ten different targets, none in the last tenth', () => {
 const account = holding(128, 1, 0, tenOf(0)), edge = holding(128, 1, 0, tenOf(0)), last = Math.floor(RENEWAL_FLOOR * 128);
 account.renewalDue({ random: seeded(1) });
 const targets = targetsOf(account);
 assert.deepEqual([RENEWAL_TAIL, RENEWAL_FLOOR, last], [0.1, 0.9, 115]);
 assert.equal(new Set(targets).size, 10, `${targets}`);
 assert.ok(targets.every(t => t >= 0 && t < last), `${targets}`);
 account.renewalDue({ random: () => 0.5 });
 assert.deepEqual(targetsOf(account), targets, 'drawn once per note, not again on every tick');
 edge.renewalDue({ random: () => 0.999999 });
 assert.deepEqual([...new Set(targetsOf(edge))], [last - 1], 'the largest draw still falls short of the last tenth');
 const unseeded = holding(128, 1, 0, tenOf(0)), words = mock.method(globalThis.crypto, 'getRandomValues', ((w: Uint32Array) => { w[0] = 0xFFFFFFFF; return w; }) as never);
 try { unseeded.renewalDue(); } finally { words.mock.restore(); }
 assert.deepEqual([...new Set(targetsOf(unseeded))], [last - 1], 'the default draw is the 32-bit word scaled into [0, 1)');
});

test('past the floor every remaining due note is renewed at once', async () => {
 const pool = epochPool(hash, 20), account = alice(20), late = { random: () => 0.999999 }, landed: unknown[] = [];
 const advance = async (to: number) => { while (pool.state.batchCount < to) pool.land(); await replay(account, pool.api); };
 pool.land('spend', await Promise.all([400n, 300n, 200n, 100n].map(amount => pool.deposit(aliceTo, amount))));
 await advance(20);
 assert.equal(account.renewalDue(late), undefined, 'every target is drawn and none is reached');
 await advance(20 + 16);
 assert.equal(account.renewalDue(late), undefined, 'still short of the largest target');
 await advance(20 + Math.floor(RENEWAL_FLOOR * 20));
 for (let plan = account.renewalDue(late); plan; plan = account.renewalDue(late)) {
  landed.push([pool.state.batchCount, plan.deadlineBatch, amounts(plan)]);
  pool.land(plan.kind, [posted(await renewal(account, plan))]);
  await replay(account, pool.api);
 }
 assert.deepEqual(landed, [[38, 39, [100n, 200n]], [39, 39, [300n, 400n]]], 'one plan per batch, the last on the deadline batch');
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[1, 300n], [1, 700n]]);
});

test('a renewed note survives the next rotation and the un-renewed one does not', async () => {
 const pool = epochPool(hash, 4), online = alice(4), offline = EpochAccount.owning(hash, bobKeys, { epochLen: 4 });
 const sync = () => Promise.all([online, offline].map(account => replay(account, pool.api)));
 pool.land('spend', [await pool.deposit(aliceTo, 500n), await pool.deposit(bobTo, 300n)]);
 for (let n = 0; n < 3; n++) pool.land();
 await sync();
 pool.land('spend', [posted(await renewal(online, online.renewalDue({ random: () => 0 })!))]);
 await sync();
 const [kept] = online.notes(), [lost] = offline.notes();
 assert.deepEqual([kept!.epoch, lost!.epoch], [1, 0]);
 for (let n = 0; n < 3; n++) pool.land();
 await sync();
 assert.deepEqual([online.rotatesNext, online.spendable(kept!), offline.spendable(lost!)], [true, true, false], 'one batch before the rotation');
 pool.land();
 await sync();
 assert.deepEqual([online.epoch, online.spendable(kept!), offline.spendable(lost!)], [2, true, false], 'after it');
 assert.ok(opens(hash, online.owner, await online.spend({ input: kept! }, aliceTo), [kept!]));
 await assert.rejects(offline.spend({ input: lost! }, bobTo), /needs a recovery/);
 assert.deepEqual([amounts(online.renewalDue({ random: () => 0 })), offline.renewalDue({ random: () => 0 })], [[500n], undefined], 'the survivor is due again; the lost note is a recovery');
});

test('renewalDue returns nothing while a renewal is in flight', () => {
 const account = holding(8, 1, 0, [[0, 100n], [0, 200n], [0, 300n], [1, 400n]]), random = () => 0, [, , third, fresh] = account.notes();
 const plan = account.renewalDue({ random })!, inFlight = new Set(plan.due.map(n => n.nullifier));
 assert.deepEqual([plan.kind, plan.due.length], ['join', 2]);
 assert.equal(account.renewalDue({ random, inFlight }), undefined, 'the plan\'s own notes');
 assert.equal(account.renewalDue({ random, inFlight: new Set([third!.nullifier]) }), undefined, 'any due note, not only the planned ones');
 assert.deepEqual(amounts(account.renewalDue({ random, inFlight: new Set([fresh!.nullifier]) })), [100n, 200n], 'a note that is not due does not block');
 inFlight.clear();
 assert.deepEqual(account.renewalDue({ random, inFlight })?.due, plan.due, 'released, the same plan is due again');
});

test('a renewal spend is indistinguishable from an ordinary spend on the wire', async () => {
 const pool = epochPool(hash, 4), account = alice(4), proof = { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['5', '6', '1'] };
 const wire = (built: EpochBuiltSpend) => JSON.parse(JSON.stringify(epochTransferBody('ab'.repeat(16), built, proof)));
 const to = { recipient: bobTo, amount: 50n }, next = () => account.renewalDue({ random: () => 0 })!;
 pool.land('spend', await Promise.all([500n, 300n, 200n].map(amount => pool.deposit(aliceTo, amount))));
 for (let n = 0; n < 3; n++) pool.land();
 await replay(account, pool.api);
 const joined = next(), pair = [await renewal(account, joined), await account.join(joined.due as [EpochOwnedNote, EpochOwnedNote], aliceTo, to)];
 pool.land('join', [posted(pair[0]!)]);
 await replay(account, pool.api);
 const single = next(), one = [await renewal(account, single), await account.spend({ input: single.due[0]!, to }, aliceTo)];
 assert.deepEqual([joined.kind, single.kind], ['join', 'spend']);
 for (const [[renewed, ordinary], inputs] of [[pair, 2], [one, 1]] as const) {
  const [r, o] = [wire(renewed), wire(ordinary)];
  assert.deepEqual([Object.keys(r).sort(), Object.keys(r.slot).sort()], [Object.keys(o).sort(), Object.keys(o.slot).sort()]);
  for (const body of [r, o]) assert.deepEqual([body.slot.nullifiers.length, body.publics.length, body.publics.slice(3, 7), body.slot.groupId, body.slot.groupSize], [inputs, 7, ['0', '0', '0', '0'], '0', 0]);
 }
});

test('the note whose target has passed is renewed, joined with the smallest other due note', () => {
 const draws = [0, 0.99, 0.99], account = holding(128, 1, 0, [[0, 300n], [0, 100n], [0, 200n]]);
 assert.deepEqual(amounts(account.renewalDue({ random: () => draws.shift()! })), [300n, 100n]);
 assert.deepEqual(targetsOf(account), [0, 113, 113]);
});

test('a note first seen mid-epoch is scheduled over what is left of the window, and past the floor renews at once', () => {
 const late = holding(128, 1, 100, tenOf(0));
 late.renewalDue({ random: seeded(3) });
 assert.ok(targetsOf(late).every(t => t >= 100 && t < 115), `${targetsOf(late)}`);
 assert.deepEqual(amounts(holding(128, 1, 120, tenOf(0)).renewalDue({ random: () => 0.999999 })), [100n, 101n]);
});

test('renewal is per asset, and another asset\'s reservation does not block it', () => {
 const account = holding(8, 1, 0, [[0, 100n], [0, 40n, 7n]]), random = () => 0;
 assert.deepEqual([amounts(account.renewalDue({ random })), amounts(account.renewalDue({ random, asset: 7n })), amounts(account.renewalDue({ random, inFlight: new Set([2n]) }))], [[100n], [40n], [100n]]);
});

test('a wallet started at (epoch, 0) answers without an anchor, then renews at the boundary on the root it holds there', async () => {
 const pool = epochPool(hash, 4), start = EpochAccount.atCheckpoint(hash, aliceKeys, { epochLen: 4, checkpoint: { epoch: 1, blocks: 0, filled: Array<string>(NOTE_DEPTH - SUBTREE_DEPTH).fill('0') }, bornAt: 4 });
 for (let n = 0; n < 4; n++) pool.land();
 pool.land('spend', [await pool.deposit(aliceTo, 700n)]);
 for (let n = 0; n < 3; n++) pool.land();
 assert.throws(() => start.anchorPlan(), /root the previous epoch closed on/);
 assert.equal(start.renewalDue({ random: () => 0 }), undefined);
 await replay(start, pool.api);
 const plan = start.renewalDue({ random: () => 0 })!, built = await renewal(start, plan);
 assert.deepEqual([start.rotatesNext, start.prevNoteRoot(), amounts(plan), plan.deadlineBatch], [true, undefined, [700n], 11]);
 assert.ok(opens(hash, start.owner, built, plan.due));
 pool.land('spend', [posted(built)]);
 await replay(start, pool.api);
 assert.deepEqual([start.prevNoteRoot(), start.notes().map(n => [n.epoch, n.amount])], [pool.state.prevNoteRoot, [[2, 700n]]]);
});
