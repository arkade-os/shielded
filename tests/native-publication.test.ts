import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { DESKTOP_UPDATE_FORMATS, DESKTOP_UPDATE_MAX_BYTES, NATIVE_PLATFORMS, NATIVE_RELEASE_ORIGIN, parseNativeRelease, type NativePlatform, type NativeRelease } from '../src/native-release.ts';
import { nativeReleaseFixture } from './fixtures/native-release.ts';
import androidSigning from '../src-tauri/android-signing.json' with {type:'json'};
import { assertNativeReleaseAdvancement, desktopUpdateMessage, extractNativeLinuxArchive, GitHubNativeReleases, nativePublicationIdentity, nativeUpdateSigningKey, prepareNativeRelease, publishNativeRelease, selectNativeArtifactDirectories, type NativeReleaseIndex, type PreparedNativeRelease } from '../tools/publish-native-release.ts';

const env = { GITHUB_REPOSITORY: 'arkade-os/shielded', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_NUMBER: '124', GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '1' };
const signingKey = new Uint8Array(32).fill(7), signingPublicKey = Buffer.from(ed25519.getPublicKey(signingKey)).toString('hex');
function artifactName(platform: NativePlatform, attempt: number) {
  return `shielded-mutinynet-${platform === 'ios' ? 'ios-unsigned' : platform}-release-${env.GITHUB_SHA}-attempt${attempt}`;
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-native-publish-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const input = join(directory, 'input'), output = join(directory, 'output'), original = nativeReleaseFixture();
  const artifact = (platform: NativePlatform, attempt = 1) => join(input, artifactName(platform, attempt));
  const add = (platform: NativePlatform, attempt: number) => {
    const selected = artifact(platform, attempt); mkdirSync(selected, { recursive: true });
    const packages = original.packages.filter(item => item.platform === platform).map(item => {
      const file = `mutinynet-${item.file.split('-mutinynet-').at(-1)!}`, bytes = Buffer.from(`actual ${file} binary attempt ${attempt}`);
      writeFileSync(join(selected, file), bytes);
      return { file, profile: item.profile, requiresSigning: item.requiresSigning, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    writeFileSync(join(selected, 'manifest.json'), JSON.stringify({ network: 'mutinynet', poolOrigin: NATIVE_RELEASE_ORIGIN, commit: env.GITHUB_SHA, platform, environment: { node: '24.22.2', rust: '1.96.0', sourceDateEpoch: 1794240000, lockfileSha256: 'c'.repeat(64), rustLockfileSha256: 'd'.repeat(64) }, packages }));
  };
  for (const platform of NATIVE_PLATFORMS) add(platform, 1);
  const signed = (attempt = 1) => join(input, `shielded-mutinynet-android-update-release-${env.GITHUB_SHA}-attempt${attempt}`);
  const addSigned = (attempt = 1) => {
    const selected = signed(attempt), file = 'mutinynet-release-signed.apk', bytes = Buffer.from(`signed APK attempt ${attempt}`);
    mkdirSync(selected, { recursive: true }); writeFileSync(join(selected, file), bytes);
    writeFileSync(join(selected, 'manifest.json'), JSON.stringify({ schema: 1, network: 'mutinynet', commit: env.GITHUB_SHA, buildNumber: Number(env.GITHUB_RUN_NUMBER), versionCode: 100000 + Number(env.GITHUB_RUN_NUMBER), packageName: androidSigning.packageName, signerSha256: androidSigning.certificateSha256, package: { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }));
  };
  return { directory, input, output, artifact, add, signed, addSigned, prepare: (attempt = 1) => prepareNativeRelease(input, output, nativePublicationIdentity({ ...env, GITHUB_RUN_ATTEMPT: String(attempt) }), '0.1.0', signingKey, new Date('2026-11-07T12:00:00Z')) };
}
function fakeGitHub(prepared: PreparedNativeRelease, options: { noChannel?: boolean; beforeAdvance?: boolean; afterAdvance?: boolean; conflict?: boolean; changedHead?: boolean; rejectSource?: boolean } = {}) {
  type Asset = { id: number; name: string; size: number };
  type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };
  const old: NativeReleaseIndex = { head: 'c'.repeat(40), manifest: parseNativeRelease(nativeReleaseFixture()) };
  let index: NativeReleaseIndex | null = options.noChannel ? null : old;
  const releases = new Map<string, Release>(), events: string[] = [];
  let nextId = 2, reads = 0;
  return {
    events, releases, old,
    currentHead: async () => { reads++; return options.changedHead && reads > 1 ? 'b'.repeat(40) : prepared.manifest.commit; },
    assertSourceAdvancement: async () => { if (options.rejectSource) throw new Error('Source downgrade'); },
    release: async (tag: string) => releases.get(tag) ?? null,
    create: async (tag: string, _commit: string, draft: boolean) => { events.push(`create:${tag}`); const release = { id: nextId++, tag_name: tag, draft, prerelease: true, assets: [] }; releases.set(tag, release); return release; },
    uploadFile: async (release: Release, name: string, path: string) => { events.push(`upload:${name}`); const asset = { id: nextId++, name, size: readFileSync(path).length }; release.assets.push(asset); return asset; },
    publish: async (release: Release) => { events.push('publish:build'); assert.equal(release.assets.length, 11 + Number(!!prepared.manifest.androidUpdate)); release.draft = false; },
    readIndex: async () => index,
    advanceIndex: async (expected: NativeReleaseIndex | null, manifest: NativeRelease) => {
      events.push('index:write');
      if (options.beforeAdvance) throw new Error('Stopped before ref advancement');
      if (options.conflict || index?.head !== expected?.head) throw new Error('Index compare-and-swap conflict');
      index = { head: 'd'.repeat(40), manifest }; events.push('index:advance');
      if (options.afterAdvance) throw new Error('Response lost after ref advancement');
    },
    latest: () => index,
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

test('publication signs exactly the in-app desktop installers and the channel parser keeps the signatures', async t => {
  const prepared = await fixture(t).prepare(), signed = prepared.manifest.packages.filter(item => item.signature);
  assert.deepEqual(signed.map(item => `${item.platform} ${item.file.split('-mutinynet-release-').at(-1)}`), ['windows-x86_64 Shielded_0.1.0_x64-setup.exe', 'linux-x86_64 Shielded.AppImage', 'macos-universal Shielded.app.zip']);
  for (const item of signed) assert.ok(ed25519.verify(Buffer.from(item.signature!, 'base64'), Buffer.from(desktopUpdateMessage(prepared.manifest, item)), ed25519.getPublicKey(signingKey)), item.file);
  assert.deepEqual(parseNativeRelease(JSON.parse(readFileSync(prepared.manifestPath, 'utf8'))).packages, prepared.manifest.packages);
});

test('publication fails rather than ship a desktop platform without its signed in-app installer', async t => {
  const f = fixture(t), path = join(f.artifact('linux-x86_64'), 'manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...original, packages: original.packages.filter((item: { file: string }) => !item.file.endsWith('.AppImage')) }));
  await assert.rejects(f.prepare(), /one in-app linux-x86_64 update package/);
});

test('an installer above the host cap is published unsigned with a warning instead of failing publication', async t => {
  const warnings: string[] = [], cap = DESKTOP_UPDATE_MAX_BYTES['linux-x86_64'];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  DESKTOP_UPDATE_MAX_BYTES['linux-x86_64'] = 10; t.after(() => { DESKTOP_UPDATE_MAX_BYTES['linux-x86_64'] = cap; });
  const packages = (await fixture(t).prepare()).manifest.packages;
  assert.equal(packages.find(item => item.file.endsWith('.AppImage'))!.signature, undefined);
  assert.ok(packages.find(item => item.file.endsWith('-setup.exe'))!.signature);
  assert.match(warnings.join('\n'), /^::warning::.*AppImage.*publishing it unsigned/);
});

test('publication caps each desktop installer exactly as the host transport does', () => {
  const transport = readFileSync(new URL('../src-tauri/src/transport/update.rs', import.meta.url), 'utf8');
  for (const [platform, suffix] of Object.entries(DESKTOP_UPDATE_FORMATS)) {
    const cap = new RegExp(`\\("shielded-mutinynet-${platform}-", "${suffix.replaceAll('.', '\\.')}", (\\d+) \\* MIB\\)`).exec(transport)?.[1];
    assert.equal(Number(cap) * 1024 * 1024, DESKTOP_UPDATE_MAX_BYTES[platform as NativePlatform], platform);
  }
});

test('the update signing key must be a base64 32-byte seed of the pinned key and is never echoed', () => {
  const seed = Buffer.from(signingKey).toString('base64');
  assert.deepEqual(nativeUpdateSigningKey({ SHIELDED_UPDATE_SIGNING_KEY: `${seed}\n` }, signingPublicKey), Buffer.from(signingKey));
  for (const value of [undefined, '', 'not base64!', `${seed}=`, Buffer.alloc(31, 7).toString('base64'), Buffer.alloc(64, 7).toString('base64')]) {
    assert.throws(() => nativeUpdateSigningKey({ SHIELDED_UPDATE_SIGNING_KEY: value }, signingPublicKey), /base64 of a 32-byte ed25519 seed/, String(value));
  }
  assert.throws(() => nativeUpdateSigningKey({ SHIELDED_UPDATE_SIGNING_KEY: seed }), (error: Error) => /does not match the update key pinned/.test(error.message) && !error.message.includes(seed));
});

test('the desktop update message and signature match the vector pinned in the Rust verifier', () => {
  const message = desktopUpdateMessage({ channel: 'native-mutinynet', network: 'mutinynet', commit: '7a90ca067003650a87163c1ffc0f6203c72e6722', buildNumber: 275 }, { platform: 'windows-x86_64', file: 'shielded-mutinynet-windows-x86_64-7a90ca067003-run44073476179-attempt1-mutinynet-release-Shielded_0.1.0_x64-setup.exe', bytes: 226613350, sha256: '59967f6469a778999c465f1e4f8d8bdda009612f8a2f37e9f3fa7c68b2a9d9e4' });
  assert.equal(message, 'shielded-native-update-v1\nchannel=native-mutinynet\nnetwork=mutinynet\nplatform=windows-x86_64\nfile=shielded-mutinynet-windows-x86_64-7a90ca067003-run44073476179-attempt1-mutinynet-release-Shielded_0.1.0_x64-setup.exe\nbytes=226613350\nsha256=59967f6469a778999c465f1e4f8d8bdda009612f8a2f37e9f3fa7c68b2a9d9e4\ncommit=7a90ca067003650a87163c1ffc0f6203c72e6722\nbuildNumber=275');
  assert.equal(signingPublicKey, 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
  assert.equal(Buffer.from(ed25519.sign(Buffer.from(message), signingKey)).toString('base64'), 'mwS7OvlAyVyjn55vYhrvkVl0DxNjLk7VrRVzvOhk9P1uOxjlGv7p9y7PcTvYmthkOM4b4QbaVoU6tlv29IlFBQ==');
});

test('signed Android artifact is published separately without changing legacy packages', async t => {
  const f = fixture(t); f.addSigned(); const prepared = await f.prepare(), update = prepared.manifest.androidUpdate!;
  assert.equal(prepared.manifest.packages.length, 9); assert.equal(prepared.files.size, 10);
  assert.equal(update.file, 'shielded-mutinynet-android-arm64-aaaaaaaaaaaa-run999-attempt1-mutinynet-release-signed.apk');
  assert.equal(update.versionCode, 100124); assert.equal(update.signerSha256, androidSigning.certificateSha256);
  assert.equal(prepared.files.get(update.file), join(f.signed(), 'mutinynet-release-signed.apk'));
  assert.match(readFileSync(prepared.sumsPath, 'utf8'), new RegExp(`${update.sha256}  ${update.file}`));
  const github = fakeGitHub(prepared); await publishNativeRelease(prepared, github);
  assert.ok(github.events.indexOf(`upload:${update.file}`) < github.events.indexOf('publish:build'));
  assert.deepEqual(github.latest()?.manifest.androidUpdate, update);
});

test('a rejected signed APK upload leaves the old public channel intact', async t => {
  const f = fixture(t); f.addSigned(); const prepared = await f.prepare(), github = fakeGitHub(prepared), upload = github.uploadFile;
  github.uploadFile = async (release, name, path) => {
    const asset = await upload(release, name, path);
    return name === prepared.manifest.androidUpdate!.file ? { ...asset, size: asset.size + 1 } : asset;
  };
  await assert.rejects(publishNativeRelease(prepared, github), /checksum or size mismatch/);
  assert.deepEqual(github.latest(), github.old);
  assert.equal(github.events.includes('publish:build'), false); assert.equal(github.events.includes('index:advance'), false);
});

test('signed artifact attempts stay pinned to the source run and the newest eligible attempt', async t => {
  const f = fixture(t); f.addSigned(); f.addSigned(2); const prepared = await f.prepare(3);
  assert.ok(prepared.files.get(prepared.manifest.androidUpdate!.file)!.startsWith(f.signed(2)));
  await assert.rejects(f.prepare(), /future/);
});

test('signed artifact preparation refuses altered bytes, signing identity and Android build mismatches', async t => {
  const f = fixture(t); f.addSigned(); const path = join(f.signed(), 'manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
  for (const change of [{ schema: 2 }, { network: 'bitcoin' }, { commit: 'b'.repeat(40) }, { buildNumber: 125 }, { versionCode: 1000 }, { packageName: 'io.other.wallet' }, { signerSha256: 'c'.repeat(64) }, { package: { ...original.package, file: '../escape.apk' } }, { package: { ...original.package, bytes: original.package.bytes + 1 } }, { package: { ...original.package, sha256: 'e'.repeat(64) } }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...change })); await assert.rejects(f.prepare());
  }
  writeFileSync(path, JSON.stringify(original)); writeFileSync(join(f.signed(), original.package.file), 'altered APK');
  await assert.rejects(f.prepare(), /SHA256/);
});

test('reruns select the newest available attempt independently for every platform within the current source run', async t => {
  const f = fixture(t); f.add('windows-x86_64', 3); f.add('android-arm64', 2);
  const prepared = await f.prepare(3);
  assert.equal(prepared.manifest.packages.length, 9);
  for (const item of prepared.manifest.packages) {
    const attempt = item.platform === 'windows-x86_64' ? 3 : item.platform === 'android-arm64' ? 2 : 1;
    assert.ok(prepared.files.get(item.file)!.startsWith(f.artifact(item.platform, attempt)));
  }
  const single = fixture(t); single.add('ios', 2);
  assert.equal((await single.prepare(2)).manifest.packages.length, 9);
});

test('artifact selection rejects missing platforms, duplicate attempts, malformed names and foreign sources', () => {
  const names = NATIVE_PLATFORMS.map(platform => artifactName(platform, 1)), identity = nativePublicationIdentity(env);
  assert.throws(() => selectNativeArtifactDirectories(names.slice(1), identity), /Missing native platform/);
  assert.throws(() => selectNativeArtifactDirectories([...names, names[0]], identity), /Duplicate/);
  assert.throws(() => selectNativeArtifactDirectories([...names, 'malformed'], identity), /Malformed/);
  assert.throws(() => selectNativeArtifactDirectories([names[0].replace(env.GITHUB_SHA, 'b'.repeat(40)), ...names.slice(1)], identity), /source commit/);
  assert.throws(() => selectNativeArtifactDirectories([...names, artifactName('ios', 2)], identity), /future/);
});

test('native preparation rejects missing platforms, wrong source/network, traversal and tampered bytes', async t => {
  const f = fixture(t), path = join(f.artifact('windows-x86_64'), 'manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
  for (const change of [{ commit: 'b'.repeat(40) }, { network: 'bitcoin' }, { poolOrigin: 'https://example.com' }, { platform: 'ios' }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...change })); await assert.rejects(f.prepare(), /source|platform|network/);
  }
  for (const change of [{ node: '24.22.3' }, { rust: '1.97.0' }]) {
    writeFileSync(path, JSON.stringify({ ...original, environment: { ...original.environment, ...change } })); await assert.rejects(f.prepare(), /reproduction environment/);
  }
  writeFileSync(path, JSON.stringify({ ...original, packages: [{ ...original.packages[0], file: '../escape.exe' }] }));
  await assert.rejects(f.prepare(), /Unsafe/);
  writeFileSync(path, JSON.stringify(original)); writeFileSync(join(dirname(path), original.packages[0].file), 'tampered');
  await assert.rejects(f.prepare(), /SHA256/);
  rmSync(path); await assert.rejects(f.prepare(), /Missing or duplicate native platform manifests/);
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

test('publisher completes every immutable asset before atomically advancing the branch index', async t => {
  const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared);
  await publishNativeRelease(prepared, github);
  assert.ok(github.events.indexOf('publish:build') < github.events.indexOf('index:write'));
  assert.deepEqual(github.latest()?.manifest, prepared.manifest);
  assert.equal(github.latest()?.head, 'd'.repeat(40));
});

test('first publication creates the branch index only after the complete build is published', async t => {
  const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared, { noChannel: true });
  await publishNativeRelease(prepared, github);
  assert.ok(github.events.indexOf('publish:build') < github.events.indexOf('index:advance'));
  assert.deepEqual(github.latest()?.manifest, prepared.manifest);
  assert.equal(github.releases.size, 1);
});

test('publisher leaves the existing index intact when source changes, ancestry fails or ref advancement fails', async t => {
  for (const options of [{ changedHead: true }, { rejectSource: true }, { beforeAdvance: true }, { conflict: true }]) {
    const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared, options);
    await assert.rejects(() => publishNativeRelease(prepared, github));
    assert.deepEqual(github.latest(), github.old);
    assert.equal(github.events.includes('index:advance'), false);
  }
});

test('lost ref update responses leave a complete index and retry returns its actual release without mutations', async t => {
  const f = fixture(t), prepared = await f.prepare(), github = fakeGitHub(prepared, { afterAdvance: true });
  await assert.rejects(() => publishNativeRelease(prepared, github), /Response lost/);
  assert.deepEqual(github.latest()?.manifest, prepared.manifest);
  const mutations = [...github.events], retry = await f.prepare(2);
  const published = await publishNativeRelease(retry, github);
  assert.equal(published.releaseUrl, prepared.manifest.releaseUrl);
  assert.notEqual(published.releaseUrl, retry.manifest.releaseUrl);
  assert.deepEqual(github.events, mutations);
});

test('idempotent retries still require the current source head and reject older or foreign source builds', async t => {
  const prepared = await fixture(t).prepare(), github = fakeGitHub(prepared);
  await publishNativeRelease(prepared, github);
  const older = { ...prepared, manifest: { ...prepared.manifest, buildNumber: 122 } };
  await assert.rejects(() => publishNativeRelease(older, github), /downgrade/);
  const wrongHead = { ...github, currentHead: async () => 'b'.repeat(40) };
  await assert.rejects(() => publishNativeRelease(prepared, wrongHead), /head/);
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

test('branch index reads pin metadata to the captured commit and bound unannounced streams', async () => {
  const head = 'c'.repeat(40), index = nativeReleaseFixture();
  const github = new GitHubNativeReleases('test', async url => {
    if (String(url).includes('/git/ref/')) return Response.json({ object: { sha: head } });
    assert.equal(String(url), `https://api.github.com/repos/arkade-os/shielded/contents/latest.json?ref=${head}`);
    return new Response(JSON.stringify(index));
  });
  assert.deepEqual(await github.readIndex(), { head, manifest: parseNativeRelease(index) });
  for (const announced of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(40 * 1024)); }, cancel() { cancelled = true; } });
    const github = new GitHubNativeReleases('test', async url => String(url).includes('/git/ref/') ? Response.json({ object: { sha: head } }) : new Response(body, announced ? { headers: { 'content-length': String(100 * 1024) } } : {}));
    await assert.rejects(() => github.readIndex(), /Oversized/);
    assert.equal(cancelled, true);
  }
});

test('Git index advancement creates one-file orphan history or a fast-forward child of the expected index', async () => {
  const manifest = parseNativeRelease(nativeReleaseFixture()), previous = 'c'.repeat(40), next = 'd'.repeat(40);
  for (const first of [false, true]) {
    let live: string | null = first ? null : previous;
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    const github = new GitHubNativeReleases('test', async (url, options) => {
      const path = String(url).replace('https://api.github.com/repos/arkade-os/shielded', '');
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      if (body) writes.push({ path, body });
      if (path === '/git/blobs') { assert.equal(body.encoding, 'utf-8'); assert.deepEqual(JSON.parse(body.content), manifest); return Response.json({ sha: 'e'.repeat(40) }); }
      if (path === '/git/trees') { assert.deepEqual(body, { tree: [{ path: 'latest.json', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }] }); return Response.json({ sha: 'f'.repeat(40) }); }
      if (path === '/git/commits') { assert.deepEqual(body.parents, first ? [] : [previous]); return Response.json({ sha: next }); }
      if (path === '/git/ref/heads/native-mutinynet') return live ? Response.json({ object: { sha: live } }) : new Response(null, { status: 404 });
      if (path === '') return Response.json({ default_branch: 'main', private: false });
      if (path === '/git/ref/heads/main') return Response.json({ object: { sha: manifest.commit } });
      if (path === '/git/refs/heads/native-mutinynet') { assert.equal(options?.method, 'PATCH'); assert.deepEqual(body, { sha: next, force: false }); live = next; return Response.json({}); }
      assert.equal(path, '/git/refs'); assert.deepEqual(body, { ref: 'refs/heads/native-mutinynet', sha: next }); live = next; return Response.json({});
    });
    await github.advanceIndex(first ? null : { head: previous, manifest }, manifest, 'main');
    assert.equal(live, next);
    assert.equal(writes.length, 4);
  }
});

test('Git index preparation failures and concurrent ref conflicts leave complete old or new indexes', async () => {
  const manifest = parseNativeRelease(nativeReleaseFixture()), previous = 'c'.repeat(40), next = 'd'.repeat(40);
  for (const failure of ['blob', 'tree', 'commit', 'recheck', 'source', 'cas', 'before-ref', 'after-ref']) {
    let live = previous, refWrites = 0;
    const github = new GitHubNativeReleases('test', async (url, options) => {
      const path = String(url).replace('https://api.github.com/repos/arkade-os/shielded', '');
      if (path === `/git/${failure}s` || (failure === 'tree' && path === '/git/trees')) throw new Error('Stopped during index preparation');
      if (path === '/git/blobs' || path === '/git/trees' || path === '/git/commits') return Response.json({ sha: next });
      if (path === '/git/ref/heads/native-mutinynet') return Response.json({ object: { sha: failure === 'recheck' ? 'b'.repeat(40) : live } });
      if (path === '') return Response.json({ default_branch: 'main', private: false });
      if (path === '/git/ref/heads/main') return Response.json({ object: { sha: failure === 'source' ? 'b'.repeat(40) : manifest.commit } });
      assert.equal(path, '/git/refs/heads/native-mutinynet'); assert.equal(JSON.parse(String(options?.body)).force, false); refWrites++;
      if (failure === 'cas') return new Response(null, { status: 422 });
      if (failure === 'before-ref') throw new Error('Stopped before ref write');
      live = next; throw new Error('Response lost after ref write');
    });
    await assert.rejects(() => github.advanceIndex({ head: previous, manifest }, manifest, 'main'));
    assert.equal(live, failure === 'after-ref' ? next : previous);
    if (['blob', 'tree', 'commit', 'recheck', 'source'].includes(failure)) assert.equal(refWrites, 0);
  }
});

test('concurrent first index creation rejects without overwriting the competing branch', async () => {
  const manifest = parseNativeRelease(nativeReleaseFixture()), competing = 'b'.repeat(40);
  let live: string | null = null;
  const github = new GitHubNativeReleases('test', async (url, options) => {
    const path = String(url).replace('https://api.github.com/repos/arkade-os/shielded', '');
    if (['/git/blobs', '/git/trees', '/git/commits'].includes(path)) return Response.json({ sha: 'd'.repeat(40) });
    if (path === '/git/ref/heads/native-mutinynet') return new Response(null, { status: 404 });
    if (path === '') return Response.json({ default_branch: 'main', private: false });
    if (path === '/git/ref/heads/main') return Response.json({ object: { sha: manifest.commit } });
    assert.equal(path, '/git/refs'); assert.equal(options?.method, 'POST');
    live = competing; return new Response(null, { status: 422 });
  });
  await assert.rejects(() => github.advanceIndex(null, manifest, 'main'), /422/);
  assert.equal(live, competing);
});

test('workflow keeps native gates and retention, limits publisher trust and serializes channel writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/native.yml', import.meta.url), 'utf8');
  const publisher = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(publisher, /github\.repository == 'arkade-os\/shielded'/);
  assert.match(publisher, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(publisher, /github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/master'/);
  assert.match(publisher, /needs: \[model, desktop, android, android-update-data, android-sign, ios\]/);
  assert.match(publisher, /group: native-mutinynet-publication\s+cancel-in-progress: false/);
  assert.match(publisher, /permissions:\s+contents: write\s+actions: read/);
  assert.match(publisher, /pattern: shielded-mutinynet-\*-release-\$\{\{ github\.sha \}\}-attempt\*/);
  assert.match(publisher, /run-id: \$\{\{ github\.run_id \}\}/);
  assert.equal((workflow.match(/retention-days: 14/g) ?? []).length, 4);
  assert.match(workflow, /lipo .* -verify_arch arm64 x86_64/);
  assert.match(workflow, /test "\$\(uname -m\)" = arm64/);
  assert.match(workflow, /cargo test .*--target aarch64-apple-darwin/);
  assert.equal((workflow.match(/secrets\.SHIELDED_UPDATE_SIGNING_KEY/g) ?? []).length, 1);
  assert.match(publisher, /tools\/publish-native-release\.ts native-downloads native-release\s+env:\s+GITHUB_TOKEN: \$\{\{ github\.token \}\}\s+SHIELDED_UPDATE_SIGNING_KEY: \$\{\{ secrets\.SHIELDED_UPDATE_SIGNING_KEY \}\}/);
});
