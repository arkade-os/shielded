import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { DemoEngine } from '../src/engine.ts';

const priorVm = process.env.SHIELDED_VM_BIN;
process.env.SHIELDED_VM_BIN = join(tmpdir(), 'shielded-missing-vm');
const { createDemoEngine } = await import('../src/engine.ts');
const key = '44'.repeat(32);

test('unknown submitted action stays blocked after restart without applying local state', { timeout: 180_000 }, async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'shielded-submit-'));
  let engine: DemoEngine | undefined;
  try {
    engine = await createDemoEngine({ dataDirectory, storageKey: key });
    await assert.rejects(engine.action('shield', { from: 'alice', amount: 1300 }, 'unknown-submit'), /(Emulator bridge exited|ENOENT)/);
    const failed = engine.snapshot() as { status: { recovery: string }; activity: unknown[]; wallets: { id: string; notes: unknown[] }[] };
    assert.equal(failed.status.recovery, 'blocked');
    assert.equal(failed.activity.length, 0);
    assert.equal(failed.wallets.find(wallet => wallet.id === 'alice')!.notes.length, 0);
    await engine.close(); engine = undefined;

    engine = await createDemoEngine({ dataDirectory, storageKey: key });
    const recovered = engine.snapshot() as { status: { recovery: string; ready: boolean }; activity: unknown[]; wallets: { id: string; notes: unknown[] }[] };
    assert.equal(recovered.status.recovery, 'blocked');
    assert.equal(recovered.status.ready, false);
    assert.equal(recovered.activity.length, 0);
    assert.equal(recovered.wallets.find(wallet => wallet.id === 'alice')!.notes.length, 0);
  } finally {
    await engine?.close();
    process.env.SHIELDED_VM_BIN = priorVm;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

after(async () => {
  const pool = (globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
