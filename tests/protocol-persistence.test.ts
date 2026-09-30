import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol, type PreparedSettlement, type ProtocolCheckpoint } from '../packages/protocol/src/index.ts';

test('protocol checkpoints restore notes, verify pending settlements, and commit each ID once', { timeout: 180_000 }, async () => {
  const first = await createProtocol({ secureKeys: true });
  const shield = await first.prepareShield('alice', 'BTC', 900);
  await first.commit(shield, { txid: 'shield-receipt' });
  const seal = await first.prepareSeal();
  await first.commit(seal, { txid: 'seal-receipt' });
  const saved = JSON.parse(JSON.stringify(first.exportState())) as ProtocolCheckpoint;
  const restored = await createProtocol({ checkpoint: saved });
  assert.deepEqual(restored.snapshot(), first.snapshot());
  const pending = await restored.prepareTransfer('alice', 'bob', 'BTC', 300);
  const adopted = await createProtocol({ checkpoint: JSON.parse(JSON.stringify(restored.exportState())) as ProtocolCheckpoint });
  const staged = await adopted.restorePrepared(JSON.parse(JSON.stringify(pending)) as PreparedSettlement);
  const committed = await adopted.commit(staged, { txid: 'transfer-receipt' });
  await adopted.commit(staged, { txid: 'duplicate-must-not-append' });
  assert.equal(committed.state.revision, 3);
  assert.equal(adopted.snapshot().receipts.length, 3);
  assert.equal(adopted.snapshot().wallets.bob.balances.BTC, 0);
  assert.equal(adopted.snapshot().wallets.bob.pending.BTC, 300);
  await assert.rejects(adopted.commit({ ...staged, boundary: { ...staged.boundary, destination: 'tampered' } }, {}), /different payload/);
});

test('checkpoint restoration rejects changed roots and altered encrypted records', { timeout: 180_000 }, async () => {
  const protocol = await createProtocol();
  const shield = await protocol.prepareShield('alice', 'DEMO', 50);
  await protocol.commit(shield, { txid: 'receipt' });
  const base = JSON.parse(JSON.stringify(protocol.exportState())) as ProtocolCheckpoint;
  const badRoot = structuredClone(base); badRoot.state.noteRoot = '1';
  await assert.rejects(createProtocol({ checkpoint: badRoot }), /root mismatch/);
  const badRecord = structuredClone(base); badRecord.encryptedLog[0].ciphertext[2] = (BigInt(badRecord.encryptedLog[0].ciphertext[2]) + 1n).toString();
  await assert.rejects(createProtocol({ checkpoint: badRecord }), /record log mismatch/);
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});
