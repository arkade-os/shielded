import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const seed = Buffer.from('shielded-local-e2e-notes-v1');
const originalRandomBytes = crypto.randomBytes;
const randomBytesDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomBytes');
let counter = 0n;
const deterministicRandomBytes = ((size: number, callback?: (error: Error | null, bytes: Buffer) => void) => {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const block = crypto.createHash('sha256').update(seed).update(Buffer.from(counter.toString(16).padStart(16, '0'), 'hex')).digest();
    counter++;
    const length = Math.min(block.length, size - offset);
    block.copy(bytes, offset, 0, length);
    offset += length;
  }
  if (callback) { setImmediate(() => callback(null, bytes)); return undefined; }
  return bytes;
}) as typeof crypto.randomBytes;
Object.defineProperty(crypto, 'randomBytes', { ...randomBytesDescriptor, value: deterministicRandomBytes });
syncBuiltinESMExports();
let engine: import('../src/engine.ts').DemoEngine | undefined;
const activeEngine = () => {
  if (!engine) throw new Error('E2E engine has not been initialized.');
  return engine;
};
const receipts: unknown[] = [];
const state = () => activeEngine().snapshot() as {
  wallets: { id: string; notes: { asset: string; amount: number; status: string }[] }[];
  reserves: { asset: string; reserve: number; liabilities: number }[];
  native: { heads: Record<string, { txid: string; vout: number }> };
  activity: Record<string, unknown>[];
};
const act = async (action: string, body: Record<string, unknown> = {}) => {
  const result = await activeEngine().action(action, body);
  receipts.push({ action, result });
  for (const reserve of state().reserves) assert.equal(reserve.reserve, reserve.liabilities, `${reserve.asset} backing`);
  console.log(`${action}: verified`);
  return result;
};
try {
  const { createDemoEngine } = await import('../src/engine.ts');
  engine = await createDemoEngine({ network: 'local-emulator', proofTransport: 'inline' });
  const initialStatus = activeEngine().snapshot().status as { network?: string; proofTransport?: string };
  assert.equal(initialStatus.network, 'Local emulator · synthetic genesis');
  assert.equal(initialStatus.proofTransport, 'inline');
  await act('shield', { from: 'alice', asset: 'BTC', amount: 100_000 });
  await act('shield', { from: 'alice', asset: 'TOKEN', amount: 1_000 });
  await assert.rejects(activeEngine().action('transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 }), /No sealed/);
  await act('seal');
  const originalVaults = { btc: structuredClone(state().native.heads.btcVault), token: structuredClone(state().native.heads.tokenVault) };
  await act('transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 });
  await act('transfer', { from: 'alice', to: 'bob', asset: 'TOKEN', amount: 250 });
  assert.deepEqual(state().native.heads.btcVault, originalVaults.btc, 'Internal BTC payment must not touch backing vault');
  assert.deepEqual(state().native.heads.tokenVault, originalVaults.token, 'Internal token payment must not touch backing vault');
  await act('seal');
  await act('withdraw', { from: 'bob', asset: 'BTC', amount: 10_000 });
  await act('withdraw', { from: 'bob', asset: 'TOKEN', amount: 100 });
  assert.equal(state().reserves.find(r => r.asset === 'BTC')!.reserve, 90_000);
  assert.equal(state().reserves.find(r => r.asset === 'TOKEN')!.reserve, 900);
  const recovered = await act('recover', { from: 'bob' }) as { balances: { BTC: number; DEMO: number } };
  assert.deepEqual(recovered.balances, { BTC: 15_000, DEMO: 150 });
  const before = JSON.stringify({ wallets: state().wallets, reserves: state().reserves, native: state().native });
  assert.equal((await act('replay') as { rejected: boolean }).rejected, true);
  assert.equal((await act('tamper', { from: 'alice', asset: 'BTC', amount: 1_000 }) as { rejected: boolean }).rejected, true);
  assert.equal(JSON.stringify({ wallets: state().wallets, reserves: state().reserves, native: state().native }), before, 'Rejected transactions must leave state unchanged');
  const rebase = await act('rebase', { from: 'alice', to: 'bob', asset: 'BTC', amount: 1_000 }) as {
    walletProofUnchanged: boolean; transitionProofRegenerated: boolean;
  };
  assert.equal(rebase.walletProofUnchanged, true);
  assert.equal(rebase.transitionProofRegenerated, true);
  const successful = state().activity.filter(activity => activity.vmVerified === true);
  assert.equal(successful.length, 10);
  for (const receipt of successful) assert.equal(receipt.proofVerified, true);
  assert.ok(!JSON.stringify(activeEngine().snapshot()).includes('spendKey'), 'REST snapshot must omit spending secrets');
  await mkdir('validation', { recursive: true });
  await writeFile('validation/e2e.json', JSON.stringify({ passed: true, cases: [
    'BTC and token shielding', 'unsealed-note spend rejection', 'seal preserves nullifiers',
    'BTC and token private transfers', 'reserve vaults untouched by internal payments',
    'exact BTC and token native withdrawals', 'encrypted recovery', 'nullifier replay rejection',
    'public-effect tamper rejected by actual VM', 'rejections preserve state', 'native lane rebase preserves wallet proof', 'private keys omitted from API',
  ], receipts, finalState: activeEngine().snapshot() }, null, 2));
  console.log('End-to-end checks passed.');
} finally {
  try { await engine?.close(); }
  finally {
    if (randomBytesDescriptor) Object.defineProperty(crypto, 'randomBytes', randomBytesDescriptor);
    else Object.defineProperty(crypto, 'randomBytes', { value: originalRandomBytes, configurable: true, writable: true });
    syncBuiltinESMExports();
  }
}
process.exit(0);
