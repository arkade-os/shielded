import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Extension, SingleKey, Transaction } from "@arkade-os/sdk";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { createSdkRuntime, DEFAULT_VM_BINARY, executeVmBinary } from "../src/sdk/runtime.ts";
import type { VmBridgeRequest } from "../src/sdk/adapter.ts";
import { computeRegistryHash, decodeRegistryInfo, RegisteredEmulatorProvider } from "../src/sdk/registry-provider.ts";
import { opaquePacket } from "../src/sdk/adapter.ts";

const programId = "11".repeat(32);

function info(signerPubkey: string, registryHash = "22".repeat(32), registeredPrograms = [programId]) {
  return { version: "shielded-registry/1", signerPubkey, registryProtocol: "shielded-registered-v1", registryHash, registeredPrograms, maxSidecarBytes: 131072 };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "shielded-registry-provider-"));
  const protocol = await createProtocol();
  const alice = await SingleKey.fromHex("61".repeat(32));
  const bob = await SingleKey.fromHex("62".repeat(32));
  const programsFile = join(directory, "registry.json");
  const binary = DEFAULT_VM_BINARY.replace("shielded-vm", "shielded-registry-vm");
  let captured: VmBridgeRequest | undefined;
  let emulatorResponse: { signedArkTx: string; signedCheckpointTxs: string[] } | undefined;
  const runtime = await createSdkRuntime({
    verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state,
    registry: { file: programsFile, recipientPublicKeys: { alice: hex.encode(await alice.xOnlyPublicKey()), bob: hex.encode(await bob.xOnlyPublicKey()) } },
    execute: async (request) => {
      captured = structuredClone(request);
      const result = await executeVmBinary(binary, request, programsFile);
      if (!result.ok || !result.arkTx || !result.checkpoints) throw new Error(result.error ?? "Local registered emulator fixture failed");
      emulatorResponse = { signedArkTx: result.arkTx, signedCheckpointTxs: result.checkpoints };
      return result;
    },
  });
  await runtime.settle(await protocol.prepareShield("alice", "BTC", 1000));
  assert.ok(captured?.sidecar);
  const registered = JSON.parse(await readFile(programsFile, "utf8")) as Record<string, string>;
  assert.ok(emulatorResponse);
  return { directory, request: captured!, registered, emulatorResponse: emulatorResponse!, runtime };
}

test("registry info rejects unsupported, unsorted, and oversized capabilities", () => {
  const key = `02${"51".repeat(32)}`;
  assert.throws(() => decodeRegistryInfo(info(key, "22".repeat(32), ["ff".repeat(32), programId])), /sorted/);
  assert.throws(() => decodeRegistryInfo({ ...info(key), version: 1 }), /Unsupported/);
  assert.throws(() => decodeRegistryInfo({ ...info(key), maxSidecarBytes: 131073 }), /sidecar limit/);
});

test("registry hash pins sorted program IDs and exact bytes", () => {
  const bytes = "5100";
  const id = hex.encode(sha256(hex.decode(bytes)));
  assert.equal(computeRegistryHash({ [id]: bytes }), "c4efd2456178f2ff68777d91f2147895f22ba9effd15b6ef8041d28cc53df800");
  assert.equal(computeRegistryHash({ [id]: bytes }), computeRegistryHash({ [id]: bytes }));
  assert.throws(() => computeRegistryHash({ [id]: "5200" }), /do not match/);
});

test("provider verifies signed Arkade response against the exact submitted body and checkpoints", { timeout: 180_000 }, async (t) => {
  const f = await fixture();
  t.after(async () => { await f.runtime.close(); await rm(f.directory, { recursive: true, force: true }); });
  const expectedKey = hex.encode(await (await SingleKey.fromHex("02".repeat(32)).compressedPublicKey()));
  const operatorKey = hex.encode(await (await SingleKey.fromHex("01".repeat(32))).xOnlyPublicKey());
  const registryHash = computeRegistryHash(f.registered);
  let calls: { method: string; path: string; body?: string }[] = [];
  let infoResponse = info(expectedKey, registryHash, Object.keys(f.registered).sort());
  let responsePayload = f.emulatorResponse;
  let dropPost = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({ method: req.method!, path: req.url!, body: Buffer.concat(chunks).toString("utf8") });
    if (req.url === "/v1/tx" && dropPost) { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/info") res.end(JSON.stringify(infoResponse));
    else res.end(JSON.stringify(responsePayload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new RegisteredEmulatorProvider({ url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, signerPubkey: expectedKey, operatorSignerPubkey: operatorKey, registryHash,
    programs: f.registered, requiredProgramIds: Object.keys(f.registered).sort(), fetch: globalThis.fetch });
  const result = await provider.submitTx(f.request);
  assert.equal(Transaction.fromPSBT(base64.decode(result.signedArkTx)).id, Transaction.fromPSBT(base64.decode(f.request.arkTx)).id);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [["GET", "/v1/info"], ["POST", "/v1/tx"]]);
  const posted = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
  assert.deepEqual(posted, { arkTx: f.request.arkTx, checkpointTxs: f.request.checkpoints, registrySidecar: f.request.sidecar });

  const postCount = () => calls.filter(({ method }) => method === "POST").length;
  const beforeWrongOperator = postCount();
  const wrongOperator = new RegisteredEmulatorProvider({ url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, signerPubkey: expectedKey, operatorSignerPubkey: "33".repeat(32), registryHash,
    programs: f.registered, requiredProgramIds: Object.keys(f.registered).sort() });
  await assert.rejects(wrongOperator.submitTx(f.request), /does not match pinned signer keys/);
  assert.equal(postCount(), beforeWrongOperator, "wrong Ark operator key blocks submission locally");

  const originalResponse = responsePayload;
  responsePayload = { ...originalResponse, signedArkTx: f.request.arkTx };
  await assert.rejects(provider.submitTx(f.request), /missing tapScriptSig/);
  const alteredBody = Transaction.fromPSBT(base64.decode(originalResponse.signedArkTx));
  alteredBody.updateOutput(0, { amount: alteredBody.getOutput(0).amount! + 1n }, true);
  responsePayload = { ...originalResponse, signedArkTx: base64.encode(alteredBody.toPSBT()) };
  await assert.rejects(provider.submitTx(f.request), /changed the submitted transaction body/);
  responsePayload = { ...originalResponse, signedCheckpointTxs: originalResponse.signedCheckpointTxs.slice(1) };
  await assert.rejects(provider.submitTx(f.request), /checkpoint/i);
  responsePayload = originalResponse;

  const postsBeforeLocalRejects = postCount();
  const unsigned = Transaction.fromPSBT(base64.decode(f.request.arkTx));
  const damagedSidecar = base64.decode(f.request.sidecar!);
  let offset = 2;
  for (let packet = 0; packet < 4; packet++) { const size = damagedSidecar[offset]! | (damagedSidecar[offset + 1]! << 8); offset += 2 + size; }
  const stateSize = damagedSidecar[offset]! | (damagedSidecar[offset + 1]! << 8);
  offset += 2 + stateSize;
  const entryCount = damagedSidecar[offset++]!;
  let lastVin = -1;
  for (let entry = 0; entry < entryCount; entry++) {
    lastVin = offset;
    offset += 2 + 32;
    const witnesses = damagedSidecar[offset]! | (damagedSidecar[offset + 1]! << 8);
    offset += 2;
    for (let witness = 0; witness < witnesses; witness++) { const size = damagedSidecar[offset]! | (damagedSidecar[offset + 1]! << 8); offset += 2 + size; }
  }
  damagedSidecar[lastVin] = 0xfa;
  damagedSidecar[lastVin + 1] = 0;
  const extension = Extension.fromTx(unsigned);
  const extIndex = Array.from({ length: unsigned.outputsLength }, (_, index) => index).find((index) => Extension.isExtension(unsigned.getOutput(index).script!));
  assert.notEqual(extIndex, undefined);
  const replacement = Extension.create(extension.getPackets().map((packet) => packet.type() === 0x84
    ? opaquePacket({ type: 0x84, data: sha256(damagedSidecar) }) : packet));
  unsigned.updateOutput(extIndex!, replacement.txOut(), true);
  await assert.rejects(provider.submitTx({ ...f.request, arkTx: base64.encode(unsigned.toPSBT()), sidecar: base64.encode(damagedSidecar) }), /not bound to its registered native input/);
  assert.equal(postCount(), postsBeforeLocalRejects, "a mismatched input program is rejected before POST");

  let before = calls.length;
  infoResponse = info(`03${"31".repeat(32)}`, registryHash, Object.keys(f.registered).sort());
  await assert.rejects(new RegisteredEmulatorProvider({ url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, signerPubkey: expectedKey, operatorSignerPubkey: operatorKey, registryHash,
    programs: f.registered, requiredProgramIds: Object.keys(f.registered).sort() }).getInfo(), /do not match pinned deployment/);
  assert.equal(calls.length, before + 1, "wrong signer stops after capability fetch");
  infoResponse = info(expectedKey, registryHash, []);
  await assert.rejects(new RegisteredEmulatorProvider({ url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, signerPubkey: expectedKey, registryHash,
    operatorSignerPubkey: operatorKey, programs: f.registered, requiredProgramIds: Object.keys(f.registered).sort() }).getInfo(), /do not match pinned deployment/);
  infoResponse = info(expectedKey, registryHash, Object.keys(f.registered).sort());
  const noSidecar = { ...f.request, sidecar: undefined };
  const withoutSidecar = new RegisteredEmulatorProvider({ url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, signerPubkey: expectedKey, operatorSignerPubkey: operatorKey, registryHash,
    programs: f.registered, requiredProgramIds: Object.keys(f.registered).sort() });
  await assert.rejects(withoutSidecar.submitTx(noSidecar), /lacks its proof sidecar/);
  const tampered = base64.decode(f.request.sidecar!);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(withoutSidecar.submitTx({ ...f.request, sidecar: base64.encode(tampered) }), /does not commit to this exact/);
  assert.equal(postCount(), postsBeforeLocalRejects, "invalid pins and sidecars never reach POST");

  const checkpoint = Transaction.fromPSBT(base64.decode(originalResponse.signedCheckpointTxs[0]!));
  checkpoint.updateOutput(0, { amount: checkpoint.getOutput(0).amount! + 1n }, true);
  responsePayload = { ...originalResponse, signedCheckpointTxs: [base64.encode(checkpoint.toPSBT()), ...originalResponse.signedCheckpointTxs.slice(1)] };
  await assert.rejects(provider.submitTx(f.request));
  responsePayload = originalResponse;

  dropPost = true;
  await assert.rejects(withoutSidecar.submitTx(f.request));
  assert.equal(postCount(), postsBeforeLocalRejects + 2, "a dropped outcome is attempted only once");
});

test("provider refuses credentials, query strings, and non-loopback cleartext", () => {
  const base = { signerPubkey: `02${"11".repeat(32)}`, operatorSignerPubkey: "11".repeat(32), registryHash: "22".repeat(32), programs: {}, requiredProgramIds: [programId] };
  for (const url of ["http://registry.example", "https://user:pass@registry.example", "https://registry.example/?token=x"]) {
    assert.throws(() => new RegisteredEmulatorProvider({ ...base, url, allowLoopbackHttp: true }));
  }
});
