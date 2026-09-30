import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { arkade } from "@arkade-os/sdk";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = process.env.ARKADEC_PATH ?? process.env.ARKADEC ?? path.resolve(project,
  process.platform === "win32" ? ".deps/compiler/target/release/arkadec.exe" : "bin/arkadec");
if (!existsSync(compiler)) {
  throw new Error("Set ARKADEC to the pinned compiler build with ecPairingProduct support");
}
const artifactDir = path.resolve(project, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const summaries = [];
for (const name of ["gate", "lane", "btc_vault", "token_vault", "recipient"]) {
  const source = path.resolve(project, `contracts/poc/${name}.ark`);
  const output = path.resolve(artifactDir, `poc_${name}.json`);
  execFileSync(compiler, [source, "-o", output], { stdio: ["ignore", "pipe", "inherit"] });
  const artifact = JSON.parse(readFileSync(output, "utf8")) as arkade.ContractArtifact & { fingerprint: string };
  const program = arkade.programFromArtifact(artifact);
  summaries.push({
    contract: artifact.contractName,
    artifact: path.relative(project, output),
    fingerprint: artifact.fingerprint,
    functions: artifact.functions.map((fn) => ({
      name: fn.name,
      covenantInstructions: fn.arkade?.asm.length ?? 0,
      pairingCalls: fn.arkade?.asm.filter((op) => op === "OP_ECPAIRING").length ?? 0,
    })),
    programName: program.name,
  });
}
writeFileSync(path.resolve(artifactDir, "compile-manifest.json"), `${JSON.stringify(summaries, null, 2)}\n`);
console.log(JSON.stringify(summaries, null, 2));
