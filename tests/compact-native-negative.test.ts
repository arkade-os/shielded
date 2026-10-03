import test, { after } from "node:test";
import assert from "node:assert/strict";
import { asset, Extension, Transaction, UnknownPacket } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { createProtocol, type PreparedSettlement } from "../packages/protocol/src/index.ts";
import { COMPACT_PACKET_TYPE, encodeCompactPacket } from "../src/compact/adapter.ts";
import { createCompactRuntime } from "../src/compact/runtime.ts";
import {
  compactBindingHash,
  serializeCompactSidecar,
  verifyCompactUnsignedSubmission,
  type CompactNativeState,
  type CompactSidecar,
} from "../src/compact/verifier.ts";

test("valid Groth16 withdrawal rejects native-effect and checkpoint mutations before signing", { timeout: 300_000 }, async () => {
  const protocol = await createProtocol();
  let runtime!: Awaited<ReturnType<typeof createCompactRuntime>>;
  let adversarialChecks = 0;
  runtime = await createCompactRuntime({
    verificationKeys: protocol.verificationKeys(),
    initialState: protocol.snapshot().state,
    onSubmission: async (prepared, submission) => {
      if (prepared.operation !== "withdraw") return;
      const saved = runtime.exportState();
      const trusted: CompactNativeState = {
        profileId: saved.compact!.profileId,
        protocol: saved.state,
        funding: { BTC: Number(saved.funding.BTC), DEMO: Number(saved.funding.DEMO) },
        heads: Object.fromEntries(Object.entries(saved.heads).map(([name, head]) => [name, {
          ...head,
          sourceTx: head.sourceTx,
        }])) as CompactNativeState["heads"],
      };
      const sidecar = submission.compactSidecar as CompactSidecar;
      const original = decodeRequest(submission.request.arkTx, submission.request.checkpoints);
      assert.equal(original.transaction.inputsLength, 3);
      assertPackageUnsigned(original);
      await verifyCompactUnsignedSubmission(trusted.profileId, sidecar, original.transaction, original.checkpoints, trusted);

      const outputAmount = clonePackage(original);
      outputAmount.transaction.updateOutput(3, { amount: outputAmount.transaction.getOutput(3).amount! + 1n });
      rebind(outputAmount.transaction, sidecar);
      await rejectsUnsigned(outputAmount, sidecar, trusted, /native output 3|sidecar/);

      const gateAmount = clonePackage(original);
      gateAmount.transaction.updateOutput(0, { amount: gateAmount.transaction.getOutput(0).amount! + 1n });
      rebind(gateAmount.transaction, sidecar);
      await rejectsUnsigned(gateAmount, sidecar, trusted, /native output 0|sidecar/);

      const marker = clonePackage(original);
      rewriteAssetPacket(marker.transaction, (groups) => groups.map((group) => ({
        ...group,
        outputs: group.outputs.map((output: { vout: number; amount: bigint }) => output.vout === 1 ? { ...output, vout: 0 } : output),
      })));
      rebind(marker.transaction, sidecar);
      await rejectsUnsigned(marker, sidecar, trusted, /asset|native output|sidecar/);

      const forgedHead = clonePackage(original);
      forgedHead.checkpoints[0].updateInput(0, { txid: new Uint8Array(32).fill(0xff) });
      await rejectsUnsigned(forgedHead, sidecar, trusted, /source txid mismatch/);

      const wrongLeaf = clonePackage(original);
      const checkpointInput = wrongLeaf.checkpoints[0].getInput(0);
      const leaf = checkpointInput.tapLeafScript![0];
      const metadata = structuredClone(leaf[0]);
      metadata.version ^= 1;
      wrongLeaf.checkpoints[0].updateInput(0, { tapLeafScript: [[metadata, leaf[1]]] });
      await rejectsUnsigned(wrongLeaf, sidecar, trusted, /tapleaf|checkpoint/);

      const nonDefault = clonePackage(original);
      nonDefault.checkpoints[0].updateInput(0, { sighashType: 1 });
      await rejectsUnsigned(nonDefault, sidecar, trusted, /SIGHASH_DEFAULT/);

      const duplicate = clonePackage(original);
      const extensionIndex = duplicate.transaction.outputsLength - 2;
      assert.throws(() => Extension.create([
        ...Extension.fromTx(duplicate.transaction).getPackets(),
        new UnknownPacket(COMPACT_PACKET_TYPE, Extension.fromTx(duplicate.transaction).getPacketByType(COMPACT_PACKET_TYPE)!.serialize()),
      ]), /duplicate packet type/);
      duplicate.transaction.updateOutput(extensionIndex, { script: duplicateCompactPacket(duplicate.transaction) });
      await rejectsUnsigned(duplicate, sidecar, trusted, /duplicate packet type 132/);
      adversarialChecks = 7;
      assertPackageUnsigned(original);
      throw new Error("stop before emulator signing after native verifier negatives");
    },
  });

  try {
    const shield = await protocol.prepareShield("alice", "BTC", 100_000) as PreparedSettlement;
    await protocol.commit(shield, await runtime.settle(shield));
    const seal = await protocol.prepareSeal() as PreparedSettlement;
    await protocol.commit(seal, await runtime.settle(seal));
    const withdrawal = await protocol.prepareWithdraw("alice", "BTC", 10_000, runtime.destination("alice")) as PreparedSettlement;
    await assert.rejects(runtime.settle(withdrawal), /stop before emulator signing/);
    assert.equal(adversarialChecks, 7);
    assert.equal(runtime.exportState().receipts.length, 2);
  } finally {
    await runtime.close();
  }
});

function decodeRequest(arkTx: string, checkpoints: string[]) {
  return {
    transaction: Transaction.fromPSBT(base64.decode(arkTx)),
    checkpoints: checkpoints.map((checkpoint) => Transaction.fromPSBT(base64.decode(checkpoint))),
  };
}

function clonePackage(value: ReturnType<typeof decodeRequest>) {
  return {
    transaction: Transaction.fromPSBT(value.transaction.toPSBT()),
    checkpoints: value.checkpoints.map((checkpoint) => Transaction.fromPSBT(checkpoint.toPSBT())),
  };
}

function assertUnsigned(transaction: Transaction) {
  for (let vin = 0; vin < transaction.inputsLength; vin++) {
    const input = transaction.getInput(vin);
    assert.equal(input.tapScriptSig?.length ?? 0, 0);
    assert.equal(input.tapKeySig?.length ?? 0, 0);
    assert.equal(input.finalScriptWitness?.length ?? 0, 0);
  }
}

async function rejectsUnsigned(
  value: ReturnType<typeof decodeRequest>, sidecar: CompactSidecar, trusted: CompactNativeState, reason: RegExp,
) {
  assertPackageUnsigned(value);
  await assert.rejects(verifyCompactUnsignedSubmission(trusted.profileId, sidecar, value.transaction, value.checkpoints, trusted), reason);
}

function assertPackageUnsigned(value: ReturnType<typeof decodeRequest>) {
  assertUnsigned(value.transaction);
  for (const checkpoint of value.checkpoints) assertUnsigned(checkpoint);
}

function rebind(transaction: Transaction, sidecar: CompactSidecar) {
  const extensionIndex = transaction.outputsLength - 2;
  const extension = Extension.fromTx(transaction);
  const packets = extension.getPackets().map((packet) => {
    if (packet.type() !== COMPACT_PACKET_TYPE) return packet;
    const current = packet.serialize();
    const decoded = {
      version: 1 as const,
      profileId: current.slice(5, 37),
      oldStateHash: current.slice(37, 69),
      newStateHash: current.slice(69, 101),
      bindingHash: compactBindingHash(sidecar, transaction),
    };
    return new UnknownPacket(COMPACT_PACKET_TYPE, encodeCompactPacket(decoded));
  });
  transaction.updateOutput(extensionIndex, Extension.create(packets).txOut());
}

function rewriteAssetPacket(transaction: Transaction, transform: (groups: any[]) => any[]) {
  const extensionIndex = transaction.outputsLength - 2;
  const extension = Extension.fromTx(transaction);
  const packets = extension.getPackets().map((packet) => {
    if (packet.type() !== 0) return packet;
    const parsed = extension.getAssetPacket()!;
    const groups = transform(parsed.groups.map((group) => ({
      assetId: group.assetId?.toString(),
      inputs: group.inputs.map(({ vin, amount }) => ({ vin, amount })),
      outputs: group.outputs.map(({ vout, amount }) => ({ vout, amount })),
    })));
    return asset.Packet.create(groups.map((group: any) => asset.AssetGroup.create(
      asset.AssetId.fromString(group.assetId), null,
      group.inputs.map(({ vin, amount }: any) => asset.AssetInput.create(vin, amount)),
      group.outputs.map(({ vout, amount }: any) => asset.AssetOutput.create(vout, amount)), [])));
  });
  transaction.updateOutput(extensionIndex, Extension.create(packets).txOut());
}

function duplicateCompactPacket(transaction: Transaction): Uint8Array {
  const extension = Extension.fromTx(transaction);
  const source = extension.serialize();
  const payload = readOpReturn(source);
  const compact = extension.getPacketByType(COMPACT_PACKET_TYPE)!.serialize();
  const typeAndLength = concat(Uint8Array.of(COMPACT_PACKET_TYPE), encodeVarUint(compact.length));
  return opReturn(concat(payload, typeAndLength, compact));
}

function readOpReturn(script: Uint8Array): Uint8Array {
  if (script[0] !== 0x6a) throw new Error("Expected OP_RETURN extension");
  const opcode = script[1];
  if (opcode <= 75) return script.slice(2, 2 + opcode);
  if (opcode === 0x4c) return script.slice(3, 3 + script[2]);
  if (opcode === 0x4d) {
    const length = script[2] | (script[3] << 8);
    return script.slice(4, 4 + length);
  }
  throw new Error("Unsupported extension push encoding");
}

function opReturn(payload: Uint8Array): Uint8Array {
  if (payload.length <= 75) return concat(Uint8Array.of(0x6a, payload.length), payload);
  if (payload.length <= 255) return concat(Uint8Array.of(0x6a, 0x4c, payload.length), payload);
  if (payload.length <= 65535) return concat(Uint8Array.of(0x6a, 0x4d, payload.length & 0xff, payload.length >>> 8), payload);
  throw new Error("Extension payload exceeds OP_RETURN test bound");
}

function encodeVarUint(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let next = value & 0x7f;
    value >>>= 7;
    if (value) next |= 0x80;
    bytes.push(next);
  } while (value);
  return Uint8Array.from(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

after(async () => {
  const pool = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
