import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `shielded-deploy-smoke-${suffix}`;
const volume = `${name}-data`;
const image = `${name}:test`;
const token = randomBytes(32).toString('base64url');
let hostPort = Number(process.env.SHIELDED_SMOKE_PORT ?? 0);
const proofTransport = process.env.SHIELDED_SMOKE_TRANSPORT ?? 'inline';
if (proofTransport !== 'inline' && proofTransport !== 'compact') throw new Error('SHIELDED_SMOKE_TRANSPORT must be inline or compact');
const compactMeasurements: { action: string; proofBytes: number; nativeWeight: number; checkpointWeights: number[] }[] = [];

function command(args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output = (output + chunk).slice(-20_000); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output = (output + chunk).slice(-20_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 || allowFailure ? resolve(output.trim()) : reject(new Error(`docker ${args[0]} exited ${code}:\n${output}`)));
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitReady(base: string, container: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (health.ok) {
        const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2_000) });
        if (ready.ok) return;
      }
    } catch { /* startup is still in progress */ }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const logs = await command(['logs', container], true);
  throw new Error(`Container did not become ready.\n${logs}`);
}

async function waitHealthy(container: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command(['inspect', '--format', '{{.State.Health.Status}}', container], true) === 'healthy') return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Docker HEALTHCHECK did not pass for ${container}`);
}

async function api(base: string, path: string, options: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(180_000) });
}

const action = async (base: string, name: string, key: string, body: object) => {
  const response = await api(base, `/api/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  const payload = await response.json() as { state?: Record<string, any>; result?: unknown; error?: string };
  assert.equal(response.status, 200, `${name}: ${payload.error ?? response.statusText}`);
  if (proofTransport === 'compact' && payload.result && !(payload.result as { rejected?: unknown }).rejected) {
    const receipt = payload.result as { proofBytes?: unknown; nativeWeight?: unknown; checkpointWeights?: unknown };
    assert.equal(payload.state?.status?.proofTransport, 'compact');
    assert.ok(typeof payload.state?.status?.profileId === 'string' && payload.state.status.profileId.length > 0,
      'compact smoke requires an actual registered local profile');
    assert.ok(Number.isSafeInteger(receipt.proofBytes) && Number(receipt.proofBytes) > 0,
      'compact receipt must report real offchain proof bytes');
    assert.ok(Number.isSafeInteger(receipt.nativeWeight) && Number(receipt.nativeWeight) > 0,
      'compact receipt must report measured native transaction weight');
    assert.ok(Number(receipt.nativeWeight) <= 4_000, `compact publication exceeds the 4,000 WU budget: ${receipt.nativeWeight}`);
    assert.ok(Array.isArray(receipt.checkpointWeights) && receipt.checkpointWeights.every((weight) =>
      Number.isSafeInteger(weight) && Number(weight) > 0 && Number(weight) <= 4_000),
    `compact checkpoint transaction exceeds the 4,000 WU budget: ${JSON.stringify(receipt.checkpointWeights)}`);
    const latestActivity = payload.state?.activity?.at(-1);
    assert.equal(Object.hasOwn(latestActivity ?? {}, 'proof'), false, 'offchain proofs must not be returned in public activity records');
    compactMeasurements.push({ action: name, proofBytes: Number(receipt.proofBytes), nativeWeight: Number(receipt.nativeWeight),
      checkpointWeights: receipt.checkpointWeights.map(Number) });
  }
  return payload;
};

async function currentState(base: string) {
  const response = await api(base, '/api/state');
  assert.equal(response.status, 200);
  return await response.json() as Record<string, any>;
}

function durableView(state: Record<string, any>) {
  return {
    wallets: state.wallets.map((wallet: Record<string, any>) => ({ id: wallet.id, address: wallet.address, notes: wallet.notes, publicBalance: wallet.publicBalance })),
    reserves: state.reserves, epoch: state.epoch, lanes: state.lanes, activity: state.activity,
    native: state.native, persistence: state.status.persistence,
  };
}

let created = false;
try {
  hostPort ||= await unusedPort();
  await command(['build', '--tag', image, '.']);
  await command(['volume', 'create', volume]);
  const base = `http://127.0.0.1:${hostPort}`;
  await command(['run', '--detach', '--name', name, '--read-only', '--user', 'node', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--stop-timeout', '120', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777', '--publish', `127.0.0.1:${hostPort}:8787`,
    '--mount', `type=volume,source=${volume},target=/data`, '--env', 'NODE_ENV=production', '--env', 'HOST=0.0.0.0', '--env', 'PORT=8787',
    '--env', 'SHIELDED_NETWORK=local-emulator', '--env', `SHIELDED_PROOF_TRANSPORT=${proofTransport}`,
    '--env', 'SHIELDED_DATA_DIR=/data', '--env', `SHIELDED_API_TOKEN=${token}`, image]);
  created = true;
  await waitReady(base, name);
  await waitHealthy(name);
  assert.equal((await fetch(`${base}/api/state`)).status, 401, 'private API must reject requests without a token');
  const initial = await currentState(base);
  assert.equal(initial.status.persistence, true);
  assert.equal(initial.status.proofTransport, proofTransport);

  const shield = await action(base, 'shield', 'smoke-shield-1', { from: 'alice', asset: 'BTC', amount: 100_000 });
  const duplicate = await action(base, 'shield', 'smoke-shield-1', { from: 'alice', asset: 'BTC', amount: 100_000 });
  assert.deepEqual(duplicate.result, shield.result, 'repeated request must return its original result');
  assert.equal(duplicate.state?.activity?.length, shield.state?.activity?.length, 'repeated request must not append activity');
  await action(base, 'seal', 'smoke-seal-1', {});
  await action(base, 'transfer', 'smoke-transfer-1', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25_000 });
  await action(base, 'seal', 'smoke-seal-2', {});
  if (proofTransport === 'compact') {
    const replay = await action(base, 'replay', 'smoke-replay-1', { from: 'alice' });
    assert.equal((replay.result as { rejected?: boolean }).rejected, true, 'compact replay must hit the spent-nullifier guard');
    const tamper = await action(base, 'tamper', 'smoke-tamper-1', { from: 'alice', to: 'bob', asset: 'BTC', amount: 1_000 });
    assert.equal((tamper.result as { rejected?: boolean }).rejected, true, 'registered compact verifier must reject a modified public signal');
    assert.equal(tamper.state?.status?.profileId, initial.status.profileId, 'a failed proof must not change the verifier profile');
  }
  await action(base, 'withdraw', 'smoke-withdraw-1', { from: 'alice', asset: 'BTC', amount: 5_000 });
  const beforeRestart = durableView(await currentState(base));

  await command(['restart', name]);
  await waitReady(base, name);
  await waitHealthy(name);
  const afterRestart = await currentState(base);
  assert.equal(afterRestart.status.proofTransport, proofTransport);
  if (proofTransport === 'compact') assert.equal(afterRestart.status.profileId, beforeRestart.native?.profileId ?? afterRestart.status.profileId);
  assert.deepEqual(durableView(afterRestart), beforeRestart, 'encrypted persistent state must survive container restart');
  assert.equal(afterRestart.wallets.find((wallet: Record<string, any>) => wallet.id === 'alice').notes.some((note: Record<string, any>) => note.status === 'spent'), true);
  const replayedShield = await action(base, 'shield', 'smoke-shield-1', { from: 'alice', asset: 'BTC', amount: 100_000 });
  assert.deepEqual(replayedShield.result, shield.result, 'persisted idempotency key must return the original receipt after restart');
  assert.deepEqual(durableView(replayedShield.state!), beforeRestart, 'replayed request must not add a transaction after restart');
  if (proofTransport === 'compact') {
    await mkdir('validation', { recursive: true });
    await writeFile('validation/compact-deployment.json', `${JSON.stringify({ network: 'local-emulator', proofTransport,
      profileId: afterRestart.status.profileId, budgetWu: 4_000, measurements: compactMeasurements,
      offchainProofsExcludedFromActivity: true, tamperedSignalRejected: true, replayRejected: true,
      fundedMutinynet: false, finality: 'synthetic local compact fixture; no Arkade or Bitcoin settlement' }, null, 2)}\n`);
  }
  console.log(`Container smoke passed: auth, ${proofTransport === 'compact' ? 'offchain proof + compact publication' : 'proof/VM'} shield→seal→transfer→seal→withdraw, idempotency, and encrypted-volume recovery.`);
} catch (error) {
  if (created) console.error(await command(['logs', name], true));
  throw error;
} finally {
  if (created) await command(['rm', '--force', name], true);
  await command(['volume', 'rm', '--force', volume], true);
  await command(['image', 'rm', '--force', image], true);
}
