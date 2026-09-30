// Temporary generic opcode-table patch until the SDK publishes OP_PUT support.
// Contracts remain compiler generated. This adds the emulator's existing byte
// to the SDK encoder; it does not modify scripts or execution behavior.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const entry = require.resolve("@arkade-os/sdk");
const directory = path.dirname(entry);
const packageFile = path.resolve(directory, "../package.json");
const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
if (pkg.version !== "0.4.77") throw new Error(`OP_PUT patch requires @arkade-os/sdk 0.4.77; found ${pkg.version}`);
let patched = 0;
let supported = 0;
for (const file of readdirSync(directory)) {
  if (!/\.(?:js|cjs|d\.ts|d\.cts)$/.test(file)) continue;
  const filename = path.resolve(directory, file);
  const source = readFileSync(filename, "utf8");
  const declarations = file.endsWith(".ts") || file.endsWith(".cts");
  const marker = declarations ? /MERKLEBRANCHVERIFY: 179;/ : /MERKLEBRANCHVERIFY: 179,/;
  if (!marker.test(source)) continue;
  if (/\bPUT: 187[;,]/.test(source)) { supported++; continue; }
  const replacement = declarations ? "MERKLEBRANCHVERIFY: 179;\n    readonly PUT: 187;" : "MERKLEBRANCHVERIFY: 179,\n  PUT: 187,";
  writeFileSync(filename, source.replace(marker, replacement));
  patched++;
}
if (patched + supported < 2) throw new Error("SDK opcode bundle layout changed; review OP_PUT patch before running the app");
console.log(`SDK OP_PUT 0xbb support: ${patched} files patched, ${supported} already supported`);
