import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createDemoEngine, type DemoEngine } from '../src/engine.ts';
import { createProtocol, type ProtocolKernel, type PreparedSettlement } from '../packages/protocol/src/index.ts';
import { EngineStore } from '../src/storage.ts';

const directory = () => mkdtempSync(join(tmpdir(), 'shielded-engine-'));
const storageKey = '33'.repeat(32);
const stop = async (engine: DemoEngine | undefined) => { if (engine) await engine.close(); };

test('encrypted engine checkpoints preserve notes and native heads across restart; request retries are idempotent', { timeout: 180_000 }, async () => {
  const dataDirectory = directory();
  let engine: DemoEngine | undefined;
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey });
    const first = await engine.action('shield', { from: 'alice', amount: 1200 }, 'shield-1');
    const firstState = engine.snapshot() as { wallets: { id: string; notes: unknown[] }[]; native: { heads: Record<string, unknown> } };
    assert.ok(firstState.wallets.find(wallet => wallet.id === 'alice')!.notes.length > 0);
    await stop(engine); engine = undefined;

    engine = await createDemoEngine({ dataDirectory, storageKey });
    const restored = engine.snapshot() as { wallets: { id: string; notes: unknown[] }[]; native: { heads: Record<string, unknown> }; activity: unknown[] };
    assert.equal(restored.wallets.find(wallet => wallet.id === 'alice')!.notes.length, firstState.wallets.find(wallet => wallet.id === 'alice')!.notes.length);
    assert.deepEqual(restored.native.heads, firstState.native.heads);
    assert.equal(restored.activity.length, 1);
    assert.deepEqual(await engine.action('shield', { from: 'alice', amount: 1200 }, 'shield-1'), first);
    await assert.rejects(engine.action('shield', { from: 'alice', amount: 1201 }, 'shield-1'), /different action body/);
    assert.equal((engine.snapshot() as { activity: unknown[] }).activity.length, 1);
  } finally { await stop(engine); rmSync(dataDirectory, { recursive: true, force: true }); }
});

test('an accepted settlement with failed local commits completes after restart without resubmission', { timeout: 180_000 }, async t => {
  const dataDirectory = directory();
  let engine: DemoEngine | undefined;
  const probe = await createProtocol();
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.commit;
  let failures = 2;
  t.mock.method(prototype, 'commit', async function(this: ProtocolKernel, prepared: PreparedSettlement, receipt: unknown) {
    if (failures-- > 0) throw new Error('injected local checkpoint fault');
    return original.call(this, prepared, receipt);
  });
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey });
    await assert.rejects(engine.action('shield', { from: 'alice', amount: 1700 }, 'shield-recovery'), /injected local checkpoint fault/);
    const accepted = engine.snapshot() as { native: { heads: Record<string, unknown> }; activity: unknown[]; status: { recovery: string } };
    assert.equal(accepted.status.recovery, 'accepted');
    assert.equal(accepted.activity.length, 0);
    const acceptedHeads = structuredClone(accepted.native.heads);
    await stop(engine); engine = undefined;

    engine = await createDemoEngine({ dataDirectory, storageKey });
    const recovered = engine.snapshot() as { native: { heads: Record<string, unknown> }; activity: unknown[]; wallets: { id: string; notes: unknown[] }[] };
    assert.deepEqual(recovered.native.heads, acceptedHeads);
    assert.equal(recovered.activity.length, 1);
    assert.equal(recovered.wallets.find(wallet => wallet.id === 'alice')!.notes.length, 1);
    await engine.action('shield', { from: 'alice', amount: 1700 }, 'shield-recovery');
    const retried = engine.snapshot() as { activity: unknown[]; native: { heads: Record<string, unknown> } };
    assert.equal(retried.activity.length, 1);
    assert.deepEqual(retried.native.heads, acceptedHeads);
  } finally { await stop(engine); rmSync(dataDirectory, { recursive: true, force: true }); }
});

test('a durable commit write failure freezes the process and restart completes from the last accepted checkpoint', { timeout: 180_000 }, async t => {
  const dataDirectory = directory();
  let engine: DemoEngine | undefined;
  const save = EngineStore.prototype.save;
  let calls = 0;
  t.mock.method(EngineStore.prototype, 'save', function(this: EngineStore, checkpoint: unknown) {
    if (++calls === 6) throw new Error('injected disk checkpoint fault');
    return save.call(this, checkpoint);
  });
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey });
    await assert.rejects(engine.action('shield', { from: 'alice', amount: 2100 }, 'disk-recovery'), /injected disk checkpoint fault/);
    const failed = engine.snapshot() as { status: { ready: boolean; message: string }; activity: unknown[] };
    assert.equal(failed.status.ready, false);
    assert.match(failed.status.message, /checkpoint write failed/);
    assert.equal(failed.activity.length, 1);
    await assert.rejects(engine.action('seal', {}), /read-only/);
    await stop(engine); engine = undefined;

    engine = await createDemoEngine({ dataDirectory, storageKey });
    const restored = engine.snapshot() as { status: { ready: boolean }; activity: unknown[]; wallets: { id: string; notes: unknown[] }[] };
    assert.equal(restored.status.ready, true);
    assert.equal(restored.activity.length, 1);
    assert.equal(restored.wallets.find(wallet => wallet.id === 'alice')!.notes.length, 1);
  } finally { await stop(engine); rmSync(dataDirectory, { recursive: true, force: true }); }
});

after(async () => {
  const pool = (globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
