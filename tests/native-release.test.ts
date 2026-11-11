import assert from 'node:assert/strict';
import test from 'node:test';
import { NATIVE_PACKAGE_MAX_BYTES, parseNativeRelease } from '../src/native-release.ts';
import { androidUpdateFixture, nativeReleaseFixture as release } from './fixtures/native-release.ts';

test('native manifest accepts complete immutable Mutinynet downloads and strips unknown data', () => {
  const input = { ...release(), unknown: 'ignored' }, parsed = parseNativeRelease(input);
  assert.equal(parsed.packages.length, 9);
  assert.equal(parsed.commit, input.commit);
  assert.equal('unknown' in parsed, false);
});

test('native manifest keeps the last published release installable before reproducibility metadata existed', () => {
  const { environment: _, ...legacy } = release(), parsed = parseNativeRelease({ ...legacy, buildNumber: 37 });
  assert.equal(parsed.buildNumber, 37);
  assert.equal('environment' in parsed, false);
  assert.throws(() => parseNativeRelease({ ...legacy, buildNumber: 38 }), /Missing native build environment/);
});

test('native manifest rejects incorrect channel, identity, timestamps and oversized packages', () => {
  for (const change of [
    { schema: 2 }, { channel: 'latest' }, { network: 'bitcoin' }, { commit: 'A'.repeat(40) },
    { buildNumber: 0 }, { buildNumber: Number.MAX_SAFE_INTEGER + 1 }, { version: 'unversioned' },
    { publishedAt: 'yesterday' }, { publishedAt: '2026-02-30T00:00:00Z' },
    { environment: null }, { environment: {} },
  ]) assert.throws(() => parseNativeRelease({ ...release(), ...change }));
  for (const change of [{ bytes: 0 }, { bytes: NATIVE_PACKAGE_MAX_BYTES + 1 }, { sha256: 'B'.repeat(64) }, { sha256: 'bad' }]) {
    const input = release(); Object.assign(input.packages[0], change);
    assert.throws(() => parseNativeRelease(input));
  }
});

test('native manifest rejects foreign, redirected, credentialed and traversing URLs', () => {
  for (const transform of [
    (url: string) => url.replace('arkade-os/shielded', 'attacker/shielded'),
    (url: string) => url.replace('https:', 'http:'), (url: string) => url.replace('github.com', 'user@github.com'),
    (url: string) => `${url}?download=1`, (url: string) => `${url}#hash`,
    (url: string) => url.replace('/download/', '/download/../download/'),
    (url: string) => url.replace('/download/', '/download/%2e%2e/download/'),
  ]) { const input = release(); input.packages[0].url = transform(input.packages[0].url); assert.throws(() => parseNativeRelease(input)); }
  const input = release(); input.releaseUrl = 'https://github.com/arkade-os/shielded/releases/tag/native-mutinynet';
  assert.throws(() => parseNativeRelease(input));
});

test('native manifest requires every platform and format without duplicate downloads', () => {
  for (let index = 0; index < 9; index++) {
    const input = release(), replacement = { ...input.packages[(index + 1) % 9] };
    replacement.file = `extra-${replacement.file}`;
    replacement.url = `${replacement.url.slice(0, replacement.url.lastIndexOf('/') + 1)}${replacement.file}`;
    input.packages[index] = replacement;
    assert.equal(input.packages.length, 9);
    assert.throws(() => parseNativeRelease(input), /Incomplete native release:/);
  }
  const duplicate = release(); duplicate.packages.push({ ...duplicate.packages[0] });
  assert.throws(() => parseNativeRelease(duplicate), /duplicate/);
  const wrongFormat = release(); wrongFormat.packages[0].file += '.zip'; wrongFormat.packages[0].url += '.zip';
  assert.throws(() => parseNativeRelease(wrongFormat), /format/);
});

test('native manifest keeps Android debug and unsigned device labels honest', () => {
  for (const index of [5, 7]) {
    const input = release(); input.packages[index].requiresSigning = false;
    assert.throws(() => parseNativeRelease(input), /signing/);
    const missingLabel = release(); missingLabel.packages[index].file = missingLabel.packages[index].file.replace('-unsigned', '');
    missingLabel.packages[index].url = missingLabel.packages[index].url.replace('-unsigned', '');
    assert.throws(() => parseNativeRelease(missingLabel), /signing/);
  }
  const input = release(); input.packages[0].profile = 'debug';
  assert.throws(() => parseNativeRelease(input));
});

test('signed Android update metadata is additive to every legacy download', () => {
  const input = release(), androidUpdate = androidUpdateFixture(input), parsed = parseNativeRelease({ ...input, androidUpdate: { ...androidUpdate, ignored: true } });
  assert.deepEqual(parsed.packages, parseNativeRelease(input).packages);
  assert.deepEqual(parsed.androidUpdate, androidUpdate);
  assert.equal('androidUpdate' in parseNativeRelease(input), false);
});

test('signed Android updates reject foreign identity, signer, build, filename and unsafe downloads', () => {
  const input = release(), original = androidUpdateFixture(input);
  for (const change of [
    { packageName: 'io.attacker.wallet' }, { signerSha256: 'e'.repeat(64) }, { signerSha256: 'BAD' },
    { versionCode: 1000 }, { versionCode: original.versionCode + 1 }, { versionCode: 2_100_000_001 },
    { platform: 'ios' }, { profile: 'debug' }, { requiresSigning: true }, { bytes: 0 }, { bytes: 128 * 1024 * 1024 + 1 }, { sha256: 'bad' },
    { file: '../release.apk' }, { file: original.file.replace('signed.apk', 'unsigned.apk') },
    { url: original.url.replace('arkade-os/shielded', 'attacker/shielded') },
    { url: `${original.url}?token=1` }, { url: original.url.replace('https:', 'http:') },
    { url: original.url.replace('/download/', '/download/../download/') }, { url: original.url.replace('github.com', 'user@github.com') },
  ]) assert.throws(() => parseNativeRelease({ ...input, androidUpdate: { ...original, ...change } }), JSON.stringify(change));
  assert.throws(() => parseNativeRelease({ ...input, androidUpdate: null }));
  assert.throws(() => parseNativeRelease({ ...input, buildNumber: 2_100_000_000, androidUpdate: { ...original, versionCode: 2_100_100_000 } }));
});
