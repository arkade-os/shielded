import test, { after } from "node:test";
import assert from "node:assert/strict";
import { base64 } from "@scure/base";
import { ArkAddress, CSVMultisigTapscript, RestArkProvider, RestEmulatorProvider, RestIndexerProvider, SingleKey, Transaction, Wallet } from "@arkade-os/sdk";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { createSdkRuntime, executeVmBinary, DEFAULT_VM_BINARY } from "../src/sdk/runtime.ts";
import { MUTINYNET_EMULATOR_KEY, verifyRemoteResponse } from "../src/sdk/live.ts";
import { offlineNativeFixture, type VmBridgeRequest } from "../src/sdk/adapter.ts";
import type { NativeCheckpoint } from "../src/sdk/runtime.ts";

test("remote receipts bind the exact body, covenant leaves and every required signature", { timeout: 180_000 }, async () => {
  const protocol = await createProtocol();
  let captured!: VmBridgeRequest;
  const runtime = await createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state,
    execute: async (request) => { captured = request; return executeVmBinary(DEFAULT_VM_BINARY, request); } });
  try {
    const prepared = await protocol.prepareShield("alice", "BTC", 10_000);
    const receipt = await runtime.settle(prepared);
    const server = SingleKey.fromHex("01".repeat(32));
    const signed = await server.sign(Transaction.fromPSBT(base64.decode(receipt.signedArkTx)));
    const response = { signedArkTx: base64.encode(signed.toPSBT()), signedCheckpointTxs: await Promise.all(receipt.signedCheckpoints.map(async (cp) => base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(cp)))).toPSBT()))) };
    const serverKey = Buffer.from(await server.xOnlyPublicKey()).toString("hex");
    assert.equal(verifyRemoteResponse(captured, response, serverKey).id, receipt.txid);
    const unsigned = { ...response, signedArkTx: captured.arkTx };
    assert.throws(() => verifyRemoteResponse(captured, unsigned, serverKey), /missing tapScriptSig/);
    const substituted = Transaction.fromPSBT(base64.decode(response.signedArkTx));
    substituted.updateOutput(0, { amount: substituted.getOutput(0).amount! - 1n }, true);
    assert.throws(() => verifyRemoteResponse(captured, { ...response, signedArkTx: base64.encode(substituted.toPSBT()) }, serverKey), /changed.*body/);
    assert.throws(() => verifyRemoteResponse(captured, { ...response, signedCheckpointTxs: response.signedCheckpointTxs.slice(1) }, serverKey), /returned.*checkpoints/);
  } finally { await runtime.close(); }
});

test("Mutinynet cannot expose a funding wallet without durable credentials", async () => {
  await assert.rejects(createSdkRuntime({ verificationKeys: {}, initialState: {} as never, network: "mutinynet" }), /durable checkpoint storage/);
});

test("ambiguous bootstrap issuance survives restart without issuing a duplicate identity", { timeout: 180_000 }, async (t) => {
  const protocol = await createProtocol();
  const serverKey = await SingleKey.fromHex("01".repeat(32)).xOnlyPublicKey();
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverKey] }).script;
  const address = new ArkAddress(serverKey, serverKey, "tark").encode();
  const tx = offlineNativeFixture([{ script: ArkAddress.decode(address).pkScript, amount: 203_330n }]);
  let submissions = 0;
  let durable!: NativeCheckpoint;
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "mutinynet", signerPubkey: `02${Buffer.from(serverKey).toString("hex")}`,
    checkpointTapscript: Buffer.from(checkpointScript).toString("hex"), maxTxWeight: 200_000n }));
  t.mock.method(RestEmulatorProvider.prototype, "getInfo", async () => ({ signerPubkey: MUTINYNET_EMULATOR_KEY }));
  t.mock.method(RestIndexerProvider.prototype, "getVirtualTxs", async () => ({ txs: [] }));
  t.mock.method(RestArkProvider.prototype, "submitTx", async () => { submissions++; throw new Error("injected lost issuance response"); });
  t.mock.method(Wallet, "create", async (config: { arkProvider: RestArkProvider }) => ({
    getAddress: async () => address, getBoardingAddress: async () => "tb1q-test-boarding", dispose: async () => {},
    getBalance: async () => ({ available: 203_330, boarding: { confirmed: 0, unconfirmed: 0, total: 0 } }),
    assetManager: { issue: async () => { await config.arkProvider.submitTx(base64.encode(tx.toPSBT()), []); return { arkTxId: tx.id, assetId: `${tx.id}:0` }; } },
  }));
  const options = { verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state, network: "mutinynet" as const,
    onCheckpoint: async (checkpoint: NativeCheckpoint) => { durable = JSON.parse(JSON.stringify(checkpoint)); } };
  const first = await createSdkRuntime(options);
  await assert.rejects(first.bootstrap!(), /lost issuance response/);
  assert.equal(submissions, 1);
  assert.equal(durable.live!.pendingBootstrap!.step, "issue:lane");
  await first.close();
  const restored = await createSdkRuntime({ ...options, checkpoint: durable });
  try {
    await assert.rejects(restored.bootstrap!(), /outcome is unknown/);
    assert.equal(submissions, 1);
    assert.equal(restored.exportState().live!.pendingBootstrap!.txid, tx.id);
  } finally { await restored.close(); }
});

after(async () => {
  const pool = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
