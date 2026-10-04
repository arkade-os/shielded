import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { digest, financialState } from './compact-mutinynet-evidence.ts';

const base = process.env.SHIELDED_SMOKE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.SHIELDED_API_TOKEN;
const prefix = process.env.SHIELDED_SMOKE_KEY_PREFIX ?? 'compact-mutinynet-v1';
const freshReportPath = 'validation/compact-mutinynet.json';
const replayReportPath = 'validation/compact-mutinynet-restart-replay.json';
assert.match(prefix, /^[A-Za-z0-9._:-]{1,90}$/);

type Scenario = { action: string; suffix: string; body: Record<string, unknown>; resultSha256: string; txid: string };
async function api(path: string, body?: object, key?: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': key! } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
  const result = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, `${path}: ${result.error ?? response.statusText}`);
  return result;
}

async function main() {
  assert.ok(token && token.length >= 32, 'SHIELDED_API_TOKEN is required');
  assert.equal(existsSync(replayReportPath), false, 'Refusing to overwrite existing restart/replay evidence');
  const baseline = JSON.parse(await readFile(freshReportPath, 'utf8')) as {
    verifiedAt: string; network: string; proofTransport: string; profileId: string; fundedMutinynet: boolean; idempotencyKeyPrefix: string;
    negativeScenariosVerified: boolean; parties: string[]; assets: string[]; measurements: Scenario[];
    finalFinancialStateSha256: string; finalActivityCount: number; finalActivityTxids: string[];
  };
  assert.equal(baseline.network, 'mutinynet');
  assert.equal(baseline.proofTransport, 'compact');
  assert.equal(baseline.fundedMutinynet, true);
  assert.equal(baseline.idempotencyKeyPrefix, prefix, 'Replay keys must use the exact accepted fresh-run prefix');
  assert.equal(baseline.negativeScenariosVerified, true);
  assert.deepEqual(baseline.parties, ['Alice', 'Bob']);
  assert.deepEqual(baseline.assets, ['BTC', 'DEMO']);
  assert.match(baseline.profileId, /^[0-9a-f]{64}$/);
  assert.equal(baseline.measurements.length, 20, 'fresh run must record all 20 positive lifecycle actions');
  assert.ok(baseline.measurements.every((entry) => entry.suffix && entry.body && entry.resultSha256 && entry.txid));
  assert.equal((await fetch(`${base}/api/state`)).status, 401);

  const before = await api('/api/state');
  assert.equal(before.status.ready, true);
  assert.equal(before.status.profileId, baseline.profileId);
  const beforeDigest = digest(financialState(before));
  assert.equal(beforeDigest, baseline.finalFinancialStateSha256, 'service restart changed the saved funded state before replay');
  assert.equal(before.activity.length, baseline.finalActivityCount);
  assert.deepEqual(before.activity.map((item: Record<string, unknown>) => item.txid).filter(Boolean), baseline.finalActivityTxids);

  const replayed: { action: string; suffix: string; txid: string; resultSha256: string }[] = [];
  for (const item of baseline.measurements) {
    const response = await api(`/api/actions/${item.action}`, item.body, `${prefix}-${item.suffix}`);
    assert.equal(response.state.status.profileId, baseline.profileId);
    assert.equal(digest(JSON.stringify(response.result)), item.resultSha256,
      `${item.suffix} did not return the exact previously saved idempotent receipt`);
    assert.equal(response.result.txid, item.txid);
    replayed.push({ action: item.action, suffix: item.suffix, txid: item.txid, resultSha256: item.resultSha256 });
  }

  const after = await api('/api/state');
  const afterDigest = digest(financialState(after));
  assert.equal(afterDigest, beforeDigest, 'replaying accepted request keys changed financial state');
  assert.equal(afterDigest, baseline.finalFinancialStateSha256);
  assert.equal(after.activity.length, baseline.finalActivityCount);
  assert.deepEqual(after.activity.map((item: Record<string, unknown>) => item.txid).filter(Boolean), baseline.finalActivityTxids);

  await mkdir('validation', { recursive: true });
  await writeFile(replayReportPath, `${JSON.stringify({ verifiedAt: new Date().toISOString(), network: 'mutinynet',
    profileId: baseline.profileId, sourceReport: freshReportPath, sourceReportSha256: digest(JSON.stringify(baseline)),
    sameVolumeRestartReplay: true, actionCount: replayed.length, replayed, beforeFinancialStateSha256: beforeDigest,
    afterFinancialStateSha256: afterDigest, activityCount: after.activity.length,
    activityTxids: after.activity.map((item: Record<string, unknown>) => item.txid).filter(Boolean),
    newFinancialActionsDuringReplay: 0 }, null, 2)}\n`);
  console.log(`Restart/replay verification passed for ${replayed.length} saved action receipts.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
