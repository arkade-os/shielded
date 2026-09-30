import test, { after } from "node:test";
import assert from "node:assert/strict";
import { base64 } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import { arkade, EmulatorPacket, Extension, Transaction } from "@arkade-os/sdk";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { opaquePacket, type VmBridgeRequest } from "../src/sdk/adapter.ts";
import { createSdkRuntime, DEFAULT_VM_BINARY, executeVmBinary } from "../src/sdk/runtime.ts";

const binary = DEFAULT_VM_BINARY;
function mutated(request: VmBridgeRequest, edit: (tx: Transaction) => void): VmBridgeRequest {
  const tx = Transaction.fromPSBT(base64.decode(request.arkTx));
  edit(tx);
  return { ...request, arkTx: base64.encode(tx.toPSBT()) };
}
function changePacket(tx: Transaction, type: number, edit: (bytes: Uint8Array) => Uint8Array) {
  const extension = Extension.fromTx(tx);
  const packets = extension.getPackets().map((packet) => packet.type() === type
    ? opaquePacket({ type, data: edit(packet.serialize()) }) : packet);
  const index = Array.from({ length: tx.outputsLength }, (_, i) => i)
    .find((i) => Extension.isExtension(tx.getOutput(i).script!));
  assert.notEqual(index, undefined);
  tx.updateOutput(index!, { script: Extension.create(packets).txOut().script });
}
async function rejected(request: VmBridgeRequest) {
  const result = await executeVmBinary(binary, request);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /OP_VERIFY|verification|failed to execute/i);
  assert.equal(result.arkTx, undefined);
  assert.equal(result.signatureCount ?? 0, 0);
}

test("real compiled covenants reject key, state, reserve, and destination substitutions", { timeout: 180_000 }, async (t) => {
  const protocol = await createProtocol();
  let captured: VmBridgeRequest | undefined;
  const runtime = await createSdkRuntime({
    verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state,
    execute: async (request) => { captured = structuredClone(request); return executeVmBinary(binary, request); },
  });
  try {
    const shield = await protocol.prepareShield("alice", "BTC", 100_000);
    const receipt = await runtime.settle(shield);
    await protocol.commit(shield, receipt);
    const shieldRequest = captured!;
    assert.equal(receipt.executedInputs, 3);
    assert.equal(receipt.signatureCount, 6);

    await t.test("verification key coordinates cannot replace the constructor's pinned key", async () => {
      await rejected(mutated(shieldRequest, (tx) => {
        const extension = Extension.fromTx(tx);
        const entries = extension.getEmulatorPacket()!.entries.map((entry, index) => {
          if (index !== 0) return entry;
          assert.ok(entry.witness);
          const witness = RawWitness.decode(entry.witness);
          const position = witness.length - 1;
          witness[position] = arkade.BigNum.encode(arkade.BigNum.decode(witness[position]) + 1n);
          return { ...entry, witness: RawWitness.encode(witness) };
        });
        const packets = extension.getPackets().map((packet) => packet.type() === 1 ? EmulatorPacket.create(entries) : packet);
        const index = tx.outputsLength - 2;
        tx.updateOutput(index, { script: Extension.create(packets).txOut().script });
      }));
    });
    await t.test("published lane state must equal the proved successor", async () => {
      await rejected(mutated(shieldRequest, (tx) => changePacket(tx, 0x83, (bytes) => {
        const result = bytes.slice(); result[0] ^= 1; return result;
      })));
    });
    await t.test("native reserves cannot differ from the authorized deposit", async () => {
      await rejected(mutated(shieldRequest, (tx) => {
        tx.updateOutput(0, { amount: tx.getOutput(0).amount! - 1n });
        tx.updateOutput(2, { amount: tx.getOutput(2).amount! + 1n });
      }));
    });
    const seal = await protocol.prepareSeal();
    await protocol.commit(seal, await runtime.settle(seal));
    const withdrawal = await protocol.prepareWithdraw("alice", "BTC", 10_000, runtime.destination("alice"));
    await runtime.settle(withdrawal);
    const withdrawalRequest = captured!;
    await t.test("a valid private proof cannot authorize a substituted native recipient", async () => {
      await rejected(mutated(withdrawalRequest, (tx) => {
        tx.updateOutput(3, { script: tx.getOutput(0).script });
      }));
    });
    await t.test("a valid withdrawal proof cannot authorize a different amount", async () => {
      await rejected(mutated(withdrawalRequest, (tx) => {
        tx.updateOutput(3, { amount: tx.getOutput(3).amount! + 1n });
        tx.updateOutput(2, { amount: tx.getOutput(2).amount! - 1n });
      }));
    });
  } finally { await runtime.close(); }
});

test("native rebase preserves the wallet intent and replaces stale public state", { timeout: 180_000 }, async () => {
  const protocol = await createProtocol();
  const runtime = await createSdkRuntime({
    verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state,
  });
  try {
    const shield = await protocol.prepareShield("alice", "BTC", 100_000);
    await protocol.commit(shield, await runtime.settle(shield));
    const seal = await protocol.prepareSeal();
    await protocol.commit(seal, await runtime.settle(seal));

    const pending = await protocol.prepareTransfer("alice", "bob", "BTC", 25_000);
    const competing = await protocol.prepareShield("alice", "BTC", 10_000);
    await protocol.commit(competing, await runtime.settle(competing));

    const committedState = protocol.snapshot();
    const committedNative = runtime.snapshot();
    await assert.rejects(runtime.settle(pending), /Native lane changed/);
    assert.deepEqual(protocol.snapshot(), committedState);
    assert.deepEqual(runtime.snapshot(), committedNative);
    await assert.rejects(protocol.commit(pending, {}), /Stale settlement/);
    assert.deepEqual(protocol.snapshot(), committedState);
    assert.deepEqual(runtime.snapshot(), committedNative);

    const rebased = await protocol.rebase(pending);
    assert.deepEqual(rebased.intentProof, pending.intentProof);
    assert.deepEqual(rebased.intentSignals, pending.intentSignals);
    assert.notDeepEqual(rebased.transitionProof, pending.transitionProof);
    assert.notDeepEqual(rebased.transitionSignals, pending.transitionSignals);
    assert.equal(await protocol.verify(rebased), true);
    await protocol.commit(rebased, await runtime.settle(rebased));

    const result = protocol.snapshot();
    assert.equal(result.wallets.alice.pending.BTC, 85_000);
    assert.equal(result.wallets.bob.pending.BTC, 25_000);
    assert.equal(result.state.reserves.BTC, 110_000);
    assert.equal((runtime.snapshot() as { reserves: { BTC: number } }).reserves.BTC, 110_000);
  } finally { await runtime.close(); }
});

// snarkjs verify caches its worker pool; release it after this isolated test file.
after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});
