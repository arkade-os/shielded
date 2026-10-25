import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import express from 'express';
import type { RollupEpochRecord } from '../src/rollup/epoch-operator.ts';
import { createRollupRouter } from '../src/rollup/http.ts';
import { rollupKeyFilesOf, rollupKeyPath, rollupProvingOf, type RollupService } from '../src/rollup/service.ts';
import { epochProvingUrls, epochTransferBody } from '../src/shielded/epoch-pool.ts';
import { circuitUrls, pickNote, type PoolApi } from '../src/shielded/pool.ts';
import { BTC_ASSET, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { anchorOf } from '../packages/protocol/src/rollup/epoch.ts';
import { EpochAccount } from '../packages/protocol/src/rollup/epoch-account.ts';
import { epochPaddingTransfer, type EpochBuiltSpend } from '../packages/protocol/src/rollup/epoch-circuit.ts';
import { statementOf } from '../packages/protocol/src/rollup/notes.ts';
import { rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { rejection } from './fixtures/epoch.ts';
import { epochPool, opens, posted } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const alice = (epochLen: number) => EpochAccount.owning(hash, aliceKeys, { epochLen });
const pays = (amount: bigint) => ({ to: { recipient: bobTo, amount } });
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (const batch of (await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${account.batchCount}&limit=500`)).batches) await account.apply(batch);
};
/** One batch per entry, depositing that amount to Alice (0n: padding only), then her account synced to the pool. */
const funded = async (epochLen: number, deposits: bigint[]) => {
 const pool = epochPool(hash, epochLen), account = alice(epochLen);
 for (const amount of deposits) pool.land('spend', amount ? [await pool.deposit(aliceTo, amount)] : []);
 await replay(account, pool.api);
 return { pool, account };
};

test('the anchor plan equals the operator\'s nextAnchorRoot in both phases', async () => {
 const pool = epochPool(hash, 4), account = alice(4), rotating: number[] = [];
 for (let n = 0; n < 10; n++) {
  if (n) { pool.land(); await replay(account, pool.api); }
  const { state } = pool, plan = account.anchorPlan();
  assert.deepEqual(plan, { rPrev: state.nextAnchorRoot(), rCur: { epoch: state.epoch, root: state.latestRoot() }, liveEpoch: state.epoch + Number(state.rotatesNext()), rotatesNext: state.rotatesNext() }, `after ${n} batches`);
  if (plan.rotatesNext) rotating.push(n);
 }
 assert.deepEqual(rotating, [4, 8]);
});

test('the anchor plan never guesses a previous-epoch root it has not learned', async () => {
 const { pool, account } = await funded(4, [0n, 0n, 0n]);
 account['prev'] = undefined;
 assert.throws(() => account.anchorPlan(), /root the previous epoch closed on/);
 pool.land();
 await replay(account, pool.api);
 assert.equal(account.anchorPlan().rPrev, pool.state.nextAnchorRoot(), 'the batch that rotates opens against the closing root alone');
});

test('a spend built while rotatesNext is true is still admitted after the rotation', async () => {
 const { pool, account } = await funded(4, [500n, 600n, 0n, 0n]);
 const plan = account.anchorPlan(), [a, b] = account.notes();
 assert.deepEqual([plan.rotatesNext, plan.rPrev, plan.liveEpoch], [true, plan.rCur.root, 1]);
 const riding = await account.spend({ input: a!, ...pays(100n) }, aliceTo), after = await account.spend({ input: b!, ...pays(100n) }, aliceTo);
 for (const [built, note] of [[riding, a!], [after, b!]] as const) assert.ok(built.witness.input.sel === 1n && opens(hash, account.owner, built, [note]));
 pool.land('spend', [posted(riding)]);
 assert.equal(pool.state.epoch, 1, 'the first rode the batch that rotated');
 pool.land('spend', [posted(after)]);
 await replay(account, pool.api);
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[1, 400n], [1, 500n]]);
});

test('a spend built one batch earlier is refused with stale-anchor after the rotation', async () => {
 const { pool, account } = await funded(4, [500n, 0n, 0n]);
 const early = await account.spend({ input: account.notes()[0]!, ...pays(100n) }, aliceTo);
 pool.land();
 assert.throws(() => pool.land('spend', [posted(early)]), rejection('stale-anchor'), 'in the batch that rotates');
 pool.land();
 assert.throws(() => pool.land('spend', [posted(early)]), rejection('stale-anchor'), 'in any batch after it');
});

test('sel is 1 for an NT[c-1] note and 0 for an NT[c] note, and the pool admits both', async () => {
 const { pool, account } = await funded(2, [500n, 0n, 600n]);
 const plan = account.anchorPlan(), [old, cur] = account.notes();
 assert.deepEqual([old!.epoch, cur!.epoch, plan.liveEpoch, plan.rotatesNext], [0, 1, 1, false]);
 assert.notEqual(plan.rPrev, plan.rCur.root, 'mid-epoch, so sel decides which tree the path must open');
 const spends = [await account.spend({ input: old!, ...pays(100n) }, aliceTo), await account.spend({ input: cur!, ...pays(100n) }, aliceTo)];
 assert.deepEqual(spends.map(s => [s.witness.input.sel, s.slot.rCur]), [[1n, plan.rCur], [0n, plan.rCur]], 'both name the newest root, whichever tree holds the note');
 assert.ok(opens(hash, account.owner, spends[0]!, [old!]) && opens(hash, account.owner, spends[1]!, [cur!]));
 pool.land('spend', spends.map(posted));
 await replay(account, pool.api);
 assert.equal(account.balance(), 900n);
});

test('every dummy input carries sel 0', async () => {
 const account = alice(2), deposit = await account.spend({ deposit: 500n }, aliceTo), legs = await account.depositAsset(7n, 10n, 330n, aliceTo);
 const pads = await Promise.all(([1, 2] as const).map(width => epochPaddingTransfer(hash, { rPrev: 1n, rCur: { epoch: 0, root: 2n }, self: aliceTo, width })));
 assert.deepEqual([deposit, ...legs, ...pads].map(s => s.witness.input.sel), [0n, 0n, 0n, 0n, [0n, 0n]]);
});

test('a note from an epoch below liveEpoch-1 is not spendable and pay() never picks it', async () => {
 const { pool, account } = await funded(2, [600n, 0n, 1000n]);
 const [old, fresh] = account.notes();
 assert.deepEqual([account.spendable(old!), account.spendable(fresh!)], [true, true]);
 pool.land();
 await replay(account, pool.api);
 assert.deepEqual([account.anchorPlan().rotatesNext, account.spendable(old!), account.spendable(fresh!)], [true, false, true], 'it leaves one batch before its epoch is archived');
 const { spends } = await account.pay(bobTo, 500n, aliceTo);
 assert.deepEqual(spends.map(s => s.slot.nullifiers[0]), [fresh!.nullifier]);
 await assert.rejects(account.spend({ input: old!, ...pays(100n) }, aliceTo), /needs a recovery/);
});

test('spendableNotes leaves out a note that needs a recovery, so the smallest cover is one a spend accepts', async () => {
 const pool = epochPool(hash, 2), account = alice(2), seven = (deposit: bigint) => pool.transfer({ ask: 0n, nk: 0n, self: aliceTo, request: { asset: 7n, deposit } });
 pool.land('spend', [await pool.deposit(aliceTo, 600n), await seven(40n)]);
 pool.land();
 pool.land('spend', [await pool.deposit(aliceTo, 1000n), await seven(50n)]);
 pool.land('spend', [await pool.deposit(aliceTo, 300n)]);
 await replay(account, pool.api);
 const [old, big, small] = account.notes();
 assert.deepEqual([account.anchorPlan().rotatesNext, old!.epoch, big!.epoch, pickNote(account.notes(), 500n, new Set())], [true, 0, 1, old], 'unfiltered, the smallest cover is the note that needs a recovery');
 assert.deepEqual(account.spendableNotes(), [big, small], 'in notes() order, not by amount');
 assert.equal(pickNote(account.spendableNotes(), 500n, new Set()), big);
 assert.deepEqual([account.spendableNotes(BTC_ASSET, new Set([big!.nullifier])), account.spendableNotes(7n).map(n => [n.epoch, n.amount])], [[small], [[1, 50n]]]);
});

test('spendableNotes throws as spend does while the account has not learned the previous epoch\'s root', () => {
 const account = alice(4);
 account['prev'] = undefined;
 assert.throws(() => account.spendableNotes(), /root the previous epoch closed on/);
});

test('the submitted body carries anchor and rCur and no root, and exactly one of rCur and origin', async () => {
 const { account } = await funded(2, [500n, 0n, 600n]), [old, cur] = account.notes(), plan = account.anchorPlan(), program = new Uint8Array(32).fill(7);
 const proof = { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['5', '6', '1'] };
 const wire = (built: EpochBuiltSpend, extra = {}) => JSON.parse(JSON.stringify(epochTransferBody('ab'.repeat(16), built, proof, extra)));
 const spend = await account.spend({ input: cur!, withdraw: 400n, program }, aliceTo), body = wire(spend, { program });
 assert.deepEqual([Object.keys(body).sort(), Object.keys(body.slot).sort()], [['ciphertext', 'id', 'program', 'proof', 'publics', 'slot'], ['anchor', 'commitments', 'ctDigest', 'groupId', 'groupSize', 'nullifiers', 'rCur']]);
 assert.deepEqual([body.slot.anchor, body.slot.rCur, body.publics.length, body.slot.nullifiers.length, wire(await account.join([old!, cur!], aliceTo)).slot.nullifiers.length],
  [String(anchorOf(hash, plan.rPrev, plan.rCur.root)), { epoch: 1, root: String(plan.rCur.root) }, 7, 1, 2]);
 const { anchor, nullifiers, commitments, ctDigest, groupId, groupSize } = body.slot;
 assert.equal(String(statementOf(hash, { domain: ROLLUP_DOMAIN, root: BigInt(anchor), nullifiers: nullifiers.map(BigInt), commitments: commitments.map(BigInt), ctDigest: BigInt(ctDigest), groupId: BigInt(groupId), groupSize })), body.publics[0], 'admission recomputes the statement over the anchor');
 const { rCur, ...bare } = spend.slot, recovery = wire({ ...spend, slot: { ...bare, origin: 0 } }).slot;
 assert.deepEqual([recovery.origin, 'rCur' in recovery], [0, false]);
 for (const slot of [bare, { ...spend.slot, origin: 0 }]) assert.throws(() => epochTransferBody('ab'.repeat(16), { ...spend, slot }, proof), /exactly one of rCur and origin/);
});

test('an epoch proving URL names epoch-spend, and the pool serves it', async (t) => {
 const keys = mkdtempSync(join(tmpdir(), 'epoch-proving-')), files: Record<string, string> = {};
 t.after(() => rmSync(keys, { recursive: true, force: true }));
 for (const name of rollupKeyFilesOf('epoch')) { writeFileSync(join(keys, name), name); files[name] = name.replace(/\W/g, ''); }
 const app = express();
 app.use('/api/rollup', createRollupRouter(() => ({ keyFile: (name: string) => rollupKeyPath(keys, name, 'epoch') }) as unknown as RollupService));
 const server = app.listen(0, '127.0.0.1');
 await new Promise(resolve => server.once('listening', resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, proving = rollupProvingOf('epoch', files);
 const { account } = await funded(2, [500n, 0n, 600n]), [old, cur] = account.notes();
 const spend = epochProvingUrls(await account.spend({ input: cur!, ...pays(100n) }, aliceTo), proving, origin), joined = epochProvingUrls(await account.join([old!, cur!], aliceTo), proving, origin);
 assert.deepEqual(spend, { wasm: `${origin}/api/rollup/proving/epoch-spend.wasm?v=epochspendwasm`, zkey: `${origin}/api/rollup/proving/epoch-spend.zkey?v=epochspendzkey` });
 assert.equal(joined.zkey, `${origin}/api/rollup/proving/epoch-join.zkey?v=epochjoinzkey`, 'a join proves with the join circuit');
 const served = async (url: string) => { const response = await fetch(url); return [response.status, await response.text()]; };
 for (const url of [spend.wasm, spend.zkey, joined.wasm, joined.zkey]) assert.deepEqual(await served(url), [200, new URL(url).pathname.split('/').pop()], url);
 for (const url of Object.values(circuitUrls('spend', proving, origin))) assert.equal((await served(url))[0], 404, url);
});
