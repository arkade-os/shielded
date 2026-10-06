import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { buildBn128 } from 'ffjavascript';
import { STOCK_DOMAIN, stockProofDescriptor } from '../packages/protocol/src/stock-native.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, 'circuits', 'stock', 'build', 'compiled');
const phase1 = resolve(root, '.deps', 'stock-ceremony', 'powersOfTau28_hez_final_18.ptau');
const expectedPtauBlake2b512 = '7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e';
const compilerDir = join(root, '.deps', 'native-circom-2.2.2');
const compilerPins = {
  'circom-windows-amd64.exe': 'e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1',
  'circom-linux-amd64': 'f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5',
};
const file = (name) => join(build, name);

async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function run() {
  if (!process.argv.includes('--development-only')) {
    throw new Error('This setup is development-only. Pass --development-only explicitly.');
  }
  await access(file('stock-combined.circom'));
  await access(file('stock-combined.r1cs'));
  await access(file('stock-combined_js/stock-combined.wasm'));
  await access(phase1);
  const compilerMetadata = JSON.parse(await readFile(join(compilerDir, 'compiler.json'), 'utf8'));
  const compiler = join(compilerDir, compilerMetadata.file);
  if (compilerMetadata.version !== '2.2.2' || compilerPins[compilerMetadata.file] !== compilerMetadata.sha256) {
    throw new Error('Native Circom metadata is missing or does not match a pinned 2.2.2 compiler. Run tools/prepare-stock-tools.mjs first.');
  }
  await access(compiler);

  const [ptauHash, compilerHash] = await Promise.all([
    digest(phase1, 'blake2b512'),
    digest(compiler),
  ]);
  if (ptauHash !== expectedPtauBlake2b512) throw new Error('The public phase1 file does not match its pinned BLAKE2b512.');
  if (compilerHash !== compilerMetadata.sha256) throw new Error('The Circom compiler does not match its pinned 2.2.2 metadata.');

  const initialZkey = file('stock-combined.initial.zkey');
  const finalZkey = file('stock-combined.zkey');
  const vkeyPath = file('stock-combined.vkey.json');
  const manifestPath = file('stock-combined.manifest.json');
  for (const path of [initialZkey, finalZkey, vkeyPath, manifestPath]) {
    try { await access(path); throw new Error(`Refusing to overwrite existing setup artifact: ${path}`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  // Preload the same global curve object snarkjs will reuse, forcing a bounded single-thread setup.
  globalThis.curve_bn128 = await buildBn128(true);
  const r1csPath = file('stock-combined.r1cs');
  await snarkjs.zKey.newZKey(r1csPath, phase1, initialZkey, console);
  await snarkjs.zKey.contribute(
    initialZkey,
    finalZkey,
    'Local development-only contribution; not a production ceremony',
    randomBytes(32).toString('hex'),
    console,
  );
  const phase2Valid = await snarkjs.zKey.verifyFromInit(initialZkey, phase1, finalZkey, console);
  if (!phase2Valid) throw new Error('Development phase2 verification failed.');

  const vkey = await snarkjs.zKey.exportVerificationKey(finalZkey, console);
  if (vkey.protocol !== 'groth16' || vkey.curve !== 'bn128' || vkey.nPublic !== 1 || vkey.IC?.length !== 2) {
    throw new Error('Generated verifier key does not have the required one-public-signal Groth16 BN254 profile.');
  }
  const descriptor = stockProofDescriptor(vkey, STOCK_DOMAIN.toString());
  await writeFile(vkeyPath, `${JSON.stringify(vkey, null, 2)}\n`, { flag: 'wx' });

  const artifactFiles = {
    'stock-combined.circom': 'stock-combined.circom',
    'stock-combined.r1cs': 'stock-combined.r1cs',
    'stock-combined.wasm': 'stock-combined_js/stock-combined.wasm',
    'stock-combined.initial.zkey': 'stock-combined.initial.zkey',
    'stock-combined.zkey': 'stock-combined.zkey',
    'stock-combined.vkey.json': 'stock-combined.vkey.json',
  };
  const artifacts = {};
  for (const [name, relativePath] of Object.entries(artifactFiles)) {
    const path = file(relativePath);
    artifacts[name] = { size: (await stat(path)).size, sha256: await digest(path) };
  }

  const snarkjsPackage = JSON.parse(await readFile(join(root, 'node_modules', 'snarkjs', 'package.json'), 'utf8'));
  const manifest = {
    version: 1,
    profile: descriptor,
    setup: {
      purpose: 'development-only local proof generation',
      phase1: 'powersOfTau28_hez_final_18.ptau',
      phase1Blake2b512: ptauHash,
      phase2: 'development-only',
      phase2Description: 'single local random contribution; not a reviewed multi-party production ceremony',
      verifiedAgainstInitialZkey: phase2Valid,
    },
    compiler: { name: 'iden3/circom', version: compilerMetadata.version, binary: compilerMetadata.file, binarySha256: compilerHash, optimization: 'O2' },
    proving: { system: 'Groth16', curve: 'BN254', constraints: 200540, publicSignals: 1, statementEncoding: 'sha256-le-248' },
    circuit: { sourceSha256: artifacts['stock-combined.circom'].sha256, r1csSha256: artifacts['stock-combined.r1cs'].sha256 },
    toolchain: { snarkjs: snarkjsPackage.version },
    artifacts,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`Development-only stock Groth16 setup verified. Profile: ${descriptor.profileId}`);
  console.log(`Manifest: ${manifestPath}`);
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
