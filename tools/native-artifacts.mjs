import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://shielded.mutinynet.arkade.sh';

export function verifyMutinynet(projectRoot) {
  const host = readFileSync(join(projectRoot, 'src-tauri/src/lib.rs'), 'utf8');
  const routes = readFileSync(join(projectRoot, 'src-tauri/src/transport/routes.rs'), 'utf8');
  if (host.match(/poolOrigin: '([^']+)'/)?.[1] !== origin || routes.match(/pub const POOL: &str = "([^"]+)";/)?.[1] !== new URL(origin).hostname) {
    throw new Error('Native artifacts require the hardcoded Mutinynet host and route policy');
  }
}

/** Hashes text with CRLF and lone CR normalized to LF across platforms. */
export function canonicalTextSha256(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}

function groups(platform, profile) {
  if (!['debug', 'release'].includes(profile)) throw new Error('Use the debug or release native profile');
  const desktop = `src-tauri/target/${profile}/bundle`;
  const mac = `src-tauri/target/universal-apple-darwin/${profile}/bundle`;
  switch (platform) {
    case 'windows-x86_64': return [{ directory: `${desktop}/nsis`, extension: '.exe', profile }];
    case 'linux-x86_64': return [{ directory: `${desktop}/deb`, extension: '.deb', profile }, { directory: `${desktop}/appimage`, extension: '.AppImage', profile }];
    case 'macos-universal': return [{ directory: `${mac}/dmg`, extension: '.dmg', profile }, { directory: `${mac}/macos`, extension: '.app.zip', profile }];
    case 'android-arm64': return [profile, ...(profile === 'release' ? ['debug'] : [])].map(selected => ({ directory: 'src-tauri/gen/android/app/build/outputs/apk', extension: '.apk', profile: selected, segment: selected, requiresSigning: selected === 'release' }));
    case 'ios': return [{ directory: 'src-tauri/gen/apple/build/arm64', extension: '.ipa', profile, requiresSigning: true }, { directory: 'src-tauri/gen/apple/build', extension: '-simulator.app.zip', profile }];
    default: throw new Error('Unknown native artifact platform');
  }
}

export function collectNativeArtifacts(projectRoot, platform, profile, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Native artifacts require the source commit SHA');
  verifyMutinynet(projectRoot);
  const selected = groups(platform, profile).flatMap(group => {
    const directory = join(projectRoot, group.directory);
    const matches = files(directory).filter(path => path.endsWith(group.extension) && (!group.segment || relative(directory, path).split(/[\\/]/).includes(group.segment)));
    if (!matches.length) throw new Error(`Missing ${group.profile} ${group.extension} artifact in ${group.directory}`);
    return matches.map(path => ({ path, profile: group.profile, requiresSigning: !!group.requiresSigning }));
  });
  for (const artifact of selected) if (!statSync(artifact.path).size) throw new Error(`Empty native artifact: ${artifact.path}`);
  const output = resolve(projectRoot, 'src-tauri/target/native-artifacts', `${platform}-${profile}`);
  if (existsSync(output) && readdirSync(output).length) throw new Error('Native artifact output must be empty before collection');
  mkdirSync(output, { recursive: true });
  const packages = selected.sort((a, b) => a.path.localeCompare(b.path)).map(artifact => {
    const name = `mutinynet-${artifact.profile}${artifact.requiresSigning ? '-unsigned' : ''}-${basename(artifact.path)}`;
    const destination = join(output, name);
    if (existsSync(destination)) throw new Error(`Duplicate native artifact filename: ${name}`);
    copyFileSync(artifact.path, destination);
    const bytes = readFileSync(destination);
    return { file: name, profile: artifact.profile, requiresSigning: artifact.requiresSigning, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const lockfileSha256 = canonicalTextSha256(readFileSync(join(projectRoot, 'package-lock.json')));
  const rustLockfileSha256 = canonicalTextSha256(readFileSync(join(projectRoot, 'src-tauri/Cargo.lock')));
  const environment = {
    node: '24.22.2',
    rust: '1.96.0',
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
    lockfileSha256,
    rustLockfileSha256,
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ network: 'mutinynet', poolOrigin: origin, platform, commit, environment, packages }, null, 2) + '\n');
  writeFileSync(join(output, 'SHA256SUMS'), packages.map(item => `${item.sha256}  ${item.file}\n`).join(''));
  writeFileSync(join(output, 'README.txt'), [
    'Shielded native wallet — Mutinynet test funds only.',
    `Pool: ${origin}`,
    `Platform: ${platform}. Build profile: ${profile}. Source: ${commit}.`,
    `Reproduction environment: Node ${environment.node}, Rust ${environment.rust}, SOURCE_DATE_EPOCH ${environment.sourceDateEpoch}.`,
    `Lockfile SHA-256 (UTF-8 text, CRLF/CR normalized to LF): npm ${lockfileSha256}; Cargo ${rustLockfileSha256}.`,
    'Wallet networking uses embedded Tor; this workflow does not configure a direct mode.',
    'macOS archives preserve the app bundle and executable permissions. These builds are not notarized by this workflow.',
    'The iPhone device IPA is unsigned and needs your own signing and provisioning before installation. The simulator archive runs only in an iOS simulator.',
    'The Android release APK is unsigned. The additional debug APK uses the runner development key and is explicitly a debug build.',
    'Debug signing is not a stable distribution identity. Updates require the same signing key; preserve your recovery phrase before replacing an existing installation.',
    'Distribution signing credentials are not generated, stored or uploaded by this workflow.',
    '',
  ].join('\n'));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, platform, profile] = process.argv.slice(2);
    if (command === 'verify-network') verifyMutinynet(root);
    else if (command === 'collect') console.log(collectNativeArtifacts(root, platform, profile, process.env.GITHUB_SHA));
    else throw new Error('Use verify-network or collect <platform> <debug|release>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
