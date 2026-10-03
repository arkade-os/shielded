import {
  asset,
  buildOffchainTx,
  CSVMultisigTapscript,
  Extension,
  MultisigTapscript,
  SingleKey,
  Transaction,
  VtxoScript,
  createAssetPacket,
  type ArkTxInput,
  type Recipient,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { pathToFileURL } from "node:url";

const GATE_FUNDING = 200_000n;
const CARRIER = 1_000n;
const MINIMUM_BOOTSTRAP_FUNDS = 203_330n;
const TOKEN_SUPPLY = 10_000_000n;

export interface CompactBootstrapBudgetResult {
  readonly sdk: string;
  readonly submitted: false;
  readonly broadcast: false;
  readonly scenario: {
    readonly assetVtxoInputs: number;
    readonly pureBtcInputs: number;
    readonly mainInputs: number;
    readonly recipientOutputs: number;
    readonly nativeAssetGroups: number;
    readonly changeSats: string;
    readonly exitTimelock: string;
    readonly checkpointTimelock: string;
  };
  readonly signedMain: { readonly weightWU: number; readonly vsize: number; readonly bytes: number };
  readonly signedCheckpoint: { readonly count: number; readonly maxWeightWU: number; readonly maxBytes: number };
  readonly illustrativeLimitWU: 4_000;
  readonly passedIllustrativeLimit: boolean;
  readonly limitation: string;
}

/**
 * Reproduce the SDK buildOffchainTx stage used by compact/live.ts wallet.send,
 * without connecting to a wallet provider or submitting anything.
 */
export async function measureCompactBootstrapBudget(btcInputs = 1): Promise<CompactBootstrapBudgetResult> {
  if (!Number.isInteger(btcInputs) || btcInputs < 1 || btcInputs > 32) throw new Error("btcInputs must be in [1, 32]");
  const wallet = SingleKey.fromPrivateKey(new Uint8Array(32).fill(1));
  const server = SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
  const [walletKey, serverKey] = await Promise.all([wallet.xOnlyPublicKey(), server.xOnlyPublicKey()]);
  const collaborative = MultisigTapscript.encode({ pubkeys: [walletKey, serverKey] }).script;
  const ownerExit = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 2048n }, pubkeys: [walletKey] }).script;
  const walletScript = new VtxoScript([collaborative, ownerExit]);
  const serverUnroll = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 4096n }, pubkeys: [serverKey] });

  const identities = new Map<string, bigint>([
    ["token", TOKEN_SUPPLY], ["lane", 1n], ["btcVault", 1n], ["tokenVault", 1n],
  ]);
  const assetCoins: { input: ArkTxInput; assetId: string; amount: bigint; sourceTx: Uint8Array }[] = [];
  for (const [name, amount] of identities) {
    const tx = new Transaction({ version: 2 });
    tx.addInput({ txid: syntheticTxid(`issue:${name}`), index: 0 });
    tx.addOutput({ script: walletScript.pkScript, amount: CARRIER });
    const genesisGroup = asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, amount)], []);
    tx.addOutput(Extension.create([asset.Packet.create([genesisGroup])]).txOut());
    const assetId = asset.AssetId.create(tx.id, 0).toString();
    assetCoins.push({ input: {
      txid: tx.id, vout: 0, value: Number(CARRIER), tapTree: walletScript.encode(),
      tapLeafScript: walletScript.findLeaf(hex.encode(collaborative)),
    }, assetId, amount, sourceTx: tx.toBytes(false, false) });
  }

  const btcTotal = MINIMUM_BOOTSTRAP_FUNDS - CARRIER * BigInt(assetCoins.length);
  const fundingInputs: ArkTxInput[] = [];
  const fundingPerInput = btcTotal / BigInt(btcInputs);
  let btcRemainder = btcTotal % BigInt(btcInputs);
  for (let index = 0; index < btcInputs; index++) {
    const value = fundingPerInput + (index === btcInputs - 1 ? btcRemainder : 0n);
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Synthetic BTC input value is out of range");
    const tx = new Transaction({ version: 2 });
    tx.addInput({ txid: syntheticTxid(`btc:${btcInputs}:${index}`), index: 0 });
    tx.addOutput({ script: walletScript.pkScript, amount: value });
    fundingInputs.push({ txid: tx.id, vout: 0, value: Number(value), tapTree: walletScript.encode(),
      tapLeafScript: walletScript.findLeaf(hex.encode(collaborative)) });
  }

  const inputs: ArkTxInput[] = [...assetCoins.map(({ input }) => input), ...fundingInputs];
  const assetInputs = new Map<number, { assetId: string; amount: bigint }[]>();
  for (const [vin, coin] of assetCoins.entries()) assetInputs.set(vin, [{ assetId: coin.assetId, amount: coin.amount }]);
  const recipients: Recipient[] = [
    { address: "", amount: Number(GATE_FUNDING), assets: [{ assetId: assetCoins[0].assetId, amount: TOKEN_SUPPLY }], tapTree: walletScript.encode() },
    { address: "", amount: Number(CARRIER), assets: [{ assetId: assetCoins[1].assetId, amount: 1n }], tapTree: walletScript.encode() },
    { address: "", amount: Number(CARRIER), assets: [{ assetId: assetCoins[2].assetId, amount: 1n }], tapTree: walletScript.encode() },
    { address: "", amount: Number(CARRIER), assets: [{ assetId: assetCoins[3].assetId, amount: 1n }], tapTree: walletScript.encode() },
  ];
  const outputs = [GATE_FUNDING, CARRIER, CARRIER, CARRIER].map((amount) => ({ script: walletScript.pkScript, amount }));
  const selectedSats = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
  const outputSats = outputs.reduce((sum, output) => sum + output.amount, 0n);
  const change = selectedSats - outputSats;
  if (change < 0n) throw new Error("Synthetic inputs do not cover compact bootstrap outputs");
  if (change > 0n) outputs.push({ script: walletScript.pkScript, amount: change });
  const assetPacket = createAssetPacket(assetInputs, recipients, undefined);
  outputs.push(Extension.create([assetPacket]).txOut());

  const built = buildOffchainTx(inputs, outputs, serverUnroll);
  const signerIndexes = Array.from({ length: built.arkTx.inputsLength }, (_, index) => index);
  let signedArkTx = await wallet.sign(built.arkTx, signerIndexes);
  signedArkTx = await server.sign(signedArkTx, signerIndexes);
  signedArkTx.finalize();
  const signedCheckpoints: Transaction[] = [];
  for (const checkpoint of built.checkpoints) {
    let signed = await wallet.sign(checkpoint, [0]);
    signed = await server.sign(signed, [0]);
    signed.finalize();
    signedCheckpoints.push(signed);
  }
  const extension = Extension.fromTx(signedArkTx);
  const packet = extension.getAssetPacket();
  if (packet?.groups.length !== 4) throw new Error(`SDK produced ${packet?.groups.length ?? 0} asset groups; expected 4`);
  return {
    sdk: "@arkade-os/sdk buildOffchainTx (0.4.77)",
    submitted: false,
    broadcast: false,
    scenario: { assetVtxoInputs: assetCoins.length, pureBtcInputs: btcInputs, mainInputs: signedArkTx.inputsLength,
      recipientOutputs: recipients.length, nativeAssetGroups: packet.groups.length, changeSats: change.toString(),
      exitTimelock: "2048 seconds", checkpointTimelock: "4096 seconds" },
    signedMain: { weightWU: signedArkTx.weight, vsize: signedArkTx.vsize, bytes: signedArkTx.extract().length },
    signedCheckpoint: { count: signedCheckpoints.length, maxWeightWU: Math.max(...signedCheckpoints.map((tx) => tx.weight)),
      maxBytes: Math.max(...signedCheckpoints.map((tx) => tx.extract().length)) },
    illustrativeLimitWU: 4_000,
    passedIllustrativeLimit: signedArkTx.weight <= 4_000,
    limitation: "Fixture-key signatures and synthetic source outputs; wallet selection, funded issuance ancestry, actual operator cap and live submission are not exercised.",
  };
}

function syntheticTxid(label: string): string {
  let value = 0x811c9dc5;
  for (const char of label) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return value.toString(16).padStart(8, "0").repeat(8);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = [];
  for (const btcInputs of [1, 2, 4]) result.push(await measureCompactBootstrapBudget(btcInputs));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
