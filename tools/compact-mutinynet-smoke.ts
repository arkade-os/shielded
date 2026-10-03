import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { base64, hex } from '@scure/base';
import { Extension, RestIndexerProvider, Transaction } from '@arkade-os/sdk';
import { encodeCompactPacket, extractCompactPacket } from '../src/compact/adapter.ts';

const base = process.env.SHIELDED_SMOKE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SHIELDED_API_TOKEN;
const prefix = process.env.SHIELDED_SMOKE_KEY_PREFIX ?? 'compact-mutinynet-v1';
const fundFromFaucet = process.argv.includes('--fund-from-faucet');
const boardConfirmed = process.argv.includes('--board-confirmed');
assert.ok(token && token.length >= 32, 'SHIELDED_API_TOKEN is required');
assert.match(prefix, /^[A-Za-z0-9._:-]{1,90}$/);
const indexer = new RestIndexerProvider('https://mutinynet.arkade.sh');

async function api(path: string, body?: object, key?: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': key! } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
  const result = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, `${path}: ${result.error ?? response.statusText}`);
  return result;
}

async function state() { return api('/api/state'); }
async function action(name: string, suffix: string, body: object = {}) {
  return api(`/api/actions/${name}`, body, `${prefix}-${suffix}`);
}

async function main() {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  let current = await state();
  assert.equal(current.status.network, 'mutinynet');
  assert.equal(current.status.proofTransport, 'compact');
  assert.equal(current.native.operator.arkUrl, 'https://mutinynet.arkade.sh');
  assert.ok(BigInt(current.native.operator.effectiveMaxTxWeight) <= 4_000n);
  if (!current.native.ready) {
    await action('sync', `funding-sync-${Date.now()}`);
    current = await state();
    if (boardConfirmed && Number(current.native.funding.availableSats) < Number(current.native.funding.requiredSats)) {
      assert.ok(Number(current.native.funding.boarding.confirmed) > 0, 'Confirmed on-chain boarding funds are required');
      current = (await action('board', 'board-confirmed')).state;
    }
    if (Number(current.native.funding.availableSats) < Number(current.native.funding.requiredSats)) {
      assert.ok(fundFromFaucet, 'Fund the displayed Mutinynet Ark address, or explicitly use --fund-from-faucet');
      assert.equal(current.native.phase, 'funding-required', 'Automatic faucet funding is only for a fresh wallet');
      const address = current.native.funding.arkAddress;
      assert.ok(typeof address === 'string' && address.startsWith('tark'));
      const funded = await fetch('https://faucet.mutinynet.arkade.sh/faucet', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, amount: 300_000 }),
        signal: AbortSignal.timeout(180_000) });
      assert.ok(funded.ok, `Mutinynet faucet failed: HTTP ${funded.status}`);
      for (let attempt = 0; attempt < 30; attempt++) {
        current = (await action('sync', `sync-${Date.now()}-${attempt}`)).state;
        if (Number(current.native.funding.availableSats) >= Number(current.native.funding.requiredSats)) break;
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    }
    current = (await action('bootstrap', 'bootstrap')).state;
  }
  assert.equal(current.status.ready, true);
  assert.match(current.status.profileId, /^[0-9a-f]{64}$/);
  const profileId = current.status.profileId;
  const initialHeadTxids = [...new Set(Object.values(current.native.heads as Record<string, { txid: string }>).map(head => head.txid))];
  const steps = [
    ['shield', 'btc-shield', { from: 'alice', asset: 'BTC', amount: 100_000 }],
    ['seal', 'btc-seal-1', {}],
    ['transfer', 'btc-transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 }],
    ['seal', 'btc-seal-2', {}],
    ['withdraw', 'btc-withdraw', { from: 'bob', asset: 'BTC', amount: 10_000 }],
    ['shield', 'token-shield', { from: 'alice', asset: 'DEMO', amount: 10_000 }],
    ['seal', 'token-seal-1', {}],
    ['transfer', 'token-transfer', { from: 'alice', to: 'bob', asset: 'DEMO', amount: 2_500 }],
    ['seal', 'token-seal-2', {}],
    ['withdraw', 'token-withdraw', { from: 'bob', asset: 'DEMO', amount: 1_000 }],
  ] as const;
  const measurements: Record<string, unknown>[] = [];
  for (const [name, suffix, body] of steps) {
    const payload = await action(name, suffix, body);
    const receipt = payload.result;
    assert.equal(receipt.network, 'mutinynet');
    assert.equal(receipt.finality, 'operator-preconfirmed');
    assert.equal(payload.state.status.profileId, profileId);
    assert.ok(receipt.nativeWeight > 0 && receipt.nativeWeight <= 4_000);
    assert.ok(receipt.checkpointWeights.length > 0 && receipt.checkpointWeights.every((weight: number) => weight > 0 && weight <= 4_000));
    const tx = Transaction.fromPSBT(base64.decode(receipt.signedArkTx));
    assert.equal(tx.id, receipt.txid);
    const packet = extractCompactPacket(tx);
    assert.ok(packet);
    assert.equal(encodeCompactPacket(packet).length, 133);
    assert.equal(hex.encode(packet.profileId), profileId);
    assert.ok(Extension.fromTx(tx).getPackets().every(packet => packet.type() === 0 || packet.type() === 0x84));
    const { txs } = await indexer.getVirtualTxs([tx.id]);
    const indexed = txs.map(raw => Transaction.fromRaw(hex.decode(raw))).find(raw => raw.id === tx.id);
    assert.ok(indexed, 'Accepted live transaction must have indexed raw ancestry');
    assert.deepEqual(indexed.unsignedTx, tx.unsignedTx);
    const effects = Array.from({ length: tx.outputsLength }, (_, vout) => ({ txid: tx.id, vout }))
      .filter(({ vout }) => (tx.getOutput(vout).amount ?? 0n) > 0n);
    if (payload.state.activity.at(-1)?.txid === tx.id) {
      const { vtxos } = await indexer.getVtxos({ outpoints: effects });
      assert.ok(effects.every(({ vout }) => vtxos.some(coin => coin.txid === tx.id && coin.vout === vout &&
        !coin.isSpent && !coin.isSwept && !coin.isUnrolled && coin.value === Number(tx.getOutput(vout).amount) &&
        coin.script === hex.encode(tx.getOutput(vout).script!))), 'Every latest live output must be accepted and unspent');
    }
    const checkpoints = receipt.signedCheckpoints.map((entry: string) => Transaction.fromPSBT(base64.decode(entry)));
    const { txs: checkpointRaws } = await indexer.getVirtualTxs(checkpoints.map((entry: Transaction) => entry.id));
    assert.ok(checkpoints.every((checkpoint: Transaction) => checkpointRaws.some(raw => Transaction.fromRaw(hex.decode(raw)).id === checkpoint.id)));
    assert.equal(Object.hasOwn(payload.state.activity.find((entry: Record<string, unknown>) => entry.txid === tx.id), 'proof'), false);
    const count = payload.state.activity.length;
    const duplicate = await action(name, suffix, body);
    assert.deepEqual(duplicate.result, receipt);
    assert.equal(duplicate.state.activity.length, count);
    measurements.push({ action: name, asset: 'asset' in body ? body.asset : undefined, txid: tx.id,
      proofBytes: receipt.proofBytes, nativeWeight: receipt.nativeWeight, checkpointWeights: receipt.checkpointWeights,
      checkpointTxids: checkpoints.map((entry: Transaction) => entry.id), indexed: true });
    console.log(`${suffix}: ${tx.id} (${receipt.nativeWeight} WU)`);
  }
  const final = await state();
  assert.equal(final.status.ready, true);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'bob').publicBalance.BTC, 10_000);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'bob').publicBalance.TOKEN, 1_000);
  await mkdir('validation', { recursive: true });
  await writeFile('validation/compact-mutinynet.json', `${JSON.stringify({ verifiedAt: new Date().toISOString(), network: 'mutinynet',
    proofTransport: 'compact', profileId, budgetWu: 4_000, fundedMutinynet: true, initialHeadTxids, measurements,
    finality: 'Arkd accepted and indexer confirmed; Bitcoin confirmation and unilateral pool exit are not tested',
    idempotencyVerified: true }, null, 2)}\n`);
  console.log('Funded Mutinynet compact BTC and DEMO lifecycles passed. Preserve the encrypted volume and exact validator revision.');
}

await main();
