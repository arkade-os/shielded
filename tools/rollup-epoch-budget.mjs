// Fails unless the five epoch circuits fit one 2^20 Groth16 domain and still compile to the counts and r1cs bytes pinned below.
// --O2 folds linear === constraints away, so deleting one leaves nConstraints unchanged; only the hash sees it. Re-pin after a deliberate edit.
// epoch-nonmember is a test harness outside every ceremony, so it is not listed. r1cs.info loads every constraint, hence the 8 GB heap in the npm script.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const LIMIT = 1_048_575;
const pins = {
  'epoch-spend': { nConstraints: 11_079, nPubInputs: 7, nOutputs: 0, sha256: '39320faffecf66e43fe9edb8cab07f2a1dd6628ad3075d11fbecb167f50b8afa' },
  'epoch-join': { nConstraints: 20_068, nPubInputs: 7, nOutputs: 0, sha256: '0af7c61fc31549d1f239f4e4b0f6966517f355fe94c01f1d6f05d5f1202905d7' },
  'epoch-batch-spend': { nConstraints: 554_038, nPubInputs: 11, nOutputs: 0, sha256: 'c6caa00ce22388a1f9704880f5d4875548983b8bd2e87ed749f55c037dc9d441' },
  'epoch-batch-join': { nConstraints: 953_418, nPubInputs: 11, nOutputs: 0, sha256: '327b2c96eb24a0d6a2069f3c0d7374afa8b4d9d922278121922834d7d8c12017' },
  'epoch-batch-recover': { nConstraints: 185_132, nPubInputs: 2, nOutputs: 0, sha256: '0d53fcc7e1d5f38928fdd12b5e64962564f26597837ed1225a1305fe2a1f06e0' },
};

const build = join(fileURLToPath(new URL('../', import.meta.url)), 'circuits', 'rollup', 'build');
const digest = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const row = ([name, ...cells]) => [name.padEnd(19), ...cells.map(cell => cell.toLocaleString('en-US').padStart(12))].join(' ');

const problems = [];
console.log(row(['circuit', 'nConstraints', 'nPubInputs', 'nOutputs', 'fit', 'slack', 'r1cs']));
for (const [name, pin] of Object.entries(pins)) {
  const path = join(build, `${name}.r1cs`);
  let actual;
  try {
    const { nConstraints, nPubInputs, nOutputs } = await snarkjs.r1cs.info(path);
    actual = { nConstraints, nPubInputs, nOutputs, sha256: await digest(path) };
  } catch (error) {
    problems.push(`${name}.r1cs unreadable (${error.code ?? error.message}); run npm run rollup:compile:epoch`);
    continue;
  }
  const fit = actual.nConstraints + actual.nPubInputs + actual.nOutputs;
  if (fit > LIMIT) problems.push(`${name} fit ${fit} exceeds ${LIMIT} by ${fit - LIMIT}`);
  for (const key of ['nConstraints', 'nPubInputs', 'nOutputs', 'sha256']) if (actual[key] !== pin[key]) problems.push(`${name} ${key} pinned ${pin[key]}, compiled ${actual[key]}`);
  console.log(row([name, actual.nConstraints, actual.nPubInputs, actual.nOutputs, fit, LIMIT - fit, actual.sha256 === pin.sha256 ? 'ok' : 'MISMATCH']));
}
await globalThis.curve_bn128?.terminate();
if (problems.length) {
  console.error(`\n${problems.length} problem(s) against the pins in tools/rollup-epoch-budget.mjs:\n${problems.map(line => `  ${line}`).join('\n')}`);
  process.exitCode = 1;
}
