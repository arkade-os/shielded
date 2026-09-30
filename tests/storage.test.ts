import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineStore } from '../src/storage.ts';

const key = '11'.repeat(32);
test('encrypted checkpoints survive reopen and fail closed on a wrong key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-store-'));
  try {
    const store = EngineStore.open(directory, key);
    store.save({ note: 'private checkpoint', revision: 4 });
    store.close();
    const reopened = EngineStore.open(directory, key);
    assert.deepEqual(reopened.load(), { note: 'private checkpoint', revision: 4 });
    reopened.close();
    const wrongKey = EngineStore.open(directory, '22'.repeat(32));
    try { assert.throws(() => wrongKey.load(), /failed authentication/); } finally { wrongKey.close(); }
    assert.equal(readFileSync(join(directory, 'shielded.sqlite')).includes(Buffer.from('private checkpoint')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a second process owner cannot open the same engine directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-lock-'));
  let store: EngineStore | undefined;
  try {
    store = EngineStore.open(directory, key);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { EngineStore } from './src/storage.ts'; try { EngineStore.open(${JSON.stringify(directory)}, '${key}'); process.exit(0); } catch (error) { console.error(error.message); process.exit(2); }`],
    { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /Storage is locked/);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an abrupt process exit releases SQLite ownership for restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-crash-'));
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { EngineStore } from './src/storage.ts'; const db=EngineStore.open(${JSON.stringify(directory)}, '${key}'); db.save({revision:9}); process.exit(0);`],
    { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const reopened = EngineStore.open(directory, key);
    try { assert.deepEqual(reopened.load(), { revision: 9 }); } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('modified checkpoint ciphertext is rejected without replacing the stored state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-corrupt-'));
  try {
    const store = EngineStore.open(directory, key);
    store.save({ revision: 12 });
    store.close();
    const db = new DatabaseSync(join(directory, 'shielded.sqlite'));
    try { db.exec("UPDATE checkpoint SET ciphertext = zeroblob(length(ciphertext)) WHERE id=1"); } finally { db.close(); }
    const corrupted = EngineStore.open(directory, key);
    try { assert.throws(() => corrupted.load(), /failed authentication/); } finally { corrupted.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
