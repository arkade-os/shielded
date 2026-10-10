// Temporary patches until the SDK publishes them: OP_PUT in the opcode table, and `new this(...)` in the
// wallet factories so a subclass can be produced by the inherited `create`. Neither changes scripts or execution.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONSTRUCTORS = ["_Wallet", "_ReadonlyWallet"];
const PATCHED = /const wallet = new this\(/g;

/** Rewrites every `new _Wallet(` / `new _ReadonlyWallet(` to `new this(`, reporting the count per name. */
export function patchConstruction(source) {
  let text = source;
  const hits = {};
  for (const name of CONSTRUCTORS) {
    const pattern = new RegExp(`new ${name}\\(`, "g");
    hits[name] = (text.match(pattern) ?? []).length;
    text = text.replace(pattern, "new this(");
  }
  return { text, hits, already: (source.match(PATCHED) ?? []).length };
}

/**
 * A wallet bundle constructs each factory exactly once. Refusing per constructor name is what stops a second
 * `_Wallet` site in one bundle from masking a missing `_ReadonlyWallet` site in the same one.
 */
export function assertBundleSites(file, result) {
  const { hits, already } = result;
  if (already === CONSTRUCTORS.length && CONSTRUCTORS.every((name) => !hits[name])) return "already";
  if (CONSTRUCTORS.every((name) => hits[name] === 1)) return "patched";
  const found = CONSTRUCTORS.map((name) => `${hits[name] ?? 0}x new ${name}(`).join(", ");
  throw new Error(`SDK wallet factories changed in ${file}: found ${found} and ${already} already patched; review the \`new this\` patch before running the app`);
}

export function patchSdk(directory) {
  const pkg = JSON.parse(readFileSync(path.resolve(directory, "../package.json"), "utf8"));
  if (pkg.version !== "0.4.77") throw new Error(`SDK patches require @arkade-os/sdk 0.4.77; found ${pkg.version}`);
  let patched = 0, supported = 0, bundles = 0, already = 0;
  for (const file of readdirSync(directory)) {
    if (!/\.(?:js|cjs|d\.ts|d\.cts)$/.test(file)) continue;
    const filename = path.resolve(directory, file);
    let source = readFileSync(filename, "utf8"), dirty = false;
    const declarations = file.endsWith(".ts") || file.endsWith(".cts");
    const marker = declarations ? /MERKLEBRANCHVERIFY: 179;/ : /MERKLEBRANCHVERIFY: 179,/;
    if (marker.test(source)) {
      if (/\bPUT: 187[;,]/.test(source)) supported++;
      else {
        const replacement = declarations ? "MERKLEBRANCHVERIFY: 179;\n    readonly PUT: 187;" : "MERKLEBRANCHVERIFY: 179,\n  PUT: 187,";
        source = source.replace(marker, replacement); patched++; dirty = true;
      }
    }
    if (!declarations) {
      const result = patchConstruction(source);
      if (result.hits._Wallet || result.hits._ReadonlyWallet || result.already) {
        bundles++;
        if (assertBundleSites(file, result) === "patched") { source = result.text; dirty = true; } else already++;
      }
    }
    if (dirty) writeFileSync(filename, source);
  }
  if (patched + supported < 2) throw new Error("SDK opcode bundle layout changed; review the OP_PUT patch before running the app");
  if (bundles !== 2) throw new Error(`SDK wallet bundle layout changed: expected 2 bundles carrying the factories, found ${bundles}; review the \`new this\` patch before running the app`);
  return { patched, supported, bundles, already };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.dirname(createRequire(import.meta.url).resolve("@arkade-os/sdk"));
  const result = patchSdk(directory);
  console.log(`SDK OP_PUT 0xbb support: ${result.patched} files patched, ${result.supported} already supported`);
  console.log(`SDK \`new this\` factories: ${result.bundles - result.already} bundles patched, ${result.already} already patched`);
}
