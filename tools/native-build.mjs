import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');

export function nativeArguments(platform, action, args = [], host = process.platform) {
  if (!['desktop', 'android', 'ios'].includes(platform)) throw new Error('Use desktop, android or ios');
  if (platform === 'ios' && host !== 'darwin') throw new Error('Build iOS on macOS with Xcode');
  if (!['dev', 'build', 'init', 'prepare'].includes(action) || (platform === 'desktop' && !['dev', 'build'].includes(action))) throw new Error('Unsupported native action');
  return [...(platform === 'desktop' ? [] : [platform]), action, ...args];
}

export function protectAndroidManifest(source) {
  const matches = [...source.matchAll(/<application\b[^>]*>/g)];
  if (matches.length !== 1) throw new Error('Expected one generated Android application');
  let application = matches[0][0];
  for (const [name, value] of Object.entries({ allowBackup: 'false', fullBackupContent: 'false', dataExtractionRules: '@xml/shielded_data_extraction_rules' })) {
    const attribute = new RegExp(`\\s+android:${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'g');
    application = application.replace(attribute, '').replace(/\s*\/?>(?=$)/, end => ` android:${name}="${value}"${end.trimStart()}`);
  }
  return source.replace(matches[0][0], application);
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, shell: false, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Tauri command failed (exit ${result.status ?? 'unavailable'})`);
}

function prepareAndroid() {
  const manifest = resolve(root, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  if (!existsSync(manifest) || lstatSync(manifest).isSymbolicLink()) throw new Error('Initialize the local Android project first');
  const source = readFileSync(manifest, 'utf8');
  const prepared = protectAndroidManifest(source);
  if (prepared !== source) writeFileSync(manifest, prepared);
}

export function main([platform = 'desktop', action = 'dev', ...args] = process.argv.slice(2)) {
  if (platform === 'icons') { run(['icon', 'src-tauri/icon.svg', '--output', 'src-tauri/icons']); return; }
  if (args[0] === '--') args.shift();
  const command = nativeArguments(platform, action, args);
  if (args.some(arg => ['--help', '-h'].includes(arg))) { run(command); return; }
  if (!existsSync(resolve(root, 'src-tauri/icons/icon.png'))) run(['icon', 'src-tauri/icon.svg', '--output', 'src-tauri/icons']);
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
    if (action === 'init' && initialized) return;
    if (action !== 'init' && !initialized) throw new Error('Initialize the local iOS project first');
    if (action === 'prepare') return;
  }
  run(command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
