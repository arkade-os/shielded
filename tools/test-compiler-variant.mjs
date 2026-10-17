import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const revision = '89a1ff73b24441699095c9135d6429f7dc6cb6ab';
const root = fileURLToPath(new URL('..', import.meta.url));
const candidate = process.argv.slice(2).length === 1 && process.argv[2] === '--candidate';
if (process.argv.length > 2 && !candidate) throw new Error('Usage: node tools/test-compiler-variant.mjs [--candidate]');
const source = process.env.SHIELDED_COMPILER_SOURCE;
if (!source) throw new Error('Set SHIELDED_COMPILER_SOURCE to a clean arkade-os/compiler checkout.');
const compilerRoot = resolve(source);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}
const git = (args, trim = true) => {
  const output = run('git', ['-C', compilerRoot, ...args], { encoding: 'utf8', stdio: 'pipe' });
  return trim ? output.trim() : output;
};
const actualRevision = git(['rev-parse', 'HEAD']);
const changes = git(['status', '--porcelain', '--untracked-files=all']);
if (!candidate && (actualRevision !== revision || changes)) {
  throw new Error(`Compiler checkout must be clean and pinned to ${revision}.`);
}
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(compilerRoot, 'target'));
run(process.env.CARGO ?? 'cargo', ['build', '--manifest-path', resolve(compilerRoot, 'Cargo.toml'), '--locked', '--release', '--bin', 'arkadec'], {
  env: { ...process.env, CARGO_TARGET_DIR: target },
});
const compiler = resolve(target, 'release', process.platform === 'win32' ? 'arkadec.exe' : 'arkadec');
const sha256 = createHash('sha256').update(readFileSync(compiler)).digest('hex');
const output = resolve(root, process.env.SHIELDED_COMPILER_OUTPUT ?? '.recovery/compiler-variant/vectors');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'toolchain.json'), JSON.stringify({
  baselineRevision: revision, revision: actualRevision, candidate, changes,
  trackedDiffSha256: createHash('sha256').update(git(['diff', '--binary', 'HEAD'], false)).digest('hex'),
  untrackedFiles: git(['ls-files', '--others', '--exclude-standard', '-z'], false).split('\0').filter(Boolean).map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(resolve(compilerRoot, path))).digest('hex'),
  })),
  sha256, platform: process.platform, arch: process.arch,
}, null, 2) + '\n');
console.log(`Compiler ${actualRevision}${candidate ? ' (candidate)' : ''}; SHA256 ${sha256}; vectors ${output}`);
const python = process.env.SHIELDED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
run(python, ['-I', '-m', 'unittest', 'discover', '-s', 'contracts/compiler', '-p', 'test_*.py']);
run(python, ['-I', '-m', 'unittest', 'discover', '-s', 'tools/compiler', '-p', 'test_*.py']);
run(process.env.GO ?? 'go', ['test', '-count=1', '-v', './...'], {
  cwd: resolve(root, 'tools/vm'),
  env: {
    ...process.env, SHIELDED_COMPILER_VARIANT: '1', SHIELDED_COMPILER_CANDIDATE: candidate ? '1' : '0',
    SHIELDED_ARKADEC: compiler, SHIELDED_PYTHON: python, SHIELDED_COMPILER_OUTPUT: output,
  },
});
const snapshot = resolve(root, 'contracts/compiler/vectors');
const manifest = JSON.parse(readFileSync(resolve(snapshot, 'manifest.json'), 'utf8'));
const changed = [];
for (const [path, expected] of Object.entries(manifest.files)) {
  let text;
  try {
    text = readFileSync(resolve(output, path), 'utf8').replaceAll('\r\n', '\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    changed.push(path);
    continue;
  }
  if (createHash('sha256').update(text).digest('hex') !== expected) changed.push(path);
}
console.log(`Stable vectors: ${changed.length} changed of ${Object.keys(manifest.files).length}${changed.length ? ` (${changed.join(', ')})` : ''}`);
if (!candidate && changed.length) throw new Error('Pinned compiler vectors differ from the checked-in baseline.');
