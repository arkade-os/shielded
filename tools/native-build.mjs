import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  if (versionCode !== undefined) {
    const separator = command.indexOf('--');
    command.splice(separator < 0 ? command.length : separator, 0, '--config', JSON.stringify({ bundle: { android: { versionCode, autoIncrementVersionCode: false } } }));
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
      prepareIcons();
      return;
    }
    if (action !== 'init' && !initialized) throw new Error('Initialize the local iOS project first');
    prepareIcons();
    if (action === 'prepare') return;
  }
  run(command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
