import express from 'express';
import { fileURLToPath } from 'node:url';
import { createDemoEngine, type DemoEngine } from './engine.ts';

const app = express();
app.use(express.json({ limit: '32kb' }));
let engine: DemoEngine | undefined;
let initializationError: string | undefined;
let busy = false;
const actions = new Set(['shield', 'seal', 'transfer', 'withdraw', 'reset', 'replay', 'tamper', 'recover', 'rebase']);
const unavailable = () => ({
  status: { ready: false, mode: 'local-emulator', network: 'Local emulator · synthetic genesis',
    message: initializationError ?? 'Loading proof keys and compiled Programs…' },
  wallets: [], reserves: [], lanes: [], activity: [], artifacts: [],
});

app.get('/api/state', (_request, response) => response.json(engine?.snapshot() ?? unavailable()));
app.post('/api/actions/:action', async (request, response) => {
  const action = request.params.action;
  if (!actions.has(action)) { response.status(404).json({ error: 'Unknown showcase action' }); return; }
  if (!engine) { response.status(503).json({ error: initializationError ?? 'Runtime is initializing' }); return; }
  if (busy) { response.status(409).json({ error: 'A proof or settlement is already in progress' }); return; }
  busy = true;
  try {
    const result = await engine.action(action, request.body ?? {});
    response.json({ state: engine.snapshot(), result });
  } catch (error) {
    response.status(422).json({ error: error instanceof Error ? error.message : String(error), state: engine.snapshot() });
  } finally { busy = false; }
});
app.use(express.static(fileURLToPath(new URL('../app/dist', import.meta.url))));
app.get('/', (_request, response) => response.sendFile(fileURLToPath(new URL('../app/dist/index.html', import.meta.url))));
const port = Number(process.env.PORT ?? 8787);
const server = app.listen(port, '127.0.0.1', () => console.log(`Shielded showcase API: http://127.0.0.1:${port}`));

try { engine = await createDemoEngine(); console.log('Compiled Programs, Groth16 prover, and emulator ready.'); }
catch (error) { initializationError = error instanceof Error ? error.message : String(error); console.error(initializationError); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  engine?.close();
  server.close(() => process.exit(0));
});
