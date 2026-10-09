import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { buildBn128 } from 'ffjavascript';

const root = fileURLToPath(new URL('../', import.meta.url));
const PTAU = 'powersOfTau28_hez_final_20.ptau';
const PTAU_BLAKE2B512 = '89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b';
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!args.includes('--development-only')) throw new Error('This setup is development-only. Pass --development-only explicitly.');
const build = resolve(option('--build') ?? join(root, 'circuits', 'rollup', 'build'));
const out = resolve(option('--out') ?? join(build, 'keys')), ptau = resolve(option('--ptau') ?? join(root, '.deps', 'rollup-ceremony', PTAU));
const circuits = (option('--circuits') ?? 'spend,join,batch-spend,batch-join').split(',');
const progress = stage => console.log('ROLLUP_SETUP_PROGRESS=' + JSON.stringify({ stage }));
// One thread bounds memory on a shared host; the global curve is the one snarkjs reuses.
if (args.includes('--single-thread')) globalThis.curve_bn128 = await buildBn128(true);

async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

progress('phase-1 transcript');
if (!existsSync(ptau) || await digest(ptau, 'blake2b512') !== PTAU_BLAKE2B512) {
  mkdirSync(resolve(ptau, '..'), { recursive: true });
  rmSync(ptau, { force: true });
  const response = await fetch('https://circom.info/' + PTAU, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error('Phase-1 transcript download failed: HTTP ' + response.status);
  const partial = ptau + '.partial-' + process.pid, hash = createHash('blake2b512');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(partial, { flags: 'wx' }));
  if (hash.digest('hex') !== PTAU_BLAKE2B512) { rmSync(partial); throw new Error('The phase-1 transcript does not match its pinned BLAKE2b512.'); }
  renameSync(partial, ptau);
}

mkdirSync(out, { recursive: true });
const manifest = { version: 1, setup: { phase1: PTAU, phase1Blake2b512: PTAU_BLAKE2B512, phase2: 'development-only' }, circuits: {} };
for (const name of circuits) {
  const r1cs = join(build, `${name}.r1cs`), initial = join(out, `${name}.initial.zkey`), zkey = join(out, `${name}.zkey`);
  if (existsSync(zkey)) throw new Error(`Refusing to overwrite existing setup artifact: ${zkey}`);
  progress(`${name} key`);
  await snarkjs.zKey.newZKey(r1cs, ptau, initial);
  progress(`${name} contribution`);
  await snarkjs.zKey.contribute(initial, zkey, 'Local development-only contribution; not a production ceremony', randomBytes(32).toString('hex'));
  rmSync(initial);
  await writeFile(join(out, `${name}.vkey.json`), JSON.stringify(await snarkjs.zKey.exportVerificationKey(zkey)) + '\n');
  copyFileSync(join(build, `${name}_js`, `${name}.wasm`), join(out, `${name}.wasm`));
  manifest.circuits[name] = { r1cs: await digest(r1cs), files: Object.fromEntries(await Promise.all(['zkey', 'vkey.json', 'wasm'].map(async ext => [`${name}.${ext}`, await digest(join(out, `${name}.${ext}`))]))) };
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
await globalThis.curve_bn128?.terminate();
console.log('Development-only rollup keys written to ' + out);
