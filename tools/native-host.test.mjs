import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nativeArguments, protectAndroidManifest } from './native-build.mjs';

const root = new URL('../src-tauri/', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

test('bundled renderer has no direct network or remote asset capability', () => {
  const config = json('tauri.conf.json');
  const csp = Object.fromEntries(config.app.security.csp.split(';').filter(part => part.trim()).map(part => {
    const [directive, ...values] = part.trim().split(/\s+/);
    return [directive, values];
  }));
  assert.deepEqual(csp['connect-src'], ["'self'", 'ipc:', 'http://ipc.localhost', 'https://ipc.localhost']);
  for (const [directive, values] of Object.entries(csp)) {
    assert.ok(!values.some(value => /^(https?:|wss?:|\*)$/.test(value)), directive);
  }
  assert.deepEqual(csp['frame-src'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  assert.equal(config.build.devUrl, undefined);
  assert.equal(config.build.frontendDist, '../app/dist');
});

test('only the local main window receives bounded native commands', () => {
  const capability = json('capabilities/main.json');
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.ok(capability.permissions.includes('shielded-platform:allow-secret-get'));
  assert.ok(capability.permissions.includes('shielded-platform:allow-secret-set'));
  assert.ok(!capability.permissions.some(permission => /shell|opener|http:|fs:/.test(permission)));
});

test('build commands reject incompatible hosts and forward Tauri arguments without a shell', () => {
  assert.deepEqual(nativeArguments('desktop', 'build', ['--debug'], 'win32'), ['build', '--debug']);
  assert.deepEqual(nativeArguments('android', 'build', ['--apk'], 'linux'), ['android', 'build', '--apk']);
  assert.deepEqual(nativeArguments('ios', 'build', ['--no-sign'], 'darwin'), ['ios', 'build', '--no-sign']);
  assert.throws(() => nativeArguments('ios', 'build', [], 'win32'), /macOS/);
  assert.throws(() => nativeArguments('desktop', 'init', [], 'linux'), /action/);
});

test('Android preparation disables all generated-app backup paths without losing unrelated attributes', () => {
  const manifest = '<manifest><application android:allowBackup="true" android:label="Shielded" android:fullBackupContent="@xml/old" /></manifest>';
  const prepared = protectAndroidManifest(manifest);
  assert.ok(prepared.includes('android:allowBackup="false"'));
  assert.ok(prepared.includes('android:fullBackupContent="false"'));
  assert.ok(prepared.includes('android:dataExtractionRules="@xml/shielded_data_extraction_rules"'));
  assert.ok(prepared.includes('android:label="Shielded"'));
  assert.equal(protectAndroidManifest(prepared), prepared);
  assert.throws(() => protectAndroidManifest('<manifest/>'), /application/);
});
