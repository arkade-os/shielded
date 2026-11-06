import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../spec/tla/', import.meta.url));
const checksum = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const temporary = mkdtempSync(join(tmpdir(), 'shielded-tlc-'));
try {
  let artifact;
  if (process.env.TLC_JAR) artifact = readFileSync(process.env.TLC_JAR);
  else {
    const response = await fetch('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar', { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`TLC download failed: HTTP ${response.status}`);
    artifact = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(artifact).digest('hex') !== checksum) throw new Error('TLC artifact checksum mismatch');
  const jar = join(temporary, 'tla2tools.jar');
  writeFileSync(jar, artifact);
  const configurations = readdirSync(directory).filter(name => /^NativeSession.*\.cfg$/.test(name) && !name.endsWith('_Sim.cfg')).sort();
  if (!configurations.includes('NativeSession.cfg')) throw new Error('Base model configuration is missing');
  for (const configuration of configurations) {
    const expected = readFileSync(join(directory, configuration), 'utf8').match(/^\\\* EXPECT: (.+)\r?$/m)?.[1];
    if (!expected || (expected !== 'GREEN' && !/^Invariant \w+ is violated$/.test(expected))) throw new Error(`Invalid EXPECT in ${configuration}`);
    const result = spawnSync(process.env.JAVA || 'java', [
      '-Xmx2G', '-cp', jar, 'tlc2.TLC', '-workers', '2', '-metadir', join(temporary, configuration),
      '-config', configuration, 'NativeSession.tla',
    ], { cwd: directory, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const matches = expected === 'GREEN'
      ? result.status === 0 && output.includes('Model checking completed. No error has been found.')
      : result.status === 12 && output.includes(`${expected}.`);
    if (result.error || !matches) throw new Error(`${configuration}: expected ${expected}, exit ${result.status}\n${result.error || ''}\n${output}`);
    process.stdout.write(`${configuration}: ${expected}\n`);
  }
  process.stdout.write(`${configurations.length} configurations matched their expected results\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
