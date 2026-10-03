import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { asset, CSVMultisigTapscript, SingleKey, VtxoScript } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { createProtocol, type PreparedSettlement } from "../packages/protocol/src/index.ts";
import { registerCompactProfile, normalizeCompactSource, type CompactProfileConfig } from "../src/compact/profile.ts";
import { verifyCompactProof, type CompactNativeState, type CompactSidecar } from "../src/compact/verifier.ts";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function destinationField(script: Uint8Array): string {
  const digest = createHash("sha256").update(script.subarray(2)).digest();
  return (BigInt(`0x${Buffer.from(digest).reverse().toString("hex")}`) % FIELD).toString();
}

test("registered compact verifier checks real Groth16 proofs and fails closed on tampering", { timeout: 180_000 }, async () => {
  const protocol = await createProtocol();
  const prepared = await protocol.prepareShield("alice", "BTC", 400) as PreparedSettlement;
  const server = SingleKey.fromHex("05".repeat(32));
  const emulator = SingleKey.fromHex("06".repeat(32));
  const recipient = SingleKey.fromHex("07".repeat(32));
  const serverKey = await server.xOnlyPublicKey();
  const emulatorKey = await emulator.xOnlyPublicKey();
  const recipientKey = await recipient.xOnlyPublicKey();
  const timelock = { type: "blocks" as const, value: 144n };
  const checkpointScript = CSVMultisigTapscript.encode({ timelock, pubkeys: [serverKey] }).script;
  const destination = new VtxoScript([CSVMultisigTapscript.encode({ timelock, pubkeys: [recipientKey] }).script]).pkScript;
  const verificationKeys = protocol.verificationKeys() as CompactProfileConfig["verificationKeys"];
  const config: CompactProfileConfig = {
    relationVersion: "ark-shield-poc-v1",
    domain: prepared.intentSignals[0],
    verificationKeys,
    serverKey: hex.encode(serverKey),
    emulatorKey: hex.encode(emulatorKey),
    checkpointScript: hex.encode(checkpointScript),
    exitTimelock: { type: "blocks", value: "144" },
    identities: {
      lane: asset.AssetId.create("11".repeat(32), 0).toString(),
      btcVault: asset.AssetId.create("11".repeat(32), 1).toString(),
      tokenVault: asset.AssetId.create("11".repeat(32), 2).toString(),
      token: asset.AssetId.create("11".repeat(32), 3).toString(),
    },
    destinations: { alice: { scriptPubKey: hex.encode(destination), field: destinationField(destination) } },
  };
  const profile = await registerCompactProfile(config);
  await assert.rejects(registerCompactProfile({ ...config, identities: { ...config.identities, token: config.identities.lane } }), /must be distinct/);
  await assert.rejects(registerCompactProfile({ ...config, identities: { ...config.identities, lane: "lane-id" } }), /Invalid compact asset identity lane/);
  await assert.rejects(registerCompactProfile({ ...config, serverKey: config.serverKey.toUpperCase() }), /Invalid compact signer/);
  await assert.rejects(registerCompactProfile({ ...config, emulatorKey: config.serverKey }), /Invalid compact signer/);
  const sidecar: CompactSidecar = {
    operation: prepared.operation,
    intentProof: prepared.intentProof,
    transitionProof: prepared.transitionProof,
    intentSignals: prepared.intentSignals,
    transitionSignals: prepared.transitionSignals,
    oldState: prepared.oldState,
    newState: prepared.newState,
    ciphertextRecords: prepared.ciphertextRecords,
    boundary: prepared.boundary,
  };
  const trusted: CompactNativeState = { profileId: profile.profileId, protocol: prepared.oldState, funding: { BTC: 10_000_000, DEMO: 10_000_000 }, heads: {} };
  await verifyCompactProof(profile.profileId, sidecar, trusted);

  const badProof = structuredClone(sidecar);
  badProof.intentProof!.pi_a[0] = ((BigInt(badProof.intentProof!.pi_a[0]) + 1n) % FIELD).toString();
  await assert.rejects(verifyCompactProof(profile.profileId, badProof, trusted), /Groth16 proof verification failed/);

  const badBoundary = structuredClone(sidecar);
  badBoundary.boundary.deposit.BTC++;
  await assert.rejects(verifyCompactProof(profile.profileId, badBoundary, trusted), /public signals|boundary metadata/);

  await assert.rejects(verifyCompactProof("00".repeat(32), sidecar, trusted), /not registered/);
});

test("implementation source fingerprint normalizes Windows CRLF", () => {
  const unix = Buffer.from("export const value = 1;\n", "utf8");
  const windows = Buffer.from("export const value = 1;\r\n", "utf8");
  assert.deepEqual(normalizeCompactSource(unix), normalizeCompactSource(windows));
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});
