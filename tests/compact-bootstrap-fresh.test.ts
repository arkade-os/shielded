import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CSVMultisigTapscript, SingleKey, Transaction, asset } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
  assertFreshBootstrapCheckpoint, assertRecoverableCheckpoint, beginFreshBootstrap, recoverLostSubmitResponse,
  type BootstrapJournal,
  type StoredEngine,
} from "../tools/compact-bootstrap-recovery.ts";
import { buildCompactSpend, createCompactClosure } from "../src/compact/adapter.ts";
import { offlineNativeFixture } from "../src/sdk/adapter.ts";

const profileId = "c".repeat(64);
const bootstrapBodyHash = createHash("sha256").update(JSON.stringify({ action: "bootstrap", body: {} })).digest("hex");

function freshCheckpoint(): StoredEngine {
  const identities = Object.fromEntries(["lane", "btcVault", "tokenVault", "token"].map((name, index) => {
    const tx = offlineNativeFixture([{ script: new Uint8Array([0x51]), amount: BigInt(index + 1) }]);
    return [name, asset.AssetId.create(tx.id, 0).toString()];
  }));
  const issuanceTransactions = Object.fromEntries(Object.keys(identities).map((name, index) => [name, `${index + 1}`.repeat(64)]));
  return {
    version: 2, proofTransport: "compact", profileId,
    protocol: { encryptedLog: [], receipts: [], nullifiers: [], trees: { notes: [], spent: [], history: [] } },
    native: {
      version: 1, network: "mutinynet", domain: "20260930001", state: { noteCount: 0, historyCount: 0, reserves: { BTC: 0, DEMO: 0 } },
      serverKey: "a".repeat(64), emulatorKey: "b".repeat(64), aliceSecret: "01".repeat(32), bobSecret: "02".repeat(32),
      checkpointScript: "checkpoint-policy", identities: structuredClone(identities), issuanceRaw: issuanceTransactions.token!,
      genesisRaw: "", heads: {}, funding: { BTC: "0", DEMO: "0" }, receipts: [],
      compact: { version: 1, profileId, sidecars: {} },
      live: { seedHex: "03".repeat(32), compactEmulatorSecret: "04".repeat(32), arkUrl: "https://mutinynet.arkade.sh",
        emulatorUrl: "inprocess://compact-verifier", phase: "funding-programs", issued: structuredClone(identities),
        issuanceTransactions, boardingReceipts: [] },
    },
    activities: [], publicBalances: { alice: { BTC: 0, DEMO: 0 }, bob: { BTC: 0, DEMO: 0 } },
    requests: { "bootstrap-key": { bodyHash: bootstrapBodyHash, status: "pending" } },
  } as unknown as StoredEngine;
}

test("fresh registered bootstrap writes its own marker before resource funding", async () => {
  const checkpoint = freshCheckpoint();
  let persisted = 0;
  await beginFreshBootstrap(checkpoint, async (saved) => {
    persisted++;
    assert.equal((saved.native.live as any).bootstrapRecovery.freshStart, true);
    assert.equal(Object.keys(saved.native.heads).length, 0);
  });
  assert.equal(persisted, 1);
  assert.doesNotThrow(() => assertFreshBootstrapCheckpoint(checkpoint));
  assert.throws(() => assertRecoverableCheckpoint(checkpoint), /durable pending funding request|adopted resource prefix/);
});

test("fresh continuation admits only its contiguous receipt-backed prefix and identified pending request", async () => {
  const checkpoint = freshCheckpoint();
  await beginFreshBootstrap(checkpoint, async () => {});
  const live = checkpoint.native.live as any;
  const head = { txid: "d".repeat(64), vout: 0, value: 200_000, sourceTx: "raw-gate" };
  checkpoint.native.heads.gate = head;
  checkpoint.native.genesisRaw = head.sourceTx;
  checkpoint.native.funding = { BTC: "200000", DEMO: "10000000" };
  live.bootstrapRecovery.heads.gate = { request: { arkTx: "saved", checkpoints: [] },
    response: { arkTxid: head.txid }, finalizedCheckpointTxs: [] };
  live.pendingBootstrap = { step: "fund:lane", txid: "e".repeat(64), recoveryOwned: true,
    request: { arkTx: "saved-next", checkpoints: ["checkpoint"] }, response: { arkTxid: "e".repeat(64) } };
  assert.doesNotThrow(() => assertFreshBootstrapCheckpoint(checkpoint));
  live.pendingBootstrap.response = undefined;
  assert.doesNotThrow(() => assertFreshBootstrapCheckpoint(checkpoint));
  live.pendingBootstrap.recoveryOwned = undefined;
  assert.throws(() => assertFreshBootstrapCheckpoint(checkpoint), /unknown or mismatched funding request/);
});

test("fresh admission rejects stale activity, unrelated pending requests, unmarked heads and altered registration", async () => {
  const base = freshCheckpoint();
  const mutateAndReject = async (mutate: (checkpoint: StoredEngine) => void, pattern: RegExp) => {
    const checkpoint = structuredClone(base);
    await beginFreshBootstrap(checkpoint, async () => {});
    mutate(checkpoint);
    assert.throws(() => assertFreshBootstrapCheckpoint(checkpoint), pattern);
  };
  await mutateAndReject((checkpoint) => { checkpoint.activities.push({ type: "withdraw" }); }, /empty pool/);
  await mutateAndReject((checkpoint) => { checkpoint.requests.old = { bodyHash: "f".repeat(64), status: "pending" }; }, /exactly one identified/);
  await mutateAndReject((checkpoint) => { checkpoint.native.compact!.profileId = "f".repeat(64); }, /exact registered compact/);
  const unmarked = freshCheckpoint();
  unmarked.native.heads.gate = { txid: "d".repeat(64), vout: 0, value: 200_000, sourceTx: "raw" };
  assert.throws(() => assertFreshBootstrapCheckpoint(unmarked, true), /before resource funding/);
});

test("fresh marker persistence failure prevents continuation admission", async () => {
  const checkpoint = freshCheckpoint();
  await assert.rejects(beginFreshBootstrap(checkpoint, async () => { throw new Error("disk failure"); }), /disk failure/);
  assert.equal((checkpoint.native.live as any).bootstrapRecovery.freshStart, true);
  const reopened = freshCheckpoint();
  assert.throws(() => assertFreshBootstrapCheckpoint(reopened), /marker is missing/);
});

async function lostSubmitFixture() {
  const server = SingleKey.fromHex("08".repeat(32));
  const walletIdentity = SingleKey.fromHex("09".repeat(32));
  const serverKey = hex.encode(await server.xOnlyPublicKey());
  const walletKey = await walletIdentity.xOnlyPublicKey();
  const profile = hex.decode(profileId);
  const closure = createCompactClosure(profile, await server.xOnlyPublicKey(), walletKey, { type: "seconds", value: 2048n });
  const source = offlineNativeFixture([{ script: closure.pkScript, amount: 10_000n }]);
  const spend = await buildCompactSpend({ profileId: profile, oldStateHash: new Uint8Array(32).fill(5),
    newStateHash: new Uint8Array(32).fill(6), sidecarTranscript: Uint8Array.of(1),
    inputs: [{ coin: { txid: source.id, vout: 0, value: 10_000, sourceTx: source.toBytes(false, false) },
      tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript }],
    outputs: [{ script: closure.pkScript, amount: 10_000n }],
    checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [await server.xOnlyPublicKey(), walletKey] }),
    exitTimelock: { type: "seconds", value: 2048n }, serverPubkey: await server.xOnlyPublicKey(), emulatorPubkey: walletKey });
  const localArk = await walletIdentity.sign(spend.arkTx);
  const response = { arkTxid: spend.arkTx.id, finalArkTx: base64.encode((await server.sign(spend.arkTx)).toPSBT()),
    signedCheckpointTxs: await Promise.all(spend.checkpoints.map(async (checkpoint) =>
      base64.encode((await server.sign(checkpoint, [0])).toPSBT()))) };
  const request = { arkTx: base64.encode(localArk.toPSBT()), checkpoints: spend.checkpoints.map((entry) => base64.encode(entry.toPSBT())) };
  const pending = { step: "fund:gate", txid: spend.arkTx.id, request, recoveryOwned: true } as BootstrapJournal;
  const provider = { async getPendingTxs() { return [response]; }, async submitTx() { throw new Error("must not resubmit"); },
    async finalizeTx() { throw new Error("must not finalize in response recovery"); } };
  const indexer = { async getVtxos({ outpoints }: { outpoints: { txid: string; vout: number }[] }) {
    return { vtxos: outpoints.map(({ txid, vout }) => ({ txid, vout, value: 10_000, script: hex.encode(closure.pkScript) })) };
  } };
  const walletApi = {
    async getScriptMap() { return new Map([[hex.encode(closure.pkScript), { encode: () => closure.tapTree, forfeit: () => [] }]]); },
    async makeGetPendingTxIntentSignature() { return {}; },
  };
  return { pending, provider, indexer, walletApi, response, serverKey, txid: spend.arkTx.id };
}

test("response-lost Submit is reconciled from one exact signed pending response before finalize", async () => {
  const f = await lostSubmitFixture();
  let persisted = 0;
  await recoverLostSubmitResponse({ pending: f.pending, provider: f.provider as never, indexer: f.indexer as never, wallet: f.walletApi as never,
    serverKey: f.serverKey, limit: 4_000n, persist: async () => {
      persisted++;
      assert.equal(f.pending.response?.arkTxid, f.txid);
    } });
  assert.equal(persisted, 1);
  assert.equal(Transaction.fromPSBT(base64.decode(f.pending.response!.finalArkTx)).id, f.txid);
});

test("missing or duplicate pending Submit responses remain unresolved without retries", async () => {
  const f = await lostSubmitFixture();
  let pendingCalls = 0, submitCalls = 0, finalizeCalls = 0;
  f.provider.getPendingTxs = async () => { pendingCalls++; return []; };
  f.provider.submitTx = async () => { submitCalls++; throw new Error("must not resubmit"); };
  f.provider.finalizeTx = async () => { finalizeCalls++; throw new Error("must not finalize unknown request"); };
  await assert.rejects(recoverLostSubmitResponse({ pending: f.pending, provider: f.provider as never, indexer: f.indexer as never,
    wallet: f.walletApi as never, serverKey: f.serverKey, limit: 4_000n, persist: async () => { throw new Error("must not persist"); } }),
  /No unique matching signed pending response/);
  assert.equal(pendingCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(finalizeCalls, 0);
  assert.equal(f.pending.response, undefined);
});
