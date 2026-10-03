import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  asset, ASSET_CARRIER_SATS, ConditionMultisigTapscript, CSVMultisigTapscript, MultisigTapscript, SingleKey, Transaction, VtxoScript,
  type Identity, type RelativeTimelock,
} from "@arkade-os/sdk";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import type { PreparedSettlement, ProtocolState, Owner } from "../../packages/protocol/src/types.ts";
import {
  buildCompactSpend, canonicalNativeBody, createCompactClosure, type CompactAssetAllocation,
  type CompactInput, type CompactOutput,
} from "./adapter.ts";
import {
  registerCompactProfile, hashProtocolState, type CompactProfileConfig, type CompactVerifierProfile,
} from "./profile.ts";
import {
  serializeCompactSidecar, verifyCompactSubmission, verifyCompactUnsignedSubmission,
  type CompactNativeState, type CompactSidecar,
} from "./verifier.ts";
import { signCompactEmulator, verifyCompactResponse } from "./signer.ts";
import {
  coinFromTransaction, offlineNativeFixture, transferAssetPacket, type ResourceCoin,
} from "../sdk/adapter.ts";
import { spendSummary } from "../sdk/adapter.ts";
import type {
  NativeCheckpoint, NativeReceipt, NativeSubmission, NativeVmResult, SdkRuntime, SdkRuntimeOptions,
} from "../sdk/runtime.ts";
import type { VmBridgeRequest } from "../sdk/adapter.ts";

const INITIAL_FUNDING = 10_000_000n;
const CARRIER = 1_000n;
const EXIT_BLOCKS = { type: "blocks", value: 144n } as const;
const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface CompactRuntimeOptions extends SdkRuntimeOptions {
  /** Server-owned profile. Never accept this object from an HTTP request. */
  compactProfile?: CompactProfileConfig;
  /** Required in Mutinynet mode. It signs the emulator side before forwarding. */
  emulatorIdentity?: Identity;
  /** Local-only signer for the test fixture's Arkade server key. */
  serverIdentity?: Identity;
  weightLimit?: bigint | number;
}

type HeadName = "gate" | "lane" | "btcVault" | "tokenVault";
type HeadMap = Record<HeadName, ResourceCoin>;
type AssetName = "lane" | "btcVault" | "tokenVault" | "token";

function sameState(left: ProtocolState, right: ProtocolState): boolean {
  return left.noteRoot === right.noteRoot && left.spentRoot === right.spentRoot &&
    left.historyRoot === right.historyRoot && left.noteCount === right.noteCount &&
    left.historyCount === right.historyCount && left.revision === right.revision &&
    left.reserves.BTC === right.reserves.BTC && left.reserves.DEMO === right.reserves.DEMO;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requiredHead(heads: HeadMap, name: HeadName): ResourceCoin & { sourceTx: Uint8Array } {
  const head = heads[name];
  if (!head?.sourceTx) throw new Error(`Compact checkpoint has no authenticated ${name} transaction`);
  return head as ResourceCoin & { sourceTx: Uint8Array };
}

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function fieldForScript(script: Uint8Array): string {
  return (littleEndian(sha256(script.subarray(2))) % FR).toString();
}

export function createCompactDestination(serverPubkey: Uint8Array, ownerPubkey: Uint8Array, exitTimelock: RelativeTimelock): { scriptPubKey: Uint8Array; tapTree: Uint8Array; field: string } {
  if (serverPubkey.length !== 32 || ownerPubkey.length !== 32 || Buffer.from(serverPubkey).equals(Buffer.from(ownerPubkey))) {
    throw new Error("Compact destination needs distinct x-only server and owner keys");
  }
  const forfeitLeaf = MultisigTapscript.encode({ pubkeys: [ownerPubkey, serverPubkey] }).script;
  const exitLeaf = CSVMultisigTapscript.encode({ timelock: exitTimelock, pubkeys: [ownerPubkey] }).script;
  const tree = new VtxoScript([forfeitLeaf, exitLeaf]);
  return { scriptPubKey: tree.pkScript, tapTree: tree.encode(), field: fieldForScript(tree.pkScript) };
}

export async function createCompactProfile(config: CompactProfileConfig): Promise<{ profile: CompactVerifierProfile; closure: ReturnType<typeof createCompactClosure> }> {
  const profile = await registerCompactProfile(config);
  return { profile, closure: createCompactClosure(hex.decode(profile.profileId), hex.decode(profile.serverKey), hex.decode(profile.emulatorKey),
    { type: profile.exitTimelock.type, value: BigInt(profile.exitTimelock.value) }) };
}

async function p2trRecipient(secret: string, serverKey: Uint8Array, exitTimelock: RelativeTimelock) {
  return createCompactDestination(serverKey, await SingleKey.fromHex(secret).xOnlyPublicKey(), exitTimelock);
}

function validateCheckpoint(checkpoint: NativeCheckpoint, state: ProtocolState, network: string, domain: string): void {
  if (checkpoint.version !== 1 || checkpoint.network !== network || checkpoint.domain !== domain || !sameState(checkpoint.state, state)) {
    throw new Error("Compact checkpoint does not match its network, domain, or protocol state");
  }
  for (const name of ["gate", "lane", "btcVault", "tokenVault"] as const) {
    const head = checkpoint.heads[name];
    if (!head || !head.sourceTx) throw new Error(`Compact checkpoint lacks ${name} provenance`);
    const source = Transaction.fromRaw(hex.decode(head.sourceTx));
    const output = source.getOutput(head.vout);
    if (source.id !== head.txid || output.amount !== BigInt(head.value) || !output.script) {
      throw new Error(`Compact checkpoint ${name} ancestry is invalid`);
    }
  }
}

function extensionAssets(checkpoint: NativeCheckpoint, inputs: readonly CompactInput[], operation: PreparedSettlement["operation"],
  prepared: PreparedSettlement, identities: Record<AssetName, string>, nextGateToken: bigint, selectedVault?: "btcVault" | "tokenVault",
  withdrawToken = 0n): CompactAssetAllocation[] {
  const allocations: CompactAssetAllocation[] = [
    { assetId: identities.lane, inputs: [{ vin: 1, amount: 1n }], outputs: [{ vout: 1, amount: 1n }] },
  ];
  if (selectedVault) allocations.push({ assetId: identities[selectedVault], inputs: [{ vin: 2, amount: 1n }], outputs: [{ vout: 2, amount: 1n }] });

  const assetInputs = checkpoint.funding.DEMO === "0" ? [] : [{ vin: 0, amount: BigInt(checkpoint.funding.DEMO) }];
  const assetOutputs = nextGateToken > 0n ? [{ vout: 0, amount: nextGateToken }] : [];
  if (selectedVault === "tokenVault") {
    const oldReserve = BigInt(prepared.oldState.reserves.DEMO);
    const newReserve = BigInt(prepared.newState.reserves.DEMO);
    if (oldReserve) assetInputs.push({ vin: 2, amount: oldReserve });
    if (newReserve) assetOutputs.push({ vout: 2, amount: newReserve });
    if (withdrawToken) assetOutputs.push({ vout: 3, amount: withdrawToken });
  }
  if (assetInputs.length || assetOutputs.length) allocations.push({ assetId: identities.token, inputs: assetInputs, outputs: assetOutputs });
  return allocations;
}

function compactSummary(tx: Transaction, checkpoints: Transaction[], inputCount: number, placeholder?: Uint8Array) {
  const weighted = Transaction.fromPSBT(tx.toPSBT());
  for (let vin = 0; vin < weighted.inputsLength; vin++) {
    const leaf = weighted.getInput(vin).tapLeafScript?.[0];
    if (!leaf) throw new Error(`Compact input ${vin} has no profile leaf`);
    weighted.updateInput(vin, { finalScriptWitness: [new Uint8Array(64), new Uint8Array(64),
      leaf[1].subarray(0, -1), TaprootControlBlock.encode(leaf[0])] });
  }
  const base = weighted.toBytes(false, false).length;
  const signed = weighted.toBytes(true, true).length;
  const estimatedSignedWeight = signed + 3 * base;
  return {
    txid: tx.id,
    nativeInputs: inputCount,
    nativeOutputs: tx.outputsLength,
    checkpointCount: checkpoints.length,
    extensionIndex: tx.outputsLength - 2,
    anchorIndex: tx.outputsLength - 1,
    txBytes: tx.toBytes().length,
    estimatedSignedWeight,
    psbtBytes: tx.toPSBT().length,
    extensionBytes: tx.getOutput(tx.outputsLength - 2).script?.length ?? 0,
    covenantBytes: Array.from({ length: inputCount }, (_, vin) => tx.getInput(vin).tapLeafScript?.[0]?.[1].length ?? 0),
    witnessBytes: Array.from({ length: inputCount }, () => 0),
    inputs: Array.from({ length: inputCount }, (_, vin) => ({
      outpoint: `${tx.getInput(vin).txid}:${tx.getInput(vin).index}`,
      contract: "registered-compact-profile", function: "publish", amount: Number(tx.getInput(vin).witnessUtxo?.amount ?? 0n),
    })),
    ...(placeholder ? { proofBytes: placeholder.length } : {}),
  };
}

function finalizeSignedWeight(tx: Transaction): { weight: number; signatureCount: number } {
  const finalized = Transaction.fromPSBT(tx.toPSBT());
  let signatureCount = 0;
  for (let vin = 0; vin < finalized.inputsLength; vin++) {
    const input = finalized.getInput(vin);
    const leaf = input.tapLeafScript?.[0];
    if (!leaf) throw new Error(`Signed compact input ${vin} is missing its tapleaf`);
    const script = leaf[1].subarray(0, -1);
    const pubkeys = (ConditionMultisigTapscript.isScriptValid(script) === true
      ? ConditionMultisigTapscript.decode(script)
      : MultisigTapscript.decode(script)).params.pubkeys;
    const signatures = new Map((input.tapScriptSig ?? []).map(([entry, signature]) => [hex.encode(entry.pubKey), signature]));
    const ordered = [...pubkeys].reverse().map((pubkey) => {
      const signature = signatures.get(hex.encode(pubkey));
      if (!signature) throw new Error(`Signed compact input ${vin} lacks a required signer`);
      signatureCount++;
      return signature;
    });
    finalized.updateInput(vin, { finalScriptWitness: [
      ...ordered, script, TaprootControlBlock.encode(leaf[0]),
    ] });
  }
  finalized.finalize();
  return { weight: finalized.weight, signatureCount };
}

function makeRequest(arkTx: Transaction, checkpoints: Transaction[]): VmBridgeRequest {
  return { arkTx: base64.encode(arkTx.toPSBT()), checkpoints: checkpoints.map((tx) => base64.encode(tx.toPSBT())) };
}

function compressedIdentityKey(profileKey: string): Uint8Array { return hex.decode(profileKey); }
function xOnlyKey(profileKey: string): Uint8Array {
  const key = hex.decode(profileKey);
  if (key.length !== 32) throw new Error("Compact operator keys must be x-only keys");
  return key;
}

export async function createCompactRuntime(options: CompactRuntimeOptions): Promise<SdkRuntime> {
  const network = options.network ?? options.checkpoint?.network ?? "local-emulator";
  const restored = options.checkpoint;
  const domain = BigInt(restored?.domain ?? options.domain ?? 20260930001n).toString();
  const initialState = structuredClone(options.initialState);
  if (network === "mutinynet" && (!restored || !restored.compact || !options.compactProfile || !options.execute || !options.emulatorIdentity)) {
    throw new Error("Mutinynet compact runtime requires a durable accepted bootstrap, pinned profile, emulator signer, and explicit Arkade submit callback");
  }

  const server = network === "mutinynet" ? undefined : SingleKey.fromHex("01".repeat(32));
  const emulator = network === "mutinynet" ? undefined : SingleKey.fromHex("02".repeat(32));
  const aliceSecret = restored?.aliceSecret ?? "03".repeat(32);
  const bobSecret = restored?.bobSecret ?? "04".repeat(32);
  if (network === "mutinynet" && !options.emulatorIdentity) throw new Error("A configured emulator signing identity is required");

  const serverKey = options.compactProfile?.serverKey ?? restored?.serverKey ?? hex.encode(await server!.xOnlyPublicKey());
  const emulatorKey = options.compactProfile?.emulatorKey ?? restored?.emulatorKey ?? hex.encode(await emulator!.xOnlyPublicKey());
  const serverProfileKey = options.compactProfile?.serverKey ?? serverKey;
  if (!serverProfileKey || !emulatorKey) throw new Error("Compact profile lacks pinned server/emulator signer keys");
  const checkpointScript = restored?.checkpointScript ?? hex.encode(CSVMultisigTapscript.encode({ timelock: EXIT_BLOCKS, pubkeys: [hex.decode(serverKey)] }).script);
  const exitTimelock = options.compactProfile?.exitTimelock ?? { type: "blocks" as const, value: "144" };
  const [aliceRecipient, bobRecipient] = await Promise.all([
    p2trRecipient(aliceSecret, hex.decode(serverProfileKey), { type: exitTimelock.type, value: BigInt(exitTimelock.value) }),
    p2trRecipient(bobSecret, hex.decode(serverProfileKey), { type: exitTimelock.type, value: BigInt(exitTimelock.value) }),
  ]);
  const recipientScripts = { alice: aliceRecipient, bob: bobRecipient };
  const destinations = Object.fromEntries((Object.entries(recipientScripts) as [Owner, typeof recipientScripts.alice][]).map(([owner, destination]) => [owner, {
    scriptPubKey: hex.encode(destination.scriptPubKey), field: fieldForScript(destination.scriptPubKey),
  }]));

  let identities: Record<AssetName, string>;
  let issuance: Transaction;
  let genesis: Transaction;
  let heads: HeadMap;
  let gateFundingBtc: bigint;
  let gateFundingToken: bigint;
  if (restored) {
    validateCheckpoint(restored, initialState, network, domain);
    identities = Object.fromEntries(Object.entries(restored.identities).filter(([name]) => ["lane", "btcVault", "tokenVault", "token"].includes(name))) as Record<AssetName, string>;
    if (Object.keys(identities).length !== 4) throw new Error("Compact checkpoint lacks native asset identities");
    issuance = Transaction.fromRaw(hex.decode(restored.issuanceRaw));
    genesis = Transaction.fromRaw(hex.decode(restored.genesisRaw));
    heads = Object.fromEntries(Object.entries(restored.heads).map(([name, coin]) => [name, { ...coin, sourceTx: hex.decode(coin.sourceTx) }])) as HeadMap;
    gateFundingBtc = BigInt(restored.funding.BTC);
    gateFundingToken = BigInt(restored.funding.DEMO);
  } else {
    const issuePacket = asset.Packet.create([1n, 1n, 1n, INITIAL_FUNDING + BigInt(initialState.reserves.DEMO)].map((quantity) =>
      asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, quantity)], [])));
    issuance = offlineNativeFixture([{ script: recipientScripts.alice.scriptPubKey,
      amount: INITIAL_FUNDING + 3n * CARRIER + BigInt(initialState.reserves.BTC) }], [issuePacket]);
    identities = {
      lane: asset.AssetId.create(issuance.id, 0).toString(),
      btcVault: asset.AssetId.create(issuance.id, 1).toString(),
      tokenVault: asset.AssetId.create(issuance.id, 2).toString(),
      token: asset.AssetId.create(issuance.id, 3).toString(),
    };
    gateFundingBtc = INITIAL_FUNDING;
    gateFundingToken = INITIAL_FUNDING;
    genesis = offlineNativeFixture([
      { script: new Uint8Array(34), amount: gateFundingBtc },
      { script: new Uint8Array(34), amount: CARRIER },
      { script: new Uint8Array(34), amount: CARRIER + BigInt(initialState.reserves.BTC) },
      { script: new Uint8Array(34), amount: CARRIER },
    ], [], { txid: issuance.id, vout: 0 });
    heads = {
      gate: coinFromTransaction(genesis, 0), lane: coinFromTransaction(genesis, 1),
      btcVault: coinFromTransaction(genesis, 2), tokenVault: coinFromTransaction(genesis, 3),
    };
  }

  const generatedConfig: CompactProfileConfig = options.compactProfile ?? {
    relationVersion: "ark-shield-poc-v1",
    domain,
    verificationKeys: options.verificationKeys as CompactProfileConfig["verificationKeys"],
    serverKey: serverProfileKey,
    emulatorKey,
    checkpointScript,
    exitTimelock: { type: exitTimelock.type, value: exitTimelock.value.toString() },
    identities,
    destinations,
  };
  if (generatedConfig.domain !== domain) throw new Error("Compact profile domain does not match encrypted state");
  if (JSON.stringify(generatedConfig.identities) !== JSON.stringify(identities)) throw new Error("Compact profile native asset identities do not match checkpoint");
  if (restored?.compact && restored.compact.profileId !== (await registerCompactProfile(generatedConfig)).profileId) {
    throw new Error("Compact verifier profile changed; refusing to restore this checkpoint");
  }
  const profile: CompactVerifierProfile = await registerCompactProfile(generatedConfig);
  if (serverKey !== profile.serverKey || emulatorKey !== profile.emulatorKey || (restored && restored.checkpointScript !== profile.checkpointScript)) {
    throw new Error("Compact checkpoint signer keys or exit policy do not match the registered profile");
  }
  if (Object.entries(destinations).some(([owner, entry]) => generatedConfig.destinations[owner]?.scriptPubKey !== entry.scriptPubKey || generatedConfig.destinations[owner]?.field !== entry.field)) {
    throw new Error("Compact profile destinations do not match the encrypted wallet keys");
  }
  const closure = createCompactClosure(hex.decode(profile.profileId), hex.decode(profile.serverKey), hex.decode(profile.emulatorKey),
    { type: profile.exitTimelock.type, value: BigInt(profile.exitTimelock.value) });
  const resourceScripts = [0, 1, 2, 3].map(() => closure.pkScript);

  if (!restored) {
    genesis = offlineNativeFixture([
      { script: resourceScripts[0], amount: gateFundingBtc },
      { script: resourceScripts[1], amount: CARRIER },
      { script: resourceScripts[2], amount: CARRIER + BigInt(initialState.reserves.BTC) },
      { script: resourceScripts[3], amount: CARRIER },
    ], [transferAssetPacket([
      { assetId: identities.lane, inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 1, amount: 1n }] },
      { assetId: identities.btcVault, inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 2, amount: 1n }] },
      { assetId: identities.tokenVault, inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 3, amount: 1n }] },
      { assetId: identities.token, inputs: [{ vin: 0, amount: INITIAL_FUNDING + BigInt(initialState.reserves.DEMO) }], outputs: [
        { vout: 0, amount: INITIAL_FUNDING },
        ...(initialState.reserves.DEMO ? [{ vout: 3, amount: BigInt(initialState.reserves.DEMO) }] : []),
      ] },
    ])], { txid: issuance.id, vout: 0 });
    heads = {
      gate: coinFromTransaction(genesis, 0), lane: coinFromTransaction(genesis, 1),
      btcVault: coinFromTransaction(genesis, 2), tokenVault: coinFromTransaction(genesis, 3),
    };
  }

  for (const name of ["gate", "lane", "btcVault", "tokenVault"] as const) {
    const source = Transaction.fromRaw(heads[name].sourceTx!);
    const out = source.getOutput(heads[name].vout);
    if (source.id !== heads[name].txid || !out.script || hex.encode(out.script) !== hex.encode(closure.pkScript) || out.amount !== BigInt(heads[name].value)) {
      throw new Error(`Compact ${name} head does not match the registered profile closure`);
    }
  }
  const checkpoint = CSVMultisigTapscript.decode(hex.decode(profile.checkpointScript));
  const serverSigner = options.serverIdentity ?? (network === "mutinynet" ? undefined : server);
  const emulatorSigner = options.emulatorIdentity ?? (network === "mutinynet" ? undefined : emulator);
  if (!emulatorSigner) throw new Error("Compact emulator signer is not configured");
  if (network !== "mutinynet" && !serverSigner && !options.execute) throw new Error("Local compact mode requires the local server signer");
  if (hex.encode(await emulatorSigner.xOnlyPublicKey()) !== profile.emulatorKey) throw new Error("Compact emulator signing identity does not match the registered profile");
  if (serverSigner && hex.encode(await serverSigner.xOnlyPublicKey()) !== profile.serverKey) throw new Error("Compact server signing identity does not match the registered profile");

  let state = structuredClone(initialState);
  const receipts: NativeReceipt[] = structuredClone(restored?.receipts ?? []);
  const sidecars: Record<string, string> = structuredClone(restored?.compact?.sidecars ?? {});
  let pendingAcceptance = structuredClone(restored?.compact?.pendingAcceptance);
  let closed = false;
  let busy = false;
  const weightLimit = options.weightLimit === undefined ? 4_000n : BigInt(options.weightLimit);
  let lastProofBytes = receipts.at(-1)?.proofBytes;
  let lastNativeWeight = receipts.at(-1)?.nativeWeight;

  const nativeState = (): CompactNativeState => ({
    profileId: profile.profileId,
    protocol: structuredClone(state),
    funding: { BTC: Number(gateFundingBtc), DEMO: Number(gateFundingToken) },
    heads: Object.fromEntries(Object.entries(heads).map(([name, coin]) => [name, {
      txid: coin.txid, vout: coin.vout, value: coin.value, sourceTx: hex.encode(coin.sourceTx!),
    }])) as CompactNativeState["heads"],
  });

  const exportState = (): NativeCheckpoint => ({
    version: 1, network, domain, state: structuredClone(state), serverKey: hex.encode(xOnlyKey(profile.serverKey)),
    emulatorKey: profile.emulatorKey, aliceSecret, bobSecret, checkpointScript: profile.checkpointScript,
    identities: { ...profile.identities }, issuanceRaw: hex.encode(issuance.toBytes()), genesisRaw: hex.encode(genesis.toBytes()),
    heads: Object.fromEntries(Object.entries(heads).map(([name, coin]) => [name, { ...coin, sourceTx: hex.encode(coin.sourceTx!) }])),
    funding: { BTC: gateFundingBtc.toString(), DEMO: gateFundingToken.toString() }, receipts: structuredClone(receipts),
    ...(restored?.live ? { live: structuredClone(restored.live) } : {}),
    compact: { version: 1, profileId: profile.profileId, sidecars: structuredClone(sidecars),
      ...(pendingAcceptance ? { pendingAcceptance: structuredClone(pendingAcceptance) } : {}) },
  });

  const accept = async (prepared: PreparedSettlement, submission: NativeSubmission, result: NativeVmResult): Promise<NativeReceipt> => {
    if (!result.ok || !result.arkTx || !result.checkpoints || !result.txid) throw new Error(result.error ?? "Compact Arkade submission was not accepted");
    const requested = Transaction.fromPSBT(base64.decode(submission.request.arkTx));
    const verifiedSignatures = verifyCompactResponse(submission.request, result, profile.serverKey, profile.emulatorKey);
    const signed = verifiedSignatures.arkTx;
    const measured = finalizeSignedWeight(signed);
    const checkpointMeasurements = verifiedSignatures.checkpoints.map(finalizeSignedWeight);
    if (weightLimit !== undefined && BigInt(measured.weight) > weightLimit) {
      throw new Error(`Fully signed compact transaction weighs ${measured.weight} WU; configured limit is ${weightLimit}`);
    }
    if (weightLimit !== undefined && checkpointMeasurements.some(({ weight }) => BigInt(weight) > weightLimit)) {
      throw new Error(`Fully signed compact checkpoint exceeds configured limit ${weightLimit}`);
    }
    if (result.txid !== requested.id || signed.id !== requested.id || !Buffer.from(canonicalNativeBody(signed)).equals(Buffer.from(canonicalNativeBody(requested)))) {
      throw new Error("Compact signer returned a different transaction body");
    }
    const sidecar = submission.compactSidecar;
    if (!sidecar) throw new Error("Compact submission journal omitted its proof sidecar");
    const verified = await verifyCompactSubmission(profile.profileId, sidecar, signed, verifiedSignatures.checkpoints, nativeState());
    if (verified.transactionId !== signed.id || !sameState(verified.protocol, prepared.newState)) throw new Error("Compact verifier returned a different accepted state");
    sidecars[prepared.id] = Buffer.from(serializeCompactSidecar(sidecar)).toString("base64");
    pendingAcceptance = { txid: signed.id, result: structuredClone(result) };
    await options.onCheckpoint?.(exportState());

    const receipt = {
      id: prepared.id, operation: prepared.operation, txid: signed.id, backend: result.backend,
      executedInputs: result.executedInputs ?? signed.inputsLength,
      signatureCount: measured.signatureCount + checkpointMeasurements.reduce((total, item) => total + item.signatureCount, 0),
      vmMs: result.durationMs, native: submission.native, publicSignalCounts: { intent: 25, transition: 30 },
      signedArkTx: result.arkTx, signedCheckpoints: result.checkpoints, proofTimes: prepared.proofTimes,
      network, finality: network === "mutinynet" ? "operator-preconfirmed" : "emulator-only",
      proofBytes: serializeCompactSidecar(sidecar).length, nativeWeight: measured.weight,
      checkpointWeights: checkpointMeasurements.map(({ weight }) => weight),
    } as NativeReceipt & { proofBytes: number; nativeWeight: number; checkpointWeights: number[] };
    heads = { ...heads, ...Object.fromEntries(Object.entries(verified.heads).map(([name, coin]) => [name, {
      txid: coin.txid, vout: coin.vout, value: coin.value, sourceTx: hex.decode(coin.sourceTx),
    }])) } as HeadMap;
    gateFundingBtc = BigInt(verified.funding.BTC);
    gateFundingToken = BigInt(verified.funding.DEMO);
    state = structuredClone(verified.protocol);
    receipts.push(receipt);
    pendingAcceptance = undefined;
    lastProofBytes = serializeCompactSidecar(sidecar).length;
    lastNativeWeight = measured.weight;
    return receipt;
  };

  const settle = async (preparedInput: PreparedSettlement): Promise<NativeReceipt> => {
    if (closed) throw new Error("Compact runtime is closed");
    if (busy) throw new Error("Another compact publication is in flight");
    const prepared = structuredClone(preparedInput);
    if (!sameState(state, prepared.oldState)) throw new Error("Compact state head changed; rebase the proof before publication");
    busy = true;
    try {
      const depositBtc = BigInt(prepared.boundary.deposit.BTC);
      const depositToken = BigInt(prepared.boundary.deposit.DEMO);
      const withdrawBtc = BigInt(prepared.boundary.withdrawal.BTC);
      const withdrawToken = BigInt(prepared.boundary.withdrawal.DEMO);
      if ((depositBtc || withdrawBtc) && (depositToken || withdrawToken)) throw new Error("Compact profile supports one native asset boundary per operation");
      const selectedVault = depositBtc || withdrawBtc ? "btcVault" : depositToken || withdrawToken ? "tokenVault" : undefined;
      const tokenPayoutCarrier = withdrawToken ? BigInt(ASSET_CARRIER_SATS) : 0n;
      const nextGateBtc = gateFundingBtc - depositBtc - tokenPayoutCarrier;
      const nextGateToken = gateFundingToken - depositToken;
      if (nextGateBtc < 0n || nextGateToken < 0n) throw new Error("Compact pool funding is insufficient");
      const inputs: CompactInput[] = [
        { coin: requiredHead(heads, "gate"), tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript },
        { coin: requiredHead(heads, "lane"), tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript },
      ];
      if (selectedVault) inputs.push({ coin: requiredHead(heads, selectedVault), tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript });
      const outputs: CompactOutput[] = [
        { script: closure.pkScript, amount: nextGateBtc },
        { script: closure.pkScript, amount: CARRIER },
      ];
      if (selectedVault) outputs.push({ script: closure.pkScript,
        amount: selectedVault === "btcVault" ? CARRIER + BigInt(prepared.newState.reserves.BTC) : CARRIER });
      if (withdrawBtc || withdrawToken) {
        const owner = (Object.entries(profile.destinations).find(([, destination]) =>
          destination.scriptPubKey === prepared.boundary.destination || destination.field === prepared.boundary.destination)?.[0]) as Owner | undefined;
        if (!owner || !recipientScripts[owner]) throw new Error("Compact withdrawal destination is not a registered user script");
        outputs.push({ script: hex.decode(profile.destinations[owner].scriptPubKey), amount: withdrawBtc || tokenPayoutCarrier });
      }
      const allocations = extensionAssets(exportState(), inputs, prepared.operation, prepared, identities,
        nextGateToken, selectedVault, withdrawToken);
      const sidecar: CompactSidecar = {
        operation: prepared.operation, intentProof: prepared.intentProof, transitionProof: prepared.transitionProof,
        intentSignals: prepared.intentSignals, transitionSignals: prepared.transitionSignals, oldState: prepared.oldState,
        newState: prepared.newState, ciphertextRecords: prepared.ciphertextRecords, boundary: prepared.boundary,
      };
      const transcript = serializeCompactSidecar(sidecar);
      const spend = await buildCompactSpend({ profileId: hex.decode(profile.profileId), oldStateHash: hex.decode(hashProtocolState(prepared.oldState)),
        newStateHash: hex.decode(hashProtocolState(prepared.newState)), sidecarTranscript: transcript, inputs, outputs,
        checkpoint, exitTimelock: { type: profile.exitTimelock.type, value: BigInt(profile.exitTimelock.value) },
        serverPubkey: xOnlyKey(profile.serverKey), emulatorPubkey: xOnlyKey(profile.emulatorKey), assets: allocations });
      const native = compactSummary(spend.arkTx, spend.checkpoints, inputs.length) as ReturnType<typeof spendSummary>;
      if (weightLimit !== undefined && BigInt(native.estimatedSignedWeight) > weightLimit) throw new Error(`Compact transaction requires ${native.estimatedSignedWeight} weight units; configured limit is ${weightLimit}`);

      await verifyCompactUnsignedSubmission(profile.profileId, sidecar, spend.arkTx, spend.checkpoints, nativeState());
      const submission: NativeSubmission = { txid: spend.arkTx.id, request: makeRequest(spend.arkTx, spend.checkpoints), native,
        nextState: prepared.newState, nextGateFunding: { BTC: nextGateBtc.toString(), DEMO: nextGateToken.toString() },
        selectedVault, compactSidecar: sidecar };
      await options.onSubmission?.(deepFreeze(structuredClone(prepared)), deepFreeze(structuredClone(submission)));

      const emulatorSignedRequest = await signCompactEmulator(submission.request, emulatorSigner);
      let result: NativeVmResult;
      if (options.execute) {
        result = await options.execute(emulatorSignedRequest);
      } else {
        if (!serverSigner) throw new Error("Compact local signing requires the registered server signer");
        const emulatorSigned = Transaction.fromPSBT(base64.decode(emulatorSignedRequest.arkTx));
        const serverSigned = await serverSigner.sign(emulatorSigned);
        const emulatorCheckpoints = emulatorSignedRequest.checkpoints.map((tx) => Transaction.fromPSBT(base64.decode(tx)));
        const signedCheckpoints = await Promise.all(emulatorCheckpoints.map((tx) => serverSigner.sign(tx, [0])));
        result = { ok: true, arkTx: base64.encode(serverSigned.toPSBT()), checkpoints: signedCheckpoints.map((tx) => base64.encode(tx.toPSBT())),
          txid: serverSigned.id, executedInputs: serverSigned.inputsLength, signatureCount: serverSigned.inputsLength * 2,
          durationMs: 0, backend: "registered-compact-verifier" };
      }
      const checked = verifyCompactResponse(submission.request, result, profile.serverKey, profile.emulatorKey);
      if (checked.arkTx.id !== submission.txid) throw new Error("Compact signer changed the published transaction ID");
      return await accept(prepared, submission, result);
    } finally { busy = false; }
  };

  return {
    settle,
    destination: (owner) => {
      const script = profile.destinations[owner]?.scriptPubKey;
      if (!script) return "";
      const bytes = hex.decode(script);
      if (bytes.length !== 34 || bytes[0] !== 0x51 || bytes[1] !== 0x20) throw new Error("Registered compact destination is not a native Taproot witness program");
      return hex.encode(bytes.subarray(2));
    },
    snapshot: () => ({ mode: "compact-offchain", network, profileId: profile.profileId,
      validatorHash: profile.validatorHash, relationVersion: profile.relationVersion,
      proof: "Groth16 / BN254 verified by registered local verifier",
      nativeWeight: lastNativeWeight, proofBytes: lastProofBytes, weightLimit: weightLimit?.toString(),
      state: structuredClone(state), funding: { BTC: gateFundingBtc.toString(), DEMO: gateFundingToken.toString() },
      heads: Object.fromEntries(Object.entries(heads).map(([name, coin]) => [name, { txid: coin.txid, vout: coin.vout, value: coin.value }])),
      receipts: receipts.map(({ signedArkTx: _tx, signedCheckpoints: _checkpoints, ...receipt }) => receipt),
      syntheticFunding: network === "local-emulator" }),
    compiledArtifacts: () => ({ compactProfile: { profileId: profile.profileId, validatorHash: profile.validatorHash,
      relationVersion: profile.relationVersion, profile: profile } }),
    close: async () => { closed = true; },
    exportState,
    reconcile: async (prepared, submission) => {
      const prior = receipts.find((receipt) => receipt.id === prepared.id && receipt.txid === submission.txid);
      if (prior) return structuredClone(prior);
      if (!sameState(state, prepared.oldState)) return undefined;
      if (pendingAcceptance) {
        if (pendingAcceptance.txid !== submission.txid) throw new Error("Durable compact acceptance journal does not match the pending native transaction");
        return accept(structuredClone(prepared), structuredClone(submission), structuredClone(pendingAcceptance.result));
      }
      if (network === "mutinynet") {
        const result = await options.recoverSubmission?.(submission);
        return result ? accept(prepared, submission, result) : undefined;
      }
      return settle(prepared);
    },
  };
}
