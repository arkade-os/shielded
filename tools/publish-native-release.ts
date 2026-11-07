import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_PACKAGE_MAX_BYTES, NATIVE_PLATFORMS, NATIVE_RELEASE_ORIGIN, parseNativeRelease, type NativePlatform, type NativeRelease, type NativeReleasePackage } from '../src/native-release.ts';

const repository = 'arkade-os/shielded';
const apiOrigin = `https://api.github.com/repos/${repository}`;
const channel = 'native-mutinynet';
interface Identity { commit: string; buildNumber: number; runId: number; attempt: number; branch: string; }
interface Asset { id: number; name: string; size: number; digest?: string; }
interface Release { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean; assets: Asset[]; }
export interface NativeReleaseIndex { head: string; manifest: NativeRelease; }
export interface PreparedNativeRelease { manifest: NativeRelease; files: Map<string, string>; manifestPath: string; sumsPath: string; identity: Identity; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native artifact manifest');
  return value as Record<string, unknown>;
}
function safeNumber(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid trusted native build number');
  return Number(value);
}
export function nativePublicationIdentity(env: NodeJS.ProcessEnv): Identity {
  if (env.GITHUB_REPOSITORY !== repository || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '') || !/^refs\/heads\/(main|master)$/.test(env.GITHUB_REF ?? '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Native publication requires a trusted primary branch run');
  return { commit: env.GITHUB_SHA!, buildNumber: safeNumber(env.GITHUB_RUN_NUMBER), runId: safeNumber(env.GITHUB_RUN_ID), attempt: safeNumber(env.GITHUB_RUN_ATTEMPT), branch: env.GITHUB_REF!.slice('refs/heads/'.length) };
}
function artifactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Native artifacts cannot contain symbolic links');
    if (entry.isDirectory()) return artifactFiles(path);
    if (!entry.isFile()) throw new Error('Unsupported native artifact entry');
    return [path];
  });
}
export function extractNativeLinuxArchive(archive: string, directory: string): void {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/);
  const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/);
  if (!names.length || listing.length !== names.length || listing.some(line => !/^[-d]/.test(line)) || names.some(name => !/^linux-x86_64-release\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(name) || name.includes('..')) || new Set(names).size !== names.length) throw new Error('Unsafe native Linux archive');
  execFileSync('tar', ['-xzf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions', '--keep-old-files'], { maxBuffer: 1024 * 1024 });
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function selectNativeArtifactDirectories(names: readonly string[], identity: Identity): Map<NativePlatform, string> {
  const selected = new Map<NativePlatform, { name: string; attempt: number }>();
  const seen = new Set<string>();
  for (const name of names) {
    const match = /^shielded-mutinynet-(windows-x86_64|linux-x86_64|macos-universal|android-arm64|ios-unsigned)-release-([a-f0-9]{40})-attempt([1-9]\d*)$/.exec(name);
    if (!match || match[2] !== identity.commit) throw new Error('Malformed native artifact name or source commit');
    const platform = (match[1] === 'ios-unsigned' ? 'ios' : match[1]) as NativePlatform, attempt = safeNumber(match[3]);
    if (attempt > identity.attempt || seen.has(name)) throw new Error('Duplicate or future native artifact attempt');
    seen.add(name);
    const previous = selected.get(platform);
    if (!previous || attempt > previous.attempt) selected.set(platform, { name, attempt });
  }
  if (selected.size !== NATIVE_PLATFORMS.length) throw new Error('Missing native platform artifacts');
  return new Map([...selected].map(([platform, value]) => [platform, value.name]));
}
export async function prepareNativeRelease(input: string, output: string, identity: Identity, version: string, now = new Date()): Promise<PreparedNativeRelease> {
  const entries = readdirSync(input, { withFileTypes: true });
  if (entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Native downloads must contain platform artifact directories');
  const selected = selectNativeArtifactDirectories(entries.map(entry => entry.name), identity);
  const tag = `${channel}-${identity.commit.slice(0, 12)}-run${identity.runId}-attempt${identity.attempt}`;
  const files = new Map<string, string>(), platforms = new Set<NativePlatform>(), packages: NativeReleasePackage[] = [];
  for (const [expectedPlatform, name] of selected) {
    const directory = join(input, name), archives = artifactFiles(directory).filter(path => path.endsWith('.tar.gz'));
    if (archives.length > 1 || (archives.length && (expectedPlatform !== 'linux-x86_64' || basename(archives[0]) !== 'linux-x86_64-release.tar.gz'))) throw new Error('Unexpected native Linux archive');
    for (const archive of archives) extractNativeLinuxArchive(archive, resolve(archive, '..'));
    const manifests = artifactFiles(directory).filter(path => basename(path) === 'manifest.json');
    if (manifests.length !== 1) throw new Error('Missing or duplicate native platform manifests');
    const path = manifests[0];
    if (lstatSync(path).size > 64 * 1024) throw new Error('Oversized native artifact manifest');
    const manifest = object(JSON.parse(readFileSync(path, 'utf8'))), platform = manifest.platform as NativePlatform;
    if (manifest.network !== 'mutinynet' || manifest.poolOrigin !== NATIVE_RELEASE_ORIGIN || manifest.commit !== identity.commit || platform !== expectedPlatform || platforms.has(platform) || !Array.isArray(manifest.packages)) throw new Error('Native artifact source, platform or network mismatch');
    platforms.add(platform);
    for (const raw of manifest.packages) {
      const item = object(raw);
      if (typeof item.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(item.file) || item.file.includes('..')) throw new Error('Unsafe native artifact filename');
      const packagePath = join(resolve(path, '..'), item.file), stats = lstatSync(packagePath);
      if (!stats.isFile() || stats.isSymbolicLink() || !stats.size || stats.size > NATIVE_PACKAGE_MAX_BYTES || stats.size !== item.bytes || await digest(packagePath) !== item.sha256) throw new Error(`Native artifact size or SHA256 mismatch: ${item.file}`);
      const file = `shielded-mutinynet-${platform}-${identity.commit.slice(0, 12)}-run${identity.runId}-attempt${identity.attempt}-${item.file}`;
      if (files.has(file)) throw new Error('Duplicate native artifact filename');
      files.set(file, packagePath);
      packages.push({ platform, file, profile: item.profile, requiresSigning: item.requiresSigning, bytes: item.bytes, sha256: item.sha256, url: `https://github.com/${repository}/releases/download/${tag}/${file}` } as NativeReleasePackage);
    }
  }
  const manifest = parseNativeRelease({ schema: 1, channel, network: 'mutinynet', commit: identity.commit, buildNumber: identity.buildNumber, version, publishedAt: now.toISOString(), releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`, packages });
  mkdirSync(output, { recursive: true });
  const manifestPath = join(output, 'manifest.json'), sumsPath = join(output, 'SHA256SUMS');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(sumsPath, [...packages.map(item => `${item.sha256}  ${item.file}`), `${await digest(manifestPath)}  manifest.json`, ''].join('\n'));
  return { manifest, files, manifestPath, sumsPath, identity };
}

export function assertNativeReleaseAdvancement(candidate: NativeRelease, current: NativeRelease | null, head: string): void {
  if (candidate.commit !== head) throw new Error('Native release source is no longer the default branch head');
  if (current && candidate.buildNumber <= current.buildNumber) throw new Error('Native release channel cannot downgrade or repeat a build');
}

export class GitHubNativeReleases {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, options: RequestInit = {}, allow404 = false): Promise<Response> {
    const response = await this.fetcher(path.startsWith('https:') ? path : `${apiOrigin}${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'shielded-native-release', 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok && !(allow404 && response.status === 404)) throw new Error(`GitHub native release request failed: ${response.status}`);
    return response;
  }
  async currentHead(branch: string): Promise<string> {
    const repo = await (await this.request('')).json() as { default_branch: string; private: boolean };
    if (repo.private !== false) throw new Error('Native downloads require a public repository');
    if (repo.default_branch !== branch) throw new Error('Only the repository default branch may publish native downloads');
    const ref = await (await this.request(`/git/ref/heads/${branch}`)).json() as { object: { sha: string } };
    return ref.object.sha;
  }
  async assertSourceAdvancement(current: NativeRelease | null, candidate: NativeRelease): Promise<void> {
    if (!current || current.commit === candidate.commit) return;
    const comparison = await (await this.request(`/compare/${current.commit}...${candidate.commit}`)).json() as { status: string };
    if (comparison.status !== 'ahead') throw new Error('Native release source cannot move behind or diverge from the published channel');
  }
  async waitForChecks(commit: string, pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms)), attempts = 60): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const data = await (await this.request(`/actions/workflows/checks.yml/runs?head_sha=${commit}&event=push&per_page=100`)).json() as { workflow_runs: { id: number; head_sha: string; status: string; conclusion: string | null }[] };
      const run = data.workflow_runs.filter(run => run.head_sha === commit).sort((a, b) => b.id - a.id)[0];
      if (run?.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error('Ordinary Checks did not succeed for the exact native source commit');
        return;
      }
      if (attempt + 1 < attempts) await pause(20_000);
    }
    throw new Error('Timed out waiting for ordinary Checks on the exact native source commit');
  }
  async release(tag: string): Promise<Release | null> {
    const response = await this.request(`/releases/tags/${tag}`, {}, true);
    return response.status === 404 ? null : await response.json() as Release;
  }
  async create(tag: string, commit: string, draft: boolean): Promise<Release> {
    return await (await this.request('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Shielded native Mutinynet — ${commit.slice(0, 12)}`, draft, prerelease: true, make_latest: 'false', body: 'Mutinynet test funds only. macOS builds are not notarized. Android release APKs are unsigned; debug APKs use a runner development key that is not a stable upgrade identity. iPhone IPAs require your own signing and provisioning. iOS simulator archives do not install on a phone. Preserve your recovery phrase before replacing an installation. See https://shielded.mutinynet.arkade.sh/#download for installation instructions.' }) })).json() as Release;
  }
  async uploadFile(release: Release, name: string, path: string): Promise<Asset> {
    return await (await this.request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(lstatSync(path).size) }, body: createReadStream(path) as unknown as BodyInit, duplex: 'half' } as RequestInit)).json() as Asset;
  }
  async publish(release: Release): Promise<void> {
    await this.request(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: true, make_latest: 'false' }) });
  }
  private async indexHead(): Promise<string | null> {
    const response = await this.request(`/git/ref/heads/${channel}`, {}, true);
    if (response.status === 404) return null;
    const ref = await response.json() as { object: { sha: string } };
    if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Invalid native index commit');
    return ref.object.sha;
  }
  async readIndex(): Promise<NativeReleaseIndex | null> {
    const head = await this.indexHead();
    if (!head) return null;
    const response = await this.request(`/contents/latest.json?ref=${head}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!response.body || Number(response.headers.get('content-length')) > 64 * 1024) {
      await response.body?.cancel();
      throw new Error('Oversized or empty native channel manifest');
    }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > 64 * 1024) throw new Error('Oversized native channel manifest');
      chunks.push(chunk);
    }
    return { head, manifest: parseNativeRelease(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
  }
  async advanceIndex(expected: NativeReleaseIndex | null, manifest: NativeRelease, sourceBranch: string): Promise<void> {
    const blob = await (await this.request('/git/blobs', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(manifest, null, 2) + '\n', encoding: 'utf-8' }) })).json() as { sha: string };
    const tree = await (await this.request('/git/trees', { method: 'POST', body: JSON.stringify({ tree: [{ path: 'latest.json', mode: '100644', type: 'blob', sha: blob.sha }] }) })).json() as { sha: string };
    const commit = await (await this.request('/git/commits', { method: 'POST', body: JSON.stringify({ message: `Native Mutinynet build ${manifest.buildNumber}: ${manifest.commit}`, tree: tree.sha, parents: expected ? [expected.head] : [] }) })).json() as { sha: string };
    if (await this.indexHead() !== (expected?.head ?? null)) throw new Error('Native release index changed during publication');
    assertNativeReleaseAdvancement(manifest, null, await this.currentHead(sourceBranch));
    if (expected) await this.request(`/git/refs/heads/${channel}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    else await this.request('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${channel}`, sha: commit.sha }) });
  }
}

export async function publishNativeRelease(prepared: PreparedNativeRelease, github: Pick<GitHubNativeReleases, 'currentHead' | 'assertSourceAdvancement' | 'release' | 'create' | 'uploadFile' | 'publish' | 'readIndex' | 'advanceIndex'>): Promise<NativeRelease> {
  const { manifest, identity } = prepared, tag = manifest.releaseUrl.split('/').at(-1)!;
  const index = await github.readIndex(), current = index?.manifest ?? null;
  assertNativeReleaseAdvancement(manifest, null, await github.currentHead(identity.branch));
  await github.assertSourceAdvancement(current, manifest);
  if (current?.commit === manifest.commit && current.buildNumber === manifest.buildNumber) return current;
  assertNativeReleaseAdvancement(manifest, current, manifest.commit);
  if (await github.release(tag)) throw new Error('Immutable native build release already exists');
  const build = await github.create(tag, identity.commit, true);
  for (const item of manifest.packages) {
    const asset = await github.uploadFile(build, item.file, prepared.files.get(item.file)!);
    if (asset.size !== item.bytes || (asset.digest && asset.digest !== `sha256:${item.sha256}`)) throw new Error('Published native package checksum or size mismatch');
  }
  await github.uploadFile(build, 'manifest.json', prepared.manifestPath);
  await github.uploadFile(build, 'SHA256SUMS', prepared.sumsPath);
  await github.publish(build);
  assertNativeReleaseAdvancement(manifest, current, await github.currentHead(identity.branch));
  await github.advanceIndex(index, manifest, identity.branch);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const identity = nativePublicationIdentity(process.env);
    if (!process.env.GITHUB_TOKEN) throw new Error('Native publication requires GITHUB_TOKEN');
    const github = new GitHubNativeReleases(process.env.GITHUB_TOKEN);
    await github.waitForChecks(identity.commit);
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
    const prepared = await prepareNativeRelease(resolve(process.argv[2] ?? 'native-downloads'), resolve(process.argv[3] ?? 'native-release'), identity, version);
    const published = await publishNativeRelease(prepared, github);
    console.log(`Published ${published.releaseUrl}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
