import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import type { RollupEpochRecord } from '../packages/protocol/src/rollup/epoch-record.ts';
import { epochIncomingNotes, epochRevealLinkOf } from '../src/shielded/epoch-disclosure.ts';
import { epochSyncAccount } from '../src/shielded/epoch-pool.ts';
import { epochCatchUp, type EpochBatchPage } from '../src/shielded/epoch-sync.ts';
import type { PoolApi } from '../src/shielded/pool.ts';
import type { SentRecord } from '../src/shielded/repository.ts';
import { ROLLUP_DOMAIN, ROLLUP_FIELD } from '../packages/protocol/src/rollup/constants.ts';
import { decodeDisclosure, encodeDisclosure, fullViewKeyOf, parseFullViewKey, parseViewKey, sentNoteOf, verifyDisclosure, viewKeyOf, type DisclosedNote, type Disclosure, type IncomingNote } from '../packages/protocol/src/rollup/disclosure.ts';
import { EpochAccount, type EpochHistoryEntry } from '../packages/protocol/src/rollup/epoch-account.ts';
import { akOf } from '../packages/protocol/src/rollup/notes.ts';
import { parseRollupAddress, rollupAddressOf, rollupRecipientOf, type RollupRecipient } from '../packages/protocol/src/rollup/wallet.ts';
import { deriveRollupKeys2 } from '../packages/protocol/src/wallet-keys.ts';
import { epochPool, posted } from './fixtures/epoch-pool.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys, bobKeys] = ['11', '22'].map(byte => deriveRollupKeys2(byte.repeat(32), 'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>, ReturnType<typeof deriveRollupKeys2>];
const [aliceTo, bobTo] = [aliceKeys, bobKeys].map(k => rollupRecipientOf(hash, k.ask, k.nk, k.viewSecret)) as [RollupRecipient, RollupRecipient];
const [aliceAddress, bobAddress] = [aliceTo, bobTo].map(rollupAddressOf) as [string, string];
const ORIGIN = 'https://example.test';
const EPOCH_LEN = 4;
const fresh = (keys: typeof aliceKeys) => EpochAccount.owning(hash, keys, { epochLen: EPOCH_LEN });
const replay = async (account: EpochAccount, api: PoolApi) => {
 for (const batch of (await api<EpochBatchPage>(`/batches?from=${account.batchCount}&limit=100`)).batches) await account.apply(batch);
 return account;
};
const watch = async (keys: typeof aliceKeys, api: PoolApi) => {
 const key = parseFullViewKey(hash, fullViewKeyOf(akOf(hash, keys.ask), keys.nk, keys.viewSecret)), watcher = new EpochAccount(hash, key, { epochLen: EPOCH_LEN, replica: true });
 await epochSyncAccount(watcher, api);
 return watcher;
};
/** Disclose.tsx's /verify: a note's batch is fetched by floor(index / 32), then its slot and output are read off the index. */
const verifyOnPool = async (api: PoolApi, disclosure: Disclosure) => {
 const batches = new Map<number, RollupEpochRecord | undefined>();
 for (const n of new Set(disclosure.notes.map(note => Math.floor(note.index / 32)))) batches.set(n, (await api<EpochBatchPage>(`/batches?from=${n}&limit=1`)).batches[0]);
 return verifyDisclosure(hash, disclosure, index => batches.get(Math.floor(index / 32))?.slots[Math.floor((index % 32) / 2)]?.commitments[index % 2]);
};
const disclosureOf = (link: string | undefined) => decodeDisclosure(link!.split('#')[1]!);
const listed = (found: IncomingNote[]) => found.map(n => [n.batch, n.index, n.amount, n.deposit]);

/** 4-batch epochs. Alice is paid 500 and 300 at batch 0, and pays Bob 100 at batch 1, 600 as two legs at batch 5 and 30 at batch 8, which rotates; at batch 10 Bob recovers his epoch-0 note. */
let built: ReturnType<typeof buildWorld> | undefined;
const world = () => (built ??= buildWorld());
async function buildWorld() {
 const pool = epochPool(hash, EPOCH_LEN), alice = fresh(aliceKeys), bob = fresh(bobKeys), sent = new Map<bigint, SentRecord>();
 const pay = async (amount: bigint) => {
  await replay(alice, pool.api);
  const { spends } = await alice.pay(bobTo, amount, aliceTo);
  for (const spend of spends) {
   const note = sentNoteOf(hash, spend);
   sent.set(spend.witness.slot.nullifiers[0]!, { to: bobAddress, note: { amount: String(note.amount), asset: String(note.asset), rho: String(note.rho) } });
  }
  pool.land('spend', spends.map(posted));
 };
 pool.land('spend', [await pool.deposit(aliceTo, 500n), await pool.deposit(aliceTo, 300n)]);
 await pay(100n);
 while (pool.state.batchCount < 5) pool.land();
 await pay(600n);
 while (pool.state.batchCount < 8) pool.land();
 await pay(30n);
 pool.land();
 await replay(bob, pool.api);
 pool.land('recover', [posted(await bob.recover(bob.notes()[0]!, bobTo))]);
 return { pool, sent };
}

test('a reveal link for a note received after a rotation verifies against the batch that holds it', async () => {
 const { pool } = await world(), bob = await replay(fresh(bobKeys), pool.api), receipts = bob.history.filter(e => e.kind === 'receive');
 assert.deepEqual(receipts.map(e => [e.batch, e.epoch, e.created.map(n => n.index)]), [[1, 0, [32]], [5, 1, [32, 34]], [8, 2, [0]]], 'the leaf index starts over in every epoch');
 for (const entry of receipts) {
  const disclosure = disclosureOf(epochRevealLinkOf(ORIGIN, entry, { self: bobAddress, sentOf: () => undefined })), yes = disclosure.notes.map(() => true);
  assert.deepEqual(await verifyOnPool(pool.api, disclosure), yes, `batch ${entry.batch}`);
  const leaves = { ...disclosure, notes: disclosure.notes.map((n, i) => ({ ...n, index: entry.created[i]!.index })) };
  assert.deepEqual(await verifyOnPool(pool.api, leaves), entry.epoch ? yes.map(() => false) : yes, `the per-epoch leaf index of batch ${entry.batch}`);
 }
});

test('a reveal link for a send verifies, unchanged from the classic computation', async () => {
 const { pool, sent } = await world(), alice = await replay(fresh(aliceKeys), pool.api), sends = alice.history.filter(e => e.kind === 'send');
 const o = { self: aliceAddress, sentOf: (nullifier: bigint) => sent.get(nullifier) };
 assert.deepEqual(sends.map(e => [e.batch, e.epoch, e.slots]), [[1, 0, [0]], [5, 1, [0, 1]], [8, 2, [0]]]);
 for (const entry of sends) {
  const disclosure = disclosureOf(epochRevealLinkOf(ORIGIN, entry, o));
  assert.deepEqual(disclosure.notes.map(n => n.index), entry.slots.map(slot => entry.batch * 32 + 2 * slot), `batch ${entry.batch}: the classic send index`);
  assert.deepEqual([disclosure.to, await verifyOnPool(pool.api, disclosure)], [bobAddress, disclosure.notes.map(() => true)], `batch ${entry.batch}`);
 }
 assert.deepEqual(disclosureOf(epochRevealLinkOf(ORIGIN, sends[1]!, o)).notes.map(n => [n.index, n.amount]), [[160, 500n], [162, 100n]], 'each leg of a group is named by its own slot');
});

test('a disclosure that repeats a note, or names a value past what a note holds, is refused, so its verified total cannot be inflated', async () => {
 const { pool, sent } = await world(), alice = await replay(fresh(aliceKeys), pool.api), send = alice.history.find(e => e.kind === 'send')!;
 const disclosure = disclosureOf(epochRevealLinkOf(ORIGIN, send, { self: aliceAddress, sentOf: (nullifier: bigint) => sent.get(nullifier) })), note = disclosure.notes[0]!;
 const inflated: [string, DisclosedNote[]][] = [['a repeated note', [note, note]], ['an amount past 64 bits', [{ ...note, amount: note.amount + ROLLUP_FIELD }]],
  ['an asset past the field', [{ ...note, asset: note.asset + ROLLUP_FIELD }]], ['a rho past the field', [{ ...note, rho: note.rho + ROLLUP_FIELD }]]];
 for (const [what, notes] of inflated) {
  assert.ok((await verifyOnPool(pool.api, { ...disclosure, notes })).every(Boolean), `${what} still matches the published commitment`);
  assert.throws(() => decodeDisclosure(encodeDisclosure({ ...disclosure, notes })), /Not a shielded payment disclosure/, what);
 }
});

test('a view key lists every note it received across three epochs, at the right batches', async () => {
 const { pool } = await world(), key = parseViewKey(viewKeyOf(bobTo.owner, bobKeys.viewSecret)), bob = await replay(fresh(bobKeys), pool.api);
 assert.deepEqual(bob.notes().map(n => [n.epoch, n.index]), [[1, 32], [1, 34], [2, 0], [2, 64]], 'the account names its notes by epoch and leaf');
 assert.deepEqual(listed(await epochIncomingNotes(hash, pool.records, key)), [[1, 32, 100n, false], [5, 160, 500n, false], [5, 162, 100n, false], [8, 256, 30n, false], [10, 320, 100n, false]]);
 assert.deepEqual(listed(await epochIncomingNotes(hash, pool.records.slice(5), key, 5)), [[5, 160, 500n, false], [5, 162, 100n, false], [8, 256, 30n, false], [10, 320, 100n, false]], 'from a later page, by the same stream position');
});

test('a view key leaves out a note sealed to it that commits to another owner', async () => {
 const pool = epochPool(hash, EPOCH_LEN), key = parseViewKey(viewKeyOf(bobTo.owner, bobKeys.viewSecret));
 pool.land('spend', [await pool.deposit({ ...bobTo, owner: aliceTo.owner }, 400n), await pool.deposit(bobTo, 300n)]);
 assert.deepEqual(listed(await epochIncomingNotes(hash, pool.records, key)), [[0, 2, 300n, true]]);
});

test('a full viewing key over an epoch pool sees the same notes and their spends', async () => {
 const { pool } = await world(), [alice, bob] = await Promise.all([aliceKeys, bobKeys].map(async keys => {
  const watcher = await watch(keys, pool.api), owner = await replay(fresh(keys), pool.api);
  assert.deepEqual([watcher.batchCount, watcher.notes(), watcher.history], [11, owner.notes(), owner.history]);
  return watcher;
 }));
 assert.deepEqual(alice.notes().map(n => [n.epoch, n.index, n.amount]), [[2, 1, 70n]], 'her payments left one change note');
 assert.deepEqual(bob.notes().map(n => [n.epoch, n.index, n.amount]), [[1, 32, 500n], [1, 34, 100n], [2, 0, 30n], [2, 64, 100n]], 'his recovery spent the epoch-0 note');
 assert.deepEqual(alice.history.map(e => [e.kind, e.batch, e.spent.length]), [['shield', 0, 0], ['shield', 0, 0], ['send', 1, 1], ['send', 5, 2], ['send', 8, 1]], 'each payment with the notes it spent');
 await assert.rejects(() => alice.spend({ input: alice.notes()[0]! }, aliceTo), /spend authority/);
});

// Minted by the code of 98436a5 (the genesis-3 ROLLUP_DOMAIN bump) from deriveRollupKeys2('11'.repeat(32), 'mutinynet'); identical at this commit.
const GENESIS3 = {
 address: 'shrol21fwljy697marav7lxj5uspcpncmusg35wxjzf4l3s2fzs5cy0yqzyg8a6jqchj66k4jvtdvg0dez79z4memfsu4m36d8e9nxcpgsuc6clprr5h',
 view: 'shview21fwljy697marav7lxj5uspcpncmusg35wxjzf4l3s2fzs5cy0yqz2jrzwr7jnzkyyu0dk5cqlrms8msx4cg66z2xglhjzy6psj4e026s3umm9y',
 full: 'shfvk21qr6cvtvhfzhrg9ahdavt2zaq99lr5nl50mk7k8rmeqnu8umvdsnkcrl432k52qhvq6redhcxqkyf3407cshcasd374l2n45dshyc2xdfp38plff3tzzw8km2vq03acracr2uyddp9ry0mepzdqcf2uh4dgs5p9sk',
};

test('a view key and address built on genesis-3 rules decode unchanged', async () => {
 const { pool } = await world(), address = parseRollupAddress(GENESIS3.address), view = parseViewKey(GENESIS3.view), full = parseFullViewKey(hash, GENESIS3.full);
 assert.equal(ROLLUP_DOMAIN, 20261017000n);
 assert.deepEqual([view.owner, full.owner, aliceTo.owner], [address.owner, address.owner, address.owner], 'ak and nk still derive the owner the address carries');
 assert.deepEqual([aliceAddress, viewKeyOf(aliceTo.owner, aliceKeys.viewSecret), fullViewKeyOf(akOf(hash, aliceKeys.ask), aliceKeys.nk, aliceKeys.viewSecret)], [GENESIS3.address, GENESIS3.view, GENESIS3.full], 'and the same seed still mints the same strings');
 assert.deepEqual(listed(await epochIncomingNotes(hash, pool.records, view)), [[0, 0, 500n, true], [0, 2, 300n, true], [1, 33, 200n, false], [5, 163, 100n, false], [8, 257, 70n, false]], 'and it lists what an epoch pool paid it, its deposits as deposits');
});

test('a reveal link exists only for a payment, a receipt or a shield, and names only what the wallet remembers', () => {
 const entry = (over: Partial<EpochHistoryEntry>): EpochHistoryEntry => ({ kind: 'send', batch: 9, epoch: 2, amounts: [], spent: [7n], created: [], slots: [0], ...over });
 const remembers = (...known: bigint[]) => ({ self: aliceAddress, sentOf: (nullifier: bigint): SentRecord | undefined => (known.includes(nullifier) ? { to: bobAddress, note: { amount: String(nullifier), asset: '0', rho: '9' } } : undefined) });
 const named = (e: EpochHistoryEntry, ...known: bigint[]) => disclosureOf(epochRevealLinkOf(ORIGIN, e, remembers(...known))).notes.map(n => [n.index, n.amount]);
 const received = entry({ kind: 'receive', spent: [], created: [{ amount: 400n, asset: 0n, rho: 5n, epoch: 2, index: 77, nullifier: 1n }] });
 for (const kind of ['withdraw', 'merge', 'renew', 'recover'] as const) assert.equal(epochRevealLinkOf(ORIGIN, { ...received, kind }, remembers()), undefined, kind);
 assert.deepEqual([named(received), named({ ...received, kind: 'shield' })], [[[301, 400n]], [[301, 400n]]], 'batch 9, place 13 of its block');
 assert.equal(epochRevealLinkOf(ORIGIN, entry({}), remembers()), undefined, 'no remembered note, no link');
 assert.deepEqual(named(entry({ spent: [7n, 8n], slots: [4] }), 7n, 8n), [[296, 7n]], 'a join names its payment once, from its first input');
});

test('epochSyncAccount pages through /batches from the account\'s own count and stops on an empty page', async () => {
 const { pool } = await world(), asked: number[] = [];
 const paged = (extra: number) => ((path: string) => {
  if (asked.push(Number(/from=(\d+)/.exec(path)![1])) > 12) throw new Error('runaway');
  return pool.api<EpochBatchPage>(path.replace('limit=50', 'limit=3')).then(page => ({ ...page, total: page.total + extra }));
 }) as PoolApi;
 const honest = fresh(aliceKeys);
 await epochSyncAccount(honest, paged(0));
 assert.deepEqual([honest.batchCount, asked.splice(0)], [11, [0, 3, 6, 9]]);
 const overstated = fresh(aliceKeys);
 await epochSyncAccount(overstated, paged(5));
 assert.deepEqual([overstated.batchCount, asked.splice(0)], [11, [0, 3, 6, 9, 11]], 'a total beyond what the pool serves');
});

test('two syncs of one account that overlap apply each batch once, whichever two they are', async () => {
 const { pool } = await world(), syncs = [epochSyncAccount, epochCatchUp];
 for (const first of syncs) for (const second of syncs) {
  const account = fresh(aliceKeys);
  await Promise.all([first(account, pool.api), second(account, pool.api)]);
  assert.deepEqual([account.batchCount, account.latestRoot()], [pool.records.length, pool.state.latestRoot()], `${first.name} then ${second.name}`);
 }
});
