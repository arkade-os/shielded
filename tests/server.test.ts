import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp, loadServerConfig, type ServerConfig } from '../src/server.ts';

const token = 'a sufficiently long test-only deployment token';
const localConfig: ServerConfig = { host: '127.0.0.1', port: 8787, dataDirectory: './data', network: 'local-emulator',
  arkUrl: 'https://mutinynet.arkade.sh', emulatorUrl: 'https://emulator.mutinynet.arkade.sh', apiToken: token };
const mutinynetConfig: ServerConfig = { ...localConfig, network: 'mutinynet' };
const compactMutinynetConfig: ServerConfig = { ...mutinynetConfig, proofTransport: 'compact' };

async function withServer(config: ServerConfig, state: Record<string, unknown>, run: (base: string, calls: unknown[][]) => Promise<void>) {
  const calls: unknown[][] = [];
  const engine = { snapshot: () => structuredClone(state), close() {}, async action(...args: [string, Record<string, unknown>, string?]) { calls.push(args); return { accepted: true }; } };
  const server = createApp({ config, engine }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function login(base: string) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ token }) });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert(setCookie);
  return setCookie.split(';', 1)[0];
}

test('health is public while state and cookie writes require authentication and same origin', async () => {
  await withServer(localConfig, { status: { ready: true }, wallets: [{ id: 'private-wallet' }] }, async base => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { enabled: true, authenticated: false });
    assert.equal((await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' }, body: JSON.stringify({ token }) })).status, 403);
    const cookie = await login(base);
    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json() as { wallets: { id: string }[] }).wallets[0].id, 'private-wallet');
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), { enabled: true, authenticated: true });
    const crossOrigin = await fetch(`${base}/api/actions/seal`, { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await fetch(`${base}/api/session`, { method: 'DELETE', headers: { cookie, origin: base } })).status, 204);
  });
});

test('readyz reflects engine initialization and does not expose snapshot data', async () => {
  await withServer(localConfig, { status: { ready: false }, wallets: [{ note: 'private' }] }, async base => {
    const starting = await fetch(`${base}/readyz`);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), { ready: false, network: 'local-emulator' });
  });
  await withServer(localConfig, { status: { ready: true, reconciliationRequired: true } }, async base => {
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  });
});

test('Mutinynet blocks demo actions, requires idempotency keys, and forwards valid keys', async () => {
  await withServer(mutinynetConfig, { status: { ready: false, fundingRequired: true } }, async (base, calls) => {
    const cookie = await login(base);
    const headers = { cookie, origin: base, 'content-type': 'application/json' };
    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.deepEqual((await state.json() as { status: { allowedActions: string[] } }).status.allowedActions,
      ['bootstrap', 'sync', 'shield', 'seal', 'transfer', 'withdraw', 'recover']);
    assert.equal((await fetch(`${base}/api/actions/reset`, { method: 'POST', headers, body: '{}' })).status, 403);
    const bootstrap = await fetch(`${base}/api/actions/bootstrap`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'bootstrap-123' }, body: '{}' });
    assert.equal(bootstrap.status, 200);
    assert.equal((await fetch(`${base}/api/actions/shield`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/api/actions/shield`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'bad key' }, body: '{}' })).status, 400);
    const accepted = await fetch(`${base}/api/actions/shield`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'deposit-123' }, body: JSON.stringify({ amount: 1000 }) });
    assert.equal(accepted.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['bootstrap', {}, 'bootstrap-123']);
    assert.deepEqual(calls[1], ['shield', { amount: 1000 }, 'deposit-123']);
  });
});

test('compact Mutinynet boarding is authenticated, idempotent, and unavailable on inline deployments', async () => {
  await withServer(compactMutinynetConfig, { status: { ready: false, allowedActions: ['bootstrap', 'sync', 'board'] } }, async (base, calls) => {
    assert.equal((await fetch(`${base}/api/actions/board`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const cookie = await login(base);
    const headers = { cookie, origin: base, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/actions/board`, { method: 'POST', headers, body: '{}' })).status, 400,
      'Mutinynet board must require an idempotency key');
    assert.equal((await fetch(`${base}/api/actions/board`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'board-1' }, body: '{}' })).status, 200);
    assert.deepEqual(calls, [['board', {}, 'board-1']]);
  });
  await withServer(mutinynetConfig, { status: { ready: false } }, async (base) => {
    const cookie = await login(base);
    const response = await fetch(`${base}/api/actions/board`, { method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json', 'idempotency-key': 'board-inline' }, body: '{}' });
    assert.equal(response.status, 403, 'inline Mutinynet deployments must not expose unsupported boarding');
  });
});

test('malformed JSON and invalid request bodies return JSON client errors', async () => {
  await withServer(localConfig, { status: { ready: true } }, async base => {
    const cookie = await login(base);
    const malformed = await fetch(`${base}/api/actions/seal`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json() as { error: string }).error, /Malformed JSON/);
    const primitive = await fetch(`${base}/api/actions/seal`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: 'null' });
    assert.equal(primitive.status, 400);
  });
});

test('non-loopback bind requires a strong API token', () => {
  assert.throws(() => loadServerConfig({ HOST: '127.attacker.example', PORT: '8787', SHIELDED_NETWORK: 'local-emulator' }), /SHIELDED_API_TOKEN/);
  assert.throws(() => loadServerConfig({ HOST: '0.0.0.0', PORT: '8787', SHIELDED_NETWORK: 'local-emulator' }), /SHIELDED_API_TOKEN/);
  assert.equal(loadServerConfig({ HOST: '127.0.0.2', PORT: '8787', SHIELDED_NETWORK: 'local-emulator' }).host, '127.0.0.2');
});

test('persistent engine action policy can remove destructive demo reset', async () => {
  await withServer(localConfig, { status: { ready: true, allowedActions: ['seal'] } }, async (base, calls) => {
    const cookie = await login(base);
    const headers = { cookie, origin: base, 'content-type': 'application/json' };
    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.deepEqual((await state.json() as { status: { allowedActions: string[] } }).status.allowedActions, ['seal']);
    const reset = await fetch(`${base}/api/actions/reset`, { method: 'POST', headers, body: '{}' });
    assert.equal(reset.status, 403);
    assert.equal(calls.length, 0);
  });
});
