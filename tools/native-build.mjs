import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');

export function androidVersionCode(env = process.env) {
  if (!env.GITHUB_RUN_NUMBER && env.GITHUB_ACTIONS !== 'true') return undefined;
  const build = env.GITHUB_RUN_NUMBER;
  if (!/^[1-9]\d*$/.test(build ?? '') || !Number.isSafeInteger(Number(build)) || Number(build) > 2_099_900_000) throw new Error('Android version code requires a positive, bounded GitHub run number');
  return 100_000 + Number(build);
}

export function nativeArguments(platform, action, args = [], host = process.platform, env = process.env) {
  if (!['desktop', 'android', 'ios'].includes(platform)) throw new Error('Use desktop, android or ios');
  if (platform === 'ios' && host !== 'darwin') throw new Error('Build iOS on macOS with Xcode');
  if (!['dev', 'build', 'init', 'prepare'].includes(action) || (platform === 'desktop' && !['dev', 'build'].includes(action))) throw new Error('Unsupported native action');
  if (action === 'init' && !env.npm_execpath && !env.PNPM_PACKAGE_NAME) throw new Error(`Initialize through npm run native:${platform} -- init so generated IDE callbacks can resolve Tauri`);
  const command = [...(platform === 'desktop' ? [] : [platform]), action, ...args];
  const versionCode = platform === 'android' && action !== 'prepare' ? androidVersionCode(env) : undefined;
  const overlay = versionCode !== undefined ? { bundle: { android: { versionCode, autoIncrementVersionCode: false } } }
    : platform === 'desktop' && host === 'darwin' && env.SHIELDED_APPLE_PASSKEYS === '1' ? { bundle: { macOS: { entitlements: 'macos/PasskeyEntitlements.plist' } } } : undefined;
  if (overlay) {
    const separator = command.indexOf('--');
    command.splice(separator < 0 ? command.length : separator, 0, '--config', JSON.stringify(overlay));
  }
  return command;
}

export function protectAndroidManifest(source) {
  const matches = [...source.matchAll(/<application\b(?:[^"'>]|"[^"]*"|'[^']*')*>/g)];
  if (matches.length !== 1) throw new Error('Expected one generated Android application');
  const protectedAttributes = { 'android:allowBackup': 'false', 'android:fullBackupContent': 'false', 'android:dataExtractionRules': '@xml/shielded_data_extraction_rules' };
  const attributes = Object.entries(protectedAttributes).map(([name, value]) => `${name}="${value}"`).join(' ');
  const application = matches[0][0]
    .replace(/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g, (attribute, name) => Object.hasOwn(protectedAttributes, name) ? '' : attribute)
    .replace(/\s*\/?>(?=$)/, end => ` ${attributes}${end.trimStart()}`);
  return source.replace(matches[0][0], () => application);
}

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, shell: false, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Tauri command failed (exit ${result.status ?? 'unavailable'})`);
}

export function prepareIcons(projectRoot = root) {
  run(['icon', resolve(projectRoot, 'src-tauri/icon.json'), '--output', resolve(projectRoot, 'src-tauri/icons'), '--ios-color', '#111f31'], projectRoot);
}

export function prepareAndroid(projectRoot = root) {
  const app = resolve(projectRoot, 'src-tauri/gen/android/app');
  const manifest = resolve(app, 'src/main/AndroidManifest.xml');
  if (!existsSync(manifest) || lstatSync(manifest).isSymbolicLink()) throw new Error('Initialize the local Android project first');
  const identifier = JSON.parse(readFileSync(resolve(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')).identifier;
  const gradle = resolve(app, 'build.gradle.kts');
  if (!existsSync(gradle) || lstatSync(gradle).isSymbolicLink()) throw new Error('Regenerate the Android project for the configured identifier');
  const settings = readFileSync(gradle, 'utf8');
  if (['namespace', 'applicationId'].some(name => settings.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] !== identifier)) {
    throw new Error('Generated Android project has a different identifier; preserve native edits and regenerate src-tauri/gen/android');
  }
  const source = readFileSync(manifest, 'utf8');
  const prepared = protectAndroidManifest(source);
  if (prepared !== source) writeFileSync(manifest, prepared);
  prepareIcons(projectRoot);
}

export function prepareApplePasskeys(projectRoot = root, env = process.env, execute = spawnSync) {
  if (env.SHIELDED_APPLE_PASSKEYS !== '1') return;
  const apple = resolve(projectRoot, 'src-tauri/gen/apple');
  const local = path => {
    const suffix = relative(resolve(projectRoot), path);
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Apple entitlement path must stay inside the generated project');
    let part = resolve(projectRoot);
    for (const name of suffix.split(sep)) {
      part = resolve(part, name);
      if (!existsSync(part) || lstatSync(part).isSymbolicLink()) throw new Error('Initialize the local iOS project without symlinked entitlement paths');
    }
    return path;
  };
  local(apple);
  const projects = readdirSync(apple, { withFileTypes: true }).filter(file => file.isDirectory() && file.name.endsWith('.xcodeproj'));
  if (projects.length !== 1) throw new Error('Expected one generated iOS application project');
  const plist = path => {
    const result = execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', local(path)], { shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Apple entitlement inspection failed');
    try { return JSON.parse(result.stdout); } catch { throw new Error('Apple entitlement inspection returned an invalid property list'); }
  };
  const objects = plist(resolve(apple, projects[0].name, 'project.pbxproj')).objects;
  if (!objects || typeof objects !== 'object' || Array.isArray(objects)) throw new Error('The iOS project has no build settings');
  const targets = Object.values(objects).filter(value => value?.isa === 'PBXNativeTarget' && value.productType === 'com.apple.product-type.application');
  if (targets.length !== 1) throw new Error('Expected one iOS application target');
  const configs = objects[targets[0].buildConfigurationList]?.buildConfigurations;
  if (!Array.isArray(configs) || !configs.length) throw new Error('The iOS target has no signing configuration');
  const identifier = JSON.parse(readFileSync(resolve(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')).identifier.replaceAll('_', '-');
  const paths = configs.map(id => {
    const settings = objects[id]?.buildSettings, value = settings?.CODE_SIGN_ENTITLEMENTS;
    if (settings?.PRODUCT_BUNDLE_IDENTIFIER !== identifier || typeof value !== 'string') throw new Error('The iOS signing configuration has a different identifier or entitlement path');
    const path = value.replace(/^\$\(SRCROOT\)\//, '');
    if (path.includes('$') || isAbsolute(path)) throw new Error('The iOS entitlement path must be a generated project file');
    const resolved = resolve(apple, path), suffix = relative(apple, resolved);
    if (suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('The iOS entitlement path leaves the generated project');
    return local(resolved);
  });
  if (new Set(paths).size !== 1) throw new Error('The iOS build configurations use different entitlement files');
  const file = paths[0], entitlements = plist(file), key = 'com.apple.developer.associated-domains', domain = 'webcredentials:shielded.mutinynet.arkade.sh';
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) throw new Error('Invalid Apple entitlements');
  const domains = Object.hasOwn(entitlements, key) ? entitlements[key] : [];
  if (!Array.isArray(domains) || domains.some(value => typeof value !== 'string')) throw new Error('Invalid Apple associated domains');
  if (domains.includes(domain)) return;
  const result = execute('/usr/bin/plutil', [Object.hasOwn(entitlements, key) ? '-replace' : '-insert', key, '-json', JSON.stringify([...domains, domain]), file], { shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Apple entitlement preparation failed');
}

export function main([platform = 'desktop', action = 'dev', ...args] = process.argv.slice(2)) {
  if (platform === 'icons') { prepareIcons(); return; }
  if (args[0] === '--') args.shift();
  const command = nativeArguments(platform, action, args);
  if (args.some(arg => ['--help', '-h'].includes(arg))) { run(command); return; }
  if (!existsSync(resolve(root, 'src-tauri/icons/icon.png'))) prepareIcons();
  if (platform === 'android') {
    if (action === 'init') {
      if (!existsSync(resolve(root, 'src-tauri/gen/android/app'))) run(command);
      prepareAndroid();
      return;
    }
    prepareAndroid();
    if (action === 'prepare') return;
  }
  if (platform === 'ios') {
    const initialized = existsSync(resolve(root, 'src-tauri/gen/apple'));
    if (action === 'init') {
      if (!initialized) run(command);
      prepareApplePasskeys();
      prepareIcons();
      return;
    }
    if (action !== 'init' && !initialized) throw new Error('Initialize the local iOS project first');
    prepareApplePasskeys();
    prepareIcons();
    if (action === 'prepare') return;
  }
  run(command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
