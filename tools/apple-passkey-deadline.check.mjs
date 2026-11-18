import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'This check requires the Apple Swift toolchain');
const temporary = realpathSync(tmpdir()), prefix = 'shielded-apple-passkey-deadline-';
const workspace = mkdtempSync(join(temporary, prefix));
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
};

try {
  const binary = join(workspace, 'deadline-check');
  run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', join(root, 'src-tauri/plugins/shielded-platform/ios/Sources/PasskeyDeadline.swift'), join(root, 'tools/apple-passkey-deadline.swift'), '-o', binary]);
  console.info(run(binary, []).trim());
} finally {
  const target = realpathSync(workspace);
  assert.equal(dirname(target), temporary);
  assert.ok(basename(target).startsWith(prefix));
  rmSync(target, { recursive: true, force: true });
}
