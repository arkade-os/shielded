import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../spec/tla/', import.meta.url));
export const TLC_CHECKSUM = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const TLC_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';

/** Fetch the pinned TLC artifact, retrying transport errors and corrupt bodies. */
export async function downloadTlcArtifact({fetchImpl=fetch,checksum=TLC_CHECKSUM,wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),report=message=>process.stderr.write(`${message}\n`) }={}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(TLC_URL, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`TLC download failed: HTTP ${response.status}`);
      const artifact = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(artifact).digest('hex') !== checksum) throw new Error('TLC artifact checksum mismatch');
      return artifact;
    } catch (error) {
      if (attempt === 3) throw error;
      report(`${error.message}; retrying ${attempt}/2`);
      await wait(attempt * 5_000);
    }
  }
}

async function main() {
  const temporary = mkdtempSync(join(tmpdir(), 'shielded-tlc-'));
  try {
    const artifact = process.env.TLC_JAR ? readFileSync(process.env.TLC_JAR) : await downloadTlcArtifact();
    if (createHash('sha256').update(artifact).digest('hex') !== TLC_CHECKSUM) throw new Error('TLC artifact checksum mismatch');
    const jar = join(temporary, 'tla2tools.jar');
    writeFileSync(jar, artifact);
    const configurations = readdirSync(directory).filter(name => /^(NativeSession|NativeViewHandoff|TorStatus|TorStartup|TorConnect|WalletStatus|HttpReuse|AndroidUpdate|UpdateRecovery|NativeWarmView|NativeContinuity).*\.cfg$/.test(name) && !name.endsWith('_Sim.cfg')).sort();
    for (const model of ['NativeSession', 'NativeViewHandoff', 'TorStatus', 'TorStartup', 'TorConnect', 'WalletStatus', 'HttpReuse', 'AndroidUpdate', 'UpdateRecovery', 'UpdateRecoveryReceipts', 'NativeWarmView', 'NativeWarmViewStatus', 'NativeContinuity', 'NativeContinuityStatus']) if (!configurations.includes(`${model}.cfg`)) throw new Error(`${model} base configuration is missing`);
    for (const configuration of configurations) {
      const expected = readFileSync(join(directory, configuration), 'utf8').match(/^\\\* EXPECT: (.+)\r?$/m)?.[1];
      if (!expected || (expected !== 'GREEN' && !/^Invariant \w+ is violated$/.test(expected))) throw new Error(`Invalid EXPECT in ${configuration}`);
      const result = spawnSync(process.env.JAVA || 'java', [
        '-Xmx2G', '-cp', jar, 'tlc2.TLC', '-workers', '2', '-metadir', join(temporary, configuration),
        '-config', configuration, `${configuration.split(/[_.]/)[0]}.tla`,
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
