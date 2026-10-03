import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import {
  ConditionCSVMultisigTapscript, ConditionMultisigTapscript, CSVMultisigTapscript, MultisigTapscript, Transaction, matchServerCheckpoints,
  verifyTapscriptSignatures, type Identity,
} from "@arkade-os/sdk";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import type { NativeVmResult } from "../sdk/runtime.ts";
import type { VmBridgeRequest } from "../sdk/adapter.ts";

function sameBody(actual: Transaction, expected: Transaction): void {
  if (actual.id !== expected.id || hex.encode(actual.unsignedTx) !== hex.encode(expected.unsignedTx)) {
    throw new Error("Compact signer changed the transaction body");
  }
}

function signerKeys(script: Uint8Array): Uint8Array[] {
  if (ConditionMultisigTapscript.isScriptValid(script) === true) return ConditionMultisigTapscript.decode(script).params.pubkeys;
  if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) return ConditionCSVMultisigTapscript.decode(script).params.pubkeys;
  try { return CSVMultisigTapscript.decode(script).params.pubkeys; }
  catch { return MultisigTapscript.decode(script).params.pubkeys; }
}

function sameSpendLeaf(actual: Transaction, expected: Transaction, vin: number, label: string) {
  const actualLeaf = actual.getInput(vin).tapLeafScript?.[0];
  const expectedLeaf = expected.getInput(vin).tapLeafScript?.[0];
  if (!actualLeaf || !expectedLeaf || !Buffer.from(actualLeaf[1]).equals(Buffer.from(expectedLeaf[1])) ||
      !Buffer.from(TaprootControlBlock.encode(actualLeaf[0])).equals(Buffer.from(TaprootControlBlock.encode(expectedLeaf[0])))) {
    throw new Error(`${label} changed the submitted spend leaf`);
  }
  return expectedLeaf;
}

function addMissingSignatures(actual: Transaction, source: Transaction, vin: number): void {
  const current = actual.getInput(vin).tapScriptSig ?? [];
  const missing = (source.getInput(vin).tapScriptSig ?? []).filter(([key]) => !current.some(([other]) =>
    hex.encode(other.pubKey) === hex.encode(key.pubKey) && hex.encode(other.leafHash) === hex.encode(key.leafHash)));
  if (missing.length) actual.updateInput(vin, { tapScriptSig: [...current, ...missing] });
}

/** Add the registered emulator signature before sending a proof sidecar to Arkade. */
export async function signCompactEmulator(request: VmBridgeRequest, emulator: Identity): Promise<VmBridgeRequest> {
  const tx = Transaction.fromPSBT(base64.decode(request.arkTx));
  const signed = await emulator.sign(tx);
  sameBody(signed, tx);
  const checkpoints = await Promise.all(request.checkpoints.map(async (entry) => {
    const checkpoint = Transaction.fromPSBT(base64.decode(entry));
    const signedCheckpoint = await emulator.sign(checkpoint, [0]);
    sameBody(signedCheckpoint, checkpoint);
    return base64.encode(signedCheckpoint.toPSBT());
  }));
  return { arkTx: base64.encode(signed.toPSBT()), checkpoints };
}

/** Verify all pinned operator signatures and reject altered Arkade responses. */
export function verifyCompactResponse(
  request: VmBridgeRequest,
  result: NativeVmResult,
  serverKey: string,
  emulatorKey: string,
): { arkTx: Transaction; checkpoints: Transaction[] } {
  if (!result.ok || !result.arkTx || !result.checkpoints) throw new Error(result.error ?? "Compact signer returned an incomplete response");
  const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
  const returned = Transaction.fromPSBT(base64.decode(result.arkTx));
  sameBody(returned, expected);
  const signed = Transaction.fromPSBT(returned.toPSBT());
  const checkpointRequests = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
  const checkpointPairs = matchServerCheckpoints(result.checkpoints, checkpointRequests, "compact verifier");
  const signedCheckpoints: Transaction[] = [];
  const mainKeys = [serverKey, emulatorKey];
  for (let vin = 0; vin < signed.inputsLength; vin++) {
    const leaf = sameSpendLeaf(returned, expected, vin, "Arkade compact transaction");
    const script = leaf[1].subarray(0, -1);
    const signers = signerKeys(script);
    if (signers.length !== 2 || !signers.some((key) => hex.encode(key) === serverKey) || !signers.some((key) => hex.encode(key) === emulatorKey)) {
      throw new Error("Compact input does not contain the pinned two-signer profile closure");
    }
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    const localSignatures = expected.getInput(vin).tapScriptSig ?? [];
    if (localSignatures.some(([key]) => hex.encode(key.pubKey) === emulatorKey)) {
      verifyTapscriptSignatures(expected, vin, [emulatorKey], undefined, undefined, leafHash);
    } else if (!(returned.getInput(vin).tapScriptSig ?? []).some(([key]) => hex.encode(key.pubKey) === emulatorKey)) {
      throw new Error("Compact transaction is missing the pinned emulator signature");
    }
    verifyTapscriptSignatures(returned, vin, [serverKey], undefined, undefined, leafHash);
    addMissingSignatures(signed, expected, vin);
    verifyTapscriptSignatures(signed, vin, mainKeys, undefined, undefined, leafHash);
  }
  const checkpointById = new Map(checkpointPairs.map(({ server: tx, local }) => [local.id, tx]));
  for (const { server, local } of checkpointPairs) {
    sameBody(server, local);
    for (let vin = 0; vin < server.inputsLength; vin++) {
      const leaf = sameSpendLeaf(server, local, vin, "Arkade compact checkpoint");
      const script = leaf[1].subarray(0, -1);
      const signerSet = signerKeys(script).map((key) => hex.encode(key));
      if (signerSet.length !== 2 || !signerSet.includes(serverKey) || !signerSet.includes(emulatorKey)) {
        throw new Error("Compact checkpoint does not contain exactly the pinned server and emulator keys");
      }
      const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
      const localSignatures = local.getInput(vin).tapScriptSig ?? [];
      if (localSignatures.some(([key]) => hex.encode(key.pubKey) === emulatorKey)) {
        verifyTapscriptSignatures(local, vin, [emulatorKey], undefined, undefined, leafHash);
      } else if (!(server.getInput(vin).tapScriptSig ?? []).some(([key]) => hex.encode(key.pubKey) === emulatorKey)) {
        throw new Error("Compact checkpoint is missing the pinned emulator signature");
      }
      verifyTapscriptSignatures(server, vin, [serverKey], undefined, undefined, tapLeafHash(script, leaf[1].at(-1)!));
      const combined = Transaction.fromPSBT(server.toPSBT());
      addMissingSignatures(combined, local, vin);
      verifyTapscriptSignatures(combined, vin, [serverKey, emulatorKey], undefined, undefined, leafHash);
    }
  }
  for (const local of checkpointRequests) {
    const signedCheckpoint = checkpointById.get(local.id);
    if (!signedCheckpoint) throw new Error("Compact signer omitted a submitted checkpoint");
    const combined = Transaction.fromPSBT(signedCheckpoint.toPSBT());
    for (let vin = 0; vin < combined.inputsLength; vin++) addMissingSignatures(combined, local, vin);
    signedCheckpoints.push(combined);
  }
  return { arkTx: signed, checkpoints: signedCheckpoints };
}
