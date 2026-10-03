import assert from "node:assert/strict";
import test from "node:test";
import { base64, hex } from "@scure/base";
import {
  ArkAddress, asset, CSVMultisigTapscript, Ramps, RestArkProvider, RestIndexerProvider, SingleKey, Transaction, Wallet,
} from "@arkade-os/sdk";
import { buildCompactSpend, createCompactClosure } from "../src/compact/adapter.ts";
import { createCompactDestination, createCompactProfile } from "../src/compact/runtime.ts";
import { createCompactLiveRuntime } from "../src/compact/live.ts";
import { signCompactEmulator, verifyCompactResponse } from "../src/compact/signer.ts";
import type { NativeCheckpoint, NativeVmResult } from "../src/sdk/runtime.ts";
import type { ProtocolState } from "../packages/protocol/src/types.ts";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { offlineNativeFixture, transferAssetPacket } from "../src/sdk/adapter.ts";

const state: ProtocolState = { noteRoot: "0", spentRoot: "0", historyRoot: "0", noteCount: 0, historyCount: 0, revision: 0,
  reserves: { BTC: 0, DEMO: 0 } };
const server = SingleKey.fromHex("01".repeat(32));

test("compact live adapter refuses a non-Mutinynet Ark provider before creating a wallet", async (t) => {
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "mainnet" } as never));
  let checkpoints = 0;
  await assert.rejects(createCompactLiveRuntime({ verificationKeys: {}, initialState: state, network: "mutinynet",
    onCheckpoint: async () => { checkpoints++; } }), /only supports Mutinynet/);
  assert.equal(checkpoints, 0, "provider identity is checked before any wallet checkpoint is written");
});

test("compact live restore requires the encrypted dedicated signer key", async () => {
  const checkpoint = emptyCheckpoint({ seedHex: "01".repeat(32), arkUrl: "https://mutinynet.arkade.sh",
    emulatorUrl: "inprocess://compact-verifier", phase: "funding-required", issued: {} });
  await assert.rejects(createCompactLiveRuntime({ verificationKeys: {}, initialState: state, network: "mutinynet",
    checkpoint, onCheckpoint: async () => {} }), /Encrypted compact Mutinynet wallet and verifier signing keys/);
});

test("altered Arkade bootstrap response is rejected before it is journaled as signed", { timeout: 30_000 }, async (t) => {
  const fixture = await mockCompactLive(t, async () => {
    const altered = offlineNativeFixture([{ amount: 7_000n, script: Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(9)) }]);
    return { finalArkTx: base64.encode(altered.toPSBT()), signedCheckpointTxs: [] } as never;
  });
  const runtime = await fixture.create();
  try {
    await assert.rejects(runtime.bootstrap!(), /changed the submitted transaction body/);
    assert.equal(fixture.durable.live!.pendingBootstrap!.response, undefined);
  } finally { await runtime.close(); }
});

test("lost issuance response survives restart without resubmitting the unknown transaction", { timeout: 30_000 }, async (t) => {
  let submitCount = 0;
  const fixture = await mockCompactLive(t, async () => {
    submitCount++;
    throw new Error("injected lost Arkade response");
  });
  const first = await fixture.create();
  await assert.rejects(first.bootstrap!(), /injected lost Arkade response/);
  assert.equal(submitCount, 1);
  assert.equal(fixture.durable.live!.pendingBootstrap!.step, "issue:lane");
  await first.close();

  const restored = await fixture.create(fixture.durable);
  try {
    await assert.rejects(restored.bootstrap!(), /outcome is unknown; no transaction will be resubmitted/);
    assert.equal(submitCount, 1);
    assert.equal(restored.exportState().live!.pendingBootstrap!.txid, fixture.durable.live!.pendingBootstrap!.txid);
  } finally { await restored.close(); }
});

test("restart after gate funding keeps the accepted head and blocks an unknown second resource without resending", { timeout: 90_000 }, async (t) => {
  const protocol = await createProtocol();
  const serverKey = await server.xOnlyPublicKey();
  const emulator = SingleKey.fromHex("04".repeat(32));
  const emulatorKey = await emulator.xOnlyPublicKey();
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }).script;
  const identities = Object.fromEntries(["lane", "btcVault", "tokenVault", "token"].map((name, index) => {
    const issuance = offlineNativeFixture([{ script: Uint8Array.of(0x51), amount: 1_000n + BigInt(index) }]);
    return [name, asset.AssetId.create(issuance.id, 0).toString()];
  })) as Record<"lane" | "btcVault" | "tokenVault" | "token", string>;
  const aliceSecret = "02".repeat(32);
  const bobSecret = "03".repeat(32);
  const [alice, bob] = await Promise.all([aliceSecret, bobSecret].map(async (secret) => createCompactDestination(
    serverKey, await SingleKey.fromHex(secret).xOnlyPublicKey(), { type: "seconds", value: 2048n })));
  const registered = await createCompactProfile({ relationVersion: "ark-shield-poc-v1", domain: "20260930001",
    verificationKeys: protocol.verificationKeys() as never, serverKey: hex.encode(serverKey), emulatorKey: hex.encode(emulatorKey),
    checkpointScript: hex.encode(checkpointScript), exitTimelock: { type: "seconds", value: "2048" }, identities,
    destinations: { alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field },
      bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field } } });
  const gate = offlineNativeFixture([{ script: registered.closure.pkScript, amount: 200_000n }], [transferAssetPacket([
    { assetId: identities.token, inputs: [{ vin: 0, amount: 10_000_000n }], outputs: [{ vout: 0, amount: 10_000_000n }] },
  ])]);
  const gateRaw = hex.encode(gate.toBytes());
  const checkpoint = emptyCheckpoint({ seedHex: "05".repeat(32), compactEmulatorSecret: "04".repeat(32),
    arkUrl: "https://mutinynet.arkade.sh", emulatorUrl: "inprocess://compact-verifier", phase: "funding-programs",
    issued: identities, issuanceTransactions: {} });
  checkpoint.serverKey = hex.encode(serverKey);
  checkpoint.emulatorKey = hex.encode(emulatorKey);
  checkpoint.checkpointScript = hex.encode(checkpointScript);
  checkpoint.identities = identities;
  checkpoint.genesisRaw = gateRaw;
  checkpoint.funding = { BTC: "200000", DEMO: "10000000" };
  checkpoint.heads.gate = { txid: gate.id, vout: 0, value: 200_000, sourceTx: gateRaw };
  checkpoint.compact = { version: 1, profileId: registered.profile.profileId, sidecars: {} };
  let durable = structuredClone(checkpoint);
  let sendCount = 0;
  const info = { network: "mutinynet", signerPubkey: `02${hex.encode(serverKey)}`, checkpointTapscript: hex.encode(checkpointScript),
    unilateralExitDelay: 2048n, maxTxWeight: 4_000n };
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => info as never);
  t.mock.method(RestArkProvider.prototype, "submitTx", async () => { throw new Error("injected lost Arkade response"); });
  t.mock.method(RestIndexerProvider.prototype, "getVirtualTxs", async (txids: string[]) => ({
    txs: txids.includes(gate.id) ? [gateRaw] : [],
  } as never));
  t.mock.method(RestIndexerProvider.prototype, "getVtxos", async ({ outpoints }: { outpoints: { txid: string; vout: number }[] }) => ({
    vtxos: outpoints.filter(({ txid, vout }) => txid === gate.id && vout === 0).map(() => ({ txid: gate.id, vout: 0,
      value: 200_000, script: hex.encode(registered.closure.pkScript), isSpent: false, isSwept: false, isUnrolled: false })),
  } as never));
  t.mock.method(Wallet, "create", async ({ arkProvider }: { arkProvider: RestArkProvider }) => ({
    getAddress: async () => "tark-mock", getBoardingAddress: async () => "tb1q-mock",
    getBalance: async () => ({ available: 10_000, boarding: { confirmed: 0, unconfirmed: 0, total: 0 } }),
    dispose: async () => {}, assetManager: { issue: async () => { throw new Error("saved identities must not be reissued"); } },
    send: async () => {
      sendCount++;
      const source = offlineNativeFixture([{ script: registered.closure.pkScript, amount: 1_000n }]);
      const spend = await buildCompactSpend({ profileId: hex.decode(registered.profile.profileId), oldStateHash: new Uint8Array(32).fill(7),
        newStateHash: new Uint8Array(32).fill(8), sidecarTranscript: Uint8Array.of(1),
        inputs: [{ coin: { txid: source.id, vout: 0, value: 1_000, sourceTx: source.toBytes(false, false) },
          tapTree: registered.closure.tapTree, tapLeafScript: registered.closure.tapLeafScript }],
        outputs: [{ script: registered.closure.pkScript, amount: 1_000n }],
        checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }),
        exitTimelock: { type: "seconds", value: 2048n }, serverPubkey: serverKey, emulatorPubkey: emulatorKey });
      await arkProvider.submitTx(base64.encode(spend.arkTx.toPSBT()), spend.checkpoints.map((tx) => base64.encode(tx.toPSBT())));
      return spend.arkTx.id;
    },
  } as never));
  const create = (value: NativeCheckpoint) => createCompactLiveRuntime({ verificationKeys: protocol.verificationKeys(),
    initialState: state, network: "mutinynet", checkpoint: value,
    onCheckpoint: async (next) => { durable = structuredClone(next); } });
  const first = await create(checkpoint);
  await assert.rejects(first.bootstrap!(), /injected lost Arkade response/);
  assert.equal(sendCount, 1);
  assert.equal(durable.heads.gate?.txid, gate.id);
  assert.equal(durable.live?.pendingBootstrap?.step, "fund:lane");
  await first.close();
  const restored = await create(durable);
  try {
    await assert.rejects(restored.bootstrap!(), /outcome is unknown; no transaction will be resubmitted/);
    assert.equal(sendCount, 1);
    assert.equal(restored.exportState().heads.gate?.txid, gate.id);
  } finally { await restored.close(); }
});

test("compact boarding uses only confirmed onchain inputs and accepts only its indexed output and commitment", async (t) => {
  const serverKey = await server.xOnlyPublicKey();
  const address = new ArkAddress(serverKey, serverKey, "tark").encode();
  const addressScript = hex.encode(ArkAddress.decode(address).pkScript);
  const input = { txid: "31".repeat(32), vout: 1, value: 600_000, status: { confirmed: true } };
  const laterInput = { txid: "33".repeat(32), vout: 0, value: 700_000, status: { confirmed: true } };
  const unconfirmed = { txid: "32".repeat(32), vout: 0, value: 1_000_000, status: { confirmed: false } };
  let commitment = new Transaction({ version: 2 });
  let activeInput = input;
  commitment.addInput({ txid: input.txid, index: input.vout, sequence: 0xfffffffd });
  let expectedAmount = 0;
  let boardingCoins = [input, unconfirmed];
  let durable!: NativeCheckpoint;
  let settleCalls = 0;
  let indexedCommitment = "43".repeat(32);
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }).script;
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "mutinynet", signerPubkey: `02${hex.encode(serverKey)}`,
    checkpointTapscript: hex.encode(checkpointScript), unilateralExitDelay: 2048n, maxTxWeight: 4_000n,
    fees: { intentFee: {}, txFeeRate: "1" } } as never));
  t.mock.method(RestIndexerProvider.prototype, "getVtxos", async () => ({ vtxos: [{ txid: "42".repeat(32), vout: 0,
    value: expectedAmount, script: addressScript, commitmentTxIds: [indexedCommitment], isSpent: false, isSwept: false,
    isUnrolled: false, assets: [] }] } as never));
  t.mock.method(Wallet, "create", async () => ({
    getAddress: async () => address, getBoardingAddress: async () => address,
    getBalance: async () => ({ available: expectedAmount, boarding: { confirmed: expectedAmount ? 0 : input.value,
      unconfirmed: 0, total: expectedAmount ? 0 : input.value } }),
    getBoardingUtxos: async () => boardingCoins, getVtxos: async () => [],
    onchainProvider: { getTxOutspends: async (txid: string) => {
      if (txid !== activeInput.txid) return [];
      return Array.from({ length: activeInput.vout + 1 }, (_, index) => ({ spent: index === activeInput.vout,
        txid: index === activeInput.vout ? commitment.id : "" }));
    } },
    settle: async (params: { inputs: typeof input[]; outputs: { address: string; amount: bigint }[] }, callback: (event: unknown) => void) => {
      settleCalls++;
      activeInput = params.inputs[0];
      assert.equal(params.inputs.length, 1);
      commitment = new Transaction({ version: 2 });
      commitment.addInput({ txid: activeInput.txid, index: activeInput.vout, sequence: 0xfffffffd });
      expectedAmount = Number(params.outputs.find((output) => output.address === address)!.amount);
      if (settleCalls > 1) indexedCommitment = commitment.id;
      await callback({ type: "batch_finalization", id: "round-1", commitmentTx: base64.encode(commitment.toPSBT()) });
      await callback({ type: "batch_finalized", id: "round-1", commitmentTxid: commitment.id });
      return commitment.id;
    },
    dispose: async () => {}, assetManager: { issue: async () => { throw new Error("unexpected issuance"); } },
  } as never));
  const create = (checkpoint?: NativeCheckpoint) => createCompactLiveRuntime({ verificationKeys: {}, initialState: state,
    network: "mutinynet", checkpoint, onCheckpoint: async (value) => { durable = structuredClone(value); } });
  const runtime = await create();
  try {
    assert.equal(runtime.snapshot().onboardAvailable, true);
    const pending = await runtime.onboardFunding!("board-original");
    assert.equal(pending.status, "pending", "an unrelated round cannot satisfy boarding even with the same value and script");
    assert.equal(settleCalls, 1);
    const snapshot = runtime.snapshot() as { funding: { onboarding: Record<string, unknown> } };
    assert.equal("commitmentTx" in snapshot.funding.onboarding, false);
    assert.equal("walletOutpoints" in snapshot.funding.onboarding, false);
  } finally { await runtime.close(); }

  durable.live!.pendingBoarding!.commitmentTxid = "ff".repeat(32);
  const mismatched = await create(durable);
  try {
    assert.equal((await mismatched.onboardFunding!("board-original")).status, "pending", "a stored ID that differs from the persisted PSBT cannot be accepted");
    assert.match(durable.live!.pendingBoarding!.error ?? "", /commitment transaction ID changed/);
  } finally { await mismatched.close(); }

  indexedCommitment = commitment.id;
  durable.live!.pendingBoarding!.commitmentTxid = undefined;
  durable.live!.pendingBoarding!.events = durable.live!.pendingBoarding!.events.filter((event) => event.type !== "batch_finalized");
  const restored = await create(durable);
  let firstCommitmentTxid = "";
  let firstAmountSats = 0;
  try {
    const result = await restored.onboardFunding!("board-alias");
    assert.equal(settleCalls, 1, "recovery reads the persisted commitment instead of submitting the selected inputs again");
    assert.equal(result.status, "accepted", JSON.stringify({ result, pending: durable.live!.pendingBoarding }));
    assert.equal(result.commitmentTxid, commitment.id);
    assert.deepEqual(result.selectedOutpoints, [{ txid: input.txid, vout: input.vout }]);
    assert.deepEqual(result.outputOutpoints, [{ txid: "42".repeat(32), vout: 0 }]);
    assert.equal(durable.live!.pendingBoarding!.status, "accepted");
    firstCommitmentTxid = commitment.id;
    firstAmountSats = expectedAmount;
  } finally { await restored.close(); }

  boardingCoins = [laterInput];
  const legacy = structuredClone(durable);
  delete legacy.live!.pendingBoarding!.requestId;
  delete legacy.live!.pendingBoarding!.requestIds;
  const legacyRuntime = await create(legacy);
  try {
    await assert.rejects(legacyRuntime.onboardFunding!("board-new"), /legacy accepted boarding attempt has no API idempotency identity/);
    assert.equal(settleCalls, 1, "legacy accepted state fails closed instead of claiming a new request");
  } finally { await legacyRuntime.close(); }

  const replayed = await create(durable);
  try {
    const sameRequest = await replayed.onboardFunding!("board-alias");
    assert.deepEqual(sameRequest, { status: "accepted", commitmentTxid: firstCommitmentTxid,
      selectedOutpoints: [{ txid: input.txid, vout: input.vout }], outputOutpoints: [{ txid: "42".repeat(32), vout: 0 }], amountSats: firstAmountSats },
    "an accepted native receipt survives restart before the engine can mark its alias request done, even after new coins arrive");
    assert.equal(settleCalls, 1, "restarting an accepted-but-not-engine-completed request does not board again");
    const second = await replayed.onboardFunding!("board-second");
    assert.equal(second.status, "accepted", "a new id can board a later confirmed deposit");
    assert.equal(settleCalls, 2);
    assert.equal(durable.live!.boardingReceipts?.[0]?.requestId, "board-original");
    assert.deepEqual(durable.live!.boardingReceipts?.[0]?.requestIds, ["board-alias"]);
    const legacyArchived = structuredClone(durable);
    delete legacyArchived.live!.boardingReceipts![0].requestId;
    delete legacyArchived.live!.boardingReceipts![0].requestIds;
    const legacyArchiveRuntime = await create(legacyArchived);
    try {
      await assert.rejects(legacyArchiveRuntime.onboardFunding!("board-third"), /legacy accepted boarding receipt has no API idempotency identity/);
      assert.equal(settleCalls, 2, "an unidentified archived receipt blocks new rounds");
    } finally { await legacyArchiveRuntime.close(); }
    const originalRetry = await replayed.onboardFunding!("board-original");
    assert.deepEqual(originalRetry, sameRequest, "an archived receipt replays the original response before selecting newer coins");
    const aliasRetry = await replayed.onboardFunding!("board-alias");
    assert.deepEqual(aliasRetry, sameRequest, "the reconciler's idempotency key is archived with the original key");
    assert.equal(settleCalls, 2, "retrying the original request never boards the later deposit");
  } finally { await replayed.close(); }
});

test("ambiguous compact boarding is reconciled after restart without resubmitting", async (t) => {
  const serverKey = await server.xOnlyPublicKey();
  const address = new ArkAddress(serverKey, serverKey, "tark").encode();
  const input = { txid: "51".repeat(32), vout: 0, value: 500_000, status: { confirmed: true } };
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }).script;
  let durable!: NativeCheckpoint;
  let settleCalls = 0;
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "mutinynet", signerPubkey: `02${hex.encode(serverKey)}`,
    checkpointTapscript: hex.encode(checkpointScript), unilateralExitDelay: 2048n, maxTxWeight: 4_000n,
    fees: { intentFee: {}, txFeeRate: "1" } } as never));
  t.mock.method(Wallet, "create", async () => ({
    getAddress: async () => address, getBoardingAddress: async () => address,
    getBalance: async () => ({ available: 0, boarding: { confirmed: input.value, unconfirmed: 0, total: input.value } }),
    getBoardingUtxos: async () => [input], getVtxos: async () => [],
    onchainProvider: { getTxOutspends: async () => [{ spent: false, txid: "" }] },
    settle: async (_params: unknown, callback: (event: unknown) => void) => {
      settleCalls++;
      await callback({ type: "batch_started", id: "round-lost" });
      throw new Error("lost round response");
    },
    dispose: async () => {}, assetManager: { issue: async () => { throw new Error("unexpected issuance"); } },
  } as never));
  const create = (checkpoint?: NativeCheckpoint) => createCompactLiveRuntime({ verificationKeys: {}, initialState: state, network: "mutinynet",
    checkpoint, onCheckpoint: async (value) => { durable = structuredClone(value); } });
  const first = await create();
  try {
    const result = await first.onboardFunding!("board-unknown");
    assert.equal(result.status, "pending");
    assert.equal(settleCalls, 1);
    assert.deepEqual(durable.live!.pendingBoarding!.selectedOutpoints, [{ txid: input.txid, vout: input.vout }]);
  } finally { await first.close(); }
  const legacy = structuredClone(durable);
  delete legacy.live!.pendingBoarding!.requestId;
  delete legacy.live!.pendingBoarding!.requestIds;
  const legacyRuntime = await create(legacy);
  try {
    await assert.rejects(legacyRuntime.onboardFunding!("board-new"), /legacy unresolved boarding attempt has no API idempotency identity/);
    assert.equal(settleCalls, 1, "an old unidentified journal cannot be adopted or resubmitted under a fresh key");
  } finally { await legacyRuntime.close(); }
  const restored = await create(durable);
  try {
    assert.equal(restored.snapshot().onboardAvailable, true, "pending board action remains available for read-only reconciliation");
    const result = await restored.onboardFunding!("board-reconcile");
    assert.equal(result.status, "pending");
    assert.equal(settleCalls, 1, "restart never submits another round with the captured inputs");
  } finally { await restored.close(); }
});

test("compact checkpoint finalization accepts emulator plus Arkade signatures and rejects a stripped emulator signature", async () => {
  const serverKey = await server.xOnlyPublicKey();
  const emulator = SingleKey.fromHex("06".repeat(32));
  const emulatorKey = await emulator.xOnlyPublicKey();
  const wallet = SingleKey.fromHex("07".repeat(32));
  assert.notEqual(hex.encode(await wallet.xOnlyPublicKey()), hex.encode(emulatorKey));
  const closure = createCompactClosure(new Uint8Array(32).fill(8), serverKey, emulatorKey, { type: "seconds", value: 2048n });
  const source = offlineNativeFixture([{ script: closure.pkScript, amount: 10_000n }]);
  const spend = await buildCompactSpend({ profileId: new Uint8Array(32).fill(8), oldStateHash: new Uint8Array(32).fill(9),
    newStateHash: new Uint8Array(32).fill(10), sidecarTranscript: Uint8Array.of(1),
    inputs: [{ coin: { txid: source.id, vout: 0, value: 10_000, sourceTx: source.toBytes(false, false) },
      tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript }],
    outputs: [{ script: closure.pkScript, amount: 10_000n }],
    checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey, emulatorKey] }),
    exitTimelock: closure.exitTimelock, serverPubkey: serverKey, emulatorPubkey: emulatorKey });
  const unsignedRequest = { arkTx: base64.encode(spend.arkTx.toPSBT()), checkpoints: spend.checkpoints.map((tx) => base64.encode(tx.toPSBT())) };
  const signedRequest = await signCompactEmulator(unsignedRequest, emulator);
  const signedArk = await server.sign(Transaction.fromPSBT(base64.decode(signedRequest.arkTx)));
  const signedCheckpoints = await Promise.all(unsignedRequest.checkpoints.map(async (entry) => {
    const checkpoint = await server.sign(Transaction.fromPSBT(base64.decode(entry)), [0]);
    return base64.encode(checkpoint.toPSBT());
  }));
  const result: NativeVmResult = { ok: true, arkTx: base64.encode(signedArk.toPSBT()), checkpoints: signedCheckpoints,
    txid: signedArk.id, executedInputs: signedArk.inputsLength, signatureCount: 4, durationMs: 0, backend: "test" };
  assert.equal(verifyCompactResponse(signedRequest, result, hex.encode(serverKey), hex.encode(emulatorKey)).checkpoints.length, 1);
  assert.throws(() => verifyCompactResponse(unsignedRequest, result, hex.encode(serverKey), hex.encode(emulatorKey)), /signature|signer/i);
});

async function mockCompactLive(
  t: test.TestContext,
  submit: (request: string) => Promise<never> | Promise<{ finalArkTx: string; signedCheckpointTxs: string[] }>,
) {
  const serverKey = await server.xOnlyPublicKey();
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }).script;
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({
    network: "mutinynet", signerPubkey: `02${hex.encode(serverKey)}`, checkpointTapscript: hex.encode(checkpointScript),
    unilateralExitDelay: 2048n, maxTxWeight: 4_000n,
  } as never));
  t.mock.method(RestArkProvider.prototype, "submitTx", async (request: string) => submit(request) as never);
  t.mock.method(RestIndexerProvider.prototype, "getVirtualTxs", async () => ({ txs: [] } as never));
  t.mock.method(RestIndexerProvider.prototype, "getVtxos", async () => ({ vtxos: [] } as never));
  let durable!: NativeCheckpoint;
  let request: { arkTx: string; checkpoints: string[] } | undefined;
  t.mock.method(Wallet, "create", async (config: { arkProvider: RestArkProvider }) => ({
    getAddress: async () => "tark-mock-address", getBoardingAddress: async () => "tb1q-mock-address",
    getBalance: async () => ({ available: 203_330, boarding: { confirmed: 0, unconfirmed: 0, total: 0 } }),
    dispose: async () => {}, send: async () => "never-sent",
    assetManager: { issue: async () => {
      const signer = SingleKey.fromHex(durable.live!.compactEmulatorSecret!);
      const emulatorKey = await signer.xOnlyPublicKey();
      const closure = createCompactClosure(new Uint8Array(32).fill(4), serverKey, emulatorKey, { type: "seconds", value: 2048n });
      const source = offlineNativeFixture([{ script: closure.pkScript, amount: 10_000n }]);
      const spend = await buildCompactSpend({ profileId: new Uint8Array(32).fill(4), oldStateHash: new Uint8Array(32).fill(5),
        newStateHash: new Uint8Array(32).fill(6), sidecarTranscript: Uint8Array.of(1),
        inputs: [{ coin: { txid: source.id, vout: 0, value: 10_000, sourceTx: source.toBytes(false, false) },
          tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript }],
        outputs: [{ script: closure.pkScript, amount: 10_000n }], checkpoint: CSVMultisigTapscript.encode({
          timelock: { type: "seconds", value: 2048n }, pubkeys: [serverKey] }), exitTimelock: closure.exitTimelock,
        serverPubkey: serverKey, emulatorPubkey: emulatorKey });
      request = { arkTx: base64.encode(spend.arkTx.toPSBT()), checkpoints: spend.checkpoints.map((tx) => base64.encode(tx.toPSBT())) };
      await config.arkProvider.submitTx(request.arkTx, request.checkpoints);
      return { arkTxId: spend.arkTx.id, assetId: "unused" };
    } },
  } as never));
  return {
    get durable() { return durable; },
    create: async (checkpoint?: NativeCheckpoint) => createCompactLiveRuntime({ verificationKeys: {}, initialState: state,
      network: "mutinynet", checkpoint, onCheckpoint: async (value) => { durable = JSON.parse(JSON.stringify(value)); } }),
    get request() { return request; },
  };
}

function emptyCheckpoint(live: NonNullable<NativeCheckpoint["live"]>): NativeCheckpoint {
  return { version: 1, network: "mutinynet", domain: "20260930001", state,
    serverKey: "", emulatorKey: "", aliceSecret: "02".repeat(32), bobSecret: "03".repeat(32), checkpointScript: "",
    identities: {}, issuanceRaw: "", genesisRaw: "", heads: {}, funding: { BTC: "0", DEMO: "0" }, receipts: [], live };
}
