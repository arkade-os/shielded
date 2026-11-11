import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_BUILD_TOOLS, signAndroidArtifact } from './sign-android.mjs';
import { requireDisposableEmulator } from './android-update-fixture/emulator-guard.mjs';

function command(file, args, env = process.env, success = true, cwd) {
  const result = spawnSync(file, args, { env, cwd, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000 });
  assert.equal(typeof result.status, 'number', `${basename(file)} did not complete`);
  if (success) assert.equal(result.status, 0, `${basename(file)}: ${result.stderr || result.error?.message || ''}`);
  return result;
}

const temporary = mkdtempSync(join(tmpdir(), 'shielded-signing-check-'));
assert.equal(dirname(temporary), resolve(tmpdir()));
try {
  const sdk = process.env.ANDROID_HOME, java = process.env.JAVA_HOME;
  assert.ok(sdk && java, 'Signing integration needs Android SDK and Java');
  const executable = name => join(java, 'bin', name), tools = join(sdk, 'build-tools', ANDROID_BUILD_TOOLS), androidJar = join(sdk, 'platforms/android-36/android.jar');
  const serial = process.env.SHIELDED_TEST_EMULATOR_SERIAL, adb = join(sdk, 'platform-tools/adb');
  const device = (...args) => command(adb, ['-s', serial, ...args]);
  const installFixtures = requireDisposableEmulator(serial, device);
  const classes = join(temporary, 'classes'), dex = join(temporary, 'dex'); mkdirSync(classes); mkdirSync(dex);
  command(executable('javac'), ['-source', '8', '-target', '8', '-classpath', androidJar, '-d', classes, fileURLToPath(new URL('./android-update-fixture/DataProbe.java', import.meta.url))]);
  const classesJar = join(temporary, 'fixture-classes.jar');
  command(executable('jar'), ['--create', '--file', classesJar, '-C', classes, '.']);
  command(executable('java'), ['-cp', join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '24', '--output', dex, classesJar]);
  const password = randomBytes(32).toString('hex'), key = join(temporary, 'fixture.p12'), certificate = join(temporary, 'fixture.der');
  const keyEnv = { ...process.env, SHIELDED_SIGNING_TEST_PASSWORD: password };
  command(executable('keytool'), ['-genkeypair', '-keystore', key, '-storetype', 'PKCS12', '-alias', 'shielded-release', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=Disposable CI update fixture', '-storepass:env', 'SHIELDED_SIGNING_TEST_PASSWORD', '-keypass:env', 'SHIELDED_SIGNING_TEST_PASSWORD'], keyEnv);
  command(executable('keytool'), ['-exportcert', '-keystore', key, '-alias', 'shielded-release', '-storepass:env', 'SHIELDED_SIGNING_TEST_PASSWORD', '-file', certificate], keyEnv);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const signing = { schema: 1, packageName: 'io.arkade.shielded', alias: 'shielded-release', certificateSha256: digest(readFileSync(certificate)) };
  const env = { ...process.env, GITHUB_REPOSITORY: 'arkade-os/shielded', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), ANDROID_RELEASE_KEYSTORE_BASE64: readFileSync(key).toString('base64'), ANDROID_RELEASE_KEYSTORE_PASSWORD: password };
  const results = [], signedPaths = [];
  for (const build of [1, 2]) {
    const input = join(temporary, `input-${build}`), output = join(temporary, `output-${build}`); mkdirSync(input);
    const manifest = join(input, 'AndroidManifest.xml'), file = 'mutinynet-release-unsigned-fixture.apk';
    writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="io.arkade.shielded" android:versionCode="${100000 + build}" android:versionName="0.1.0"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:allowBackup="false" android:usesCleartextTraffic="true" android:label="Shielded CI fixture"><activity android:name=".DataProbe" android:exported="true"/></application></manifest>`);
    command(join(tools, 'aapt'), ['package', '-f', '-M', manifest, '-I', androidJar, '-F', join(input, file)]);
    command(join(tools, 'aapt'), ['add', join(input, file), 'classes.dex'], process.env, true, dex);
    const bytes = readFileSync(join(input, file));
    writeFileSync(join(input, 'manifest.json'), JSON.stringify({ network: 'mutinynet', poolOrigin: 'https://shielded.mutinynet.arkade.sh', platform: 'android-arm64', commit: env.GITHUB_SHA, packages: [{ file, profile: 'release', requiresSigning: true, bytes: bytes.length, sha256: digest(bytes) }] }));
    const result = signAndroidArtifact(input, output, { ...env, GITHUB_RUN_NUMBER: String(build) }, signing);
    results.push(result);
    const badOutput = join(temporary, `wrong-signer-${build}`);
    assert.throws(() => signAndroidArtifact(input, badOutput, { ...env, GITHUB_RUN_NUMBER: String(build) }, { ...signing, certificateSha256: 'f'.repeat(64) }), /certificate mismatch/);
    assert.equal(existsSync(badOutput), false);
    const signed = join(output, result.package.file), tampered = readFileSync(signed); tampered[0] ^= 1; signedPaths.push(signed);
    const tamperedPath = join(temporary, `tampered-${build}.apk`); writeFileSync(tamperedPath, tampered);
    assert.notEqual(command(executable('java'), ['-jar', join(tools, 'lib/apksigner.jar'), 'verify', tamperedPath], process.env, false).status, 0);
  }
  assert.equal(results[0].signerSha256, results[1].signerSha256);
  assert.equal(results[1].versionCode, results[0].versionCode + 1);
  console.log('Android SDK signing checks passed: two upgrade-compatible versions, pinned certificate refusal, tamper refusal.');
  if (installFixtures) {
    const nonce = randomBytes(16).toString('hex');
    const start = phase => device('shell', 'am', 'start', '-W', '-n', 'io.arkade.shielded/.DataProbe', '--es', 'phase', phase, '--es', 'nonce', nonce);
    const waitFor = async marker => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const log = device('logcat', '-d', '-s', 'ShieldedUpdateProbe:I', '*:S').stdout;
        assert.ok(!log.includes(`FAILED:${nonce}:`), log);
        if (log.includes(`${marker}:${nonce}`)) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.fail(`Android update data probe did not reach ${marker}`);
    };
    assert.match(device('install', signedPaths[0]).stdout, /Success/);
    start('write'); await waitFor('WRITE_OK');
    device('shell', 'am', 'force-stop', 'io.arkade.shielded');
    assert.match(device('install', '-r', signedPaths[1]).stdout, /Success/);
    start('verify'); await waitFor('VERIFY_OK');
    console.log('Android in-place update preserved dummy preferences, pending journal, Android Keystore AES-GCM ciphertext and offline WebView localStorage at http://tauri.localhost.');
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
