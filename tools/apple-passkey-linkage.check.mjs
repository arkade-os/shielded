import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'This check requires the macOS linker tools');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
};
const build = run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'tauri-plugin-shielded-platform', '--locked', '--no-run', '--message-format=json']);
const binaries = new Set(build.trim().split(/\r?\n/).map(line => JSON.parse(line))
  .filter(item => item.reason === 'compiler-artifact' && item.target.name === 'tauri_plugin_shielded_platform' && item.profile.test && item.executable)
  .map(item => item.executable));
assert.equal(binaries.size, 1, 'Inspect the platform plugin test executable, which retains the gated Apple request path');
for (const binary of binaries) {
  const symbols = run('/usr/bin/nm', ['-u', binary]);
  assert.doesNotMatch(symbols, /ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired/, 'A macOS 12 strong import would prevent an opted-in build from launching on macOS 11');
  assert.doesNotMatch(symbols, /_OBJC_CLASS_\$_ASAuthorization(?:PlatformPublicKeyCredential|PublicKeyCredentialPRF)/, 'Newer Apple classes must resolve dynamically after the OS availability guard');
}
console.info('Apple passkey linkage: no gated macOS 12+ startup imports');
