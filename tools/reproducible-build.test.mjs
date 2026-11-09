import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pinnedActions = {
  checkout: '11d5960a326750d5838078e36cf38b85af677262',
  node: '49933ea5288caeca8642d1e84afbd3f7d6820020',
  java: 'cf277c60eb25467037889841efdb72551f06f6c3',
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
