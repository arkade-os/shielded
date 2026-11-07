import assert from 'node:assert/strict';
import test from 'node:test';
import { NATIVE_PACKAGE_MAX_BYTES, parseNativeRelease } from '../src/native-release.ts';
import { nativeReleaseFixture as release } from './fixtures/native-release.ts';

test('native manifest accepts complete immutable Mutinynet downloads and strips unknown data', () => {
  const input = { ...release(), unknown: 'ignored' }, parsed = parseNativeRelease(input);
  assert.equal(parsed.packages.length, 9);
  assert.equal(parsed.commit, input.commit);
  assert.equal('unknown' in parsed, false);
});

test('native manifest rejects incorrect channel, identity, timestamps and oversized packages', () => {
  for (const change of [
    { schema: 2 }, { channel: 'latest' }, { network: 'bitcoin' }, { commit: 'A'.repeat(40) },
    { buildNumber: 0 }, { buildNumber: Number.MAX_SAFE_INTEGER + 1 }, { version: 'unversioned' },
    { publishedAt: 'yesterday' }, { publishedAt: '2026-02-30T00:00:00Z' },
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
    const input = release(); input.packages.splice(index, 1);
    assert.throws(() => parseNativeRelease(input), /Incomplete/);
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
