import assert from "node:assert/strict";
import test, { after } from "node:test";
import { asset, CSVMultisigTapscript, RestArkProvider, RestIndexerProvider, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { createCompactDestination } from "../src/compact/runtime.ts";
import { createCompactClosure } from "../src/compact/adapter.ts";
import { createCompactReadyLiveRuntime } from "../src/compact/ready-live.ts";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { offlineNativeFixture } from "../src/sdk/adapter.ts";
import type { NativeCheckpoint, NativeSubmission } from "../src/sdk/runtime.ts";
import type { ProtocolState } from "../packages/protocol/src/types.ts";

const server = SingleKey.fromHex("21".repeat(32));
const emulator = SingleKey.fromHex("22".repeat(32));
const alice = SingleKey.fromHex("23".repeat(32));
const bob = SingleKey.fromHex("24".repeat(32));

test("ready Mutinynet adapter settles, restores advanced heads, and never resubmits ambiguous network calls", { timeout: 300_000 }, async (t) => {
  const protocol = await createProtocol();
  const state = protocol.snapshot().state;
  const serverKey = hex.encode(await server.xOnlyPublicKey());
  const emulatorKey = hex.encode(await emulator.xOnlyPublicKey());
  const checkpointScript = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n },
    pubkeys: [await server.xOnlyPublicKey(), await emulator.xOnlyPublicKey()] }).script;
  const aliceDestination = createCompactDestination(await server.xOnlyPublicKey(), await alice.xOnlyPublicKey(), { type: "seconds", value: 2048n });
  const bobDestination = createCompactDestination(await server.xOnlyPublicKey(), await bob.xOnlyPublicKey(), { type: "seconds", value: 2048n });
  const issuePacket = asset.Packet.create([1n, 1n, 1n, 10_000_000n + BigInt(state.reserves.DEMO)].map((amount) =>
    asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, amount)], [])));
  const issuance = offlineNativeFixture([{ script: aliceDestination.scriptPubKey, amount: 10_003_000n }], [issuePacket]);
  const identities = { lane: asset.AssetId.create(issuance.id, 0).toString(),
    btcVault: asset.AssetId.create(issuance.id, 1).toString(), tokenVault: asset.AssetId.create(issuance.id, 2).toString(),
    token: asset.AssetId.create(issuance.id, 3).toString() };
  const destinations = { alice: { scriptPubKey: hex.encode(aliceDestination.scriptPubKey), field: aliceDestination.field },
    bob: { scriptPubKey: hex.encode(bobDestination.scriptPubKey), field: bobDestination.field } };
  const registeredConfig = { relationVersion: "ark-shield-poc-v1", domain: "20260930001",
    verificationKeys: protocol.verificationKeys() as never, serverKey, emulatorKey, checkpointScript: hex.encode(checkpointScript),
    exitTimelock: { type: "seconds" as const, value: "2048" }, identities, destinations };
  const profile = await (await import("../src/compact/profile.ts")).registerCompactProfile(registeredConfig);
  const closure = createCompactClosure(hex.decode(profile.profileId), hex.decode(serverKey), hex.decode(emulatorKey),
    { type: "seconds", value: 2048n });
  const groups = [
    asset.AssetGroup.create(asset.AssetId.fromString(identities.lane), null, [], [asset.AssetOutput.create(1, 1n)], []),
    asset.AssetGroup.create(asset.AssetId.fromString(identities.btcVault), null, [], [asset.AssetOutput.create(2, 1n)], []),
    asset.AssetGroup.create(asset.AssetId.fromString(identities.tokenVault), null, [], [asset.AssetOutput.create(3, 1n)], []),
    asset.AssetGroup.create(asset.AssetId.fromString(identities.token), null, [], [asset.AssetOutput.create(0, 10_000_000n),
      ...(state.reserves.DEMO ? [asset.AssetOutput.create(3, BigInt(state.reserves.DEMO))] : [])], []),
  ];
  const genesis = offlineNativeFixture([
    { script: closure.pkScript, amount: 200_000n }, { script: closure.pkScript, amount: 1_000n },
    { script: closure.pkScript, amount: 1_000n + BigInt(state.reserves.BTC) }, { script: closure.pkScript, amount: 1_000n },
  ], [asset.Packet.create(groups)], { txid: issuance.id, vout: 0 });
  const initial: NativeCheckpoint = {
    version: 1, network: "mutinynet", domain: "20260930001", state: structuredClone(state), serverKey, emulatorKey,
    aliceSecret: "23".repeat(32), bobSecret: "24".repeat(32), checkpointScript: hex.encode(checkpointScript), identities,
    issuanceRaw: hex.encode(issuance.toBytes()), genesisRaw: hex.encode(genesis.toBytes()),
    heads: Object.fromEntries((["gate", "lane", "btcVault", "tokenVault"] as const).map((name, vout) => [name, {
      txid: genesis.id, vout, value: Number(genesis.getOutput(vout).amount), sourceTx: hex.encode(genesis.toBytes()),
    }])),
    funding: { BTC: "200000", DEMO: "10000000" }, receipts: [],
    live: { seedHex: "25".repeat(32), compactEmulatorSecret: "22".repeat(32), arkUrl: "https://mutinynet.arkade.sh",
      emulatorUrl: "inprocess://compact-verifier", phase: "ready", issued: identities, issuanceTransactions: { ...identities } },
    compact: { version: 1, profileId: profile.profileId, sidecars: {} },
  };
  const bootstrapRequest = { arkTx: base64.encode(genesis.toPSBT()), checkpoints: [] };
  (initial.live as unknown as { bootstrapRecovery: unknown }).bootstrapRecovery = { version: 1, profileId: profile.profileId,
    heads: Object.fromEntries((["gate", "lane", "btcVault", "tokenVault"] as const).map((name) => [name, {
      request: bootstrapRequest, response: { arkTxid: genesis.id }, finalizedCheckpointTxs: [],
    }])) };
  let currentHeads = structuredClone(initial.heads);
  let submitCalls = 0, finalizeCalls = 0;
  let submitFailure = false, finalizeFailure = false, maxWeight = 4_000n, exposeAccepted = false, failSubmissionCallback = false;
  let indexedAcceptance: { ark: Transaction; checkpoints: Transaction[] } | undefined;
  const makeResponse = async (arkTx: string, checkpoints: string[]) => {
    const parsed = Transaction.fromPSBT(base64.decode(arkTx));
    const signedArk = await server.sign(parsed);
    const signedCheckpoints = await Promise.all(checkpoints.map(async (raw) => base64.encode(
      (await server.sign(Transaction.fromPSBT(base64.decode(raw)), [0])).toPSBT())));
    return { arkTxid: parsed.id, finalArkTx: base64.encode(signedArk.toPSBT()), signedCheckpointTxs: signedCheckpoints };
  };
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "mutinynet", signerPubkey: `02${serverKey}`,
    checkpointTapscript: hex.encode(checkpointScript), unilateralExitDelay: 2048n, maxTxWeight: maxWeight } as never));
  t.mock.method(RestArkProvider.prototype, "submitTx", async (arkTx: string, checkpoints: string[]) => {
    submitCalls++; if (submitFailure) throw new Error("lost submit response");
    const response = await makeResponse(arkTx, checkpoints);
    if (exposeAccepted) indexedAcceptance = { ark: Transaction.fromPSBT(base64.decode(response.finalArkTx)),
      checkpoints: response.signedCheckpointTxs.map((raw) => Transaction.fromPSBT(base64.decode(raw))) };
    return response as never;
  });
  t.mock.method(RestArkProvider.prototype, "finalizeTx", async () => { finalizeCalls++; if (finalizeFailure) throw new Error("lost finalize response"); });
  t.mock.method(RestIndexerProvider.prototype, "getVirtualTxs", async (ids: string[]) => ({ txs: indexedAcceptance
    ? [indexedAcceptance.ark, ...indexedAcceptance.checkpoints].filter((tx) => ids.some((id) => id.toLowerCase() === tx.id.toLowerCase()))
      .map((tx) => { const bodyOnly = Transaction.fromPSBT(tx.toPSBT());
        for (let vin = 0; vin < bodyOnly.inputsLength; vin++) bodyOnly.updateInput(vin, { tapScriptSig: [] });
        return base64.encode(bodyOnly.toPSBT()); }) : [] } as never));
  t.mock.method(RestIndexerProvider.prototype, "getVtxos", async (filter?: { outpoints?: { txid: string; vout: number }[] }) => ({
    vtxos: (filter?.outpoints ?? []).flatMap((point) => {
      if (indexedAcceptance) {
        for (const checkpoint of indexedAcceptance.checkpoints) {
          const input = checkpoint.getInput(0);
          if (input.txid && input.index === point.vout && hex.encode(input.txid).toLowerCase() === point.txid.toLowerCase()) {
            const source = Object.values(currentHeads).find((head) => head.txid === point.txid && head.vout === point.vout)!;
            return [{ txid: point.txid, vout: point.vout, value: source.value,
              script: hex.encode(Transaction.fromRaw(hex.decode(source.sourceTx)).getOutput(source.vout).script!),
              isSpent: true, isSwept: false, isUnrolled: false, spentBy: checkpoint.id, arkTxId: indexedAcceptance.ark.id }];
          }
        }
        const out = indexedAcceptance.ark.getOutput(point.vout);
        if (point.txid.toLowerCase() === indexedAcceptance.ark.id.toLowerCase() && out?.script && out.amount! > 0n) {
          return [{ txid: point.txid, vout: point.vout, value: Number(out.amount), script: hex.encode(out.script),
            isSpent: false, isSwept: false, isUnrolled: false }];
        }
      }
      return Object.values(currentHeads).flatMap((head) => head.txid === point.txid && head.vout === point.vout
        ? [{ txid: head.txid, vout: head.vout, value: head.value,
          script: hex.encode(Transaction.fromRaw(hex.decode(head.sourceTx)).getOutput(head.vout).script!),
          isSpent: false, isSwept: false, isUnrolled: false }] : []);
    }),
  } as never));

  let durable = structuredClone(initial), lastSubmission: NativeSubmission | undefined;
  const create = (checkpoint: NativeCheckpoint = durable) => createCompactReadyLiveRuntime({
    verificationKeys: protocol.verificationKeys(), initialState: checkpoint.state, domain: BigInt(checkpoint.domain),
    network: "mutinynet", checkpoint, onSubmission: async (_prepared, submission) => {
      lastSubmission = structuredClone(submission);
      if (failSubmissionCallback) throw new Error("durable engine request write failed");
    },
    onCheckpoint: async (value) => { durable = structuredClone(value); },
  });
  const updateIndexerHeads = (checkpoint: NativeCheckpoint) => { currentHeads = structuredClone(checkpoint.heads); };

  const runtime = await create();
  let shield = await protocol.prepareShield("alice", "BTC", 100_000);
  let shieldReceipt;
  try {
    shieldReceipt = await runtime.settle(shield);
    await protocol.commit(shield, shieldReceipt);
    const seal = await protocol.prepareSeal();
    const sealReceipt = await runtime.settle(seal);
    await protocol.commit(seal, sealReceipt);
    const afterSeal = runtime.exportState(); updateIndexerHeads(afterSeal);
    assert.equal((runtime.snapshot() as { profileId: string }).profileId, initial.compact!.profileId);
    await runtime.close();

    const restored = await create(afterSeal);
    try {
      assert.equal((restored.snapshot() as { ready: boolean }).ready, true);
      const transfer = await protocol.prepareTransfer("alice", "bob", "BTC", 25_000);
      const callbackFailure = await create(afterSeal);
      try {
        const before = submitCalls;
        failSubmissionCallback = true;
        await assert.rejects(callbackFailure.settle(transfer), /durable engine request write failed/);
        failSubmissionCallback = false;
        assert.equal(submitCalls, before, "failed engine persistence prevents network submission");
      } finally { failSubmissionCallback = false; await callbackFailure.close(); }

      const beforeSubmitCalls = submitCalls;
      submitFailure = true;
      await assert.rejects(restored.settle(transfer), /lost submit response/);
      submitFailure = false;
      assert.equal(submitCalls, beforeSubmitCalls + 1);
      assert.equal((durable.live as unknown as { readySettlement: { stage: string } }).readySettlement.stage, "submit-attempted");
      assert.ok(lastSubmission);
      await restored.close();

      const afterLostSubmit = await create(durable);
      try {
        const recovered = await afterLostSubmit.reconcile(transfer, lastSubmission!);
        assert.equal(recovered, undefined);
        assert.equal(submitCalls, beforeSubmitCalls + 1, "unknown SubmitTx is reconciled without a second SubmitTx");
      } finally { await afterLostSubmit.close(); }

      const forFinalize = await create(afterSeal);
      try {
        exposeAccepted = true;
        finalizeFailure = true;
        await assert.rejects(forFinalize.settle(transfer), /lost finalize response/);
        finalizeFailure = false;
        const finalizedOnce = finalizeCalls;
        const finalCheckpoint = structuredClone(durable);
        await forFinalize.close();
        const afterLostFinalize = await create(finalCheckpoint);
        try {
          const recovered = await afterLostFinalize.reconcile(transfer, lastSubmission!);
          assert.equal(recovered?.network, "mutinynet", "the saved verified signatures plus indexed body/spend/output links recover acceptance without indexed witnesses");
          assert.equal(finalizeCalls, finalizedOnce, "unknown FinalizeTx is reconciled without a second FinalizeTx");
        } finally { await afterLostFinalize.close(); }
      } finally { exposeAccepted = false; indexedAcceptance = undefined; await forFinalize.close(); }

      maxWeight = 1n;
      const bounded = await create(afterSeal);
      try {
        const before = submitCalls;
        await assert.rejects(bounded.settle(transfer), /weight|WU/i);
        assert.equal(submitCalls, before, "weight preflight rejects before SubmitTx");
      } finally { await bounded.close(); }
    } finally { await restored.close(); }
  } finally { await runtime.close(); }
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});
