import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp, type ServerConfig } from '../src/server.ts';

const token = 'a sufficiently long test-only deployment token';
const config: ServerConfig = { host: '127.0.0.1', port: 0, dataDirectory: './data', network: 'local-emulator',
  arkUrl: 'https://mutinynet.arkade.sh', emulatorUrl: 'https://emulator.mutinynet.arkade.sh', apiToken: token };

test('server rejects a concurrent action while the first action is pending and accepts one after it settles', async () => {
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>(resolve => { markEntered = resolve; });
  let calls = 0;
  const engine = {
    snapshot: () => ({ status: { ready: true, allowedActions: ['seal'] } }),
    async close() {},
    async action() {
      calls++;
      if (calls === 1) { markEntered(); await firstGate; }
      return { accepted: true };
    },
  };
  const app = createApp({ config, engine });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = 'http://127.0.0.1:' + address.port + '/api/actions/seal';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const send = () => fetch(url, { method: 'POST', headers, body: '{}' });

  try {
    const firstRequest = send();
    await firstEntered;
    const concurrent = await send();
    assert.equal(concurrent.status, 409);
    assert.match((await concurrent.json() as { error: string }).error, /already in progress/);
    assert.equal(calls, 1);

    releaseFirst();
    assert.equal((await firstRequest).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

