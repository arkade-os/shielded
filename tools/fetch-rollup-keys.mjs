// Downloads published proving keys and keeps each only if it matches the manifest pinned in the repo, so a build trusts
// the repo rather than wherever the files are hosted. Usage: fetch-rollup-keys.mjs <pinned-manifest.json> <base-url> <out-dir>
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [manifestPath, base, out] = process.argv.slice(2);
if (!manifestPath || !base || !out) throw new Error('Usage: fetch-rollup-keys.mjs <pinned-manifest.json> <base-url> <out-dir>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(out, { recursive: true });
for (const { files } of Object.values(manifest.circuits)) for (const [name, digest] of Object.entries(files)) {
  if (!/^[a-z-]+\.(zkey|wasm|vkey\.json)$/.test(name)) throw new Error(`Unexpected file name in the manifest: ${JSON.stringify(name)}`);
  const response = await fetch(`${base.replace(/\/+$/, '')}/${name}`);
  if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
  const hash = createHash('sha256'), partial = join(out, name + '.partial');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(partial));
  if (hash.digest('hex') !== digest) { rmSync(partial); throw new Error(`${name} does not match the pinned manifest.`); }
  renameSync(partial, join(out, name));
}
copyFileSync(manifestPath, join(out, 'manifest.json'));
console.log('Rollup keys verified into ' + out);
