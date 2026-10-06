import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import manifest from '../packages/protocol/proving-artifacts.json';
import { createPinnedArtifactLoader, verifyPinnedArtifact } from '../packages/protocol/src/pinned-artifact.ts';

const files: Record<string, string> = {
  'intent.wasm': 'circuits/build/intent_js/intent.wasm',
  'intent.zkey': 'circuits/build/intent.zkey',
  'transition.wasm': 'circuits/build/transition_js/transition.wasm',
  'transition.zkey': 'circuits/build/transition.zkey',
};

test('proving artifact pins match the committed circuit build', async () => {
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), Object.keys(files).sort());
  for (const [name, path] of Object.entries(files)) {
    const bytes = await readFile(path);
    const pin = manifest.artifacts[name as keyof typeof manifest.artifacts];
    assert.equal(bytes.byteLength, pin.size, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, name);
    const body = Uint8Array.from(bytes);
    assert.deepEqual(await verifyPinnedArtifact(new Response(body.buffer as ArrayBuffer), pin), body, name);
  }
});

test('proving artifact verifier rejects altered bytes and declared or streamed size changes', async () => {
  const pin = { size: 5, sha256: createHash('sha256').update('proof').digest('hex') };
  await assert.rejects(verifyPinnedArtifact(new Response('proef'), pin), /hash/);
  await assert.rejects(verifyPinnedArtifact(new Response('proof'), { ...pin, size: 6 }), /size/);
  await assert.rejects(verifyPinnedArtifact(new Response('proof', { headers: { 'content-length': '6' } }), pin), /size/);
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.close(); } }));
  await assert.rejects(verifyPinnedArtifact(oversized, pin), /exceeds its pinned size/);
});

test('artifact loading reports streamed download progress', async () => {
  const pin = { size: 5, sha256: createHash('sha256').update('proof').digest('hex') };
  const seen: [string, number, number][] = [];
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('pr')); controller.enqueue(new TextEncoder().encode('oof')); controller.close(); } });
  const load = createPinnedArtifactLoader(async () => new Response(body), { 'intent.wasm': pin }, (name) => `/api/proving/${name}`, undefined, (name, loaded, total) => seen.push([name, loaded, total]));
  await load('intent.wasm');
  assert.deepEqual(seen, [['intent.wasm', 2, 5], ['intent.wasm', 5, 5]]);
});

test('artifact loading caches verified bytes and retries after a rejected download', async () => {
  const pin = { size: 5, sha256: createHash('sha256').update('proof').digest('hex') };
  let calls = 0;
  const load = createPinnedArtifactLoader(async () => {
    calls++;
    return new Response(calls === 1 ? 'proef' : 'proof');
  }, { 'intent.wasm': pin }, (name) => `/api/proving/${name}`);
  await assert.rejects(load('intent.wasm'), /hash/);
  const [first, second] = await Promise.all([load('intent.wasm'), load('intent.wasm')]);
  assert.equal(calls, 2);
  assert.strictEqual(first, second);
  assert.equal(new TextDecoder().decode(first), 'proof');
});
