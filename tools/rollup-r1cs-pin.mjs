// Fails unless each genesis-3 circuit still compiles to the exact r1cs and wasm its ceremony keys were made for.
// The names are fixed on purpose: circuits added later must never widen this check.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'rollup-keys', 'genesis-3.json'), 'utf8'));
const digest = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(root, path))) hash.update(chunk);
  return hash.digest('hex');
};

const drift = [];
for (const name of ['spend', 'join', 'batch-spend', 'batch-join']) {
  const pinned = manifest.circuits[name], built = `circuits/rollup/build/${name}`, line = [];
  for (const [kind, file, expected] of [['r1cs', `${built}.r1cs`, pinned?.r1cs], ['wasm', `${built}_js/${name}.wasm`, pinned?.files?.[`${name}.wasm`]]]) {
    const actual = await digest(file).catch(error => `unreadable (${error.code})`);
    if (actual !== expected) drift.push(`${name} ${kind} ${file}\n  pinned   ${expected}\n  compiled ${actual}`);
    line.push(`${kind} ${actual === expected ? 'ok' : 'MISMATCH'}`);
  }
  console.log(`${name.padEnd(11)} ${line.join('  ')}`);
}
if (drift.length) {
  console.error(`\n${drift.length} artifact(s) differ from rollup-keys/genesis-3.json:\n${drift.join('\n')}`);
  process.exitCode = 1;
}
