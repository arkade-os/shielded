import { spawnSync } from 'node:child_process';

export function retryCommand(command, args, options = {}) {
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
    if (!result.error && result.status === 0) return;
    if (attempt === attempts) {
      throw result.error ?? new Error(`${command} failed after ${attempts} attempts (exit ${result.status ?? 'unavailable'})`);
    }
    console.error(`${command} failed (exit ${result.status ?? 'unavailable'}); retrying ${attempt}/${attempts - 1}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5000);
  }
}

if (process.argv[1]?.endsWith('retry-command.mjs')) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command) throw new Error('Use: node tools/retry-command.mjs <command> [args...]');
    retryCommand(command, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
