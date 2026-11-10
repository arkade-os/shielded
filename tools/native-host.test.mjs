import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeArguments, prepareAndroid, protectAndroidManifest } from './native-build.mjs';

const root = new URL('../src-tauri/', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

test('Windows setup bundles WebView2 without a first-run download', () => {
  assert.deepEqual(json('tauri.conf.json').bundle.windows.webviewInstallMode, { type: 'offlineInstaller', silent: true });
});

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
  const opener = capability.permissions.filter(permission => String(permission.identifier ?? permission).startsWith('opener:'));
  assert.deepEqual(opener, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://shielded.mutinynet.arkade.sh/#download' }] }]);
  assert.ok(!capability.permissions.some(permission => typeof permission === 'string' && /shell|http:|fs:/.test(permission)));
});

test('build commands reject incompatible hosts and forward Tauri arguments without a shell', () => {
  assert.deepEqual(nativeArguments('desktop', 'build', ['--debug'], 'win32'), ['build', '--debug']);
  assert.deepEqual(nativeArguments('android', 'build', ['--apk'], 'linux'), ['android', 'build', '--apk']);
  assert.deepEqual(nativeArguments('ios', 'build', ['--no-sign'], 'darwin'), ['ios', 'build', '--no-sign']);
  assert.throws(() => nativeArguments('ios', 'build', [], 'win32'), /macOS/);
  assert.throws(() => nativeArguments('desktop', 'init', [], 'linux'), /action/);
});

test('mobile initialization requires a package-manager runner for generated IDE callbacks', () => {
  for (const platform of ['android', 'ios']) {
    assert.throws(() => nativeArguments(platform, 'init', [], 'darwin', {}), /npm run native:/);
    assert.deepEqual(nativeArguments(platform, 'init', [], 'darwin', { npm_execpath: '/node/npm-cli.js' }), [platform, 'init']);
  }
});

test('generated mobile callbacks resolve the local CLI from the IDE working directory', t => {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-cli-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const directory of ['src-tauri', 'src-tauri/gen/apple']) {
    const cwd = resolve(workspace, directory);
    mkdirSync(cwd, { recursive: true });
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run -- tauri --version'], { cwd, encoding: 'utf8', shell: false })
      : spawnSync('npm', ['run', '--', 'tauri', '--version'], { cwd, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /tauri-cli 2\.12\.4/);
  }
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

test('Android backup protection preserves quoted tag characters and merge markers', () => {
  const manifest = `<manifest><application android:label="A > B $& android:allowBackup='label'" tools:replace="android:allowBackup" android:allowBackup="true" /></manifest>`;
  const prepared = protectAndroidManifest(manifest);
  assert.ok(prepared.includes(`android:label="A > B $& android:allowBackup='label'"`));
  assert.ok(prepared.includes('tools:replace="android:allowBackup"'));
  assert.ok(prepared.includes('android:allowBackup="false"'));
  assert.ok(prepared.includes('android:fullBackupContent="false"'));
  assert.ok(prepared.includes('android:dataExtractionRules="@xml/shielded_data_extraction_rules"'));
  assert.equal(protectAndroidManifest(prepared), prepared);
});

test('Android preparation refuses a stale generated identifier before changing its manifest', t => {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-project-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = resolve(workspace, 'src-tauri/gen/android/app');
  const manifest = resolve(app, 'src/main/AndroidManifest.xml');
  mkdirSync(resolve(app, 'src/main'), { recursive: true });
  writeFileSync(resolve(workspace, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'io.arkade.shielded' }));
  writeFileSync(manifest, '<manifest><application android:allowBackup="true" /></manifest>');
  for (const [namespace, applicationId] of [['io.old.wallet', 'io.arkade.shielded'], ['io.arkade.shielded', 'io.old.wallet']]) {
    writeFileSync(resolve(app, 'build.gradle.kts'), `android {\n namespace = "${namespace}"\n defaultConfig {\n applicationId = "${applicationId}"\n }\n}`);
    assert.throws(() => prepareAndroid(workspace), /different identifier/);
    assert.equal(readFileSync(manifest, 'utf8'), '<manifest><application android:allowBackup="true" /></manifest>');
  }
  writeFileSync(resolve(app, 'build.gradle.kts'), 'android {\n namespace = "io.arkade.shielded"\n defaultConfig {\n applicationId = "io.arkade.shielded"\n }\n}');
  prepareAndroid(workspace);
  assert.ok(readFileSync(manifest, 'utf8').includes('android:allowBackup="false"'));
});
