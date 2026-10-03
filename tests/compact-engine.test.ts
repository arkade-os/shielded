import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createDemoEngine } from '../src/engine.ts';
import { EngineStore } from '../src/storage.ts';
import { createProtocol, type ProtocolKernel, type PreparedSettlement } from '../packages/protocol/src/index.ts';

test('encrypted engine checkpoint binds its proof transport and refuses an implicit switch', { timeout: 180_000 }, async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'shielded-compact-engine-'));
  const storageKey = '47'.repeat(32);
  let engine: Awaited<ReturnType<typeof createDemoEngine>> | undefined;
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey, proofTransport: 'inline' });
    assert.equal((engine.snapshot() as { status: { proofTransport: string } }).status.proofTransport, 'inline');
    await engine.close();
    engine = undefined;

    await assert.rejects(createDemoEngine({ dataDirectory, storageKey, proofTransport: 'compact' }),
      /Stored proof transport is inline; refusing to reopen it as compact/);

    engine = await createDemoEngine({ dataDirectory, storageKey, proofTransport: 'inline' });
    assert.equal((engine.snapshot() as { status: { proofTransport: string } }).status.proofTransport, 'inline');
  } finally {
    await engine?.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});

test('compact accepted submission recovers after checkpoint and protocol commit interruptions without resubmitting', { timeout: 240_000 }, async t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'shielded-compact-recovery-'));
  const storageKey = '58'.repeat(32);
  const protocol = await createProtocol();
  const protocolPrototype = Object.getPrototypeOf(protocol) as ProtocolKernel;
  const originalCommit = protocolPrototype.commit;
  let interruptedProtocolCommit = false;
  t.mock.method(protocolPrototype, 'commit', async function (this: ProtocolKernel, prepared: PreparedSettlement, receipt: unknown) {
    if (prepared.operation === 'shield' && !interruptedProtocolCommit) {
      interruptedProtocolCommit = true;
      throw new Error('injected protocol commit interruption');
    }
    return originalCommit.call(this, prepared, receipt);
  });

  const originalSave = EngineStore.prototype.save;
  let interruptedAcceptedCheckpoint = false;
  t.mock.method(EngineStore.prototype, 'save', function (this: EngineStore, value: unknown) {
    const checkpoint = value as { pendingCompletion?: { phase?: string } };
    if (checkpoint.pendingCompletion?.phase === 'accepted' && !interruptedAcceptedCheckpoint) {
      interruptedAcceptedCheckpoint = true;
      throw new Error('injected accepted checkpoint commit interruption');
    }
    return originalSave.call(this, value);
  });

  let engine: Awaited<ReturnType<typeof createDemoEngine>> | undefined;
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey, proofTransport: 'compact' });
    const requestId = 'compact-recovery-shield';
    await assert.rejects(engine.action('shield', { from: 'alice', asset: 'BTC', amount: 100_000 }, requestId),
      /injected accepted checkpoint commit interruption/);
    const acceptedHeads = structuredClone((engine.snapshot() as { native: { heads: unknown } }).native.heads);
    assert.equal(interruptedAcceptedCheckpoint, true);
    assert.equal(interruptedProtocolCommit, false, 'the failed durable accepted checkpoint must precede protocol commit');
    await engine.close();
    engine = undefined;

    engine = await createDemoEngine({ dataDirectory, storageKey, proofTransport: 'compact' });
    const recovered = engine.snapshot() as { native: { heads: unknown }; activity: { type: string; status: string; txid?: string }[] };
    assert.deepEqual(recovered.native.heads, acceptedHeads, 'reconciliation must retain the already accepted native heads');
    assert.equal(recovered.activity.filter(item => item.type === 'shield' && item.status === 'accepted').length, 1);
    assert.equal(interruptedProtocolCommit, true, 'restart must finish protocol commit after its injected interruption');

    const beforeRetryHeads = structuredClone(recovered.native.heads);
    const duplicate = await engine.action('shield', { from: 'alice', asset: 'BTC', amount: 100_000 }, requestId) as { txid?: string };
    const afterRetry = engine.snapshot() as typeof recovered;
    assert.deepEqual(afterRetry.native.heads, beforeRetryHeads, 'persisted idempotency must not submit another native transaction');
    assert.equal(afterRetry.activity.filter(item => item.type === 'shield' && item.status === 'accepted').length, 1);
    assert.equal(duplicate.txid, afterRetry.activity.find(item => item.type === 'shield' && item.status === 'accepted')?.txid,
      'the persisted idempotency key must return the recovered accepted receipt');
  } finally {
    await engine?.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
