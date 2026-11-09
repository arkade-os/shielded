import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
    for (const match of read(`.github/workflows/${workflow}`).matchAll(/uses: (actions\/[a-z-]+)@([^\s#]+)/g)) {
      assert.match(match[2], /^[a-f0-9]{40}$/, `${workflow}: ${match[0]}`);
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
  assert.match(native, /retry-command\.mjs node node_modules\/@tauri-apps\/cli\/tauri\.js android build/);
  assert.match(native, /retry-command\.mjs node tools\/native-build\.mjs desktop build/);
  assert.match(read('.github/workflows/checks.yml'), /retry-command\.mjs docker build/);
  assert.match(read('tools/check-native-model.mjs'), /attempt <= 3/);
});
