import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidVersionCode } from './native-build.mjs';

export const ANDROID_BUILD_TOOLS = '36.0.0';
const MAX_APK_BYTES = 128 * 1024 * 1024;
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function runTool(command, args, env) {
  const result = spawnSync(command, args, { env, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Android signing tool failed: ${basename(command)}`);
  return result.stdout;
}

function childEnvironment(env) {
  const result = { ...env };
  for (const name of ['ANDROID_RELEASE_KEYSTORE_BASE64', 'ANDROID_RELEASE_KEYSTORE_PASSWORD', 'SHIELDED_APK_STORE_PASSWORD', 'GITHUB_TOKEN', 'GH_TOKEN']) delete result[name];
  return result;
}

function regularFile(path, maximum) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximum) throw new Error('Invalid Android signing input file');
  return readFileSync(path);
}

function assertPackage(badging, packageName, versionCode) {
  const value = /^package: name='([^']+)' versionCode='(\d+)'/m.exec(badging);
  if (!value || value[1] !== packageName || value[2] !== String(versionCode) || /^application-debuggable\b/m.test(badging)) throw new Error('Android package identity, version code or release profile mismatch');
}

export function selectAndroidSigningSource(input, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('Invalid Android signing source run');
  const entries = readdirSync(input, { withFileTypes: true }).map(entry => {
    const match = /^shielded-mutinynet-android-arm64-release-([a-f0-9]{40})-attempt([1-9]\d*)$/.exec(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !match || match[1] !== env.GITHUB_SHA || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > Number(env.GITHUB_RUN_ATTEMPT)) throw new Error('Unexpected Android signing source artifact');
    return { path: join(input, entry.name), attempt: Number(match[2]) };
  });
  if (!entries.length) throw new Error('Missing Android signing source artifact');
  return entries.sort((a, b) => b.attempt - a.attempt)[0].path;
}

export function signAndroidArtifact(input, output, env = process.env, signing = JSON.parse(readFileSync(join(root, 'src-tauri/android-signing.json'))), run = runTool) {
  const versionCode = androidVersionCode(env), buildNumber = Number(env.GITHUB_RUN_NUMBER);
  if (env.GITHUB_REPOSITORY !== 'arkade-os/shielded' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !/^refs\/heads\/(main|master)$/.test(env.GITHUB_REF ?? '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !versionCode) throw new Error('Android signing requires a trusted primary branch source');
  if (signing.schema !== 1 || signing.packageName !== 'io.arkade.shielded' || signing.alias !== 'shielded-release' || !/^[a-f0-9]{64}$/.test(signing.certificateSha256 ?? '')) throw new Error('Invalid public Android signing identity');
  const encoded = env.ANDROID_RELEASE_KEYSTORE_BASE64, password = env.ANDROID_RELEASE_KEYSTORE_PASSWORD;
  if (!encoded || !password || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Stable Android signing secrets are required; no debug signing fallback');
  const keystore = Buffer.from(encoded, 'base64');
  if (keystore.length < 512 || keystore.length > 64 * 1024 || keystore.toString('base64') !== encoded) throw new Error('Invalid Android signing keystore');
  const manifest = JSON.parse(regularFile(join(input, 'manifest.json'), 64 * 1024));
  if (manifest.network !== 'mutinynet' || manifest.poolOrigin !== 'https://shielded.mutinynet.arkade.sh' || manifest.platform !== 'android-arm64' || manifest.commit !== env.GITHUB_SHA || !Array.isArray(manifest.packages)) throw new Error('Android signing source artifact mismatch');
  const packages = manifest.packages.filter(item => item.profile === 'release');
  if (packages.length !== 1) throw new Error('Expected one unsigned Android release source');
  const item = packages[0];
  if (item.requiresSigning !== true || typeof item.file !== 'string' || !/^mutinynet-release-unsigned-[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.apk$/.test(item.file) || item.file.includes('..')) throw new Error('Unsafe unsigned Android release filename');
  const source = join(input, item.file), sourceBytes = regularFile(source, MAX_APK_BYTES);
  if (sourceBytes.length !== item.bytes || hash(sourceBytes) !== item.sha256) throw new Error('Android source APK size or SHA256 mismatch');
  if (!env.ANDROID_HOME || !env.JAVA_HOME) throw new Error('Android signing requires pinned SDK tools and Java');
  const tools = join(env.ANDROID_HOME, 'build-tools', ANDROID_BUILD_TOOLS), extension = process.platform === 'win32' ? '.exe' : '';
  const aapt = join(tools, `aapt${extension}`), zipalign = join(tools, `zipalign${extension}`), java = join(env.JAVA_HOME, 'bin', `java${extension}`), signer = join(tools, 'lib/apksigner.jar');
  const childEnv = childEnvironment(env);
  assertPackage(run(aapt, ['dump', 'badging', source], childEnv), signing.packageName, versionCode);
  if (existsSync(output)) throw new Error('Android signed artifact output must not already exist');
  const temporary = mkdtempSync(join(tmpdir(), 'shielded-android-sign-'));
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('shielded-android-sign-')) throw new Error('Unsafe Android signing temporary directory');
  try {
    const key = join(temporary, 'release.p12'), aligned = join(temporary, 'aligned.apk'), signed = join(temporary, 'signed.apk');
    run(zipalign, ['-P', '16', '-f', '4', source, aligned], childEnv);
    writeFileSync(key, keystore, { flag: 'wx', mode: 0o600 });
    keystore.fill(0);
    run(java, ['-jar', signer, 'sign', '--ks', key, '--ks-key-alias', signing.alias, '--ks-pass', 'env:SHIELDED_APK_STORE_PASSWORD', '--key-pass', 'env:SHIELDED_APK_STORE_PASSWORD', '--min-sdk-version', '24', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false', '--out', signed, aligned], { ...childEnv, SHIELDED_APK_STORE_PASSWORD: password });
    const verified = run(java, ['-jar', signer, 'verify', '--verbose', '--print-certs', signed], childEnv);
    const certificates = [...verified.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$/gm)].map(match => match[1].toLowerCase());
    if (!verified.includes('Verified using v2 scheme (APK Signature Scheme v2): true') || certificates.length !== 1 || certificates[0] !== signing.certificateSha256) throw new Error('Signed Android APK signature or pinned certificate mismatch');
    assertPackage(run(aapt, ['dump', 'badging', signed], childEnv), signing.packageName, versionCode);
    run(zipalign, ['-c', '-P', '16', '4', signed], childEnv);
    const bytes = regularFile(signed, MAX_APK_BYTES), file = 'mutinynet-release-signed.apk';
    const result = { schema: 1, network: 'mutinynet', commit: env.GITHUB_SHA, buildNumber, versionCode, packageName: signing.packageName, signerSha256: certificates[0], package: { file, bytes: bytes.length, sha256: hash(bytes) } };
    mkdirSync(output, { recursive: true });
    copyFileSync(signed, join(output, file));
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally {
    keystore.fill(0);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Use sign-android.mjs <unsigned-artifact-directory> <signed-output-directory>');
    const result = signAndroidArtifact(selectAndroidSigningSource(resolve(input)), resolve(output));
    console.log(`Signed ${result.packageName} versionCode ${result.versionCode}; certificate SHA256 ${result.signerSha256}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
