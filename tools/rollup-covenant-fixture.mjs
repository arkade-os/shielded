import {mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as snarkjs from 'snarkjs';
import {buildBn128} from 'ffjavascript';
import {pinnedCircom} from '../circuits/rollup/compiler.mjs';

// Real snarkjs keys and proofs for the covenant's toy circuits, so the Go
// engine tests exercise snarkjs's own key and proof encodings end to end.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'circuits', 'rollup');
const build = path.join(source, 'build', 'covenant');
const output = process.argv[2] ?? path.join(root, 'tools', 'vm', 'testdata', 'rollup-covenant-snarkjs.json');
const file = (name) => path.join(build, name);
mkdirSync(build, {recursive: true});
mkdirSync(path.dirname(output), {recursive: true});
const compiler = pinnedCircom(root);
for (const name of ['covenant-client', 'covenant-batch']) {
  const result = spawnSync(compiler, [path.join(source, `${name}.circom`), '--r1cs', '--wasm', '--O2', '-o', build], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const curve = await buildBn128();
await snarkjs.powersOfTau.newAccumulator(curve, 6, file('pot_0.ptau'));
await snarkjs.powersOfTau.contribute(file('pot_0.ptau'), file('pot_1.ptau'), 'covenant fixture', 'covenant fixture phase one');
await snarkjs.powersOfTau.preparePhase2(file('pot_1.ptau'), file('pot.ptau'));
const keys = {};
for (const name of ['covenant-client', 'covenant-batch']) {
  await snarkjs.zKey.newZKey(file(`${name}.r1cs`), file('pot.ptau'), file(`${name}_0.zkey`));
  await snarkjs.zKey.contribute(file(`${name}_0.zkey`), file(`${name}.zkey`), 'covenant fixture', `${name} phase two`);
  keys[name] = await snarkjs.zKey.exportVerificationKey(file(`${name}.zkey`));
}

const le248 = (bytes) => {
  const digest = createHash('sha256').update(bytes).digest();
  let value = 0n;
  for (let i = 30; i >= 0; i--) value = (value << 8n) | BigInt(digest[i]);
  return value;
};
const packet = (a, b) => Buffer.concat([Buffer.alloc(31, a), Buffer.alloc(1), Buffer.alloc(31, b), Buffer.alloc(1)]);
const oldPacket = packet(0x0a, 0x0b), newPacket = packet(0x0c, 0x0d), payoutProgram = Buffer.alloc(32, 0x51);
const slots = [];
for (let i = 0; i < 11; i++) {
  const w = BigInt(i + 2);
  const input = {pub: w * w, deposit: i === 1 ? 2500n : 0n, withdraw: i === 3 ? 1000n : 0n, boundaryAsset: 0n, destination: i === 3 ? le248(payoutProgram) : 0n, w};
  const strings = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.toString()]));
  slots.push(await snarkjs.groth16.fullProve(strings, file('covenant-client_js/covenant-client.wasm'), file('covenant-client.zkey')));
}
const binding = Buffer.concat([Buffer.from([0x53, 0x48, 2, 0, 11]), oldPacket.subarray(0, 32), newPacket]);
const x = [...slots.map((slot) => slot.publicSignals[0]), le248(binding).toString()];
const batch = await snarkjs.groth16.fullProve({x}, file('covenant-batch_js/covenant-batch.wasm'), file('covenant-batch.zkey'));
const fixture = {clientKey: keys['covenant-client'], batchKey: keys['covenant-batch'], oldPacket: oldPacket.toString('hex'), newPacket: newPacket.toString('hex'), payoutProgram: payoutProgram.toString('hex'), slots, batch};
writeFileSync(output, JSON.stringify(fixture, null, 1) + '\n');
await curve.terminate();
console.log('wrote', path.relative(root, output));
