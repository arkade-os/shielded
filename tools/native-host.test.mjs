import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { androidVersionCode, nativeArguments, prepareAndroid, protectAndroidManifest } from './native-build.mjs';
import * as nativeBuild from './native-build.mjs';

const root = new URL('../src-tauri/', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const iconSources = workspace => {
  mkdirSync(resolve(workspace, 'src-tauri'), { recursive: true });
  for (const name of ['icon.json', 'icon.svg', 'icon-background.svg', 'icon-foreground.svg', 'icon-monochrome.svg']) copyFileSync(new URL(name, root), resolve(workspace, 'src-tauri', name));
};

test('Windows setup bundles WebView2 without a first-run download', () => {
  assert.deepEqual(json('tauri.conf.json').bundle.windows.webviewInstallMode, { type: 'offlineInstaller', silent: true });
});

test('bundled renderer has no direct network or remote asset capability', () => {
  const config = json('tauri.conf.json');
  const csp = Object.fromEntries(config.app.security.csp.split(';').filter(part => part.trim()).map(part => {
    const [directive, ...values] = part.trim().split(/\s+/);
    return [directive, values];
  }));
  assert.deepEqual(csp['connect-src'], ["'self'", 'ipc:', 'http://ipc.localhost', 'https://ipc.localhost']);
  for (const [directive, values] of Object.entries(csp)) {
    assert.ok(!values.some(value => /^(https?:|wss?:|\*)$/.test(value)), directive);
  }
  assert.deepEqual(csp['frame-src'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  assert.equal(config.build.devUrl, undefined);
  assert.equal(config.build.frontendDist, '../app/dist');
});

test('only the local main window receives bounded native commands', () => {
  const capability = json('capabilities/main.json');
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.ok(capability.permissions.includes('shielded-platform:allow-secret-get'));
  assert.ok(capability.permissions.includes('shielded-platform:allow-secret-set'));
  assert.ok(capability.permissions.includes('deep-link:default'));
  const opener = capability.permissions.filter(permission => String(permission.identifier ?? permission).startsWith('opener:'));
  assert.deepEqual(opener, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://shielded.mutinynet.arkade.sh/#download' }] }]);
  assert.ok(!capability.permissions.some(permission => typeof permission === 'string' && /shell|http:|fs:/.test(permission)));
});

test('native hosts register only the supported payment schemes', () => {
  const config = json('tauri.conf.json');
  assert.deepEqual(config.plugins['deep-link'], {
    desktop: { schemes: ['bitcoin', 'lightning', 'arkade'] },
    mobile: [{ scheme: ['bitcoin', 'lightning', 'arkade'], appLink: false }],
  });
});

test('build commands reject incompatible hosts and forward Tauri arguments without a shell', () => {
  assert.deepEqual(nativeArguments('desktop', 'build', ['--debug'], 'win32'), ['build', '--debug']);
  assert.deepEqual(nativeArguments('android', 'build', ['--apk'], 'linux', {}), ['android', 'build', '--apk']);
  assert.deepEqual(nativeArguments('ios', 'build', ['--no-sign'], 'darwin'), ['ios', 'build', '--no-sign']);
  assert.throws(() => nativeArguments('ios', 'build', [], 'win32'), /macOS/);
  assert.throws(() => nativeArguments('desktop', 'init', [], 'linux'), /action/);
});

test('mobile initialization requires a package-manager runner for generated IDE callbacks', () => {
  for (const platform of ['android', 'ios']) {
    assert.throws(() => nativeArguments(platform, 'init', [], 'darwin', {}), /npm run native:/);
    assert.deepEqual(nativeArguments(platform, 'init', [], 'darwin', { npm_execpath: '/node/npm-cli.js' }), [platform, 'init']);
  }
});

test('Android CI packages have one monotonic version code independent of the unchanged app version', () => {
  assert.equal(androidVersionCode({ GITHUB_RUN_NUMBER: '99' }), 100099);
  assert.equal(androidVersionCode({}), undefined);
  for (const value of ['0', '-1', '01', '1.5', 'NaN', '2099900001', '9007199254740992']) assert.throws(() => androidVersionCode({ GITHUB_RUN_NUMBER: value }), /version code/);
  assert.throws(() => androidVersionCode({ GITHUB_ACTIONS: 'true' }), /version code/);
  for (const action of ['init', 'build', 'dev']) {
    const args = nativeArguments('android', action, ['--apk'], 'linux', { GITHUB_RUN_NUMBER: '99', npm_execpath: '/npm' });
    assert.deepEqual(JSON.parse(args.at(-1)), { bundle: { android: { versionCode: 100099, autoIncrementVersionCode: false } } });
    assert.equal(args.at(-2), '--config');
  }
  const args = nativeArguments('android', 'build', ['--apk', '--', 'runner-arg'], 'linux', { GITHUB_RUN_NUMBER: '99' });
  assert.deepEqual(args.slice(-2), ['--', 'runner-arg']);
});

test('generated mobile callbacks resolve the local CLI from the IDE working directory', t => {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-cli-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const directory of ['src-tauri', 'src-tauri/gen/apple']) {
    const cwd = resolve(workspace, directory);
    mkdirSync(cwd, { recursive: true });
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run -- tauri --version'], { cwd, encoding: 'utf8', shell: false })
      : spawnSync('npm', ['run', '--', 'tauri', '--version'], { cwd, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /tauri-cli 2\.12\.4/);
  }
});

test('Android preparation disables all generated-app backup paths without losing unrelated attributes', () => {
  const manifest = '<manifest><application android:allowBackup="true" android:label="Shielded" android:fullBackupContent="@xml/old" /></manifest>';
  const prepared = protectAndroidManifest(manifest);
  assert.ok(prepared.includes('android:allowBackup="false"'));
  assert.ok(prepared.includes('android:fullBackupContent="false"'));
  assert.ok(prepared.includes('android:dataExtractionRules="@xml/shielded_data_extraction_rules"'));
  assert.ok(prepared.includes('android:label="Shielded"'));
  assert.equal(protectAndroidManifest(prepared), prepared);
  assert.throws(() => protectAndroidManifest('<manifest/>'), /application/);
});

test('Android backup protection preserves quoted tag characters and merge markers', () => {
  const manifest = `<manifest><application android:label="A > B $& android:allowBackup='label'" tools:replace="android:allowBackup" android:allowBackup="true" /></manifest>`;
  const prepared = protectAndroidManifest(manifest);
  assert.ok(prepared.includes(`android:label="A > B $& android:allowBackup='label'"`));
  assert.ok(prepared.includes('tools:replace="android:allowBackup"'));
  assert.ok(prepared.includes('android:allowBackup="false"'));
  assert.ok(prepared.includes('android:fullBackupContent="false"'));
  assert.ok(prepared.includes('android:dataExtractionRules="@xml/shielded_data_extraction_rules"'));
  assert.equal(protectAndroidManifest(prepared), prepared);
});

test('Android preparation refuses a stale generated identifier before changing its manifest', t => {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-project-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = resolve(workspace, 'src-tauri/gen/android/app');
  const manifest = resolve(app, 'src/main/AndroidManifest.xml');
  mkdirSync(resolve(app, 'src/main/res'), { recursive: true });
  writeFileSync(resolve(workspace, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'io.arkade.shielded' }));
  writeFileSync(manifest, '<manifest><application android:allowBackup="true" /></manifest>');
  for (const [namespace, applicationId] of [['io.old.wallet', 'io.arkade.shielded'], ['io.arkade.shielded', 'io.old.wallet']]) {
    writeFileSync(resolve(app, 'build.gradle.kts'), `android {\n namespace = "${namespace}"\n defaultConfig {\n applicationId = "${applicationId}"\n }\n}`);
    assert.throws(() => prepareAndroid(workspace), /different identifier/);
    assert.equal(readFileSync(manifest, 'utf8'), '<manifest><application android:allowBackup="true" /></manifest>');
  }
  writeFileSync(resolve(app, 'build.gradle.kts'), 'android {\n namespace = "io.arkade.shielded"\n defaultConfig {\n applicationId = "io.arkade.shielded"\n }\n}');
  iconSources(workspace);
  prepareAndroid(workspace);
  assert.ok(readFileSync(manifest, 'utf8').includes('android:allowBackup="false"'));
  assert.ok(readFileSync(resolve(app, 'src/main/res/mipmap-anydpi-v26/ic_launcher.xml'), 'utf8').includes('@mipmap/ic_launcher_monochrome'));
});

test('icon preparation updates initialized mobile projects from source and preserves asset metadata', t => {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-icons-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  iconSources(workspace);
  const android = resolve(workspace, 'src-tauri/gen/android/app/src/main/res');
  const ios = resolve(workspace, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
  mkdirSync(resolve(android, 'mipmap-xxxhdpi'), { recursive: true });
  mkdirSync(ios, { recursive: true });
  const contents = '{"images":[{"filename":"AppIcon-512@2x.png"}],"info":{"author":"fixture","version":1}}';
  writeFileSync(resolve(ios, 'Contents.json'), contents);
  writeFileSync(resolve(android, 'mipmap-xxxhdpi/ic_launcher.png'), 'template icon');
  nativeBuild.prepareIcons(workspace);
  assert.equal(readFileSync(resolve(ios, 'Contents.json'), 'utf8'), contents);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground', 'ic_launcher_background', 'ic_launcher_monochrome']) {
    assert.deepEqual(readFileSync(resolve(android, `mipmap-xxxhdpi/${name}.png`)).subarray(0, 8), signature);
  }
  const adaptive = readFileSync(resolve(android, 'mipmap-anydpi-v26/ic_launcher.xml'), 'utf8');
  for (const name of ['foreground', 'background', 'monochrome']) assert.ok(adaptive.includes(`@mipmap/ic_launcher_${name}`));
  assert.deepEqual(readFileSync(resolve(ios, 'AppIcon-512@2x.png')).subarray(0, 8), signature);
  const previous = readFileSync(resolve(android, 'mipmap-xxxhdpi/ic_launcher.png'));
  const previousIos = readFileSync(resolve(ios, 'AppIcon-512@2x.png'));
  for (const name of ['icon.svg', 'icon-foreground.svg']) writeFileSync(resolve(workspace, 'src-tauri', name), '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path fill="#a12345" d="M0 0h512v512H0Z"/></svg>');
  nativeBuild.prepareIcons(workspace);
  assert.notDeepEqual(readFileSync(resolve(android, 'mipmap-xxxhdpi/ic_launcher.png')), previous);
  assert.notDeepEqual(readFileSync(resolve(ios, 'AppIcon-512@2x.png')), previousIos);
  assert.equal(readFileSync(resolve(ios, 'Contents.json'), 'utf8'), contents);
});
