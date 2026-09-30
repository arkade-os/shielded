import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createProtocol } from "../packages/protocol/src/index.ts";
import { createSdkRuntime, type NativeSubmission } from "../src/sdk/runtime.ts";

test("native restart restores original asset identities, ancestry and current reserve heads", { timeout: 180_000 }, async () => {
  const protocol = await createProtocol();
  const runtime = await createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state });
  const genesis = runtime.exportState();
  let restored;
  try {
    const shield = await protocol.prepareShield("alice", "BTC", 100_000);
    await protocol.commit(shield, await runtime.settle(shield));
    const checkpoint = JSON.parse(JSON.stringify(runtime.exportState()));
    restored = await createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state, checkpoint });
    assert.deepEqual(restored.exportState(), checkpoint);
    assert.equal(checkpoint.genesisRaw, genesis.genesisRaw);
    assert.equal(checkpoint.issuanceRaw, genesis.issuanceRaw);
    assert.deepEqual(checkpoint.identities, genesis.identities);
    assert.notEqual(checkpoint.heads.btcVault.txid, genesis.heads.btcVault.txid);
    const corrupted = structuredClone(checkpoint);
    corrupted.heads.gate.value++;
    await assert.rejects(createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state, checkpoint: corrupted }), /ancestry or lock mismatch/);
    const seal = await protocol.prepareSeal();
    let submitted!: NativeSubmission;
    let executions = 0;
    const ambiguous = await createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: protocol.snapshot().state, checkpoint,
      onSubmission: async (_prepared, submission) => { submitted = submission; },
      execute: async () => { executions++; throw new Error("injected lost native response"); } });
    try {
      await assert.rejects(ambiguous.settle(seal), /lost native response/);
      assert.equal(await ambiguous.reconcile(seal, submitted), undefined);
      assert.equal(executions, 1);
      assert.deepEqual(ambiguous.exportState().heads, checkpoint.heads);
    } finally { await ambiguous.close(); }
    const receipt = await restored.settle(seal);
    await protocol.commit(seal, receipt);
    assert.equal(receipt.executedInputs, 2);
    assert.equal(restored.exportState().receipts.length, 2);
    await assert.rejects(createSdkRuntime({ verificationKeys: protocol.verificationKeys(), initialState: genesis.state, checkpoint }), /does not match/);
  } finally { await runtime.close(); await restored?.close(); }
});

after(async () => {
  const pool = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await pool?.terminate();
});
