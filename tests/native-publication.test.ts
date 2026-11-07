import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { NATIVE_PLATFORMS, NATIVE_RELEASE_ORIGIN, parseNativeRelease } from '../src/native-release.ts';
import { nativeReleaseFixture } from './fixtures/native-release.ts';
import { assertNativeReleaseAdvancement, extractNativeLinuxArchive, GitHubNativeReleases, nativePublicationIdentity, prepareNativeRelease, publishNativeRelease, type PreparedNativeRelease } from '../tools/publish-native-release.ts';

const env = { GITHUB_REPOSITORY: 'arkade-os/shielded', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_NUMBER: '124', GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '1' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-native-publish-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const input = join(directory, 'input'), output = join(directory, 'output'), original = nativeReleaseFixture();
  for (const platform of NATIVE_PLATFORMS) {
    const selected = join(input, platform); mkdirSync(selected, { recursive: true });
    const packages = original.packages.filter(item => item.platform === platform).map(item => {
      const file = `mutinynet-${item.file.split('-mutinynet-').at(-1)!}`, bytes = Buffer.from(`actual ${file} binary`);
      writeFileSync(join(selected, file), bytes);
      return { file, profile: item.profile, requiresSigning: item.requiresSigning, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    writeFileSync(join(selected, 'manifest.json'), JSON.stringify({ network: 'mutinynet', poolOrigin: NATIVE_RELEASE_ORIGIN, commit: env.GITHUB_SHA, platform, packages }));
  }
  return { directory, input, output, prepare: () => prepareNativeRelease(input, output, nativePublicationIdentity(env), '0.1.0', new Date('2026-11-07T12:00:00Z')) };
}
function fakeGitHub(prepared: PreparedNativeRelease, options: { noChannel?: boolean; failLatest?: boolean; wrongLatest?: boolean; lostDelete?: boolean; immutable?: boolean; changedHead?: boolean; rejectSource?: boolean } = {}) {
  type Asset = { id: number; name: string; size: number };
  type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean; assets: Asset[] };
  const old = Buffer.from(JSON.stringify(nativeReleaseFixture())), payloads = new Map<number, Uint8Array>([[1, old]]);
  const pointer: Release = { id: 1, tag_name: 'native-mutinynet', draft: false, prerelease: true, immutable: options.immutable, assets: [{ id: 1, name: 'latest.json', size: old.length }] };
  const releases = new Map<string, Release>(options.noChannel ? [] : [[pointer.tag_name, pointer]]), events: string[] = [];
  let nextId = 2, reads = 0, failed = false;
  const upload = async (release: Release, name: string, bytes: Uint8Array | string) => {
    events.push(`upload:${name}`);
    if (name === 'latest.json' && options.failLatest && !failed) { failed = true; throw new Error('Upload unavailable'); }
    const payload = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    const asset = { id: nextId++, name, size: payload.byteLength }; release.assets.push(asset); payloads.set(asset.id, payload); return asset;
  };
  return {
    events, releases, old,
    currentHead: async () => { reads++; return options.changedHead && reads > 1 ? 'b'.repeat(40) : prepared.manifest.commit; },
    assertSourceAdvancement: async () => { if (options.rejectSource) throw new Error('Source downgrade'); },
    release: async (tag: string) => releases.get(tag) ?? null,
    create: async (tag: string, _commit: string, draft: boolean) => { events.push(`create:${tag}`); const release = { id: nextId++, tag_name: tag, draft, prerelease: true, assets: [] }; releases.set(tag, release); return release; },
    upload,
    uploadFile: async (release: Release, name: string, path: string) => upload(release, name, readFileSync(path)),
    publish: async (release: Release) => { events.push('publish:build'); assert.equal(release.assets.length, 11); release.draft = false; },
    download: async (asset: Asset) => {
      events.push(`download:${asset.name}`);
      if (asset.name === 'latest.json' && asset.id !== 1 && options.wrongLatest && !failed) { failed = true; return Buffer.from('wrong bytes'); }
      return payloads.get(asset.id)!;
    },
    removePointer: async (asset: Asset) => {
      assert.equal(asset.name, 'latest.json'); events.push('remove:pointer');
      const live = releases.get('native-mutinynet')!; live.assets = live.assets.filter(item => item.id !== asset.id);
      if (options.lostDelete && !failed) { failed = true; throw new Error('Response lost after successful DELETE'); }
    },
    latest: () => payloads.get(releases.get('native-mutinynet')!.assets.find(asset => asset.name === 'latest.json')!.id),
  };
}

test('native publication trusts only primary branch pushes or dispatch and safe CI identities', () => {
  assert.equal(nativePublicationIdentity(env).buildNumber, 124);
  for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REF: 'refs/tags/main' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'fork/shielded' }, { GITHUB_RUN_NUMBER: '0' }, { GITHUB_RUN_ID: 'NaN' }, { GITHUB_RUN_ATTEMPT: '1.5' }, { GITHUB_SHA: 'not-a-sha' }]) assert.throws(() => nativePublicationIdentity({ ...env, ...change }));
  assert.equal(nativePublicationIdentity({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }).branch, 'main');
});

test('native preparation validates all actual hashes and writes complete unified immutable links', async t => {
  const f = fixture(t), prepared = await f.prepare();
  assert.equal(prepared.manifest.packages.length, 9);
  assert.equal(prepared.files.size, 9);
  assert.match(prepared.manifest.releaseUrl, /native-mutinynet-aaaaaaaaaaaa-run999-attempt1$/);
  assert.equal(readFileSync(prepared.sumsPath, 'utf8').trim().split('\n').length, 10);
  assert.equal(parseNativeRelease(JSON.parse(readFileSync(prepared.manifestPath, 'utf8'))).buildNumber, 124);
});

test('native preparation rejects missing platforms, wrong source/network, traversal and tampered bytes', async t => {
  const f = fixture(t), path = join(f.input, 'windows-x86_64', 'manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
  for (const change of [{ commit: 'b'.repeat(40) }, { network: 'bitcoin' }, { poolOrigin: 'https://example.com' }, { platform: 'ios' }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...change })); await assert.rejects(f.prepare(), /source|platform|network/);
  }
  writeFileSync(path, JSON.stringify({ ...original, packages: [{ ...original.packages[0], file: '../escape.exe' }] }));
  await assert.rejects(f.prepare(), /Unsafe/);
  writeFileSync(path, JSON.stringify(original)); writeFileSync(join(dirname(path), original.packages[0].file), 'tampered');
  await assert.rejects(f.prepare(), /SHA256/);
  rmSync(path); await assert.rejects(f.prepare(), /Missing native platform/);
});

test('Linux publication extracts only regular files beneath the expected platform folder', t => {
  const f = fixture(t), directory = join(f.directory, 'tar'), archive = join(f.directory, 'linux.tar.gz');
  mkdirSync(join(directory, 'linux-x86_64-release'), { recursive: true });
  writeFileSync(join(directory, 'linux-x86_64-release', 'manifest.json'), '{}');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'linux-x86_64-release']);
  const target = join(f.directory, 'extract'); mkdirSync(target);
  extractNativeLinuxArchive(archive, target);
  assert.equal(readFileSync(join(target, 'linux-x86_64-release', 'manifest.json'), 'utf8'), '{}');
  writeFileSync(join(directory, 'outside.txt'), 'outside');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'outside.txt']);
  assert.throws(() => extractNativeLinuxArchive(archive, target), /Unsafe/);
});

test('channel advancement rejects stale source heads and repeated or older build numbers', () => {
  const candidate = parseNativeRelease(nativeReleaseFixture());
  assert.doesNotThrow(() => assertNativeReleaseAdvancement(candidate, null, candidate.commit));
  assert.throws(() => assertNativeReleaseAdvancement(candidate, null, 'b'.repeat(40)), /head/);
  assert.throws(() => assertNativeReleaseAdvancement(candidate, candidate, candidate.commit), /downgrade/);
  assert.throws(() => assertNativeReleaseAdvancement(candidate, { ...candidate, buildNumber: candidate.buildNumber + 1 }, candidate.commit), /downgrade/);
});

test('publisher publishes every immutable asset before verifying and replacing the channel pointer', async t => {
  const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared);
  await publishNativeRelease(prepared, github);
  assert.ok(github.events.indexOf('publish:build') < github.events.indexOf('remove:pointer'));
  assert.ok(github.events.indexOf('download:candidate-run999-attempt1.json') < github.events.indexOf('remove:pointer'));
  assert.deepEqual(JSON.parse(Buffer.from(github.latest()!).toString()), prepared.manifest);
});

test('first publication creates the dedicated prerelease channel only after the complete build is published', async t => {
  const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared, { noChannel: true });
  await publishNativeRelease(prepared, github);
  assert.ok(github.events.indexOf('publish:build') < github.events.indexOf('create:native-mutinynet'));
  assert.equal(github.events.includes('remove:pointer'), false);
  assert.deepEqual(JSON.parse(Buffer.from(github.latest()!).toString()), prepared.manifest);
});

test('publisher leaves the channel intact when source changes, ancestry fails or the channel is immutable', async t => {
  for (const options of [{ changedHead: true }, { immutable: true }, { rejectSource: true }]) {
    const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared, options);
    await assert.rejects(() => publishNativeRelease(prepared, github));
    assert.deepEqual(github.latest(), github.old);
    assert.equal(github.events.includes('remove:pointer'), false);
  }
});

test('publisher restores the previous channel after pointer upload, verification or deletion response fails', async t => {
  for (const options of [{ failLatest: true }, { wrongLatest: true }, { lostDelete: true }]) {
    const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared, options);
    await assert.rejects(() => publishNativeRelease(prepared, github));
    assert.deepEqual(github.latest(), github.old);
    assert.ok(github.events.includes('publish:build'));
  }
});

test('ordinary Checks polling requires a successful latest exact-source push run and is bounded', async () => {
  const responses = [[], [{ id: 1, head_sha: env.GITHUB_SHA, status: 'in_progress', conclusion: null }], [{ id: 1, head_sha: env.GITHUB_SHA, status: 'completed', conclusion: 'success' }]];
  let calls = 0;
  const github = new GitHubNativeReleases('test', async url => {
    assert.match(String(url), /checks\.yml\/runs\?head_sha=a{40}&event=push/);
    return Response.json({ workflow_runs: responses[Math.min(calls++, 2)] });
  });
  await github.waitForChecks(env.GITHUB_SHA, async () => {}, 3); assert.equal(calls, 3);
  const failed = new GitHubNativeReleases('test', async () => Response.json({ workflow_runs: [{ id: 1, head_sha: env.GITHUB_SHA, status: 'completed', conclusion: 'success' }, { id: 2, head_sha: env.GITHUB_SHA, status: 'completed', conclusion: 'failure' }] }));
  await assert.rejects(() => failed.waitForChecks(env.GITHUB_SHA, async () => {}, 1), /did not succeed/);
  calls = 0; await assert.rejects(() => github.waitForChecks(env.GITHUB_SHA, async () => {}, 1), /Timed out/);
});

test('GitHub source comparison rejects forced backwards or divergent channel changes', async () => {
  const current = parseNativeRelease(nativeReleaseFixture()), candidate = { ...current, commit: 'b'.repeat(40), buildNumber: 124 };
  for (const status of ['behind', 'diverged', 'identical']) {
    const github = new GitHubNativeReleases('test', async () => Response.json({ status }));
    await assert.rejects(() => github.assertSourceAdvancement(current, candidate), /behind or diverge/);
  }
  await new GitHubNativeReleases('test', async () => Response.json({ status: 'ahead' })).assertSourceAdvancement(current, candidate);
});

test('channel downloads bound unannounced streams and cancel oversized bodies', async () => {
  for (const announced of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(40 * 1024)); }, cancel() { cancelled = true; } });
    const github = new GitHubNativeReleases('test', async () => new Response(body, announced ? { headers: { 'content-length': String(100 * 1024) } } : {}));
    await assert.rejects(() => github.download({ id: 1, name: 'latest.json', size: 100 * 1024 }), /Oversized/);
    assert.equal(cancelled, true);
  }
});

test('workflow keeps native gates and retention, limits publisher trust and serializes channel writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/native.yml', import.meta.url), 'utf8');
  const publisher = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(publisher, /github\.repository == 'arkade-os\/shielded'/);
  assert.match(publisher, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(publisher, /github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/master'/);
  assert.match(publisher, /needs: \[model, desktop, android, ios\]/);
  assert.match(publisher, /group: native-mutinynet-publication\s+cancel-in-progress: false/);
  assert.match(publisher, /permissions:\s+contents: write\s+actions: read/);
  assert.equal((workflow.match(/retention-days: 14/g) ?? []).length, 3);
  assert.match(workflow, /lipo .* -verify_arch arm64 x86_64/);
  assert.match(workflow, /test "\$\(uname -m\)" = arm64/);
  assert.match(workflow, /cargo test .*--target aarch64-apple-darwin/);
});
