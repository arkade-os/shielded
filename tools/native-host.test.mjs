import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('macOS camera access covers development and bundled builds with the same purpose', () => {
  const config = json('tauri.conf.json');
  const info = readFileSync(new URL(config.bundle.macOS.infoPlist, root), 'utf8');
  const devInfo = readFileSync(new URL('Info.plist', root), 'utf8');
  const entitlements = readFileSync(new URL(config.bundle.macOS.entitlements, root), 'utf8');
  assert.match(info, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  const purpose = /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]+)<\/string>/;
  assert.equal(purpose.exec(devInfo)?.[1], purpose.exec(info)?.[1]);
  assert.match(entitlements, /<key>com.apple.security.device.camera<\/key>\s*<true\s*\/>/);
  assert.doesNotMatch(entitlements, /disable-library-validation|allow-unsigned-executable-memory/);
});

test('all native platforms receive text-only clipboard access in the local main window', () => {
  const permissions = json('capabilities/main.json').permissions.filter(value => typeof value === 'string' && value.startsWith('clipboard-manager:'));
  assert.deepEqual(permissions.sort(), ['clipboard-manager:allow-read-text', 'clipboard-manager:allow-write-text']);
  assert.match(readFileSync(new URL('src/lib.rs', root), 'utf8'), /\.plugin\(tauri_plugin_clipboard_manager::init\(\)\)/);
});

test('iOS activation repairs native status for the default non-scene lifecycle without renderer authority', () => {
  const source = readFileSync(new URL('src/lib.rs', root), 'utf8');
  const swift = readFileSync(new URL('plugins/shielded-platform/ios/Sources/ShieldedPlatformPlugin.swift', root), 'utf8');
  assert.match(swift, /@_silgen_name\("shielded_native_did_become_active"\)/);
  assert.match(swift, /addObserver\(forName: UIApplication\.didBecomeActiveNotification, object: nil, queue: \.main\)/);
  assert.match(swift, /removeObserver\(observer\)/);
  const creation = swift.indexOf('override init()'), observer = swift.indexOf('addObserver('), load = swift.indexOf('override func load(');
  assert.ok(creation >= 0 && creation < observer && observer < load, 'observe activation during plugin creation, before webview load');
  assert.match(source, /pub extern "C" fn shielded_native_did_become_active\(\)/);
  assert.match(source, /\.emit_to\("main", "shielded-native-lifecycle", status\)/);
  assert.doesNotMatch(source, /WindowEvent::Focused\(/);
  assert.ok(!json('capabilities/main.json').permissions.some(value => typeof value === 'string' && /resume|foreground|active/.test(value)));
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
  assert.deepEqual(opener, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://shielded.mutinynet.arkade.sh/#download' }, { url: 'https://shielded.mutinynet.arkade.sh/download#download' }, { url: 'https://explorer.mutinynet.arkade.sh/tx/*' }, { url: 'https://explorer.mutinynet.arkade.sh/commitment-tx/*' }, { url: 'https://mempool.mutinynet.arkade.sh/tx/*' }] }]);
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

test('Apple passkeys add signing entitlements only for an explicit Apple build opt-in', () => {
  for (const host of ['darwin', 'win32', 'linux']) {
    for (const flag of [undefined, '0', 'true']) assert.deepEqual(nativeArguments('desktop', 'build', [], host, { SHIELDED_APPLE_PASSKEYS: flag }), ['build']);
  }
  const args = nativeArguments('desktop', 'build', ['--debug', '--', 'runner-arg'], 'darwin', { SHIELDED_APPLE_PASSKEYS: '1' });
  assert.deepEqual(args.slice(-2), ['--', 'runner-arg']);
  const overlay = JSON.parse(args[args.indexOf('--config') + 1]);
  assert.deepEqual(overlay, { bundle: { macOS: { entitlements: 'macos/PasskeyEntitlements.plist' } } });
  const plist = readFileSync(new URL(overlay.bundle.macOS.entitlements, root), 'utf8');
  assert.match(plist, /<key>com.apple.security.device.camera<\/key>\s*<true\s*\/>/);
  assert.match(plist, /<key>com.apple.developer.associated-domains<\/key>\s*<array>\s*<string>webcredentials:shielded\.mutinynet\.arkade\.sh<\/string>\s*<\/array>/);
  assert.doesNotMatch(plist, /TeamIdentifier|application-identifier|disable-library-validation|allow-unsigned-executable-memory/);
  for (const host of ['win32', 'linux']) assert.deepEqual(nativeArguments('desktop', 'build', [], host, { SHIELDED_APPLE_PASSKEYS: '1' }), ['build']);
  assert.deepEqual(nativeArguments('ios', 'build', ['--no-sign'], 'darwin', { SHIELDED_APPLE_PASSKEYS: '1' }), ['ios', 'build', '--no-sign']);
});

function appleProject(t, entitlements = {}) {
  const workspace = mkdtempSync(fileURLToPath(new URL('./.native-apple-', import.meta.url)));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const apple = resolve(workspace, 'src-tauri/gen/apple'), project = resolve(apple, 'shielded-native.xcodeproj');
  mkdirSync(project, { recursive: true });
  mkdirSync(resolve(apple, 'shielded-native_iOS'), { recursive: true });
  writeFileSync(resolve(workspace, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'io.arkade.shielded' }));
  const file = resolve(apple, 'shielded-native_iOS/shielded-native_iOS.entitlements');
  const settings = { PRODUCT_BUNDLE_IDENTIFIER: 'io.arkade.shielded', CODE_SIGN_ENTITLEMENTS: 'shielded-native_iOS/shielded-native_iOS.entitlements', DEVELOPMENT_TEAM: 'retained-team' };
  const pbx = { objects: { main: { isa: 'PBXNativeTarget', productType: 'com.apple.product-type.application', buildConfigurationList: 'configs' }, configs: { buildConfigurations: ['debug', 'release'] }, debug: { buildSettings: { ...settings } }, release: { buildSettings: { ...settings } } } };
  const projectFile = resolve(project, 'project.pbxproj');
  writeFileSync(projectFile, JSON.stringify(pbx));
  writeFileSync(file, JSON.stringify(entitlements));
  const writes = [];
  const execute = (command, args, options) => {
    assert.equal(command, '/usr/bin/plutil'); assert.equal(options.shell, false);
    if (args[0] === '-convert') return { status: 0, stdout: readFileSync(args.at(-1), 'utf8') };
    assert.ok(['-insert', '-replace'].includes(args[0]));
    const target = args.at(-1), value = JSON.parse(readFileSync(target, 'utf8'));
    const path = ['']; let escaped = false;
    for (const character of args[1]) {
      if (escaped) { path[path.length - 1] += character; escaped = false; }
      else if (character === '\\') escaped = true;
      else if (character === '.') path.push('');
      else path[path.length - 1] += character;
    }
    let parent = value;
    for (const key of path.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== 'object') return { status: 1 };
      parent = parent[key];
    }
    parent[path.at(-1)] = JSON.parse(args[3]); writeFileSync(target, JSON.stringify(value)); writes.push(args);
    return { status: 0 };
  };
  return { workspace, apple, file, projectFile, pbx, execute, writes };
}

test('iOS passkey preparation merges the domain into the actual signed file and preserves native edits', t => {
  const before = { 'com.apple.developer.associated-domains': ['webcredentials:other.example'], 'keychain-access-groups': ['existing-group'], 'get-task-allow': true };
  const f = appleProject(t, before), original = readFileSync(f.projectFile, 'utf8');
  nativeBuild.prepareApplePasskeys(f.workspace, {}, f.execute);
  assert.equal(f.writes.length, 0);
  nativeBuild.prepareApplePasskeys(f.workspace, { SHIELDED_APPLE_PASSKEYS: '1' }, f.execute);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { ...before, 'com.apple.developer.associated-domains': ['webcredentials:other.example', 'webcredentials:shielded.mutinynet.arkade.sh'] });
  assert.equal(readFileSync(f.projectFile, 'utf8'), original);
  nativeBuild.prepareApplePasskeys(f.workspace, { SHIELDED_APPLE_PASSKEYS: '1' }, f.execute);
  assert.equal(f.writes.length, 1);
});

test('iOS passkey preparation refuses mismatched identities, entitlement paths and malformed domains before writing', t => {
  for (const change of [
    f => { f.pbx.objects.debug.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = 'io.other.wallet'; },
    f => { f.pbx.objects.release.buildSettings.CODE_SIGN_ENTITLEMENTS = '../outside.entitlements'; },
    f => { f.pbx.objects.main.buildConfigurationList = 'missing'; },
    f => { mkdirSync(resolve(f.apple, 'another.xcodeproj')); },
    f => { writeFileSync(f.file, JSON.stringify({ 'com.apple.developer.associated-domains': 'wrong type' })); },
    f => { writeFileSync(f.file, JSON.stringify({ 'com.apple.developer.associated-domains': null })); },
  ]) {
    const f = appleProject(t); change(f); writeFileSync(f.projectFile, JSON.stringify(f.pbx));
    const original = readFileSync(f.file, 'utf8');
    assert.throws(() => nativeBuild.prepareApplePasskeys(f.workspace, { SHIELDED_APPLE_PASSKEYS: '1' }, f.execute), error => error instanceof Error && /^(The iOS|Expected one|Invalid Apple|Initialize|Apple entitlement)/.test(error.message));
    assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(f.writes.length, 0);
  }
});

test('iOS passkey preparation inserts a previously absent domain key without changing signing identity', t => {
  const f = appleProject(t, { 'application-identifier': 'existing-prefix.io.arkade.shielded' });
  nativeBuild.prepareApplePasskeys(f.workspace, { SHIELDED_APPLE_PASSKEYS: '1' }, f.execute);
  assert.equal(f.writes[0][0], '-insert');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { 'application-identifier': 'existing-prefix.io.arkade.shielded', 'com.apple.developer.associated-domains': ['webcredentials:shielded.mutinynet.arkade.sh'] });
});

test('iOS passkey preparation never follows a redirected entitlement directory', t => {
  const f = appleProject(t), target = resolve(f.workspace, 'outside');
  mkdirSync(target); writeFileSync(resolve(target, 'wallet.entitlements'), '{}');
  symlinkSync(target, resolve(f.apple, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const id of ['debug', 'release']) f.pbx.objects[id].buildSettings.CODE_SIGN_ENTITLEMENTS = 'linked/wallet.entitlements';
  writeFileSync(f.projectFile, JSON.stringify(f.pbx));
  assert.throws(() => nativeBuild.prepareApplePasskeys(f.workspace, { SHIELDED_APPLE_PASSKEYS: '1' }, f.execute), /symlinked entitlement/);
  assert.equal(readFileSync(resolve(target, 'wallet.entitlements'), 'utf8'), '{}'); assert.equal(f.writes.length, 0);
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
