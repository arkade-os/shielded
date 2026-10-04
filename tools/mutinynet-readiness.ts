import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RestArkProvider } from "@arkade-os/sdk";
import { computeRegistryHash, RegisteredEmulatorProvider } from "../src/sdk/registry-provider.ts";

interface Pins {
  arkUrl: string;
  emulatorUrl: string;
  arkSignerPubkey: string;
  emulatorSignerPubkey: string;
  operatorSignerPubkey: string;
  registryHash: string;
  registryPrograms: Record<string, string>;
  requiredMaxTxWeight: number;
  requiredMaxSidecarBytes: number;
}

function secureEndpoint(raw: string, name: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be HTTPS without credentials, query, or fragment`);
}

function requirePins(value: unknown): Pins {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pin file must contain a JSON object");
  const pins = value as Partial<Pins>;
  for (const key of ["arkUrl", "emulatorUrl", "arkSignerPubkey", "emulatorSignerPubkey", "operatorSignerPubkey", "registryHash"] as const) if (typeof pins[key] !== "string") throw new Error(`Pin file is missing ${key}`);
  if (!pins.registryPrograms || typeof pins.registryPrograms !== "object" || Array.isArray(pins.registryPrograms)) throw new Error("Pin file must include registryPrograms bytecode");
  if (!Number.isSafeInteger(pins.requiredMaxTxWeight) || Number(pins.requiredMaxTxWeight) < 1 || !Number.isSafeInteger(pins.requiredMaxSidecarBytes) || Number(pins.requiredMaxSidecarBytes) < 1) throw new Error("Pin file needs positive transaction weight and sidecar requirements");
  return pins as Pins;
}

async function main() {
  const pinPath = process.argv[2];
  if (!pinPath) throw new Error("Usage: node --import tsx tools/mutinynet-readiness.ts <public-pin-file.json>");
  const pins = requirePins(JSON.parse(await readFile(resolve(pinPath), "utf8")));
  secureEndpoint(pins.arkUrl, "Ark URL");
  secureEndpoint(pins.emulatorUrl, "Emulator URL");
  const blockers: string[] = [];
  const checks: Record<string, unknown> = { pinFile: resolve(pinPath), actions: "read-only getInfo requests; no wallet, funding, or transaction submission" };
  const localRegistryHash = computeRegistryHash(pins.registryPrograms);
  if (localRegistryHash !== pins.registryHash) blockers.push("Supplied registry program bytes do not match the pinned registry hash");
  checks.registryHashMatchesPinnedPrograms = localRegistryHash === pins.registryHash;
  let ark: Awaited<ReturnType<RestArkProvider["getInfo"]>> | undefined;
  try {
    ark = await Promise.race([
      new RestArkProvider(pins.arkUrl).getInfo(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Ark getInfo timed out")), 15_000); timer.unref(); }),
    ]);
    checks.ark = { network: ark.network, signerPubkey: ark.signerPubkey, maxTxWeight: ark.maxTxWeight?.toString() ?? null };
    if (ark.network !== "mutinynet") blockers.push(`Ark provider reports ${ark.network}, expected mutinynet`);
    if (ark.signerPubkey.toLowerCase() !== pins.arkSignerPubkey.toLowerCase()) blockers.push("Ark signer key differs from the supplied deployment pin");
    if (ark.signerPubkey.slice(-64).toLowerCase() !== pins.operatorSignerPubkey.toLowerCase()) blockers.push("Ark signer x-only key differs from the covenant operator signer pin");
    const advertisedWeight = ark.maxTxWeight;
    if (advertisedWeight === undefined) blockers.push("Ark operator does not advertise a transaction weight limit");
    else if ((advertisedWeight < 4000n ? advertisedWeight : 4000n) < BigInt(pins.requiredMaxTxWeight)) blockers.push(`Effective experimental weight limit ${advertisedWeight < 4000n ? advertisedWeight : 4000n} is below required ${pins.requiredMaxTxWeight}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "unknown Ark getInfo error";
    checks.ark = { status: "unavailable", error: message };
    blockers.push(`Ark getInfo unavailable: ${message}`);
  }
  try {
    const registry = new RegisteredEmulatorProvider({ url: pins.emulatorUrl, signerPubkey: pins.emulatorSignerPubkey, operatorSignerPubkey: pins.operatorSignerPubkey,
      registryHash: pins.registryHash, programs: pins.registryPrograms, requiredProgramIds: Object.keys(pins.registryPrograms).sort() });
    const emulator = await registry.getInfo();
    checks.registeredEmulator = emulator;
    if (emulator.maxSidecarBytes < pins.requiredMaxSidecarBytes) blockers.push(`Registered emulator sidecar cap ${emulator.maxSidecarBytes} is below required ${pins.requiredMaxSidecarBytes}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "unknown registered emulator error";
    checks.registeredEmulator = { status: "unavailable", error: message };
    blockers.push(`Registered emulator capability unavailable: ${message}`);
  }
  blockers.push("The registered transport is not connected to the live Shielded runtime");
  blockers.push("A client-owned customer deposit and withdrawal path is not deployed");
  blockers.push("Public multi-user participant registration is not deployed");
  blockers.push("The checked-in Groth16 setup is development-only, not a reviewed production setup");
  blockers.push("Users do not have an independent note-holder exit if the operator disappears");
  checks.fundedMutinynet = false;
  checks.status = blockers.length ? "BLOCKED" : "TRANSPORT_BLOCKED";
  checks.blockers = blockers;
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  if (blockers.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Read-only Mutinynet readiness check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
