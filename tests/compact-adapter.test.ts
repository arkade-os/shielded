import assert from "node:assert/strict";
import test from "node:test";
import {
  asset,
  CSVMultisigTapscript,
  Extension,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import {
  buildCompactSpend,
  canonicalNativeBody,
  createCompactClosure,
  compactBindingHash,
  decodeCompactPacket,
  encodeCompactPacket,
  extractCompactPacket,
  type CompactInput,
} from "../src/compact/adapter.ts";

const profileId = bytes(0x21);
const oldStateHash = bytes(0x31);
const newStateHash = bytes(0x41);
const sidecarTranscript = new TextEncoder().encode('{"format":"test-sidecar-v1","proof":"fixture"}');
const server = SingleKey.fromPrivateKey(bytes(1));
const emulator = SingleKey.fromPrivateKey(bytes(2));

test("compact packet is fixed-width, canonical and rejects malformed versions", () => {
  const value = { version: 1 as const, profileId, oldStateHash, newStateHash, bindingHash: bytes(0x51) };
  const encoded = encodeCompactPacket(value);
  assert.equal(encoded.length, 133);
  assert.deepEqual(decodeCompactPacket(encoded), value);
  assert.throws(() => decodeCompactPacket(encoded.slice(1)), /must be 133 bytes/);
  const badVersion = encoded.slice();
  badVersion[4] = 2;
  assert.throws(() => decodeCompactPacket(badVersion), /Unsupported compact packet version/);
});

test("SDK transfer carries only the compact application packet and binds native effects", async () => {
  const serverPubkey = await server.xOnlyPublicKey();
  const emulatorPubkey = await emulator.xOnlyPublicKey();
  const closure = createCompactClosure(profileId, serverPubkey, emulatorPubkey, { type: "blocks", value: 144n });
  const funding = createFundingTx([{ amount: 10_000n, script: closure.pkScript }]);
  const input = inputFrom(funding, 0, closure.tapTree, closure.tapLeafScript);
  const destination = outputScript(emulatorPubkey);
  const built = await buildCompactSpend({ profileId, oldStateHash, newStateHash, sidecarTranscript,
    serverPubkey, emulatorPubkey, exitTimelock: closure.exitTimelock, inputs: [input], outputs: [{ script: destination, amount: 10_000n }],
    checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverPubkey] }) });

  const packet = extractCompactPacket(built.arkTx);
  assert(packet);
  assert.deepEqual(packet, built.packet);
  const extension = Extension.fromTx(built.arkTx);
  assert.equal(extension.getPacketByType(0x84)?.serialize().length, 133);
  assert.equal(extension.getPacketByType(1), null, "compact publication must not depend on generic type-1 emulator packet");
  assert.equal(canonicalNativeBody(built.arkTx).length > 0, true);
  assert.deepEqual(compactBindingHash(sidecarTranscript, built.arkTx), packet.bindingHash);

  const signed = await signClosure(built.arkTx);
  assert(signed.isFinal);
  const witness = signed.getInput(0).finalScriptWitness;
  assert.equal(witness?.length, 4);
  assert.deepEqual(witness?.slice(0, 2).map((signature) => signature.length), [64, 64], "fixture signers use default 64-byte Schnorr signatures");
  assert(signed.weight < 4_000, `signed transfer weighed ${signed.weight} WU`);

  const changed = built.arkTx.clone();
  changed.updateOutput(0, { script: outputScript(serverPubkey), amount: 10_000n });
  assert.notDeepEqual(canonicalNativeBody(changed), canonicalNativeBody(built.arkTx));
});

test("asset transfer preserves asset packet and serialized four-input boundary stays below 4000 WU", async () => {
  const serverPubkey = await server.xOnlyPublicKey();
  const emulatorPubkey = await emulator.xOnlyPublicKey();
  const closure = createCompactClosure(profileId, serverPubkey, emulatorPubkey, { type: "blocks", value: 144n });
  const assetId = asset.AssetId.create("11".repeat(32), 0).toString();
  const funding = createFundingTx(Array.from({ length: 4 }, () => ({ amount: 2_000n, script: closure.pkScript, assetId, assetAmount: 25n })));
  const inputs: CompactInput[] = Array.from({ length: 4 }, (_, vout) => inputFrom(funding, vout, closure.tapTree, closure.tapLeafScript));
  const outputs = Array.from({ length: 6 }, (_, index) => ({ script: outputScript(index % 2 ? serverPubkey : emulatorPubkey), amount: index === 5 ? 3_000n : 1_000n }));
  const built = await buildCompactSpend({ profileId, oldStateHash, newStateHash, sidecarTranscript,
    serverPubkey, emulatorPubkey, exitTimelock: closure.exitTimelock, inputs, outputs,
    assets: [{ assetId, inputs: inputs.map((_, vin) => ({ vin, amount: 25n })), outputs: [{ vout: 5, amount: 100n }] }],
    checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverPubkey] }) });
  const extension = Extension.fromTx(built.arkTx);
  assert.equal(extension.getAssetPacket()?.groups.length, 1);
  assert.equal(extension.getPacketByType(1), null);
  assert.equal(built.packetBytes.length, 133);

  const signed = await signClosure(built.arkTx);
  assert.equal(signed.inputsLength, 4);
  assert(signed.isFinal);
  for (let vin = 0; vin < signed.inputsLength; vin++) {
    const witness = signed.getInput(vin).finalScriptWitness;
    assert.equal(witness?.length, 4);
    assert.deepEqual(witness?.slice(0, 2).map((signature) => signature.length), [64, 64]);
  }
  assert(signed.weight < 4_000, `signed boundary transaction weighed ${signed.weight} WU`);
});

test("compact spend refuses mismatched input ancestry and a non-profile closure", async () => {
  const serverPubkey = await server.xOnlyPublicKey();
  const emulatorPubkey = await emulator.xOnlyPublicKey();
  const closure = createCompactClosure(profileId, serverPubkey, emulatorPubkey, { type: "blocks", value: 144n });
  const funding = createFundingTx([{ amount: 5_000n, script: closure.pkScript }]);
  const input = inputFrom(funding, 0, closure.tapTree, closure.tapLeafScript);
  const options = { profileId, oldStateHash, newStateHash, sidecarTranscript, serverPubkey, emulatorPubkey,
    exitTimelock: closure.exitTimelock,
    inputs: [input], outputs: [{ script: outputScript(emulatorPubkey), amount: 5_000n }],
    checkpoint: CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverPubkey] }) };
  await assert.rejects(() => buildCompactSpend({ ...options, inputs: [{ ...input, coin: { ...input.coin, txid: "ff".repeat(32) } }] }), /Previous transaction ID mismatch/);
  await assert.rejects(() => buildCompactSpend({ ...options, profileId: bytes(0x99) }), /registered profile closure/);
});

function bytes(fill: number): Uint8Array { return new Uint8Array(32).fill(fill); }
function outputScript(xOnlyKey: Uint8Array): Uint8Array { return Uint8Array.of(0x51, 0x20, ...xOnlyKey); }

function createFundingTx(outputs: readonly { amount: bigint; script: Uint8Array; assetId?: string; assetAmount?: bigint }[]): Transaction {
  const tx = new Transaction({ version: 2 });
  tx.addInput({ txid: "22".repeat(32), index: 0 });
  for (const output of outputs) tx.addOutput({ amount: output.amount, script: output.script });
  const allocations = outputs.flatMap((output, vout) => output.assetId && output.assetAmount
    ? [{ assetId: output.assetId, vout, amount: output.assetAmount }] : []);
  if (allocations.length) {
    const groups = new Map<string, { vout: number; amount: bigint }[]>();
    for (const allocation of allocations) groups.set(allocation.assetId, [...(groups.get(allocation.assetId) ?? []), { vout: allocation.vout, amount: allocation.amount }]);
    const packet = asset.Packet.create(Array.from(groups, ([id, assigned]) => asset.AssetGroup.create(
      asset.AssetId.fromString(id), null, [], assigned.map(({ vout, amount }) => asset.AssetOutput.create(vout, amount)), [])));
    tx.addOutput(Extension.create([packet]).txOut());
  }
  return tx;
}

function inputFrom(tx: Transaction, vout: number, tapTree: Uint8Array, tapLeafScript: CompactInput["tapLeafScript"]): CompactInput {
  return { coin: { txid: tx.id, vout, value: Number(tx.getOutput(vout).amount), sourceTx: tx.toBytes(false, false) }, tapTree, tapLeafScript };
}

async function signClosure(tx: Transaction): Promise<Transaction> {
  let signed = await server.sign(tx, Array.from({ length: tx.inputsLength }, (_, i) => i));
  signed = await emulator.sign(signed, Array.from({ length: tx.inputsLength }, (_, i) => i));
  signed.finalize();
  return signed;
}
