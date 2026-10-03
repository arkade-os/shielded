import assert from "node:assert/strict";
import test from "node:test";
import { measureCompactBootstrapBudget } from "../tools/compact-bootstrap-budget.ts";

test("four-asset SDK bootstrap fit is sensitive to BTC coin fragmentation", async () => {
  const oneBtcCoin = await measureCompactBootstrapBudget(1);
  assert.deepEqual(oneBtcCoin.scenario, {
    assetVtxoInputs: 4, pureBtcInputs: 1, mainInputs: 5, recipientOutputs: 4,
    nativeAssetGroups: 4, changeSats: "330", exitTimelock: "2048 seconds", checkpointTimelock: "4096 seconds",
  });
  assert.equal(oneBtcCoin.submitted, false);
  assert.equal(oneBtcCoin.broadcast, false);
  assert.equal(oneBtcCoin.signedMain.weightWU, 3_924);
  assert.equal(oneBtcCoin.passedIllustrativeLimit, true);
  assert.equal(oneBtcCoin.signedCheckpoint.count, 5);

  const twoBtcCoins = await measureCompactBootstrapBudget(2);
  assert.equal(twoBtcCoins.signedMain.weightWU, 4_354);
  assert.equal(twoBtcCoins.passedIllustrativeLimit, false);

  const fourBtcCoins = await measureCompactBootstrapBudget(4);
  assert.equal(fourBtcCoins.signedMain.weightWU, 5_214);
  assert.equal(fourBtcCoins.passedIllustrativeLimit, false);
});
