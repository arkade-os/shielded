import { createDemoEngine } from '../src/engine.ts';
const engine = await createDemoEngine();
try {
  for (const [action, body] of [
    ['shield', { asset: 'BTC', amount: 100_000, from: 'alice' }],
    ['shield', { asset: 'TOKEN', amount: 1_000, from: 'alice' }],
    ['seal', {}],
    ['transfer', { asset: 'BTC', amount: 25_000, from: 'alice', to: 'bob' }],
    ['transfer', { asset: 'TOKEN', amount: 250, from: 'alice', to: 'bob' }],
    ['seal', {}],
    ['withdraw', { asset: 'BTC', amount: 10_000, from: 'bob' }],
    ['withdraw', { asset: 'TOKEN', amount: 100, from: 'bob' }],
    ['recover', { from: 'bob' }],
    ['replay', {}],
    ['tamper', {}],
  ] as const) {
    const result = await engine.action(action, body);
    console.log(JSON.stringify({ action, result }));
  }
  console.log(JSON.stringify({ final: engine.snapshot() }, null, 2));
} finally { engine.close(); }
process.exit(0);
