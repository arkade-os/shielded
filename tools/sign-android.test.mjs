import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { selectAndroidSigningSource, signAndroidArtifact } from './sign-android.mjs';
import { requireDisposableEmulator } from './android-update-fixture/emulator-guard.mjs';

const pin = 'a'.repeat(64), secret = 'private-password-never-a-command-argument';
const config = { schema: 1, packageName: 'io.arkade.shielded', alias: 'shielded-release', certificateSha256: pin };
const identity = { GITHUB_REPOSITORY: 'arkade-os/shielded', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_NUMBER: '99', ANDROID_HOME: '/sdk', JAVA_HOME: '/java', ANDROID_RELEASE_KEYSTORE_PASSWORD: secret, ANDROID_RELEASE_KEYSTORE_BASE64: Buffer.alloc(1024, 7).toString('base64') };
function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shielded-signing-test-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const input = join(root, 'input'), output = join(root, 'output'), file = 'mutinynet-release-unsigned-app-release-unsigned.apk';
  mkdirSync(input);
  const bytes = Buffer.from('PK\x03\x04actual unsigned fixture');
  writeFileSync(join(input, file), bytes);
  const manifest = { network: 'mutinynet', poolOrigin: 'https://shielded.mutinynet.arkade.sh', platform: 'android-arm64', commit: identity.GITHUB_SHA, packages: [{ file, profile: 'release', requiresSigning: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...changes }] };
  writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
  const calls = [], keys = [];
  const run = (command, args, env) => {
    calls.push({ command, args, env });
    if (basename(command).startsWith('aapt')) return "package: name='io.arkade.shielded' versionCode='100099' versionName='0.1.0'\n";
    if (basename(command).startsWith('zipalign')) { if (!args.includes('-c')) copyFileSync(args.at(-2), args.at(-1)); return ''; }
    if (args.includes('sign')) {
      const key = args[args.indexOf('--ks') + 1]; keys.push(key); assert.ok(existsSync(key));
      assert.equal(env.SHIELDED_APK_STORE_PASSWORD, secret);
      copyFileSync(args.at(-1), args[args.indexOf('--out') + 1]);
      return '';
    }
    return `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${pin}\n`;
  };
  return { root, input, output, file, manifest, calls, keys, run };
}

test('stable APK signing validates source, writes actual signed metadata and keeps secrets out of arguments', t => {
  const f = fixture(t), result = signAndroidArtifact(f.input, f.output, identity, config, f.run);
  assert.equal(result.versionCode, 100099);
  assert.equal(result.signerSha256, pin);
  assert.equal(result.packageName, config.packageName);
  assert.equal(result.package.file, 'mutinynet-release-signed.apk');
  assert.equal(result.package.sha256, createHash('sha256').update(readFileSync(join(f.output, result.package.file))).digest('hex'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.output, 'manifest.json'))), result);
  assert.ok(f.keys.every(key => !existsSync(key)));
  for (const call of f.calls) {
    assert.ok(!call.args.some(arg => arg.includes(secret) || arg.includes(identity.ANDROID_RELEASE_KEYSTORE_BASE64)));
    assert.equal(call.env.ANDROID_RELEASE_KEYSTORE_BASE64, undefined);
    assert.equal(call.env.ANDROID_RELEASE_KEYSTORE_PASSWORD, undefined);
    if (!call.args.includes('sign')) assert.equal(call.env.SHIELDED_APK_STORE_PASSWORD, undefined);
  }
});

test('missing signing secrets and untrusted events never fall back to debug signing', t => {
  for (const change of [{ ANDROID_RELEASE_KEYSTORE_BASE64: '' }, { ANDROID_RELEASE_KEYSTORE_PASSWORD: '' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'fork/shielded' }, { GITHUB_RUN_NUMBER: '0' }]) {
    const f = fixture(t);
    assert.throws(() => signAndroidArtifact(f.input, f.output, { ...identity, ...change }, config, f.run));
    assert.equal(existsSync(f.output), false);
    assert.equal(f.calls.length, 0);
  }
});

test('wrong hashes, source revisions, unsafe paths and unexpected package versions cannot be signed', t => {
  for (const change of [{ sha256: 'f'.repeat(64) }, { bytes: 1 }, { file: '../escape.apk' }, { profile: 'debug' }, { requiresSigning: false }]) {
    const f = fixture(t, change);
    assert.throws(() => signAndroidArtifact(f.input, f.output, identity, config, f.run));
    assert.equal(f.keys.length, 0);
  }
  const f = fixture(t);
  assert.throws(() => signAndroidArtifact(f.input, f.output, { ...identity, GITHUB_SHA: 'c'.repeat(40) }, config, f.run), /source/);
  assert.throws(() => signAndroidArtifact(f.input, f.output, identity, config, (command, args, env) => basename(command).startsWith('aapt') ? "package: name='io.arkade.shielded' versionCode='1000' versionName='0.1.0'" : f.run(command, args, env)), /version/);
  assert.equal(f.keys.length, 0);
});

test('signer mismatch and failed signature verification leave no package, metadata or private key', t => {
  for (const verification of [`Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${'c'.repeat(64)}\n`, `Verified using v2 scheme (APK Signature Scheme v2): false\nSigner #1 certificate SHA-256 digest: ${pin}\n`, `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${pin}\nSigner #2 certificate SHA-256 digest: ${pin}\n`]) {
    const f = fixture(t);
    assert.throws(() => signAndroidArtifact(f.input, f.output, identity, config, (command, args, env) => args.includes('verify') ? verification : f.run(command, args, env)), /signature|certificate/);
    assert.ok(f.keys.every(key => !existsSync(key)));
    assert.equal(existsSync(f.output), false);
  }
});

test('signing reruns select only the newest eligible same-source Android artifact from their run', t => {
  const f = fixture(t), inputs = join(f.root, 'artifacts'); mkdirSync(inputs);
  const name = attempt => `shielded-mutinynet-android-arm64-release-${identity.GITHUB_SHA}-attempt${attempt}`;
  for (const attempt of [1, 2]) mkdirSync(join(inputs, name(attempt)));
  assert.equal(selectAndroidSigningSource(inputs, { ...identity, GITHUB_RUN_ATTEMPT: '3' }), join(inputs, name(2)));
  assert.throws(() => selectAndroidSigningSource(inputs, { ...identity, GITHUB_RUN_ATTEMPT: '1' }), /Unexpected/);
  assert.throws(() => selectAndroidSigningSource(inputs, { ...identity, GITHUB_RUN_ATTEMPT: '3', GITHUB_SHA: 'c'.repeat(40) }), /Unexpected/);
});

test('APK fixtures cannot select physical devices or replace an existing emulator wallet', () => {
  const calls = [], device = (...args) => { calls.push(args); return { stdout: args.includes('getprop') ? '1\n' : '' }; };
  assert.equal(requireDisposableEmulator(undefined, device), false);
  assert.equal(calls.length, 0);
  for (const serial of ['', 'usb-device', 'localhost:5555', 'emulator-5554 extra']) assert.throws(() => requireDisposableEmulator(serial, device), /explicit emulator/);
  assert.equal(calls.length, 0);
  assert.throws(() => requireDisposableEmulator('emulator-5554', () => ({ stdout: '0\n' })), /physical Android device/);
  assert.throws(() => requireDisposableEmulator('emulator-5554', (...args) => ({ stdout: args.includes('getprop') ? '1\n' : 'package:io.arkade.shielded\n' })), /Existing Shielded installation is preserved/);
  assert.equal(requireDisposableEmulator('emulator-5554', device), true);
  assert.deepEqual(calls, [['shell', 'getprop', 'ro.kernel.qemu'], ['shell', 'pm', 'list', 'packages', 'io.arkade.shielded']]);
});
