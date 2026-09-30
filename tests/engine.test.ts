import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoEngine, type DemoEngine } from '../src/engine.ts';
import { createProtocol, type ProtocolKernel, type PreparedSettlement } from '../packages/protocol/src/index.ts';

type View = {
  status: { message: string };
  wallets: { id: string; publicBalance: { BTC: number }; notes: { amount: number; status: string }[] }[];
  reserves: { asset: string; reserve: number; liabilities: number }[];
  native: { heads: Record<string, { txid: string; vout: number }> };
  activity: { type: string; status: string; txid?: string; nullifiers?: string[] }[];
};
const view = (engine: DemoEngine) => engine.snapshot() as View;
const wallet = (engine: DemoEngine, id: string) => view(engine).wallets.find(item => item.id === id)!;

test('accepted settlement is completed before the next action without resubmitting it', { timeout: 180_000 }, async t => {
  const probe = await createProtocol();
  const prototype = Object.getPrototypeOf(probe) as ProtocolKernel;
  const commit = prototype.commit;
  let failuresRemaining = 2;
  let shieldAttempts = 0;
  t.mock.method(prototype, 'commit', async function (this: ProtocolKernel, prepared: PreparedSettlement, receipt: unknown) {
    if (prepared.operation === 'shield') {
      shieldAttempts++;
      if (failuresRemaining > 0) { failuresRemaining--; throw new Error('injected commit interruption'); }
    }
    return commit.call(this, prepared, receipt);
  });
  const engine = await createDemoEngine();
  try {
    await assert.rejects(engine.action('shield', { from: 'alice', asset: 'BTC', amount: 100_000 }), /injected commit interruption/);
    const acceptedHeads = structuredClone(view(engine).native.heads);
    assert.equal(view(engine).activity.filter(item => item.type === 'shield' && item.status === 'accepted').length, 0);
    assert.match(view(engine).status.message, /accepted; local completion will retry/);

    await engine.action('recover', { from: 'alice' });
    assert.deepEqual(view(engine).native.heads, acceptedHeads);
    assert.equal(view(engine).activity.filter(item => item.type === 'shield' && item.status === 'accepted').length, 1);
    assert.equal(wallet(engine, 'alice').notes.length, 1);
    assert.equal(wallet(engine, 'alice').notes[0].amount, 100_000);
    assert.equal(shieldAttempts, 3);

    await engine.action('seal', {});
    assert.equal(view(engine).activity.filter(item => item.type === 'shield' && item.status === 'accepted').length, 1);
    assert.equal(wallet(engine, 'alice').notes.length, 1);
    assert.equal(wallet(engine, 'alice').notes[0].status, 'spendable');

    failuresRemaining = 2;
    await assert.rejects(engine.action('shield', { from: 'alice', asset: 'BTC', amount: 5_000 }), /injected commit interruption/);
    await engine.action('reset', {});
    const resetHeads = structuredClone(view(engine).native.heads);
    assert.equal(view(engine).activity.length, 0);
    assert.equal(view(engine).reserves.find(item => item.asset === 'BTC')!.reserve, 0);
    assert.equal(wallet(engine, 'alice').notes.length, 0);
    await engine.action('recover', { from: 'alice' });
    assert.deepEqual(view(engine).native.heads, resetHeads);
    assert.equal(shieldAttempts, 5);
  } finally { engine.close(); }
});

test('a commit retry after application records one withdrawal and one payout', { timeout: 180_000 }, async t => {
  const probe = await createProtocol();
  const prototype = Object.getPrototypeOf(probe) as ProtocolKernel;
  const commit = prototype.commit;
  let injected = false;
  t.mock.method(prototype, 'commit', async function (this: ProtocolKernel, prepared: PreparedSettlement, receipt: unknown) {
    const result = await commit.call(this, prepared, receipt);
    if (prepared.operation === 'withdraw' && !injected) {
      injected = true;
      throw new Error('injected lost commit response');
    }
    return result;
  });
  const engine = await createDemoEngine();
  try {
    await engine.action('shield', { from: 'alice', asset: 'BTC', amount: 100_000 });
    await engine.action('seal', {});
    const priorHeads = structuredClone(view(engine).native.heads);
    const receipt = await engine.action('withdraw', { from: 'alice', asset: 'BTC', amount: 10_000 }) as { txid: string };
    const result = view(engine);

    assert.equal(injected, true);
    assert.equal(wallet(engine, 'alice').publicBalance.BTC, 10_000);
    assert.equal(result.reserves.find(item => item.asset === 'BTC')!.reserve, 90_000);
    assert.equal(result.reserves.find(item => item.asset === 'BTC')!.liabilities, 90_000);
    const unspent = wallet(engine, 'alice').notes.filter(note => note.status !== 'spent');
    assert.equal(unspent.length, 1);
    assert.equal(unspent[0].amount, 90_000);
    assert.notEqual(result.native.heads.btcVault.txid, priorHeads.btcVault.txid);
    const withdrawals = result.activity.filter(item => item.type === 'withdraw' && item.status === 'accepted');
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0].txid, receipt.txid);
    assert.equal(withdrawals[0].nullifiers?.length, 1);
  } finally { engine.close(); }
});

test('kernel commit stages cloneable data and is idempotent for one prepared settlement', async () => {
  const protocol = await createProtocol();
  const prepared = await protocol.prepareShield('alice', 'BTC', 500);
  const before = protocol.snapshot();
  await assert.rejects(protocol.commit(prepared, { invalid: () => undefined }));
  assert.deepEqual(protocol.snapshot(), before);

  await protocol.commit(prepared, { id: prepared.id });
  const committed = protocol.snapshot();
  await protocol.commit(prepared, { id: prepared.id });
  assert.deepEqual(protocol.snapshot(), committed);
  assert.equal(committed.encryptedLog.length, 2);
  assert.equal(committed.receipts.length, 1);
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});
