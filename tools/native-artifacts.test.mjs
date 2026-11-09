import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { collectNativeArtifacts, verifyMutinynet } from './native-artifacts.mjs';

const commit = 'a'.repeat(40);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-native-artifacts-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const put = (path, content = 'binary') => { const target = join(directory, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); };
  put('src-tauri/src/lib.rs', "poolOrigin: 'https://shielded.mutinynet.arkade.sh'");
  put('src-tauri/src/transport/routes.rs', 'pub const POOL: &str = "shielded.mutinynet.arkade.sh";');
  put('package-lock.json', '{}');
  put('src-tauri/Cargo.lock', '{}');
  return { directory, put };
}

test('native artifact collection refuses a different compiled network policy', t => {
  const f = fixture(t);
  verifyMutinynet(f.directory);
  f.put('src-tauri/src/transport/routes.rs', 'pub const POOL: &str = "mainnet.example";');
  assert.throws(() => verifyMutinynet(f.directory), /hardcoded Mutinynet/);
  f.put('src-tauri/src/transport/routes.rs', 'pub const POOL: &str = "shielded.mutinynet.arkade.sh";');
  f.put('src-tauri/src/lib.rs', "poolOrigin: 'https://mainnet.example'");
  assert.throws(() => verifyMutinynet(f.directory), /hardcoded Mutinynet/);
});

test('artifact manifests hash actual packages and retain network, source and profile', t => {
  const f = fixture(t), bytes = 'actual installer contents';
  f.put('src-tauri/target/release/bundle/nsis/Shielded-setup.exe', bytes);
  f.put('src-tauri/target/debug/bundle/nsis/Old-debug.exe', 'wrong profile');
  const output = collectNativeArtifacts(f.directory, 'windows-x86_64', 'release', commit);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
  assert.equal(manifest.network, 'mutinynet'); assert.equal(manifest.commit, commit);
  assert.equal(manifest.packages.length, 1); assert.equal(manifest.packages[0].profile, 'release');
  assert.equal(manifest.packages[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(readFileSync(join(output, manifest.packages[0].file), 'utf8'), bytes);
  assert.match(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), new RegExp(manifest.packages[0].sha256));
  assert.throws(() => collectNativeArtifacts(f.directory, 'windows-x86_64', 'release', commit), /must be empty/);
});

test('both Linux package formats are required and empty outputs are refused', t => {
  const f = fixture(t);
  f.put('src-tauri/target/debug/bundle/deb/Shielded.deb');
  assert.throws(() => collectNativeArtifacts(f.directory, 'linux-x86_64', 'debug', commit), /Missing debug .AppImage/);
  f.put('src-tauri/target/debug/bundle/appimage/Shielded.AppImage', '');
  assert.throws(() => collectNativeArtifacts(f.directory, 'linux-x86_64', 'debug', commit), /Empty native artifact/);
  f.put('src-tauri/target/debug/bundle/appimage/Shielded.AppImage');
  const output = collectNativeArtifacts(f.directory, 'linux-x86_64', 'debug', commit);
  assert.equal(JSON.parse(readFileSync(join(output, 'manifest.json'))).packages.length, 2);
});

test('macOS collection requires the universal app archive and disk image', t => {
  const f = fixture(t), bundle = 'src-tauri/target/universal-apple-darwin/release/bundle';
  f.put(`${bundle}/dmg/Shielded.dmg`);
  assert.throws(() => collectNativeArtifacts(f.directory, 'macos-universal', 'release', commit), /Missing release .app.zip/);
  f.put(`${bundle}/macos/Shielded.app.zip`);
  const output = collectNativeArtifacts(f.directory, 'macos-universal', 'release', commit);
  assert.equal(JSON.parse(readFileSync(join(output, 'manifest.json'))).packages.length, 2);
});

test('release Android downloads require an unsigned release APK and a separate debug APK', t => {
  const f = fixture(t), apk = 'src-tauri/gen/android/app/build/outputs/apk';
  f.put(`${apk}/arm64/release/app-arm64-release-unsigned.apk`);
  assert.throws(() => collectNativeArtifacts(f.directory, 'android-arm64', 'release', commit), /Missing debug .apk/);
  f.put(`${apk}/universal/debug/app-universal-debug.apk`);
  const output = collectNativeArtifacts(f.directory, 'android-arm64', 'release', commit);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
  assert.deepEqual(manifest.packages.map(p => [p.profile, p.requiresSigning]), [['release', true], ['debug', false]]);
  assert.match(readFileSync(join(output, 'README.txt'), 'utf8'), /Updates require the same signing key/);
});

test('iOS downloads require both the unsigned device IPA and the simulator archive', t => {
  const f = fixture(t), build = 'src-tauri/gen/apple/build';
  f.put(`${build}/arm64/Shielded.ipa`);
  assert.throws(() => collectNativeArtifacts(f.directory, 'ios', 'release', commit), /simulator.app.zip/);
  f.put(`${build}/Shielded-simulator.app.zip`);
  const output = collectNativeArtifacts(f.directory, 'ios', 'release', commit);
  const packages = JSON.parse(readFileSync(join(output, 'manifest.json'))).packages;
  assert.equal(packages.filter(p => p.requiresSigning).length, 1);
  assert.ok(packages.some(p => p.file.endsWith('.ipa')));
  assert.ok(packages.some(p => p.file.endsWith('.zip')));
});

test('artifact selectors reject unknown profiles, platforms and source revisions', t => {
  const f = fixture(t);
  assert.throws(() => collectNativeArtifacts(f.directory, 'windows-x86_64', '../debug', commit), /debug or release/);
  assert.throws(() => collectNativeArtifacts(f.directory, '../windows', 'debug', commit), /Unknown/);
  assert.throws(() => collectNativeArtifacts(f.directory, 'windows-x86_64', 'debug', 'local'), /commit SHA/);
});
