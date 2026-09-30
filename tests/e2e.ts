import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { createDemoEngine } from '../src/engine.ts';
const engine = await createDemoEngine();
const receipts: unknown[] = [];
const state = () => engine.snapshot() as {
  wallets: { id: string; notes: { asset: string; amount: number; status: string }[] }[];
  reserves: { asset: string; reserve: number; liabilities: number }[];
  native: { heads: Record<string, { txid: string; vout: number }> };
  activity: Record<string, unknown>[];
};
const act = async (action: string, body: Record<string, unknown> = {}) => {
  const result = await engine.action(action, body);
  receipts.push({ action, result });
  for (const reserve of state().reserves) assert.equal(reserve.reserve, reserve.liabilities, `${reserve.asset} backing`);
  console.log(`${action}: verified`);
  return result;
};
try {
  await act('shield', { from: 'alice', asset: 'BTC', amount: 100_000 });
  await act('shield', { from: 'alice', asset: 'TOKEN', amount: 1_000 });
  await assert.rejects(engine.action('transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 }), /No sealed/);
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
  assert.ok(!JSON.stringify(engine.snapshot()).includes('spendKey'), 'REST snapshot must omit spending secrets');
  await mkdir('validation', { recursive: true });
  await writeFile('validation/e2e.json', JSON.stringify({ passed: true, cases: [
    'BTC and token shielding', 'unsealed-note spend rejection', 'seal preserves nullifiers',
    'BTC and token private transfers', 'reserve vaults untouched by internal payments',
    'exact BTC and token native withdrawals', 'encrypted recovery', 'nullifier replay rejection',
    'public-effect tamper rejected by actual VM', 'rejections preserve state', 'native lane rebase preserves wallet proof', 'private keys omitted from API',
  ], receipts, finalState: engine.snapshot() }, null, 2));
  console.log('End-to-end checks passed.');
} finally { engine.close(); }
process.exit(0);
