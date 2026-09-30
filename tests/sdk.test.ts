import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { arkade, asset, CSVMultisigTapscript, Extension, getArkPsbtFields, PrevArkTxField, SingleKey, Transaction } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { buildCovenantSpend, coinFromTransaction, instantiateArtifact, offlineNativeFixture, opaquePacket, transferAssetPacket } from "../src/sdk/adapter.ts";

test("SDK OP_PUT matches the compiler and emulator opcode byte", async () => {
  const encoded = arkade.asmToBytes("OP_1 OP_2 OP_PUT");
  assert.equal(encoded.at(-1), 0xbb);
  assert.match(arkade.bytesToASM(encoded), /PUT/);
  const artifact = JSON.parse(await readFile("artifacts/poc_gate.json", "utf8"));
  assert.ok(artifact.functions.some((fn: { arkade?: { asm: string[] } }) => fn.arkade?.asm.includes("OP_PUT")));
  const program = arkade.programFromArtifact(artifact);
  assert.ok(program.functions.apply.arkadeScript?.asm.includes("PUT"));
});

async function fixture() {
  const server = SingleKey.fromHex("01".repeat(32));
  const owner = SingleKey.fromHex("03".repeat(32));
  const emulator = SingleKey.fromHex("02".repeat(32));
  const serverKey = await server.xOnlyPublicKey();
  const artifact = JSON.parse(await readFile("artifacts/poc_recipient.json", "utf8"));
  const contract = instantiateArtifact(artifact, { owner: await owner.xOnlyPublicKey(), exitDelay: 144n }, { serverKey, userKey: await owner.xOnlyPublicKey(), emulatorKey: await emulator.compressedPublicKey() });
  const checkpoint = CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverKey] });
  const previous = offlineNativeFixture([
    { script: contract.script.pkScript, amount: 1_000n },
    { script: contract.script.pkScript, amount: 2_000n },
  ]);
  return { contract, checkpoint, previous };
}

test("compiler Program is assembled by SDK into multiple checkpoints and covenant entries", async () => {
  const { contract, checkpoint, previous } = await fixture();
  const spend = await buildCovenantSpend({
    inputs: [0, 1].map((vout) => ({ contract, coin: coinFromTransaction(previous, vout), functionName: "spend", callArgs: [new Uint8Array(64)] })),
    outputs: [{ script: contract.script.pkScript, amount: 3_000n }],
    checkpoint,
    packets: [{ type: 0x83, data: new Uint8Array(160) }],
  });
  assert.equal(spend.checkpoints.length, 2);
  assert.equal(spend.arkTx.inputsLength, 2);
  assert.equal(spend.extensionIndex, 1);
  assert.equal(spend.anchorIndex, 2);
  const packet = Extension.fromTx(spend.arkTx).getEmulatorPacket()!;
  assert.deepEqual(packet.entries.map((entry) => entry.vin), [0, 1]);
  assert.equal(hex.encode(spend.arkTx.getOutput(2).script!), "51024e73");
  for (let vin = 0; vin < 2; vin++) {
    assert.equal(getArkPsbtFields(spend.arkTx, vin, PrevArkTxField).length, 1);
    assert.equal(hex.encode(spend.arkTx.getInput(vin).txid!), spend.checkpoints[vin].id);
    assert.equal(spend.checkpoints[vin].getInput(0).index, vin);
  }
  assert.equal(Transaction.fromPSBT(spend.arkTx.toPSBT()).id, spend.arkTx.id);
});

test("SDK adapter refuses a previous value or lock asserted by the caller", async () => {
  const { contract, checkpoint, previous } = await fixture();
  const coin = coinFromTransaction(previous, 0);
  await assert.rejects(buildCovenantSpend({
    inputs: [{ contract, coin: { ...coin, value: 2_000 }, functionName: "spend", callArgs: [new Uint8Array(64)] }],
    outputs: [{ script: contract.script.pkScript, amount: 2_000n }], checkpoint,
  }), /Previous native value mismatch/);
});

test("native asset allocations are authenticated against original SDK transaction packets", async () => {
  const { contract, checkpoint } = await fixture();
  const issuance = offlineNativeFixture([{ script: contract.script.pkScript, amount: 1_000n }], [asset.Packet.create([
    asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 50n)], []),
  ])]);
  const id = asset.AssetId.create(issuance.id, 0).toString();
  const args = {
    inputs: [{ contract, coin: coinFromTransaction(issuance, 0), functionName: "spend", callArgs: [new Uint8Array(64)] }],
    outputs: [{ script: contract.script.pkScript, amount: 1_000n }], checkpoint,
  };
  await assert.rejects(buildCovenantSpend({ ...args, assets: [{ assetId: id, inputs: [{ vin: 0, amount: 51n }], outputs: [{ vout: 0, amount: 51n }] }] }), /Unauthenticated native asset allocation/);
  await assert.rejects(buildCovenantSpend(args), /Omitted native asset group/);
  const spend = await buildCovenantSpend({ ...args, assets: [{ assetId: id, inputs: [{ vin: 0, amount: 50n }], outputs: [{ vout: 0, amount: 50n }] }] });
  assert.equal(Extension.fromTx(spend.arkTx).getAssetPacket()!.groups[0].outputs[0].amount, 50n);
});
