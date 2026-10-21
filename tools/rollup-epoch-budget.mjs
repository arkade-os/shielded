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
  'epoch-batch-spend': { nConstraints: 554_036, nPubInputs: 11, nOutputs: 0, sha256: 'f679a9cb97fb26c498aeae1a2336bc8fc8aeaf0a0c6fa5283c3d306355f6f46d' },
  'epoch-batch-join': { nConstraints: 953_416, nPubInputs: 11, nOutputs: 0, sha256: 'f11d40f55c68ff16c83158483bc35bf568ede4fddb11145a5611a723f337abf4' },
  'epoch-batch-recover': { nConstraints: 185_130, nPubInputs: 2, nOutputs: 0, sha256: 'ede602d8208fe92cf9a3742ae93ebb508c67641198ec5d39c0addf593ea649fa' },
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
  for (const key of Object.keys(pin)) if (actual[key] !== pin[key]) problems.push(`${name} ${key} pinned ${pin[key]}, compiled ${actual[key]}`);
  console.log(row([name, actual.nConstraints, actual.nPubInputs, actual.nOutputs, fit, LIMIT - fit, actual.sha256 === pin.sha256 ? 'ok' : 'MISMATCH']));
}
await globalThis.curve_bn128?.terminate();
if (problems.length) {
  console.error(`\n${problems.length} problem(s) against the pins in tools/rollup-epoch-budget.mjs:\n${problems.map(line => `  ${line}`).join('\n')}`);
  process.exitCode = 1;
}
