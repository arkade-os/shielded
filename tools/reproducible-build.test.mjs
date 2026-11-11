import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { downloadTlcArtifact } from './check-native-model.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pinnedActions = {
  checkout: 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  node: '249970729cb0ef3589644e2896645e5dc5ba9c38',
  java: 'b6effb05e454b25005698d916606bdc6ffcbf961',
  upload: 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  download: 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
};

test('shared pinned action hashes stay explicit', () => {
  for (const sha of Object.values(pinnedActions)) assert.match(sha, /^[a-f0-9]{40}$/);
});

test('native build runtimes are exactly pinned', () => {
  const action = read('.github/actions/setup/action.yml');
  assert.match(action, new RegExp(`actions/setup-node@${pinnedActions.node}`));
  assert.match(action, new RegExp(`dtolnay/rust-toolchain@[a-f0-9]{40}`));
  assert.match(action, /node-version: '24\.22\.2'/);
  assert.match(action, /toolchain: '1\.96\.0'/);
});

test('release jobs use pinned runtime actions and all GitHub actions use commit SHAs', () => {
  const native = read('.github/workflows/native.yml');
  assert.match(native, /SOURCE_DATE_EPOCH: '\d+'/);
  assert.match(native, /CARGO_INCREMENTAL: '0'/);
  assert.doesNotMatch(native, /dtolnay\/rust-toolchain@stable/);
  for (const workflow of ['native.yml', 'checks.yml', 'archive-mirror.yml']) {
    const source = read(`.github/workflows/${workflow}`);
    for (const match of source.matchAll(/uses: (actions\/[a-z-]+)@([^\s#]+)/g)) {
      assert.match(match[2], /^[a-f0-9]{40}$/, `${workflow}: ${match[0]}`);
    }
    for (const [action,pin] of [['checkout',pinnedActions.checkout],['setup-node',pinnedActions.node],['setup-java',pinnedActions.java]]) {
      for (const match of source.matchAll(new RegExp(`actions/${action}@([^\\s#]+)`, 'g'))) assert.equal(match[1], pin, `${workflow}: ${action}`);
    }
  }
});

test('Rust release output removes the checkout-specific source prefix', () => {
  assert.match(read('src-tauri/.cargo/config.toml'), /remap-path-prefix=\$CARGO_MANIFEST_DIR=src-tauri/);
});

test('package manager installs are lockfile exact', () => {
  assert.match(read('.github/workflows/native.yml'), /npm ci/g);
  assert.match(read('.github/workflows/checks.yml'), /npm ci/g);
  assert.match(read('.github/workflows/native.yml'), /Cargo\.toml --workspace --locked/g);
});

test('release package downloads use bounded retries', () => {
  const native = read('.github/workflows/native.yml');
  assert.match(native, /retry-command\.mjs node tools\/native-build\.mjs android build \$NATIVE_BUILD_FLAG/);
  assert.match(native, /retry-command\.mjs node tools\/native-build\.mjs android build --debug/);
  assert.match(native, /retry-command\.mjs node tools\/native-build\.mjs desktop build/);
  assert.match(read('.github/workflows/checks.yml'), /retry-command\.mjs docker build/);
  assert.match(read('tools/check-native-model.mjs'), /attempt <= 3/);
});

test('production APK signing is isolated from pull requests and only receives secrets in the signing step', () => {
  const source = read('.github/workflows/native.yml'), signing = source.split(/\r?\n  android-sign:\r?\n/)[1]?.split(/\r?\n  ios:\r?\n/)[0];
  assert.ok(signing);
  assert.match(signing, /github\.repository == 'arkade-os\/shielded'/);
  assert.match(signing, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(signing, /github\.ref == 'refs\/heads\/main'/);
  assert.match(signing, /needs: android/);
  assert.match(signing, /run-id: \$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(signing, /npm ci|npm install|pull_request_target/);
  assert.match(signing, /cmdline-tools\/latest\/bin\/sdkmanager" ''build-tools;36\.0\.0''/);
  assert.equal((source.match(/secrets\.ANDROID_RELEASE_KEYSTORE_BASE64/g) ?? []).length, 1);
  assert.equal((source.match(/secrets\.ANDROID_RELEASE_KEYSTORE_PASSWORD/g) ?? []).length, 1);
  assert.ok(signing.indexOf('sdkmanager') < signing.indexOf('secrets.ANDROID_RELEASE_KEYSTORE_BASE64'));
  assert.match(source, /run: node tools\/check-android-signing\.mjs/);
});

test('APK data retention is gated by a bounded disposable emulator without physical-device discovery', () => {
  const source = read('.github/workflows/native.yml'), job = source.split(/\r?\n  android-update-data:\r?\n/)[1]?.split(/\r?\n  android-sign:\r?\n/)[0];
  assert.ok(job);
  assert.match(job, /timeout-minutes: 20/);
  assert.match(job, /SHIELDED_TEST_EMULATOR_SERIAL: emulator-5554/);
  assert.match(job, /-no-window .*?-gpu swiftshader/);
  assert.match(job, /timeout 300/);
  assert.match(job, /if: always\(\)/);
  assert.doesNotMatch(job, /secrets\./);
  const probe = read('tools/check-android-signing.mjs');
  const guard = read('tools/android-update-fixture/emulator-guard.mjs');
  assert.match(guard, /ro\.kernel\.qemu/);
  assert.match(guard, /Existing Shielded installation is preserved/);
  assert.doesNotMatch(probe, /device\('uninstall'|device\('shell', 'pm', 'clear'|device\('devices'/);
  assert.match(probe, /device\('install', '-r', signedPaths\[1\]\)/);
});

test('TLC downloads retry transport errors and corrupt bodies before failing', async () => {
  const bytes = Buffer.from('verified tlc fixture'), checksum = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  const recovered = await downloadTlcArtifact({ checksum, wait:async()=>{}, report:()=>{}, fetchImpl:async()=>++calls===1?new Response(null,{status:503}):new Response(bytes) });
  assert.deepEqual(recovered, bytes);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(downloadTlcArtifact({ checksum, wait:async()=>{}, report:()=>{}, fetchImpl:async()=>{ calls++; return new Response('corrupt'); } }), /checksum mismatch/);
  assert.equal(calls, 3);
});
