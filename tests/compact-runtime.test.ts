import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { createCompactRuntime } from "../src/compact/runtime.ts";
import type { NativeCheckpoint, NativeSubmission } from "../src/sdk/runtime.ts";

test("compact runtime verifies real proofs and carries a signed low-weight payment through restartable native heads", { timeout: 240_000 }, async () => {
  const protocol = await createProtocol();
  let submitted = 0;
  let mutateSubmission = true;
  let acceptedJournal: NativeCheckpoint | undefined;
  let shieldSubmission: NativeSubmission | undefined;
  const runtime = await createCompactRuntime({
    verificationKeys: protocol.verificationKeys(),
    initialState: protocol.snapshot().state,
    onSubmission: async (prepared, submission) => {
      if (mutateSubmission) {
        mutateSubmission = false;
        (submission.request as { arkTx: string }).arkTx = "mutated";
      }
      if (prepared.operation === "shield") shieldSubmission = structuredClone(submission);
      submitted++;
    },
    onCheckpoint: async (checkpoint) => {
      if (!acceptedJournal && checkpoint.compact?.pendingAcceptance) acceptedJournal = structuredClone(checkpoint);
    },
  });
  try {
    const originalCheckpoint = runtime.exportState();
    const shield = await protocol.prepareShield("alice", "BTC", 100_000);
    const tampered = structuredClone(shield);
    tampered.transitionSignals[21] = tampered.transitionSignals[21] === "1" ? "2" : "1";
    const beforeTamper = runtime.exportState();
    await assert.rejects(runtime.settle(tampered), /Compact (new state|intent and transition|transition public)|Groth16/);
    assert.equal(submitted, 0, "invalid proof must be rejected before durable submission or signing");
    assert.deepEqual(runtime.exportState(), beforeTamper);

    await assert.rejects(runtime.settle(shield), /read only|Cannot assign/i);
    assert.equal(submitted, 0, "mutable callback data cannot alter the verified transaction");
    assert.deepEqual(runtime.exportState(), beforeTamper);
    const shieldReceipt = await runtime.settle(shield);
    assert.equal(shieldReceipt.network, "local-emulator");
    assert.ok(acceptedJournal && shieldSubmission);
    assert.deepEqual(acceptedJournal.heads, beforeTamper.heads, "acceptance journal keeps the old native heads");
    assert.deepEqual(acceptedJournal.state, beforeTamper.state, "acceptance journal keeps the old protocol state");
    assert.equal(acceptedJournal.compact?.pendingAcceptance?.txid, shieldReceipt.txid);
    assert.ok(shieldReceipt.native.estimatedSignedWeight < 4_000, `shield weighed ${shieldReceipt.native.estimatedSignedWeight} WU`);
    assert.ok((shieldReceipt.nativeWeight ?? Infinity) < 4_000, `signed shield weighed ${shieldReceipt.nativeWeight} WU`);
    assert.ok(shieldReceipt.signatureCount > shieldReceipt.native.nativeInputs * 2, "signature count includes signed checkpoint inputs");
    const replay = await createCompactRuntime({ verificationKeys: protocol.verificationKeys(),
      initialState: acceptedJournal.state, checkpoint: acceptedJournal });
    try {
      const recovered = await replay.reconcile(shield, shieldSubmission);
      assert.equal(recovered?.txid, shieldReceipt.txid, "recovery accepts the journaled result without another native submission");
      assert.deepEqual(replay.snapshot().heads, runtime.snapshot().heads);
      assert.equal(replay.exportState().compact?.pendingAcceptance, undefined);
    } finally { await replay.close(); }
    await protocol.commit(shield, shieldReceipt);

    const firstSeal = await protocol.prepareSeal();
    const firstSealReceipt = await runtime.settle(firstSeal);
    assert.ok(firstSealReceipt.native.estimatedSignedWeight < 4_000, `seal weighed ${firstSealReceipt.native.estimatedSignedWeight} WU`);
    assert.ok((firstSealReceipt.nativeWeight ?? Infinity) < 4_000);
    await protocol.commit(firstSeal, firstSealReceipt);

    const transfer = await protocol.prepareTransfer("alice", "bob", "BTC", 25_000);
    const transferReceipt = await runtime.settle(transfer);
    assert.ok(transferReceipt.native.estimatedSignedWeight < 4_000, `transfer weighed ${transferReceipt.native.estimatedSignedWeight} WU`);
    assert.ok((transferReceipt.nativeWeight ?? Infinity) < 4_000);
    await protocol.commit(transfer, transferReceipt);

    const secondSeal = await protocol.prepareSeal();
    const secondSealReceipt = await runtime.settle(secondSeal);
    assert.ok(secondSealReceipt.native.estimatedSignedWeight < 4_000, `seal weighed ${secondSealReceipt.native.estimatedSignedWeight} WU`);
    assert.ok((secondSealReceipt.nativeWeight ?? Infinity) < 4_000);
    await protocol.commit(secondSeal, secondSealReceipt);

    const withdraw = await protocol.prepareWithdraw("bob", "BTC", 10_000, runtime.destination("bob"));
    const withdrawReceipt = await runtime.settle(withdraw);
    assert.ok(withdrawReceipt.native.estimatedSignedWeight < 4_000, `withdrawal weighed ${withdrawReceipt.native.estimatedSignedWeight} WU`);
    assert.ok((withdrawReceipt.nativeWeight ?? Infinity) < 4_000);
    await protocol.commit(withdraw, withdrawReceipt);

    const saved = JSON.parse(JSON.stringify(runtime.exportState()));
    assert.equal(saved.compact.profileId, runtime.snapshot().profileId);
    assert.equal(saved.compact.sidecars[withdraw.id] !== undefined, true);
    const restored = await createCompactRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state, checkpoint: saved });
    try {
      assert.deepEqual(restored.exportState(), saved);
      assert.equal((restored.snapshot() as { profileId: string }).profileId, saved.compact.profileId);
      assert.equal(withdrawReceipt.signedArkTx.length > 0, true);
    } finally { await restored.close(); }
    assert.equal(runtime.exportState().receipts.length, 5);
    assert.equal(originalCheckpoint.genesisRaw.length > 0, true);
  } finally {
    await runtime.close();
  }
});

after(async () => {
  const pool = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
