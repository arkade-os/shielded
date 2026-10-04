import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { base64, hex } from '@scure/base';
import { Extension, RestIndexerProvider, Transaction } from '@arkade-os/sdk';
import { encodeCompactPacket, extractCompactPacket } from '../src/compact/adapter.ts';
import { digest, financialState } from './compact-mutinynet-evidence.ts';

const base = process.env.SHIELDED_SMOKE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SHIELDED_API_TOKEN;
const prefix = process.env.SHIELDED_SMOKE_KEY_PREFIX ?? 'compact-mutinynet-v1';
const progressPath = '.recovery/compact-live/compact-mutinynet-progress.jsonl';
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

async function recordProgress(event: string, details: Record<string, unknown> = {}) {
  await mkdir(dirname(progressPath), { recursive: true });
  const file = await open(progressPath, 'a');
  try {
    await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
    await file.sync();
  } finally { await file.close(); }
}

async function rejected(path: string, options: RequestInit, expected: number) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${path}: expected HTTP ${expected}, got ${response.status}`);
  return body as Record<string, any>;
}

function privateBalance(wallet: Record<string, any>, asset: 'BTC' | 'TOKEN'): number {
  return wallet.notes.filter((note: Record<string, any>) => note.asset === asset && !/spent|consumed/i.test(note.status))
    .reduce((total: number, note: Record<string, any>) => total + Number(note.amount), 0);
}

async function negativeScenarios(asset: 'BTC' | 'DEMO', amount: number, stage: 'unsealed' | 'sealed') {
  const before = await state();
  const invariant = financialState(before);
  const key = `${prefix}-negative-${asset.toLowerCase()}-${stage}`;
  const verified = async (scenario: string) => recordProgress('negative-verified', { scenario, asset, stage,
    profileId: before.status.profileId, financialStateSha256: digest(invariant) });
  const check = async (suffix: string, actionName: string, body: object) => {
    const result = await rejected(`/api/actions/${actionName}`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `${key}-${suffix}`,
    }, body: JSON.stringify(body) }, 422);
    assert.ok(typeof result.error === 'string' && result.error.length > 0, `${suffix} must return a useful rejection`);
    assert.equal(financialState(await state()), invariant, `${suffix} changed financial state`);
    await verified(suffix);
  };
  if (stage === 'unsealed') await check('unsealed-spend', 'transfer', { from: 'alice', to: 'bob', asset, amount: Math.min(amount, 1_000) });
  await check('invalid-asset', 'shield', { from: 'alice', asset: 'NOT-REGISTERED', amount: 1 });
  await check('invalid-owner', 'shield', { from: 'mallory', asset, amount: 1 });
  await check('invalid-amount', 'shield', { from: 'alice', asset, amount: 0 });
  await check('same-party', 'transfer', { from: 'alice', to: 'alice', asset, amount: 1 });
  if (stage === 'sealed') await check('overspend', 'transfer', { from: 'alice', to: 'bob', asset, amount: amount + 1 });

  const missingKey = await rejected('/api/actions/seal', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: '{}' }, 400);
  assert.match(String(missingKey.error), /Idempotency-Key/);
  assert.equal(financialState(await state()), invariant, 'missing-key request changed financial state');
  await verified('missing-idempotency-key');

  const acceptedKey = `${prefix}-${asset === 'BTC' ? 'btc-shield' : 'token-shield'}`;
  const conflict = await rejected('/api/actions/shield', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': acceptedKey,
  }, body: JSON.stringify({ from: 'alice', asset, amount: 1 }) }, 422);
  assert.match(String(conflict.error), /already used for a different action body/i);
  assert.equal(financialState(await state()), invariant, 'conflicting body against an accepted key changed financial state');
  await verified('conflicting-body-on-accepted-key');

  const invalidKey = await rejected('/api/actions/seal', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'bad key',
  }, body: '{}' }, 400);
  assert.match(String(invalidKey.error), /Invalid Idempotency-Key/);
  assert.equal(financialState(await state()), invariant, 'invalid idempotency key changed financial state');
  await verified('invalid-idempotency-key');
  const malformed = await rejected('/api/actions/seal', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `${key}-malformed`,
  }, body: '{' }, 400);
  assert.match(String(malformed.error), /Malformed JSON/);
  assert.equal(financialState(await state()), invariant, 'malformed JSON changed financial state');
  await verified('malformed-json');
  for (const disabled of ['replay', 'tamper', 'rebase']) {
    const result = await rejected(`/api/actions/${disabled}`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `${key}-disabled-${disabled}`,
    }, body: '{}' }, 403);
    assert.match(String(result.error), /disabled/i);
    assert.equal(financialState(await state()), invariant, `${disabled} changed financial state`);
    await verified(`disabled-${disabled}`);
  }
}

async function main() {
  assert.equal(existsSync('validation/compact-mutinynet.json'), false,
    'Refusing to overwrite existing fresh-run evidence; archive it before a new funded lifecycle');
  assert.equal(existsSync(progressPath), false,
    'A previous partial-run journal exists; inspect it and do not rerun financial steps automatically');
  const initialFinancialState = financialState(await state());
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401);
  await rejected('/api/actions/reset', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', 'idempotency-key': `${prefix}-disabled-reset` }, body: '{}' }, 403);
  let current = await state();
  assert.equal(financialState(current), initialFinancialState, 'authentication or disabled-action probes changed financial state');
  assert.equal(String(current.status.network).toLowerCase(), 'mutinynet');
  assert.equal(current.status.proofTransport, 'compact');
  assert.equal(current.native.operator.arkUrl, 'https://mutinynet.arkade.sh');
  assert.ok(BigInt(current.native.operator.effectiveMaxTxWeight) <= 4_000n);
  if (!current.native.ready) {
    await recordProgress('sync-started', { phase: current.native.phase });
    await action('sync', `funding-sync-${Date.now()}`);
    current = await state();
    await recordProgress('sync-completed', { phase: current.native.phase, availableSats: current.native.funding.availableSats,
      requiredSats: current.native.funding.requiredSats });
    if (boardConfirmed && Number(current.native.funding.availableSats) < Number(current.native.funding.requiredSats)) {
      assert.ok(Number(current.native.funding.boarding.confirmed) > 0, 'Confirmed on-chain boarding funds are required');
      await recordProgress('boarding-started', { confirmedSats: current.native.funding.boarding.confirmed });
      current = (await action('board', 'board-confirmed')).state;
      await recordProgress('boarding-response', { phase: current.native.phase,
        availableSats: current.native.funding.availableSats });
    }
    if (Number(current.native.funding.availableSats) < Number(current.native.funding.requiredSats)) {
      assert.ok(fundFromFaucet, 'Fund the displayed Mutinynet Ark address, or explicitly use --fund-from-faucet');
      assert.equal(current.native.phase, 'funding-required', 'Automatic faucet funding is only for a fresh wallet');
      const address = current.native.funding.arkAddress;
      assert.ok(typeof address === 'string' && address.startsWith('tark'));
      await recordProgress('faucet-request-started', { amountSats: 300_000 });
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
    await recordProgress('bootstrap-started', { phase: current.native.phase, profileId: current.status.profileId });
    current = (await action('bootstrap', 'bootstrap')).state;
    await recordProgress('bootstrap-completed', { phase: current.native.phase, profileId: current.status.profileId,
      heads: Object.fromEntries(Object.entries(current.native.heads as Record<string, { txid: string }>).map(([name, head]) => [name, head.txid])) });
  }
  assert.equal(current.status.ready, true);
  assert.equal(current.activity.length, 0, 'positive smoke requires a pristine post-bootstrap pool; restart/partial runs must use compact-mutinynet-scenarios.ts only after a complete fresh report exists');
  assert.ok(current.wallets.every((wallet: any) => wallet.notes.length === 0), 'positive smoke refuses a pool with prior private notes');
  assert.ok(current.reserves.every((entry: any) => Number(entry.reserve) === 0 && Number(entry.liabilities) === 0),
    'positive smoke refuses a pool with prior liabilities');
  assert.match(current.status.profileId, /^[0-9a-f]{64}$/);
  const profileId = current.status.profileId;
  const initialHeadTxids = [...new Set(Object.values(current.native.heads as Record<string, { txid: string }>).map(head => head.txid))];
  await recordProgress('fresh-pool-confirmed', { profileId, initialHeadTxids,
    financialStateSha256: digest(financialState(current)) });
  const steps = [
    ['shield', 'btc-shield', { from: 'alice', asset: 'BTC', amount: 100_000 }],
    ['negative', 'btc-unsealed', { asset: 'BTC', amount: 100_000, stage: 'unsealed' }],
    ['seal', 'btc-seal-1', {}],
    ['negative', 'btc-sealed', { asset: 'BTC', amount: 100_000, stage: 'sealed' }],
    ['transfer', 'btc-transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 }],
    ['seal', 'btc-seal-2', {}],
    ['withdraw', 'btc-withdraw', { from: 'bob', asset: 'BTC', amount: 10_000 }],
    ['shield', 'token-shield', { from: 'alice', asset: 'DEMO', amount: 10_000 }],
    ['negative', 'token-unsealed', { asset: 'DEMO', amount: 10_000, stage: 'unsealed' }],
    ['seal', 'token-seal-1', {}],
    ['negative', 'token-sealed', { asset: 'DEMO', amount: 10_000, stage: 'sealed' }],
    ['transfer', 'token-transfer', { from: 'alice', to: 'bob', asset: 'DEMO', amount: 2_500 }],
    ['seal', 'token-seal-2', {}],
    ['withdraw', 'token-withdraw', { from: 'bob', asset: 'DEMO', amount: 1_000 }],
    ['shield', 'bob-btc-shield', { from: 'bob', asset: 'BTC', amount: 1_000 }],
    ['seal', 'bob-btc-seal-1', {}],
    ['transfer', 'bob-btc-transfer', { from: 'bob', to: 'alice', asset: 'BTC', amount: 1_000 }],
    ['seal', 'bob-btc-seal-2', {}],
    ['withdraw', 'alice-btc-withdraw', { from: 'alice', asset: 'BTC', amount: 1_000 }],
    ['shield', 'bob-token-shield', { from: 'bob', asset: 'DEMO', amount: 100 }],
    ['seal', 'bob-token-seal-1', {}],
    ['transfer', 'bob-token-transfer', { from: 'bob', to: 'alice', asset: 'DEMO', amount: 100 }],
    ['seal', 'bob-token-seal-2', {}],
    ['withdraw', 'alice-token-withdraw', { from: 'alice', asset: 'DEMO', amount: 100 }],
  ] as const;
  const measurements: Record<string, unknown>[] = [];
  for (const [name, suffix, body] of steps) {
    if (name === 'negative') {
      const scenario = body as { asset: 'BTC' | 'DEMO'; amount: number; stage: 'unsealed' | 'sealed' };
      await negativeScenarios(scenario.asset, scenario.amount, scenario.stage);
      continue;
    }
    await recordProgress('positive-action-started', { action: name, suffix, profileId });
    const payload = await action(name, suffix, body);
    const receipt = payload.result;
    const checkpoints = receipt.signedCheckpoints.map((entry: string) => Transaction.fromPSBT(base64.decode(entry)));
    await recordProgress('positive-response-received', { action: name, suffix, profileId, txid: receipt.txid,
      receiptSha256: digest(JSON.stringify(receipt)), nativeWeight: receipt.nativeWeight,
      checkpointWeights: receipt.checkpointWeights, checkpointTxids: checkpoints.map((entry: Transaction) => entry.id) });
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
    const indexed = txs.map(raw => Transaction.fromPSBT(base64.decode(raw))).find(raw => raw.id === tx.id);
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
    const { txs: checkpointRaws } = await indexer.getVirtualTxs(checkpoints.map((entry: Transaction) => entry.id));
    assert.ok(checkpoints.every((checkpoint: Transaction) => checkpointRaws.some(raw => Transaction.fromPSBT(base64.decode(raw)).id === checkpoint.id)));
    assert.equal(Object.hasOwn(payload.state.activity.find((entry: Record<string, unknown>) => entry.txid === tx.id), 'proof'), false);
    const count = payload.state.activity.length;
    const duplicate = await action(name, suffix, body);
    assert.deepEqual(duplicate.result, receipt);
    assert.equal(duplicate.state.activity.length, count);
    measurements.push({ action: name, suffix, body, resultSha256: await digest(JSON.stringify(receipt)), txid: tx.id,
      proofBytes: receipt.proofBytes, nativeWeight: receipt.nativeWeight, checkpointWeights: receipt.checkpointWeights,
      checkpointTxids: checkpoints.map((entry: Transaction) => entry.id), indexed: true });
    await recordProgress('positive-action-verified', { action: name, suffix, profileId, txid: tx.id,
      nativeWeight: receipt.nativeWeight, checkpointWeights: receipt.checkpointWeights });
    console.log(`${suffix}: ${tx.id} (${receipt.nativeWeight} WU)`);
  }
  const final = await state();
  assert.equal(final.status.ready, true);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'bob').publicBalance.BTC, 10_000);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'bob').publicBalance.TOKEN, 1_000);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'alice').publicBalance.BTC, 1_000);
  assert.equal(final.wallets.find((wallet: any) => wallet.id === 'alice').publicBalance.TOKEN, 100);
  const alice = final.wallets.find((wallet: any) => wallet.id === 'alice');
  const bob = final.wallets.find((wallet: any) => wallet.id === 'bob');
  assert.equal(privateBalance(alice, 'BTC'), 75_000);
  assert.equal(privateBalance(alice, 'TOKEN'), 7_500);
  assert.equal(privateBalance(bob, 'BTC'), 15_000);
  assert.equal(privateBalance(bob, 'TOKEN'), 1_500);
  assert.equal(final.reserves.find((entry: any) => entry.asset === 'BTC')?.reserve, 90_000);
  assert.equal(final.reserves.find((entry: any) => entry.asset === 'TOKEN')?.reserve, 9_000);
  const result = { verifiedAt: new Date().toISOString(), network: 'mutinynet', proofTransport: 'compact', profileId,
    budgetWu: 4_000, fundedMutinynet: true, idempotencyKeyPrefix: prefix, initialHeadTxids, measurements,
    finality: 'Arkd accepted and indexer confirmed; Bitcoin confirmation and unilateral pool exit are not tested',
    idempotencyVerified: true, negativeScenariosVerified: true,
    parties: ['Alice', 'Bob'], assets: ['BTC', 'DEMO'], shieldFunding: 'treasury-backed; native payout projection is cumulative and transfers do not debit prior withdrawals',
    finalFinancialStateSha256: await digest(financialState(final)),
    finalActivityCount: final.activity.length, finalActivityTxids: final.activity.map((item: Record<string, unknown>) => item.txid).filter(Boolean),
    publicPayoutProjection: Object.fromEntries(final.wallets.map((wallet: Record<string, any>) => [wallet.id, wallet.publicBalance])),
    privateNoteBalances: Object.fromEntries(final.wallets.map((wallet: Record<string, any>) => [wallet.id,
      { BTC: privateBalance(wallet, 'BTC'), DEMO: privateBalance(wallet, 'TOKEN') }])) };
  await mkdir('validation', { recursive: true });
  await writeFile('validation/compact-mutinynet.json', `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  await recordProgress('fresh-run-completed', { profileId, finalFinancialStateSha256: result.finalFinancialStateSha256,
    acceptedActions: measurements.length });
  console.log('Funded Mutinynet compact BTC and DEMO lifecycles passed. Preserve the encrypted volume and exact validator revision.');
}

await main();
