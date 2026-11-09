import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const retry = new URL('./retry-command.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('retry command succeeds after a bounded transient failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-retry-'));
  const script = join(directory, 'attempt.mjs'), marker = join(directory, 'attempt');
  writeFileSync(script, `import {readFileSync,writeFileSync} from 'node:fs'; const p=${JSON.stringify(marker)}; let n=0; try{n=+readFileSync(p,'utf8')}catch{}; if(++n<2){writeFileSync(p,String(n));process.exit(1)};writeFileSync(p,String(n));`);
  try {
    const result = spawnSync(process.execPath, [retry, process.execPath, script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), '2');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retry command reports a lasting failure', () => {
  const result = spawnSync(process.execPath, [retry, process.execPath, '-e', 'process.exit(7)'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed after 3 attempts/);
});
