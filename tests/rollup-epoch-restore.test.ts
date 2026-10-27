import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import type { RollupEpochRecord } from '../packages/protocol/src/rollup/epoch-record.ts';
import { epochBirthCheckpoint, epochFreshAccount, epochMatchesPool, loadEpochAccount } from '../src/shielded/epoch-checkpoint.ts';
import { epochCatchUp, epochIdle } from '../src/shielded/epoch-sync.ts';
import type { PoolApi, RollupPoolStatus } from '../src/shielded/pool.ts';
import { NoteFrontier } from '../packages/protocol/src/rollup/frontier.ts';
import { NOTE_DEPTH, ROLLUP_DOMAIN, SUBTREE_DEPTH } from '../packages/protocol/src/rollup/constants.ts';
import { EpochAccount, type EpochAccountSnapshot, type EpochOwnedNote } from '../packages/protocol/src/rollup/epoch-account.ts';
import { rotatesAt } from '../packages/protocol/src/rollup/epoch-scan.ts';
import { noteOf } from '../packages/protocol/src/rollup/notes.ts';
import { rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { foldPath } from './fixtures/epoch.ts';
import { epochPool, opens, posted } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const zeros = Array<bigint>(NOTE_DEPTH).fill(0n);
const alice = (epochLen: number) => EpochAccount.owning(hash, aliceKeys, { epochLen });
const pays = (amount: bigint) => ({ to: { recipient: bobTo, amount } });
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (let page; (page = await api<{ batches: RollupEpochRecord[] }>(`/batches?from=${account.batchCount}`)).batches.length;) for (const batch of page.batches) await account.apply(batch);
};
const logged = (api: PoolApi) => {
 const asked: string[] = [];
 return { asked, api: ((path: string, ...rest: [unknown?, (() => void)?]) => { asked.push(path); return api(path, ...rest); }) as PoolApi };
};
const folds = (account: EpochAccount, note: EpochOwnedNote) =>
 foldPath(hash, noteOf(hash, ROLLUP_DOMAIN, note.amount, note.asset, account.owner, note.rho), note.index, account.frozenPath(note)!) === account.noteFinal(note.epoch);
const fromOf = (path: string) => Number(new URLSearchParams(path.split('?')[1]).get('from'));

// Mutinynet's epoch length: a birthday at an odd multiple of 64 sits on the epoch's one in-epoch checkpoint.
const LONG = 128;
let long: ReturnType<typeof buildLong> | undefined;
/** Three whole epochs, the next batch rotating: Alice is paid at 10, 100, 260 and 325 and spends the first note at 150; the rest is padding. */
async function buildLong() {
 const pool = epochPool(hash, LONG, false), helper = alice(LONG);
 for (let n = 0; n < 3 * LONG; n++) {
  if (n === 150) {
   await replay(helper, pool.api);
   pool.land('spend', [await pool.transfer({ ask: aliceKeys.ask, nk: aliceKeys.nk, self: aliceTo, request: { input: helper.notes().find(note => note.amount === 1000n)!, ...pays(300n) }, paths: [zeros] })]);
   continue;
  }
  const amount = ({ 10: 1000n, 100: 400n, 260: 250n, 325: 600n } as Record<number, bigint>)[n];
  pool.land('spend', amount ? [await pool.deposit(aliceTo, amount)] : []);
 }
 return pool;
}
const longPool = () => (long ??= buildLong());

test('a frozen epoch keeps the final root and a path that still verifies after three more rotations', async () => {
 const pool = epochPool(hash, 2), account = alice(2);
 pool.land('spend', await Promise.all([500n, 300n, 200n].map(amount => pool.deposit(aliceTo, amount))));
 pool.land();
 await replay(account, pool.api);
 const [a, b, c] = account.notes();
 pool.land('spend', [posted(await account.spend({ input: c!, ...pays(200n) }, aliceTo))]);
 await replay(account, pool.api);
 const fast = await account.spend({ input: b!, ...pays(300n) }, aliceTo);
 assert.ok(fast.witness.input.sel === 1n && opens(hash, account.owner, fast, [b!]), 'an NT[c-1] note spends on its frozen path');
 pool.land('spend', [posted(fast)]);
 for (let n = 0; n < 6; n++) pool.land();
 await replay(account, pool.api);
 assert.deepEqual([account.epoch, account.notes()], [4, [a]]);
 assert.ok(folds(account, a!));
 assert.equal(account.noteFinal(0), pool.state.archive.record(0)!.noteFinal);
 assert.deepEqual(account.snapshot().frozen, [{ epoch: 0, noteFinal: String(account.noteFinal(0)), paths: [[a!.index, account.frozenPath(a!)!.map(String)]] }], 'no path for a spent note, and no entry for an epoch the wallet holds nothing in');
});

test('the frozen noteFinal equals the operator\'s prevNoteRoot and the ER leaf\'s', async () => {
 const pool = epochPool(hash, 2), account = alice(2);
 for (let n = 0; n < 9; n++) {
  pool.land('spend', n % 2 ? [] : [await pool.deposit(aliceTo, 100n + BigInt(n))]);
  await replay(account, pool.api);
  if (!rotatesAt(n, 2)) continue;
  const closed = n / 2 - 1;
  assert.equal(account.noteFinal(closed), pool.state.prevNoteRoot, `epoch ${closed} at its rotation`);
  if (closed) assert.equal(account.noteFinal(closed - 1), pool.state.archive.record(closed - 1)!.noteFinal, `epoch ${closed - 1} once archived`);
 }
 assert.deepEqual([0, 1, 2].map(e => account.noteFinal(e)), pool.state.archive.list().filter(r => r.epoch >= 0).map(r => r.noteFinal));
 assert.ok(account.notes().filter(n => n.epoch < 4).every(n => folds(account, n)));
});

test('a wallet restored from its v2 snapshot and one replayed from bornAt agree on notes, root and history', async () => {
 const pool = epochPool(hash, 4), live = alice(4);
 for (let n = 0; n < 6; n++) pool.land('spend', n === 0 || n === 2 || n === 5 ? [await pool.deposit(aliceTo, 100n * BigInt(n + 1))] : []);
 await replay(live, pool.api);
 const saved = JSON.parse(JSON.stringify(live.snapshot())) as EpochAccountSnapshot;
 assert.deepEqual([saved.v, saved.epochLen, saved.epoch, saved.batch, saved.blockInEpoch, saved.frozen.map(f => f.epoch)], [2, 4, 1, 6, 2, [0]]);
 const resumed = EpochAccount.fromSnapshot(hash, aliceKeys, saved, 4), [old] = resumed.notes();
 const fast = await resumed.spend({ input: old!, ...pays(50n) }, aliceTo);
 assert.ok(old!.epoch === 0 && fast.witness.input.sel === 1n && opens(hash, resumed.owner, fast, [old!]), 'the fast path for an NT[c-1] note survives the restore');
 pool.land('spend', [posted(fast)]);
 for (let n = 7; n < 14; n++) pool.land('spend', n === 9 ? [await pool.deposit(aliceTo, 900n)] : []);
 const restored = await loadEpochAccount(hash, aliceKeys, { snapshot: saved, bornAt: 0, api: pool.api });
 const replayed = await loadEpochAccount(hash, aliceKeys, { bornAt: 0, api: pool.api });
 await epochCatchUp(replayed.account, pool.api);
 assert.deepEqual([restored.resumed, replayed.resumed, restored.account.epoch, restored.account.batchCount], [true, false, 3, 14]);
 assert.deepEqual(restored.account.snapshot(), replayed.account.snapshot());
 assert.ok(await epochMatchesPool(replayed.account, pool.api));
 assert.deepEqual(restored.account.notes().map(n => [n.epoch, n.amount]), [[0, 300n], [1, 600n], [1, 50n], [2, 900n]]);
});

test('a cold wallet born in the current epoch starts at the (epoch, blocks) checkpoint and matches the pool', async () => {
 const pool = await longPool(), { asked, api } = logged(pool.api), status = (await pool.api<RollupPoolStatus>('/status')).pool!;
 assert.deepEqual([status.batches, status.epoch, status.batchesInEpoch], [3 * LONG, 2, LONG], 'the epoch of the last accepted batch, not of the next');
 const bornAt = await epochBirthCheckpoint(api, pool.records[5 * 64]!.at! + 86_400_000), held: boolean[] = [];
 const account = await epochFreshAccount(hash, aliceKeys, bornAt, api, (cursor, _, at) => { if (cursor === 326) held.push(at.spendable(at.notes()[0]!)); });
 assert.deepEqual(asked, ['/times', '/status', '/checkpoints/2/64', '/batches?from=320&limit=50', '/batches?from=370&limit=50', '/status']);
 assert.deepEqual([bornAt, held], [320, [true]], 'mid-epoch, spendable() reads the prevNoteRoot the checkpoint start was seeded with');
 assert.deepEqual([account.batchCount, account.epoch, account.latestRoot(), account.prevNoteRoot()], [3 * LONG, 2, pool.state.latestRoot(), BigInt(status.prevNoteRoot!)]);
 const [note] = account.notes(), built = await account.spend({ input: note!, ...pays(100n) }, aliceTo);
 assert.deepEqual([note!.epoch, note!.amount], [2, 600n]);
 assert.ok(opens(hash, account.owner, built, [note!]));
 assert.equal(pool.state.clone().apply('spend', [built.slot, ...Array.from({ length: 9 }, () => pool.pad().slot)]).rotated, true, 'admitted by the batch that rotates');
 const inFlight = ((path: string, ...rest: [unknown?, (() => void)?]) => path.startsWith('/checkpoints/') ? Promise.reject(Object.assign(new Error('There is no checkpoint at that epoch and batch count.'), { status: 404 })) : pool.api(path, ...rest)) as PoolApi;
 const replayed = await epochFreshAccount(hash, aliceKeys, bornAt, inFlight);
 assert.deepEqual([replayed.batchCount, replayed.epoch, replayed.prevNoteRoot()], [LONG, 1, undefined], 'a 404, as while a rotating batch is in flight, is a replay from the epoch before');
 assert.ok(await epochMatchesPool(replayed, pool.api));
 assert.deepEqual([replayed.notes(), replayed.prevNoteRoot()], [account.notes(), account.prevNoteRoot()]);
});

test('a birthday past a checkpoint starts from the one below it, as the classic floor does, and one before the first asks for none', async () => {
 const pool = await longPool(), { asked, api } = logged(pool.api), early = logged(pool.api), status = (await pool.api<RollupPoolStatus>('/status')).pool!;
 const account = await epochFreshAccount(hash, aliceKeys, 2 * LONG + 70, api), young = await epochFreshAccount(hash, aliceKeys, 2 * LONG + 63, early.api);
 assert.deepEqual(asked, ['/status', '/checkpoints/2/64', '/batches?from=320&limit=50', '/batches?from=370&limit=50', '/status']);
 assert.deepEqual([account.batchCount, account.epoch, account.latestRoot(), account.prevNoteRoot(), account.notes()], [3 * LONG, 2, pool.state.latestRoot(), BigInt(status.prevNoteRoot!), []], 'Alice\'s payment at 325 is the batch before this birthday');
 assert.deepEqual([early.asked, young.batchCount, young.epoch], [['/status'], LONG, 1]);
});

test('epochBirthCheckpoint picks the same batch as the classic function did for the same /times answer', async () => {
 const asked: string[] = [], api = (async (path: string) => { asked.push(path); return { every: 64, at: [0, 1_000, 90_000_000, 200_000_000] }; }) as never, day = 86_400_000;
 assert.deepEqual([await epochBirthCheckpoint(api, 90_000_000 + day), await epochBirthCheckpoint(api, 90_000_000 + day - 1), await epochBirthCheckpoint(api, 0)], [128, 64, 0]);
 assert.deepEqual(asked, ['/times', '/times', '/times'], 'the date never leaves the wallet');
});

test('a cold wallet with an older birthday replays from the previous epoch and learns prevNoteRoot at the rotation', async () => {
 const pool = epochPool(hash, 4), { asked, api } = logged(pool.api);
 for (let n = 0; n < 18; n++) pool.land('spend', [2, 9, 13].includes(n) ? [await pool.deposit(aliceTo, 100n * BigInt(n))] : []);
 const account = await epochFreshAccount(hash, aliceKeys, 9, api), learned: (bigint | undefined)[] = [];
 assert.deepEqual([account.batchCount, account.epoch, account.blockInEpoch, account.prevNoteRoot()], [4, 1, 0, undefined], 'epoch 1, before its rotating batch');
 assert.throws(() => account.anchorPlan(), /root the previous epoch closed on/);
 await epochCatchUp(account, api, (cursor, _, at) => { learned[cursor] = at.prevNoteRoot(); });
 assert.deepEqual([asked[1], learned.slice(5, 10)], ['/batches?from=4&limit=50', [undefined, undefined, undefined, undefined, pool.state.archive.record(1)!.noteFinal]]);
 assert.ok(await epochMatchesPool(account, pool.api));
 const [crossed, live] = account.notes();
 assert.deepEqual([crossed!.epoch, crossed!.amount, live!.epoch, account.notes().length], [2, 900n, 3, 2], 'nothing before the birthday');
 assert.ok(!account.spendable(crossed!) && folds(account, crossed!) && account.noteFinal(2) === pool.state.archive.record(2)!.noteFinal, 'a note of an epoch the restore crossed is frozen for its recovery');
 const big = await longPool(), late = logged(big.api), closed = await epochFreshAccount(hash, aliceKeys, 192, late.api);
 assert.deepEqual([late.asked, closed.batchCount], [['/status'], 0], 'epoch 1 has closed, so its checkpoint is never asked for');
 await epochCatchUp(closed, big.api);
 assert.deepEqual(closed.notes().map(n => n.amount), [250n, 600n]);
});

test('matchesPool throws when the pool\'s prevNoteRoot contradicts the account\'s', async () => {
 const pool = epochPool(hash, 4), account = alice(4);
 for (let n = 0; n < 6; n++) pool.land('spend', n === 1 ? [await pool.deposit(aliceTo, 500n)] : []);
 const serving = (prevNoteRoot?: string) => (async (path: string) => {
  const answer = await pool.api<RollupPoolStatus>(path);
  return path === '/status' ? { ...answer, pool: { ...answer.pool!, prevNoteRoot } } : answer;
 }) as PoolApi;
 assert.equal(await epochMatchesPool(account, pool.api), true);
 await assert.rejects(epochMatchesPool(account, serving(String(account.prevNoteRoot()! + 1n))), /drifted across a rotation/);
 assert.equal(await epochMatchesPool(account, serving()), true, 'a pool that serves no prevNoteRoot is checked by its root alone');
 const drifted = { ...account.snapshot(), prevNoteRoot: String(account.prevNoteRoot()! + 1n) };
 await assert.rejects(loadEpochAccount(hash, aliceKeys, { snapshot: drifted, bornAt: 0, api: pool.api }), /drifted across a rotation/, 'never a quiet replay over the drift');
 const stale = { ...account.snapshot(), frontier: { ...account.snapshot().frontier, top: '1' } };
 const replayed = await loadEpochAccount(hash, aliceKeys, { snapshot: stale, bornAt: 0, api: pool.api });
 assert.deepEqual([replayed.resumed, replayed.error], [false, 'The saved wallet does not match the pool; syncing from the pool.'], 'a wrong root alone is a plain resync');
});

test('a v1 snapshot, another owner\'s, and another epochLen are each refused', async () => {
 const snapshot = alice(4).snapshot(), classic = { v: 1, owner: snapshot.owner, bornAt: 0, blocks: 0, frontier: new NoteFrontier(hash).snapshot(), owned: [], txids: [], history: [] } as unknown as EpochAccountSnapshot;
 assert.equal(EpochAccount.fromSnapshot(hash, aliceKeys, snapshot, 4).owner, alice(4).owner);
 assert.throws(() => EpochAccount.fromSnapshot(hash, aliceKeys, classic, 4), /version 1/);
 assert.throws(() => EpochAccount.fromSnapshot(hash, bobKeys, snapshot, 4), /another key/);
 assert.throws(() => EpochAccount.fromSnapshot(hash, aliceKeys, snapshot, 8), /4-batch epochs/);
 const pool = epochPool(hash, 8);
 pool.land('spend', [await pool.deposit(aliceTo, 70n)]);
 const loaded = await loadEpochAccount(hash, aliceKeys, { snapshot, bornAt: 0, api: pool.api });
 assert.deepEqual([loaded.resumed, loaded.error, loaded.account.epochLen], [false, 'That snapshot is of 4-batch epochs, and this pool\'s are 8; sync from the pool instead.', 8]);
});

test('epochCatchUp scans a long gap, fetches only the batches that concern the wallet, and crosses two rotations', async () => {
 const pool = await longPool(), { asked, api } = logged(pool.api), account = alice(LONG);
 assert.deepEqual(await Promise.all([epochCatchUp(account, api), epochIdle(account, () => account.batchCount)]), [3 * LONG, 3 * LONG], 'epochIdle waits out the catch-up');
 assert.deepEqual(asked.filter(p => p.startsWith('/scan')), ['/scan?from=50&limit=270'], 'one page past the first, ending SCAN_AFTER short of the head, across batches 128 and 256');
 assert.deepEqual(asked.filter(p => p.endsWith('&limit=1')).map(fromOf), [100, 150, 260]);
 assert.ok(await epochMatchesPool(account, pool.api));
 const [b, change] = account.notes();
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[0, 400n], [1, 700n], [2, 250n], [2, 600n]]);
 assert.deepEqual(account.snapshot().frozen.map(f => [f.epoch, f.paths.map(([index]) => index)]), [[0, [b!.index]], [1, [change!.index]]]);
 assert.ok(folds(account, b!) && folds(account, change!));
 assert.deepEqual([account.noteFinal(0), account.noteFinal(1)], [pool.state.archive.record(0)!.noteFinal, pool.state.prevNoteRoot]);
});

test('epochCatchUp sets aside a scan page that answers another from, and replays whole pages instead', async () => {
 const pool = await longPool(), account = alice(LONG);
 // A whole epoch on, so the page's rotation flags still match the batches asked for and only the from check can refuse it.
 const { asked, api } = logged(((path: string, ...rest: [unknown?, (() => void)?]) => pool.api(path.startsWith('/scan') ? path.replace(/from=\d+/, `from=${fromOf(path) + LONG}`) : path, ...rest)) as PoolApi);
 assert.equal(await epochCatchUp(account, api), 3 * LONG);
 assert.deepEqual(asked.filter(p => p.startsWith('/scan')), ['/scan?from=50&limit=270'], 'asked once, and never trusted');
 assert.ok(await epochMatchesPool(account, pool.api));
 assert.deepEqual(account.notes().map(n => [n.epoch, n.amount]), [[0, 400n], [1, 700n], [2, 250n], [2, 600n]]);
});

test('epochCatchUp surfaces a failed /scan to its caller instead of replaying whole pages, and a retry resumes', async () => {
 const pool = await longPool();
 for (const status of [429, 503, undefined]) {
  const account = alice(LONG), failure = Object.assign(new Error('The pool did not answer.'), status === undefined ? {} : { status });
  const { asked, api } = logged(((path: string, ...rest: [unknown?, (() => void)?]) => path.startsWith('/scan') ? Promise.reject(failure) : pool.api(path, ...rest)) as PoolApi);
  await assert.rejects(epochCatchUp(account, api), failure);
  assert.deepEqual(asked.filter(p => !p.startsWith('/scan')), ['/batches?from=0&limit=50'], `${status ?? 'no status'}: no whole-page replay`);
  assert.ok(await epochMatchesPool(account, pool.api), `${status ?? 'no status'}: the retry finishes the sync`);
 }
});

test('epochCatchUp replays whole pages when /scan is not served or its page does not decode', async () => {
 const pool = await longPool(), page = await pool.api<{ data: string }>('/scan?from=50&limit=270');
 const replies: [string, () => Promise<unknown>][] = [
  ['404', () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))],
  ['truncated page', () => Promise.resolve({ ...page, data: page.data.slice(0, -4) })],
  ['not base64', () => Promise.resolve({ ...page, data: '!!' })],
 ];
 for (const [label, reply] of replies) {
  const account = alice(LONG), { asked, api } = logged(((path: string, ...rest: [unknown?, (() => void)?]) => path.startsWith('/scan') ? reply() : pool.api(path, ...rest)) as PoolApi);
  assert.equal(await epochCatchUp(account, api), 3 * LONG, label);
  assert.deepEqual(asked.filter(p => p.startsWith('/scan')), ['/scan?from=50&limit=270'], `${label}: asked once`);
  assert.ok(await epochMatchesPool(account, pool.api), label);
 }
});

test('a checkpoint start that cannot be confirmed falls back to a replay start instead of rejecting', async () => {
 const pool = await longPool(), bornAt = 5 * 64;
 const down = (error: Error) => ((path: string, ...rest: [unknown?, (() => void)?]) => path.startsWith('/batches') ? Promise.reject(error) : pool.api(path, ...rest)) as PoolApi;
 const hookFails = () => { throw new Error('the wallet\'s onBatch failed'); };
 const starts = await Promise.all([
  epochFreshAccount(hash, aliceKeys, bornAt, down(new Error('fetch failed'))),
  epochFreshAccount(hash, aliceKeys, bornAt, down(Object.assign(new Error('Too many requests'), { status: 429 }))),
  epochFreshAccount(hash, aliceKeys, bornAt, pool.api, hookFails),
 ]);
 for (const account of starts) assert.deepEqual([account.batchCount, account.epoch, account.prevNoteRoot()], [LONG, 1, undefined]);
});

test('a checkpoint at blocks 0 is the empty tree of an unrotated epoch, so it takes no prevNoteRoot', () => {
 const start = (prevNoteRoot?: bigint) => EpochAccount.atCheckpoint(hash, aliceKeys, { epochLen: 4, checkpoint: { epoch: 2, blocks: 0, filled: Array<string>(NOTE_DEPTH - SUBTREE_DEPTH).fill('0') }, bornAt: 8, ...(prevNoteRoot === undefined ? {} : { prevNoteRoot }) });
 assert.equal(start().prevNoteRoot(), undefined);
 for (const seeded of [5n, 0n]) assert.throws(() => start(seeded), /no previous-epoch root to seed/, String(seeded));
});

test('rotatesNext is the account\'s own predicate: false right after an (epoch, 0) start, where the pool flag says true', async () => {
 const pool = epochPool(hash, 4), account = alice(4), seen: boolean[] = [];
 for (let n = 0; n < 6; n++) { pool.land(); await replay(account, pool.api); seen.push(account.rotatesNext); }
 assert.deepEqual(seen, [false, false, false, true, false, false]);
 const start = await epochFreshAccount(hash, aliceKeys, 9, pool.api);
 assert.deepEqual([start.batchCount, rotatesAt(start.batchCount, 4), start.rotatesNext], [4, true, false]);
 assert.throws(() => start.anchorPlan(), /root the previous epoch closed on/);
 assert.equal(account.anchorPlan().rotatesNext, account.rotatesNext);
});
