import { randomBytes } from "node:crypto";
import { base64, hex } from "@scure/base";
import {
  ArkAddress, ConditionCSVMultisigTapscript, ConditionMultisigTapscript, CSVMultisigTapscript, Estimator, Extension, MultisigTapscript, Ramps,
  InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider, RestIndexerProvider,
  SingleKey, Transaction, Wallet, asset, isVirtualCoin, matchServerCheckpoints, verifyTapscriptSignatures,
  type ArkInfo, type ExtendedCoin, type ExtendedVirtualCoin, type Identity, type Recipient, type SettlementEvent,
} from "@arkade-os/sdk";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { createCompactRuntime, createCompactDestination, createCompactProfile, type CompactRuntimeOptions } from "./runtime.ts";
import type { BoardingResult, NativeCheckpoint, NativeSubmission, NativeVmResult, SdkRuntime, SdkRuntimeOptions } from "../sdk/runtime.ts";
import type { VmBridgeRequest } from "../sdk/adapter.ts";
import { coinFromTransaction } from "../sdk/adapter.ts";
import { verifyCompactUnsignedSubmission, type CompactNativeState, type CompactSidecar } from "./verifier.ts";
import { verifyCompactResponse } from "./signer.ts";
import type { CompactProfileConfig } from "./profile.ts";

const MUTINYNET_ARK_URL = "https://mutinynet.arkade.sh";
const TOKEN_SUPPLY = 10_000_000n;
const CARRIER = 1_000n;
const GATE_FUNDING = 200_000n;
const MINIMUM_BOOTSTRAP_FUNDS = 203_330n;
const RESOURCE_NAMES = ["gate", "lane", "btcVault", "tokenVault"] as const;
const ISSUE_NAMES = ["lane", "btcVault", "tokenVault", "token"] as const;
const LIVE_EXIT_SECONDS = 2048n;
const HARD_WEIGHT_LIMIT = 4_000n;
type IssueName = typeof ISSUE_NAMES[number];
type LiveState = NonNullable<NativeCheckpoint["live"]>;
type BootstrapResponse = Awaited<ReturnType<RestArkProvider["submitTx"]>>;

function resourceSats(name: typeof RESOURCE_NAMES[number], btcReserve: bigint): bigint {
  return name === "gate" ? GATE_FUNDING : name === "btcVault" ? CARRIER + btcReserve : CARRIER;
}

function requiredResourceFunds(missing: readonly typeof RESOURCE_NAMES[number][], btcReserve: bigint): number {
  const outputs = missing.reduce((sum, name) => sum + resourceSats(name, btcReserve), 0n);
  return Number(outputs + (missing.length ? MINIMUM_BOOTSTRAP_FUNDS - GATE_FUNDING - 3n * CARRIER : 0n));
}

function sameBody(actual: Transaction, expected: Transaction): void {
  if (actual.id !== expected.id || !Buffer.from(actual.unsignedTx).equals(Buffer.from(expected.unsignedTx))) {
    throw new Error("Arkade changed the submitted transaction body");
  }
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

function sameNonWitnessTx(left: NonNullable<ReturnType<Transaction["getInput"]>["nonWitnessUtxo"]> | undefined,
  right: NonNullable<ReturnType<Transaction["getInput"]>["nonWitnessUtxo"]> | undefined): boolean {
  if (!left || !right) return left === right;
  return left.version === right.version && left.segwitFlag === right.segwitFlag && left.lockTime === right.lockTime &&
    left.inputs.length === right.inputs.length && left.inputs.every((input, index) => {
      const other = right.inputs[index];
      return Boolean(other) && sameBytes(input.txid, other.txid) && input.index === other.index &&
        sameBytes(input.finalScriptSig, other.finalScriptSig) && input.sequence === other.sequence;
    }) && left.outputs.length === right.outputs.length && left.outputs.every((output, index) => {
      const other = right.outputs[index];
      return Boolean(other) && output.amount === other.amount && sameBytes(output.script, other.script);
    }) && (left.witnesses ?? []).length === (right.witnesses ?? []).length &&
    (left.witnesses ?? []).every((witness, index) => witness.length === (right.witnesses ?? [])[index]?.length &&
      witness.every((item, itemIndex) => sameBytes(item, (right.witnesses ?? [])[index]?.[itemIndex])));
}

function bootstrapSignerKeys(script: Uint8Array): string[] {
  if (ConditionMultisigTapscript.isScriptValid(script) === true) return ConditionMultisigTapscript.decode(script).params.pubkeys.map(hex.encode);
  if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) return ConditionCSVMultisigTapscript.decode(script).params.pubkeys.map(hex.encode);
  try { return CSVMultisigTapscript.decode(script).params.pubkeys.map(hex.encode); }
  catch { return MultisigTapscript.decode(script).params.pubkeys.map(hex.encode); }
}

function assertBootstrapInputMetadata(actual: Transaction, expected: Transaction): void {
  if (actual.inputsLength !== expected.inputsLength) throw new Error("Arkade changed bootstrap input metadata");
  for (let vin = 0; vin < expected.inputsLength; vin++) {
    const input = actual.getInput(vin);
    const original = expected.getInput(vin);
    if (input.witnessUtxo?.amount !== original.witnessUtxo?.amount ||
        !input.witnessUtxo?.script || !original.witnessUtxo?.script ||
        !Buffer.from(input.witnessUtxo.script).equals(Buffer.from(original.witnessUtxo.script)) ||
        !sameNonWitnessTx(input.nonWitnessUtxo, original.nonWitnessUtxo) ||
        input.sighashType !== original.sighashType ||
        (input.tapInternalKey && !Buffer.from(input.tapInternalKey).equals(Buffer.from(original.tapInternalKey ?? []))) ||
        (original.tapInternalKey && !Buffer.from(original.tapInternalKey).equals(Buffer.from(input.tapInternalKey ?? []))) ||
        (input.tapMerkleRoot && !Buffer.from(input.tapMerkleRoot).equals(Buffer.from(original.tapMerkleRoot ?? []))) ||
        (original.tapMerkleRoot && !Buffer.from(original.tapMerkleRoot).equals(Buffer.from(input.tapMerkleRoot ?? [])))) {
      throw new Error("Arkade changed bootstrap previous-output metadata");
    }
    const leaves = input.tapLeafScript ?? [];
    const expectedLeaves = original.tapLeafScript ?? [];
    if (leaves.length !== expectedLeaves.length || leaves.some(([control, script], index) => {
      const [expectedControl, expectedScript] = expectedLeaves[index] ?? [];
      return !expectedControl || !expectedScript || !Buffer.from(script).equals(Buffer.from(expectedScript)) ||
        !Buffer.from(TaprootControlBlock.encode(control)).equals(Buffer.from(TaprootControlBlock.encode(expectedControl)));
    })) throw new Error("Arkade changed bootstrap spend leaf metadata");
  }
}

function validateBootstrapPartials(tx: Transaction, expected: Transaction, vin: number, serverKey: string, requireServer: boolean): string | undefined {
  const input = tx.getInput(vin);
  const leaves = expected.getInput(vin).tapLeafScript ?? [];
  const signatures = input.tapScriptSig ?? [];
  const seen = new Set<string>();
  const serverLeaves = new Set<string>();
  for (const [key, signature] of signatures) {
    const pubkey = hex.encode(key.pubKey);
    const leafHash = hex.encode(key.leafHash);
    const pair = `${pubkey}:${leafHash}`;
    if (key.pubKey.length !== 32 || key.leafHash.length !== 32 || (signature.length !== 64 && signature.length !== 65) || seen.has(pair)) {
      throw new Error("Arkade returned malformed or duplicate bootstrap signatures");
    }
    seen.add(pair);
    const leaf = leaves.find(([, scriptWithVersion]) => hex.encode(tapLeafHash(scriptWithVersion.subarray(0, -1), scriptWithVersion.at(-1)!)) === leafHash);
    if (!leaf) throw new Error("Arkade returned a bootstrap signature for an unsubmitted leaf");
    const signerKeys = bootstrapSignerKeys(leaf[1].subarray(0, -1));
    if (!signerKeys.includes(pubkey)) throw new Error("Arkade returned a bootstrap signature from a non-leaf signer");
    verifyTapscriptSignatures(tx, vin, [pubkey], signerKeys.filter((keyHex) => keyHex !== pubkey), undefined, key.leafHash);
    if (pubkey === serverKey) serverLeaves.add(leafHash);
  }
  if (serverLeaves.size > 1) throw new Error("Arkade returned operator signatures for conflicting bootstrap leaves");
  if (requireServer && serverLeaves.size === 0) throw new Error("Bootstrap response is missing the pinned operator signature");
  return [...serverLeaves][0];
}

function validateBootstrapResponse(request: VmBridgeRequest, response: BootstrapResponse, serverKey: string) {
  const expectedArk = Transaction.fromPSBT(base64.decode(request.arkTx));
  const serverArk = Transaction.fromPSBT(base64.decode(response.finalArkTx));
  sameBody(serverArk, expectedArk);
  assertBootstrapInputMetadata(serverArk, expectedArk);
  const localArk = Transaction.fromPSBT(base64.decode(request.arkTx));
  for (let vin = 0; vin < localArk.inputsLength; vin++) validateBootstrapPartials(localArk, expectedArk, vin, serverKey, false);
  for (let vin = 0; vin < serverArk.inputsLength; vin++) {
    const leafHash = validateBootstrapPartials(serverArk, expectedArk, vin, serverKey, true)!;
    const serverSignatures = serverArk.getInput(vin).tapScriptSig ?? [];
    const localSignatures = localArk.getInput(vin).tapScriptSig ?? [];
    if (localSignatures.some(([key]) => hex.encode(key.leafHash) !== leafHash)) throw new Error("Submitted Ark signature does not match the operator-signed bootstrap leaf");
    const combined = [...serverSignatures];
    for (const local of localSignatures) {
      const [key, signature] = local;
      const existing = combined.find(([otherKey]) => hex.encode(otherKey.pubKey) === hex.encode(key.pubKey) && hex.encode(otherKey.leafHash) === hex.encode(key.leafHash));
      if (existing) {
        if (!Buffer.from(existing[1]).equals(Buffer.from(signature))) throw new Error("Arkade returned a conflicting bootstrap partial signature");
      } else combined.push(local);
    }
    if (combined.length !== serverSignatures.length) serverArk.updateInput(vin, { tapScriptSig: combined });
    const scriptWithVersion = (expectedArk.getInput(vin).tapLeafScript ?? []).find(([, script]) =>
      hex.encode(tapLeafHash(script.subarray(0, -1), script.at(-1)!)) === leafHash)?.[1];
    if (!scriptWithVersion) throw new Error("Bootstrap operator signature has no submitted spend leaf");
    const signers = bootstrapSignerKeys(scriptWithVersion.subarray(0, -1));
    if ((serverArk.getInput(vin).tapScriptSig ?? []).some(([key]) => hex.encode(key.leafHash) !== leafHash)) {
      throw new Error("Bootstrap Ark response contains signatures for different spend leaves");
    }
    verifyTapscriptSignatures(serverArk, vin, signers, undefined, undefined, hex.decode(leafHash));
  }
  const checkpoints = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
  for (const { server: signed, local } of matchServerCheckpoints(response.signedCheckpointTxs, checkpoints, "compact bootstrap")) {
    sameBody(signed, local);
    assertBootstrapInputMetadata(signed, local);
    for (let vin = 0; vin < signed.inputsLength; vin++) validateBootstrapPartials(signed, local, vin, serverKey, true);
  }
  return serverArk;
}

function outpointKey(point: { txid: string; vout: number }): string {
  return `${point.txid.toLowerCase()}:${point.vout}`;
}

function transactionInputs(tx: Transaction): { txid: string; vout: number }[] {
  return Array.from({ length: tx.inputsLength }, (_, vin) => {
    const input = tx.getInput(vin);
    if (!input.txid || input.index === undefined) throw new Error("Boarding commitment contains an incomplete input");
    return { txid: hex.encode(input.txid).toLowerCase(), vout: input.index };
  });
}

function secureEndpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Mutinynet provider URLs must use HTTPS without embedded credentials");
}

function exitDelay(info: ArkInfo): bigint {
  const delay = BigInt(info.unilateralExitDelay);
  if (delay !== LIVE_EXIT_SECONDS) throw new Error(`Unexpected Mutinynet unilateral exit delay: ${delay} seconds`);
  return delay;
}

function signedWeight(tx: Transaction): number {
  const estimated = Transaction.fromPSBT(tx.toPSBT());
  for (let vin = 0; vin < estimated.inputsLength; vin++) {
    const leaf = estimated.getInput(vin).tapLeafScript?.[0];
    if (!leaf) throw new Error(`Cannot estimate signed weight without input ${vin} spend leaf`);
    if (estimated.getInput(vin).finalScriptWitness) continue;
    const script = leaf[1].subarray(0, -1);
    let keys: Uint8Array[];
    if (ConditionMultisigTapscript.isScriptValid(script) === true) keys = ConditionMultisigTapscript.decode(script).params.pubkeys;
    else if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) keys = ConditionCSVMultisigTapscript.decode(script).params.pubkeys;
    else {
      try { keys = CSVMultisigTapscript.decode(script).params.pubkeys; }
      catch { keys = MultisigTapscript.decode(script).params.pubkeys; }
    }
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    const partials = estimated.getInput(vin).tapScriptSig ?? [];
    const signatures = keys.map((pubKey) => partials.find(([key]) => Buffer.from(key.pubKey).equals(Buffer.from(pubKey)) &&
      Buffer.from(key.leafHash).equals(Buffer.from(leafHash)))?.[1]);
    const complete = signatures.every((signature): signature is Uint8Array => Boolean(signature));
    estimated.updateInput(vin, { finalScriptWitness: [
      ...signatures.slice().reverse().map((signature) => signature ?? new Uint8Array(complete ? 64 : 65)),
      leaf[1].subarray(0, -1), TaprootControlBlock.encode(leaf[0]),
    ] });
  }
  const base = estimated.toBytes(false, false).length;
  return estimated.toBytes(true, true).length + 3 * base;
}

function ensureWeight(tx: Transaction, operatorLimit?: bigint): void {
  const limit = operatorLimit === undefined || operatorLimit > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : operatorLimit;
  const weight = BigInt(signedWeight(tx));
  if (weight > limit) throw new Error(`Mutinynet transaction requires ${weight} WU; effective limit is ${limit} WU`);
}

function transactionFromIndexerPsbt(raws: readonly string[], txid: string): Transaction | undefined {
  return raws.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id.toLowerCase() === txid.toLowerCase());
}

function restoreSignedPsbt(raw: Transaction, original: Transaction): Transaction {
  sameBody(raw, original);
  for (let vin = 0; vin < raw.inputsLength; vin++) {
    const witness = raw.getInput(vin).finalScriptWitness;
    const leaf = original.getInput(vin).tapLeafScript?.[0];
    if (!witness || !leaf || witness.length < 3 || !Buffer.from(witness.at(-2)!).equals(Buffer.from(leaf[1].subarray(0, -1))) ||
        !Buffer.from(witness.at(-1)!).equals(Buffer.from(TaprootControlBlock.encode(leaf[0])))) {
      throw new Error("Indexed transaction does not contain the submitted profile witness");
    }
    const script = leaf[1].subarray(0, -1);
    let keys: Uint8Array[];
    if (ConditionMultisigTapscript.isScriptValid(script) === true) keys = ConditionMultisigTapscript.decode(script).params.pubkeys;
    else {
      try {
        keys = ConditionCSVMultisigTapscript.isScriptValid(script) === true
          ? ConditionCSVMultisigTapscript.decode(script).params.pubkeys
          : CSVMultisigTapscript.decode(script).params.pubkeys;
      }
      catch { keys = MultisigTapscript.decode(script).params.pubkeys; }
    }
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    original.updateInput(vin, { tapScriptSig: keys.map((pubKey, index) => [{ pubKey, leafHash }, witness[keys.length - index - 1]]) });
  }
  return original;
}

function nativeState(checkpoint: NativeCheckpoint, profileId: string): CompactNativeState {
  return { profileId, protocol: structuredClone(checkpoint.state),
    funding: { BTC: Number(checkpoint.funding.BTC), DEMO: Number(checkpoint.funding.DEMO) },
    heads: Object.fromEntries(Object.entries(checkpoint.heads).map(([name, head]) => [name, {
      txid: head.txid, vout: head.vout, value: head.value, sourceTx: head.sourceTx,
    }])) as CompactNativeState["heads"] };
}

function assertNoProgramFunding(checkpoint: NativeCheckpoint): void {
  if (checkpoint.genesisRaw || Object.keys(checkpoint.heads).length || checkpoint.funding.BTC !== "0" || checkpoint.funding.DEMO !== "0" || checkpoint.receipts.length) {
    throw new Error("Compact pre-profile checkpoint contains allocated program funds or native heads");
  }
}

function expectedIdentity(raw: Transaction): string {
  return asset.AssetId.create(raw.id, 0).toString();
}

export async function createCompactLiveRuntime(options: SdkRuntimeOptions): Promise<SdkRuntime> {
  if (!options.onCheckpoint) throw new Error("Mutinynet compact mode requires an encrypted durable checkpoint store before wallet creation");
  if ((options.network ?? options.checkpoint?.network ?? "mutinynet") !== "mutinynet") throw new Error("Compact live adapter only supports Mutinynet");
  const compactOptions = options as CompactRuntimeOptions;
  if (compactOptions.serverIdentity || compactOptions.compactProfile || compactOptions.emulatorIdentity) throw new Error("Live compact profile keys are derived from persisted Mutinynet identities");

  const restored = options.checkpoint;
  if (restored && (restored.network !== "mutinynet" || !restored.live)) throw new Error("Cannot restore a compact live pool without its Mutinynet checkpoint");
  const arkUrl = options.arkUrl ?? restored?.live?.arkUrl ?? MUTINYNET_ARK_URL;
  secureEndpoint(arkUrl);
  if (restored && restored.live!.arkUrl !== arkUrl) throw new Error("Cannot change a persisted compact pool's Arkade provider");

  let live: LiveState = restored?.live ? structuredClone(restored.live) : {
    seedHex: randomBytes(32).toString("hex"), compactEmulatorSecret: randomBytes(32).toString("hex"),
    arkUrl, emulatorUrl: "inprocess://compact-verifier", phase: "funding-required", issued: {}, issuanceTransactions: {},
  };
  if (!live.seedHex || !live.compactEmulatorSecret) throw new Error("Encrypted compact Mutinynet wallet and verifier signing keys are required");
  if (live.arkUrl !== arkUrl || live.emulatorUrl !== "inprocess://compact-verifier") throw new Error("Persisted compact signer or provider configuration changed");

  let saved: NativeCheckpoint = restored ? structuredClone(restored) : {
    version: 1, network: "mutinynet", domain: BigInt(options.domain ?? 20260930001n).toString(), state: structuredClone(options.initialState),
    serverKey: "", emulatorKey: "", aliceSecret: randomBytes(32).toString("hex"), bobSecret: randomBytes(32).toString("hex"),
    checkpointScript: "", identities: {}, issuanceRaw: "", genesisRaw: "", heads: {}, funding: { BTC: "0", DEMO: "0" }, receipts: [], live,
  };
  if (restored && (restored.domain !== BigInt(options.domain ?? restored.domain).toString() ||
      JSON.stringify(restored.state) !== JSON.stringify(options.initialState))) throw new Error("Compact live checkpoint does not match its protocol domain or state");
  if (live.phase === "funding-required" || live.phase === "issuing" || live.phase === "profile-registration") assertNoProgramFunding(saved);
  if (live.phase !== "funding-required" && live.phase !== "issuing" && live.phase !== "profile-registration" && live.phase !== "funding-programs" && live.phase !== "ready") {
    throw new Error("Unknown compact Mutinynet bootstrap phase");
  }
  if ((live.phase === "profile-registration" || live.phase === "funding-programs" || live.phase === "ready") &&
      ISSUE_NAMES.some((name) => !live.issued[name])) throw new Error("Compact profile phase lacks actual asset issuance identities");
  if ((live.phase === "profile-registration" || live.phase === "funding-programs" || live.phase === "ready") && !saved.compact?.profileId) {
    throw new Error("Compact profile phase lacks its durably registered verifier profile");
  }

  const provider = new RestArkProvider(arkUrl);
  const indexer = new RestIndexerProvider(arkUrl);
  const [info] = await Promise.all([provider.getInfo()]);
  if (info.network !== "mutinynet") throw new Error("Compact live runtime only supports Mutinynet; mainnet is forbidden");
  const serverKey = info.signerPubkey.slice(-64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(serverKey) || !info.checkpointTapscript) throw new Error("Mutinynet returned an invalid operator signer or checkpoint policy");
  const serverIdentity = hex.decode(serverKey);
  const emulatorIdentity: Identity = SingleKey.fromHex(live.compactEmulatorSecret);
  const emulatorKey = hex.encode(await emulatorIdentity.xOnlyPublicKey());
  if (restored && (restored.serverKey && restored.serverKey !== serverKey || restored.emulatorKey && restored.emulatorKey !== emulatorKey ||
      restored.checkpointScript && restored.checkpointScript !== info.checkpointTapscript)) {
    throw new Error("Mutinynet operator signer or checkpoint policy changed; encrypted migration is required");
  }
  const delay = exitDelay(info);
  const exitTimelock = { type: "seconds" as const, value: delay };
  const operatorLimit = info.maxTxWeight;
  if (operatorLimit !== undefined && operatorLimit <= 0n) throw new Error("Mutinynet operator reported an invalid transaction weight limit");
  const walletIdentity = SingleKey.fromHex(live.seedHex);
  let wallet!: Awaited<ReturnType<typeof Wallet.create>>;
  let fundingAddress = "";
  let boardingAddress = "";
  let core: SdkRuntime | undefined;
  let profile: Awaited<ReturnType<typeof createCompactProfile>>["profile"] | undefined;
  let closure: Awaited<ReturnType<typeof createCompactProfile>>["closure"] | undefined;
  let busy = false;
  let available = 0;
  let boarding = { confirmed: 0, unconfirmed: 0, total: 0 };
  let onboardingInputCount = 0;
  let step: string | undefined;
  let activeSubmission: NativeSubmission | undefined;
  const originalSubmit = provider.submitTx.bind(provider);

  const exportState = (): NativeCheckpoint => ({ ...structuredClone(core?.exportState() ?? saved), live: structuredClone(live) });
  const persist = async (): Promise<void> => { saved = exportState(); await options.onCheckpoint!(saved); };
  const queryAccepted = async (request: VmBridgeRequest): Promise<Transaction | undefined> => {
    const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
    const { txs } = await indexer.getVirtualTxs([expected.id]);
    const tx = transactionFromIndexerPsbt(txs, expected.id);
    if (!tx) return undefined;
    sameBody(tx, expected);
    const checkpoints = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
    const inputs = checkpoints.map((checkpoint) => ({ txid: hex.encode(checkpoint.getInput(0).txid!), vout: checkpoint.getInput(0).index! }));
    if (inputs.length) {
      const spent = (await indexer.getVtxos({ outpoints: inputs })).vtxos;
      if (inputs.some((input, index) => !spent.some((coin) => coin.txid === input.txid && coin.vout === input.vout &&
          coin.isSpent && coin.spentBy === checkpoints[index].id && coin.arkTxId === expected.id))) return undefined;
    }
    const outputs = Array.from({ length: expected.outputsLength }, (_, vout) => ({ txid: expected.id, vout }))
      .filter(({ vout }) => expected.getOutput(vout).amount! > 0n);
    const received = (await indexer.getVtxos({ outpoints: outputs })).vtxos;
    if (outputs.some(({ vout }) => !received.some((coin) => coin.txid === expected.id && coin.vout === vout && !coin.isSpent &&
        !coin.isSwept && !coin.isUnrolled && coin.value === Number(expected.getOutput(vout).amount!) &&
        coin.script === hex.encode(expected.getOutput(vout).script!)))) return undefined;
    return tx;
  };

  provider.submitTx = async (arkTx, checkpointTxs) => {
    if (!step || live.pendingBootstrap) throw new Error("Compact bootstrap submission has no durable unique step");
    const requested: VmBridgeRequest = { arkTx, checkpoints: checkpointTxs };
    const parsed = Transaction.fromPSBT(base64.decode(arkTx));
    ensureWeight(parsed, operatorLimit);
    for (const checkpoint of checkpointTxs) ensureWeight(Transaction.fromPSBT(base64.decode(checkpoint)), operatorLimit);
    live.pendingBootstrap = { step, txid: parsed.id, request: requested };
    await persist();
    const response = await originalSubmit(arkTx, checkpointTxs);
    const verified = validateBootstrapResponse(requested, response, serverKey);
    if (response.arkTxid !== parsed.id || verified.id !== parsed.id) throw new Error("Arkade returned a different bootstrap transaction ID");
    ensureWeight(verified, operatorLimit);
    for (const checkpoint of response.signedCheckpointTxs) ensureWeight(Transaction.fromPSBT(base64.decode(checkpoint)), operatorLimit);
    const sdkResponse = { ...response, finalArkTx: base64.encode(verified.toPSBT()) };
    live.pendingBootstrap.response = sdkResponse;
    await persist();
    return sdkResponse;
  };

  const finalizeBootstrap = async (): Promise<string | undefined> => {
    const pending = live.pendingBootstrap;
    if (!pending) return undefined;
    const accepted = await queryAccepted(pending.request);
    if (accepted) return pending.txid;
    if (!pending.response) {
      const walletApi = wallet as typeof wallet & {
        getScriptMap?: () => Promise<Map<string, { encode(): Uint8Array; forfeit(): ExtendedVirtualCoin["forfeitTapLeafScript"] }>>;
        makeGetPendingTxIntentSignature?: (coins: ExtendedVirtualCoin[]) => Promise<Parameters<RestArkProvider["getPendingTxs"]>[0]>;
      };
      if (typeof walletApi.getScriptMap !== "function" || typeof walletApi.makeGetPendingTxIntentSignature !== "function") {
        throw new Error(`Bootstrap ${pending.step} outcome is unknown; no transaction will be resubmitted`);
      }
      const originals = pending.request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
      const inputByOutpoint = new Map<string, { txid: string; vout: number; value: bigint; script: Uint8Array }>();
      for (const tx of originals) {
        const input = tx.getInput(0);
        if (!input?.txid || input.index === undefined || !input.witnessUtxo) throw new Error("Saved bootstrap checkpoint lacks its original wallet prevout");
        const outpoint = { txid: hex.encode(input.txid).toLowerCase(), vout: input.index };
        const key = outpointKey(outpoint);
        const entry = { ...outpoint, value: input.witnessUtxo.amount, script: input.witnessUtxo.script };
        const previous = inputByOutpoint.get(key);
        if (previous && (previous.value !== entry.value || !sameBytes(previous.script, entry.script))) {
          throw new Error("Saved bootstrap checkpoints disagree about a wallet prevout");
        }
        inputByOutpoint.set(key, entry);
      }
      if (!inputByOutpoint.size) throw new Error("Saved bootstrap request has no wallet prevouts to reconcile");
      const expected = [...inputByOutpoint.values()];
      const { vtxos } = await indexer.getVtxos({ outpoints: expected.map(({ txid, vout }) => ({ txid, vout })) });
      const scripts = await walletApi.getScriptMap();
      if (vtxos.length !== expected.length) throw new Error("Indexer did not return the exact saved bootstrap inputs");
      const coins = expected.map((point): ExtendedVirtualCoin => {
        const matches = vtxos.filter((coin) => outpointKey(coin) === outpointKey(point));
        if (matches.length !== 1) throw new Error("Indexer returned a missing or duplicate saved bootstrap input");
        const coin = matches[0]!;
        const scriptHex = coin.script.toLowerCase();
        const script = scripts.get(scriptHex);
        if (coin.value !== Number(point.value) || scriptHex !== hex.encode(point.script) || !script) {
          throw new Error("Indexed bootstrap input does not match the saved wallet prevout");
        }
        return { ...coin, tapTree: script.encode(), forfeitTapLeafScript: script.forfeit(), intentTapLeafScript: script.forfeit() };
      });
      const intent = await walletApi.makeGetPendingTxIntentSignature(coins);
      const matches = (await provider.getPendingTxs(intent)).filter((response) => response.arkTxid.toLowerCase() === pending.txid.toLowerCase());
      if (matches.length !== 1) throw new Error("Arkade did not return exactly one matching pending bootstrap response");
      const response = matches[0]!;
      const verified = validateBootstrapResponse(pending.request, response, serverKey);
      if (response.arkTxid.toLowerCase() !== pending.txid.toLowerCase() || verified.id.toLowerCase() !== pending.txid.toLowerCase()) {
        throw new Error("Arkade pending bootstrap response does not match the saved transaction");
      }
      ensureWeight(verified, operatorLimit);
      for (const checkpoint of response.signedCheckpointTxs) ensureWeight(Transaction.fromPSBT(base64.decode(checkpoint)), operatorLimit);
      pending.response = { ...response, finalArkTx: base64.encode(verified.toPSBT()) };
      await persist();
    }
    const verified = validateBootstrapResponse(pending.request, pending.response, serverKey);
    if (pending.response.arkTxid.toLowerCase() !== pending.txid.toLowerCase() || verified.id.toLowerCase() !== pending.txid.toLowerCase()) {
      throw new Error("Saved bootstrap response does not match the submitted transaction");
    }
    ensureWeight(verified, operatorLimit);
    for (const checkpoint of pending.response.signedCheckpointTxs) ensureWeight(Transaction.fromPSBT(base64.decode(checkpoint)), operatorLimit);
    pending.response = { ...pending.response, finalArkTx: base64.encode(verified.toPSBT()) };
    await persist();
    const checkpoints = await Promise.all(pending.response.signedCheckpointTxs.map(async (entry) => {
      const signed = await signCheckpoint(Transaction.fromPSBT(base64.decode(entry)));
      return base64.encode(signed.toPSBT());
    }));
    await provider.finalizeTx(pending.txid, checkpoints);
    return pending.txid;
  };

  const refreshFunding = async (): Promise<void> => {
    const balance = await wallet.getBalance();
    available = balance.available;
    boarding = balance.boarding;
    onboardingInputCount = typeof wallet.getBoardingUtxos === "function" ? (await eligibleBoarding()).length : 0;
  };
  const eligibleBoarding = async (): Promise<ExtendedCoin[]> => {
    const estimator = new Estimator(info.fees?.intentFee ?? {});
    const used = new Set([...(live.boardingReceipts ?? []).flatMap((receipt) => receipt.selectedOutpoints.map(outpointKey)),
      ...(live.pendingBoarding?.status === "accepted" ? live.pendingBoarding.selectedOutpoints.map(outpointKey) : [])]);
    return (await wallet.getBoardingUtxos()).filter((coin) => coin.status.confirmed && coin.value > 0 &&
      !used.has(outpointKey(coin)) && estimator.evalOnchainInput({ amount: BigInt(coin.value) }).satoshis < coin.value);
  };
  const validateBoardingCommitment = (pending: NonNullable<LiveState["pendingBoarding"]>, commitmentPsbt: string): Transaction => {
    const commitment = Transaction.fromPSBT(base64.decode(commitmentPsbt));
    const inputs = transactionInputs(commitment);
    const inputKeys = new Set(inputs.map(outpointKey));
    const selected = new Set(pending.selectedOutpoints.map(outpointKey));
    if ([...selected].some((key) => !inputKeys.has(key))) throw new Error("Boarding commitment omitted a captured wallet input");
    const walletInputs = inputs.filter((input) => pending.walletOutpoints.some((point) => outpointKey(point) === outpointKey(input)));
    if (walletInputs.length !== pending.selectedOutpoints.length || walletInputs.some((input) => !selected.has(outpointKey(input)))) {
      throw new Error("Boarding commitment spends an uncaptured wallet input");
    }
    if (pending.commitmentTxid && commitment.id !== pending.commitmentTxid) throw new Error("Boarding commitment transaction ID changed");
    return commitment;
  };
  const reconcileBoarding = async (): Promise<boolean> => {
    const pending = live.pendingBoarding;
    if (!pending || !pending.expectedOutputs.length || !pending.commitmentTx) return false;
    try {
      const commitment = validateBoardingCommitment(pending, pending.commitmentTx);
      const scriptSet = new Set(pending.expectedOutputs.map(({ script }) => script.toLowerCase()));
      const coins = (await indexer.getVtxos({ scripts: [...scriptSet] })).vtxos;
      const baseline = new Set(pending.baselineVtxos.map(outpointKey));
      const received = pending.expectedOutputs.map((expected) => coins.find((coin) =>
        !baseline.has(outpointKey(coin)) && coin.commitmentTxIds?.some((txid) => txid.toLowerCase() === commitment.id.toLowerCase()) &&
        !coin.isSpent && !coin.isSwept && !coin.isUnrolled && coin.value === expected.value &&
        coin.script.toLowerCase() === expected.script.toLowerCase() && !(coin.assets?.length)));
      if (received.some((coin) => !coin)) return false;
      const spendByTxid = new Map<string, { spent: boolean; txid?: string }[]>();
      for (const point of pending.selectedOutpoints) {
        if (!spendByTxid.has(point.txid)) spendByTxid.set(point.txid, await wallet.onchainProvider.getTxOutspends(point.txid));
        const spend = spendByTxid.get(point.txid)?.[point.vout];
        if (!spend?.spent || spend.txid?.toLowerCase() !== commitment.id.toLowerCase()) return false;
      }
      pending.outputOutpoints = received.map((coin) => ({ txid: coin!.txid, vout: coin!.vout }));
      pending.commitmentTxid = commitment.id;
      pending.status = "accepted";
      pending.error = undefined;
      await refreshFunding();
      await persist();
      return true;
    } catch (error) {
      pending.error = error instanceof Error ? error.message : String(error);
      pending.status = "unknown";
      await persist();
      return false;
    }
  };
  const compactBoardingEvent = async (event: SettlementEvent): Promise<void> => {
    const pending = live.pendingBoarding;
    if (!pending || pending.status === "accepted") return;
    const record: NonNullable<LiveState["pendingBoarding"]>["events"][number] = { type: event.type, id: event.id };
    if (event.type === "batch_finalization") record.commitmentTx = event.commitmentTx;
    if (event.type === "batch_finalized") record.commitmentTxid = event.commitmentTxid;
    if (event.type === "batch_failed") record.reason = event.reason;
    pending.events.push(record);
    if (event.type === "batch_finalization") pending.commitmentTx = event.commitmentTx;
    if (event.type === "batch_finalized") pending.commitmentTxid = event.commitmentTxid;
    await persist();
    if (event.type === "batch_finalization") validateBoardingCommitment(pending, event.commitmentTx);
    if (event.type === "batch_finalized" && pending.commitmentTx) {
      const commitment = validateBoardingCommitment(pending, pending.commitmentTx);
      if (commitment.id !== event.commitmentTxid) throw new Error("Boarding finalized event does not match its commitment PSBT");
    }
    if (event.type === "batch_failed") {
      pending.status = "unknown";
      pending.error = event.reason;
      await persist();
    }
  };
  const tokenIssuance = TOKEN_SUPPLY + BigInt(saved.state.reserves.DEMO);

  const onboardFunding = async (requestId: string): Promise<BoardingResult> => {
    if (!/^[\x21-\x7e]{1,128}$/.test(requestId)) throw new Error("Boarding requires a valid API idempotency key");
    if (busy) throw new Error("Compact Mutinynet runtime is busy");
    const receipt = live.boardingReceipts?.find((candidate) => candidate.requestId === requestId || candidate.requestIds?.includes(requestId));
    if (receipt) return { status: "accepted", commitmentTxid: receipt.commitmentTxid,
      selectedOutpoints: structuredClone(receipt.selectedOutpoints), outputOutpoints: structuredClone(receipt.outputOutpoints),
      amountSats: receipt.amountSats };
    if (live.boardingReceipts?.some((candidate) => !candidate.requestId && !candidate.requestIds?.length)) {
      throw new Error("A legacy accepted boarding receipt has no API idempotency identity; refusing a new boarding request");
    }
    if (live.pendingBoarding?.status === "accepted" && (live.pendingBoarding.requestId === requestId || live.pendingBoarding.requestIds?.includes(requestId))) {
      const accepted = live.pendingBoarding;
      return { status: "accepted", commitmentTxid: accepted.commitmentTxid,
        selectedOutpoints: structuredClone(accepted.selectedOutpoints), outputOutpoints: structuredClone(accepted.outputOutpoints ?? []),
        amountSats: accepted.expectedOutputs.reduce((sum, output) => sum + output.value, 0) };
    }
    if (live.pendingBoarding?.status === "accepted" && !live.pendingBoarding.requestId && !live.pendingBoarding.requestIds?.length) {
      throw new Error("A legacy accepted boarding attempt has no API idempotency identity; refusing a new boarding request");
    }
    if (live.phase !== "funding-required") throw new Error("Boarding is available only before compact bootstrap starts");
    if (live.pendingBootstrap) throw new Error("Compact bootstrap already has an unresolved provider submission");
    if (typeof wallet.settle !== "function") throw new Error("SDK wallet settlement is unavailable for boarding");
    if (live.pendingBoarding && live.pendingBoarding.status !== "accepted") {
      const pending = live.pendingBoarding;
      if (!pending.requestId && !pending.requestIds?.length) {
        throw new Error("A legacy unresolved boarding attempt has no API idempotency identity; refusing to reconcile it as a new request");
      }
      if (pending.requestId !== requestId && !pending.requestIds?.includes(requestId)) {
        pending.requestIds ??= [];
        pending.requestIds.push(requestId);
        await persist();
      }
      await reconcileBoarding();
      await refreshFunding();
      if (pending.status === "accepted") await persist();
      return { status: pending.status === "accepted" ? "accepted" : "pending",
        commitmentTxid: pending.commitmentTxid, selectedOutpoints: structuredClone(pending.selectedOutpoints),
        outputOutpoints: structuredClone(pending.outputOutpoints), amountSats: pending.expectedOutputs[0]?.value,
        error: pending.error };
    }
    if (live.pendingBoarding?.status === "accepted") {
      const accepted = live.pendingBoarding;
      live.boardingReceipts ??= [];
      live.boardingReceipts.push({ requestId: accepted.requestId, requestIds: structuredClone(accepted.requestIds), commitmentTxid: accepted.commitmentTxid!,
        selectedOutpoints: structuredClone(accepted.selectedOutpoints), outputOutpoints: structuredClone(accepted.outputOutpoints ?? []),
        amountSats: accepted.expectedOutputs.reduce((sum, output) => sum + output.value, 0), startedAt: accepted.startedAt });
      live.pendingBoarding = undefined;
      await persist();
      await refreshFunding();
    }
    busy = true;
    try {
      const allCoins = await wallet.getBoardingUtxos();
      const estimator = new Estimator(info.fees?.intentFee ?? {});
      const used = new Set((live.boardingReceipts ?? []).flatMap((receipt) => receipt.selectedOutpoints.map(outpointKey)));
      const selected = allCoins.filter((coin) => coin.status.confirmed && coin.value > 0 && !used.has(outpointKey(coin)) &&
        estimator.evalOnchainInput({ amount: BigInt(coin.value) }).satoshis < coin.value);
      if (!selected.length) throw new Error("No confirmed fee-eligible Mutinynet boarding inputs are available");
      const selectedOutpoints = selected.map(({ txid, vout }) => ({ txid, vout }));
      const baselineVtxos = (await wallet.getVtxos()).map(({ txid, vout }) => ({ txid, vout }));
      live.pendingBoarding = { status: "submitting", requestId, selectedOutpoints,
        selectedValues: selected.map(({ txid, vout, value }) => ({ txid, vout, value })),
        walletOutpoints: allCoins.map(({ txid, vout }) => ({ txid, vout })), expectedOutputs: [],
        inputSats: selected.reduce((sum, coin) => sum + coin.value, 0),
        baselineVtxos, startedAt: Date.now(), events: [] };
      await persist();
      const pending = live.pendingBoarding;
      try {
        const commitmentTxid = await new Ramps(wallet).onboard(info.fees, selected);
        pending.commitmentTxid ??= commitmentTxid;
        pending.status = "unknown";
        await persist();
        await reconcileBoarding();
      } catch (error) {
        pending.status = "unknown";
        pending.error = error instanceof Error ? error.message : String(error);
        await persist();
      }
      await refreshFunding();
      const outputAmount = pending.expectedOutputs[0]?.value;
      return { status: live.pendingBoarding?.status === "accepted" ? "accepted" : "pending",
        commitmentTxid: pending.commitmentTxid, selectedOutpoints: structuredClone(pending.selectedOutpoints),
        outputOutpoints: structuredClone(pending.outputOutpoints), amountSats: outputAmount, error: pending.error };
    } finally { busy = false; }
  };

  const recordIssue = async (name: IssueName, txid: string): Promise<void> => {
    const { txs } = await indexer.getVirtualTxs([txid]);
    const raw = transactionFromIndexerPsbt(txs, txid);
    if (!raw) throw new Error(`Issued ${name} ancestry is not indexed; retry bootstrap without reissuing`);
    const packet = Extension.fromTx(raw).getAssetPacket();
    const issuedAmount = name === "token" ? tokenIssuance : 1n;
    const group = packet?.groups[0];
    if (!packet || packet.groups.length !== 1 || !group || group.assetId !== null || group.controlAsset !== null ||
        group.inputs.length !== 0 || asset.AssetId.create(raw.id, 0).toString() !== expectedIdentity(raw) ||
        group.outputs.length !== 1 || group.outputs[0].vout !== 0 || group.outputs[0].amount !== issuedAmount) {
      throw new Error(`Issued ${name} identity ancestry is invalid`);
    }
    const issuanceVtxos = (await indexer.getVtxos({ outpoints: [{ txid: raw.id, vout: 0 }] })).vtxos;
    if (!issuanceVtxos.some((coin) => coin.txid === raw.id && coin.vout === 0 && !coin.isSpent && !coin.isSwept && !coin.isUnrolled)) {
      throw new Error(`Issued ${name} output is not accepted by the Mutinynet indexer`);
    }
    const identity = expectedIdentity(raw);
    if (live.issued[name] && live.issued[name] !== identity) throw new Error(`Issued ${name} identity changed during recovery`);
    live.issued[name] = identity;
    live.issuanceTransactions![name] = hex.encode(raw.toBytes());
    saved.identities[name] = identity;
    saved.issuanceRaw = hex.encode(raw.toBytes());
    live.pendingBootstrap = undefined;
    await persist();
  };

  const makeProfile = async (): Promise<void> => {
    const identities = live.issued;
    if (ISSUE_NAMES.some((name) => !identities[name])) throw new Error("Cannot register compact verifier before all actual assets are issued");
    const aliceKey = await SingleKey.fromHex(saved.aliceSecret).xOnlyPublicKey();
    const bobKey = await SingleKey.fromHex(saved.bobSecret).xOnlyPublicKey();
    const [alice, bob] = [aliceKey, bobKey].map((ownerKey) => createCompactDestination(serverIdentity, ownerKey, exitTimelock));
    const destinations = {
      alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field },
      bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field },
    };
    const config: CompactProfileConfig = {
      relationVersion: "ark-shield-poc-v1", domain: saved.domain,
      verificationKeys: options.verificationKeys as CompactProfileConfig["verificationKeys"],
      serverKey, emulatorKey, checkpointScript: info.checkpointTapscript,
      exitTimelock: { type: exitTimelock.type, value: exitTimelock.value.toString() },
      identities: identities as CompactProfileConfig["identities"], destinations,
    };
    const registered = await createCompactProfile(config);
    if (saved.compact && saved.compact.profileId !== registered.profile.profileId) throw new Error("Registered compact profile changed; refusing to alter funded resources");
    profile = registered.profile;
    closure = registered.closure;
    saved.serverKey = serverKey;
    saved.emulatorKey = emulatorKey;
    saved.checkpointScript = info.checkpointTapscript;
    saved.identities = { ...identities };
    saved.compact = { version: 1, profileId: profile.profileId, sidecars: structuredClone(saved.compact?.sidecars ?? {}) };
    live.phase = "profile-registration";
    await persist();
  };

  const validateProgramFunding = async (name: typeof RESOURCE_NAMES[number], txid: string): Promise<Transaction> => {
    const { txs } = await indexer.getVirtualTxs([txid]);
    const tx = transactionFromIndexerPsbt(txs, txid);
    if (!tx) throw new Error("Program funding ancestry is not indexed; retry without resending");
    if (!profile || !closure) throw new Error("Compact profile was not registered before program funding");
    const vout = 0;
    const expectedAmount = name === "gate" ? GATE_FUNDING : name === "btcVault"
      ? CARRIER + BigInt(saved.state.reserves.BTC) : CARRIER;
    const output = tx.getOutput(vout);
    if (!output?.script || !Buffer.from(output.script).equals(Buffer.from(closure.pkScript)) || output.amount !== expectedAmount) {
      throw new Error(`Program funding changed profile-bound ${name} output`);
    }
    const packet = Extension.fromTx(tx).getAssetPacket();
    if (!packet) throw new Error("Program funding omitted native asset identities");
    const expected = new Map<string, { vout: number; amount: bigint }[]>(name === "gate"
      ? [[live.issued.token!, [{ vout, amount: TOKEN_SUPPLY }]]]
      : name === "lane" ? [[live.issued.lane!, [{ vout, amount: 1n }]]]
      : name === "btcVault" ? [[live.issued.btcVault!, [{ vout, amount: 1n }]]]
      : [[live.issued.tokenVault!, [{ vout, amount: 1n }]],
        ...(BigInt(saved.state.reserves.DEMO) ? [[live.issued.token!, [{ vout, amount: BigInt(saved.state.reserves.DEMO) }]] as [string, { vout: number; amount: bigint }[]]] : [])]);
    const actual = packet.groups.map((group, index) => ({
      id: (group.assetId ?? asset.AssetId.create(tx.id, index)).toString(),
      outputs: group.outputs.map(({ vout, amount }) => ({ vout, amount })),
    }));
    if (actual.length !== expected.size || actual.some(({ id, outputs }) => {
      const wanted = expected.get(id);
      return !wanted || JSON.stringify(outputs.map((entry) => [entry.vout, entry.amount.toString()])) !==
        JSON.stringify(wanted.map((entry) => [entry.vout, entry.amount.toString()]));
    })) throw new Error("Program funding native asset outputs do not match the registered identities");
    const indexedHeads = (await indexer.getVtxos({ outpoints: [{ txid: tx.id, vout }] })).vtxos;
    if (!indexedHeads.some((coin) => coin.txid === tx.id && coin.vout === vout && !coin.isSpent && !coin.isSwept &&
        !coin.isUnrolled && coin.value === Number(expectedAmount) && coin.script === hex.encode(closure!.pkScript))) {
      throw new Error(`Profile-bound ${name} resource is not an accepted unspent VTXO`);
    }
    return tx;
  };

  const validateSavedProgramHead = async (name: typeof RESOURCE_NAMES[number]): Promise<void> => {
    const head = saved.heads[name];
    if (!head) return;
    const source = Transaction.fromRaw(hex.decode(head.sourceTx));
    const output = source.getOutput(head.vout);
    if (source.id !== head.txid || head.vout !== 0 || !output || head.value !== Number(output.amount) ||
        !Buffer.from(output.script!).equals(Buffer.from(closure?.pkScript ?? []))) throw new Error(`Saved ${name} head has invalid source ancestry`);
    await validateProgramFunding(name, head.txid);
  };

  const createCore = async (): Promise<void> => {
    if (!profile) await makeProfile();
    if (live.phase !== "ready") return;
    core = await createCompactRuntime({ ...compactOptions, checkpoint: { ...saved, live }, initialState: saved.state,
      network: "mutinynet", compactProfile: profile!, emulatorIdentity,
      weightLimit: operatorLimit === undefined || operatorLimit > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : operatorLimit,
      execute: executeCompact, recoverSubmission,
      onSubmission: async (prepared, submission) => {
        activeSubmission = submission;
        await options.onSubmission?.(prepared, submission);
      },
      onCheckpoint: async (checkpoint) => { saved = { ...checkpoint, live: structuredClone(live) }; await options.onCheckpoint!(saved); },
    });
  };

  const executeCompact = async (request: VmBridgeRequest): Promise<NativeVmResult> => {
    if (!profile || !activeSubmission || activeSubmission.txid !== Transaction.fromPSBT(base64.decode(request.arkTx)).id) {
      throw new Error("Compact live submission has no matching durable proof journal");
    }
    const submitted = Transaction.fromPSBT(base64.decode(request.arkTx));
    const sidecar = activeSubmission.compactSidecar as CompactSidecar | undefined;
    if (!sidecar) throw new Error("Compact live submission omitted its Groth16 proof sidecar");
    const unsigned = Transaction.fromPSBT(base64.decode(activeSubmission.request.arkTx));
    sameBody(submitted, unsigned);
    await verifyCompactUnsignedSubmission(profile.profileId, sidecar, unsigned,
      activeSubmission.request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry))), nativeState(saved, profile.profileId));
    for (let vin = 0; vin < submitted.inputsLength; vin++) {
      const leaf = submitted.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error(`Compact input ${vin} lost its registered profile leaf`);
      verifyTapscriptSignatures(submitted, vin, [emulatorKey], undefined, undefined, tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    ensureWeight(submitted, operatorLimit);
    const started = performance.now();
    const response = await originalSubmit(request.arkTx, request.checkpoints);
    const result: NativeVmResult = { ok: true, arkTx: response.finalArkTx, checkpoints: response.signedCheckpointTxs,
      txid: response.arkTxid, executedInputs: submitted.inputsLength, signatureCount: submitted.inputsLength * 2,
      durationMs: performance.now() - started, backend: "mutinynet-arkade-registered-compact" };
    const verified = verifyCompactResponse(request, result, serverKey, emulatorKey);
    ensureWeight(verified.arkTx, operatorLimit);
    result.arkTx = base64.encode(verified.arkTx.toPSBT());
    result.checkpoints = verified.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT()));
    live.pendingSettlement = { txid: verified.arkTx.id, result };
    await persist();
    await finalizeSettlement(request, verified.checkpoints, verified.arkTx.id);
    return result;
  };

  const finalizeSettlement = async (request: VmBridgeRequest, checkpoints: readonly Transaction[], txid: string): Promise<void> => {
    if (checkpoints.length !== request.checkpoints.length) throw new Error("Compact finalization checkpoint count changed");
    const final = checkpoints.map((checkpoint, index) => {
      const expected = Transaction.fromPSBT(base64.decode(request.checkpoints[index]));
      sameBody(checkpoint, expected);
      for (let vin = 0; vin < checkpoint.inputsLength; vin++) {
        const leaf = expected.getInput(vin).tapLeafScript?.[0];
        const returnedLeaf = checkpoint.getInput(vin).tapLeafScript?.[0];
        if (!leaf || !returnedLeaf || !Buffer.from(leaf[1]).equals(Buffer.from(returnedLeaf[1])) ||
            !Buffer.from(TaprootControlBlock.encode(leaf[0])).equals(Buffer.from(TaprootControlBlock.encode(returnedLeaf[0])))) {
          throw new Error("Compact finalization changed the submitted checkpoint tapleaf");
        }
        const script = leaf[1].subarray(0, -1);
        const keys = ConditionMultisigTapscript.isScriptValid(script) === true
          ? ConditionMultisigTapscript.decode(script).params.pubkeys
          : ConditionCSVMultisigTapscript.isScriptValid(script) === true
            ? ConditionCSVMultisigTapscript.decode(script).params.pubkeys
            : (() => { try { return CSVMultisigTapscript.decode(script).params.pubkeys; } catch { return MultisigTapscript.decode(script).params.pubkeys; } })();
        const pinned = keys.map(hex.encode);
        if (pinned.length !== 2 || !pinned.includes(serverKey) || !pinned.includes(emulatorKey)) {
          throw new Error("Compact checkpoint does not contain exactly the pinned server and emulator keys");
        }
        const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
        verifyTapscriptSignatures(checkpoint, vin, [emulatorKey], undefined, undefined, leafHash);
        verifyTapscriptSignatures(checkpoint, vin, [serverKey], undefined, undefined, leafHash);
      }
      return base64.encode(checkpoint.toPSBT());
    });
    await provider.finalizeTx(txid, final);
  };

  const signCheckpoint = async (checkpoint: Transaction): Promise<Transaction> => {
    const signed = await walletIdentity.sign(checkpoint, [0]);
    const leaf = checkpoint.getInput(0).tapLeafScript?.[0];
    if (!leaf) throw new Error("Checkpoint is missing its submitted spend leaf");
    const script = leaf[1].subarray(0, -1);
    const keys = bootstrapSignerKeys(script);
    verifyTapscriptSignatures(signed, 0, keys, undefined, undefined, tapLeafHash(script, leaf[1].at(-1)!));
    return signed;
  };

  const recoverSubmission = async (submission: NativeSubmission): Promise<NativeVmResult | undefined> => {
    const pending = live.pendingSettlement;
    if (pending?.txid === submission.txid) {
      const verified = verifyCompactResponse(submission.request, pending.result, serverKey, emulatorKey);
      await finalizeSettlement(submission.request, verified.checkpoints, submission.txid);
      return pending.result;
    }
    const accepted = await queryAccepted(submission.request);
    if (!accepted) return undefined;
    const expected = Transaction.fromPSBT(base64.decode(submission.request.arkTx));
    const indexed = restoreSignedPsbt(accepted, expected);
    const requestedCheckpoints = submission.request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
    const indexedCheckpoints = await indexer.getVirtualTxs(requestedCheckpoints.map((entry) => entry.id));
    const checkpoints = requestedCheckpoints.map((requested) => {
      const found = transactionFromIndexerPsbt(indexedCheckpoints.txs, requested.id);
      if (!found) throw new Error("Accepted compact transaction is missing indexed checkpoint ancestry");
      return base64.encode(restoreSignedPsbt(found, requested).toPSBT());
    });
    const result: NativeVmResult = { ok: true, arkTx: base64.encode(indexed.toPSBT()), checkpoints,
      txid: indexed.id, executedInputs: indexed.inputsLength, signatureCount: 0, durationMs: 0, backend: "mutinynet-indexer-reconciled" };
    verifyCompactResponse(submission.request, result, serverKey, emulatorKey);
    return result;
  };

  try {
    saved.live = live;
    saved.serverKey = serverKey;
    saved.emulatorKey = emulatorKey;
    saved.checkpointScript = info.checkpointTapscript;
    if (!restored) await persist();
    wallet = await Wallet.create({ identity: walletIdentity, arkProvider: provider, indexerProvider: indexer,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() }, walletMode: "static" });
    fundingAddress = await wallet.getAddress();
    boardingAddress = await wallet.getBoardingAddress();
    const originalSettle = typeof wallet.settle === "function" ? wallet.settle.bind(wallet) : undefined;
    if (originalSettle) wallet.settle = async (params, eventCallback) => {
      const pending = live.pendingBoarding;
      if (!pending || pending.status !== "submitting") return originalSettle(params, eventCallback);
      const inputs = params?.inputs ?? [];
      const actual = inputs.map(({ txid, vout }) => ({ txid, vout }));
      const expected = new Set(pending.selectedOutpoints.map(outpointKey));
      const selectedValues = new Map(pending.selectedValues.map((input) => [outpointKey(input), input.value]));
      if (actual.length !== expected.size || actual.some((point, index) => isVirtualCoin(inputs[index]) ||
          !expected.has(outpointKey(point)) || inputs[index].value !== selectedValues.get(outpointKey(point)))) {
        pending.status = "unknown";
        pending.error = "SDK boarding settlement included an uncaptured or wallet-owned VTXO input";
        await persist();
        throw new Error(pending.error);
      }
      const ownOutputs = (params?.outputs ?? []).filter((output) => output.address === fundingAddress);
      const estimator = new Estimator(info.fees?.intentFee ?? {});
      const netInput = pending.selectedValues.reduce((sum, input) => sum + BigInt(input.value) -
        BigInt(estimator.evalOnchainInput({ amount: BigInt(input.value) }).satoshis), 0n);
      const outputFee = estimator.evalOffchainOutput({ amount: netInput, script: hex.encode(ArkAddress.decode(fundingAddress).pkScript) }).satoshis;
      const expectedAmount = netInput - BigInt(outputFee);
      if ((params?.outputs ?? []).length !== 1 || ownOutputs.length !== 1 || ownOutputs[0].amount !== expectedAmount ||
          ownOutputs[0].amount <= 0n || ownOutputs[0].amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        pending.status = "unknown";
        pending.error = "SDK boarding settlement did not produce exactly one durable wallet Ark output";
        await persist();
        throw new Error(pending.error);
      }
      pending.expectedOutputs = ownOutputs.map((output) => ({
        script: hex.encode(ArkAddress.decode(output.address).pkScript), value: Number(output.amount),
      }));
      await persist();
      let callbackError: unknown;
      let eventQueue = Promise.resolve();
      const guardedCallback = (event: SettlementEvent): void => {
        eventQueue = eventQueue.then(() => compactBoardingEvent(event)).catch((error: unknown) => { callbackError ??= error; });
      };
      try {
        let commitmentTxid: string | undefined;
        let settlementError: unknown;
        try { commitmentTxid = await originalSettle(params, guardedCallback); }
        catch (error) { settlementError = error; }
        await eventQueue;
        if (callbackError) throw callbackError;
        if (settlementError) throw settlementError;
        if (!commitmentTxid) throw new Error("SDK boarding settlement returned no commitment transaction ID");
        pending.commitmentTxid ??= commitmentTxid;
        pending.status = "unknown";
        await persist();
        return commitmentTxid;
      } catch (error) {
        pending.status = "unknown";
        pending.error = error instanceof Error ? error.message : String(error);
        await persist();
        throw error;
      }
    };
    await refreshFunding();
    if (saved.compact) {
      const alice = createCompactDestination(serverIdentity, await SingleKey.fromHex(saved.aliceSecret).xOnlyPublicKey(), exitTimelock);
      const bob = createCompactDestination(serverIdentity, await SingleKey.fromHex(saved.bobSecret).xOnlyPublicKey(), exitTimelock);
      const registered = await createCompactProfile({
        relationVersion: "ark-shield-poc-v1", domain: saved.domain,
        verificationKeys: options.verificationKeys as CompactProfileConfig["verificationKeys"],
        serverKey, emulatorKey, checkpointScript: info.checkpointTapscript,
        exitTimelock: { type: exitTimelock.type, value: exitTimelock.value.toString() },
        identities: live.issued as CompactProfileConfig["identities"],
        destinations: { alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field },
          bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field } },
      });
      if (saved.compact.profileId !== registered.profile.profileId) throw new Error("Registered compact profile changed; refusing to restore live assets");
      profile = registered.profile;
      closure = registered.closure;
    }
    if (live.phase === "ready") {
      if (!saved.compact || !saved.genesisRaw || RESOURCE_NAMES.some((name) => !saved.heads[name])) throw new Error("Ready compact Mutinynet checkpoint lacks accepted program ancestry");
      await createCore();
    }

    const bootstrap = async (): Promise<void> => {
      if (busy) throw new Error("Compact Mutinynet bootstrap is already running");
      if (live.phase === "ready") return;
      busy = true;
      try {
        if (live.pendingBoarding && live.pendingBoarding.status !== "accepted" && !await reconcileBoarding()) {
          throw new Error("Compact boarding outcome is unresolved; bootstrap is paused without retrying the round");
        }
        await refreshFunding();
        const missingResources = RESOURCE_NAMES.filter((name) => !saved.heads[name]);
        const remainingRequired = requiredResourceFunds(missingResources, BigInt(saved.state.reserves.BTC));
        if (!live.pendingBootstrap && available < remainingRequired) {
          throw new Error(`Funding required: send at least ${remainingRequired} test sats to ${fundingAddress}`);
        }
        for (const name of RESOURCE_NAMES) await validateSavedProgramHead(name);
        if (live.phase === "funding-required" || live.phase === "issuing") {
          live.phase = "issuing";
          await persist();
        }
        for (const name of ISSUE_NAMES) {
          if (live.issued[name]) continue;
          step = `issue:${name}`;
          if (live.pendingBootstrap && live.pendingBootstrap.step !== step) throw new Error("Saved compact bootstrap request does not match the next asset identity");
          const resumed = await finalizeBootstrap();
          const result = resumed ? { arkTxId: resumed } : await wallet.assetManager.issue({ amount: name === "token" ? tokenIssuance : 1n,
            metadata: { name: `Shielded PoC ${name}`, ticker: name === "token" ? "DEMO" : `SH-${name}` } });
          await recordIssue(name, result.arkTxId);
        }
        if (!profile || !saved.compact) await makeProfile();
        if (!profile || !closure || !saved.compact) throw new Error("Compact verifier profile was not durably registered before program funding");
        if (live.phase !== "funding-programs") {
          live.phase = "funding-programs";
          await persist();
        }
        for (const name of RESOURCE_NAMES) {
          if (saved.heads[name]) continue;
          step = `fund:${name}`;
          if (live.pendingBootstrap && live.pendingBootstrap.step !== step) {
            throw new Error("Saved compact resource funding request does not match the next missing head");
          }
          const resumed = await finalizeBootstrap();
          let txid: string;
          if (resumed) txid = resumed;
          else {
            const assets = name === "gate" ? [{ assetId: live.issued.token!, amount: TOKEN_SUPPLY }]
              : name === "lane" ? [{ assetId: live.issued.lane!, amount: 1n }]
              : name === "btcVault" ? [{ assetId: live.issued.btcVault!, amount: 1n }]
              : [{ assetId: live.issued.tokenVault!, amount: 1n }, ...(BigInt(saved.state.reserves.DEMO)
                ? [{ assetId: live.issued.token!, amount: BigInt(saved.state.reserves.DEMO) }] : [])];
            const amount = Number(resourceSats(name, BigInt(saved.state.reserves.BTC)));
            const address = new ArkAddress(serverIdentity, closure.pkScript.subarray(2), "tark").encode();
            txid = await wallet.send({ recipients: [{ address, amount, assets, tapTree: closure.tapTree } as Recipient] });
          }
          const resourceTx = await validateProgramFunding(name, txid);
          const sourceTx = hex.encode(resourceTx.toBytes());
          saved.heads[name] = { ...coinFromTransaction(resourceTx, 0), sourceTx };
          if (name === "gate") {
            saved.genesisRaw = sourceTx;
            saved.funding = { BTC: GATE_FUNDING.toString(), DEMO: TOKEN_SUPPLY.toString() };
          }
          live.pendingBootstrap = undefined;
          await persist();
        }
        if (RESOURCE_NAMES.some((name) => !saved.heads[name])) throw new Error("Compact program funding did not produce all resource heads");
        saved.issuanceRaw = live.issuanceTransactions!.token!;
        live.phase = "ready";
        await persist();
        await createCore();
      } finally { busy = false; step = undefined; }
    };

    const onboardAvailable = (): boolean => live.phase === "funding-required" && !busy && !live.pendingBootstrap &&
      (Boolean(live.pendingBoarding && live.pendingBoarding.status !== "accepted") || onboardingInputCount > 0);
    const snapshot = (): Record<string, unknown> => {
      const active = core?.snapshot() ?? {};
      const pendingBoarding = live.pendingBoarding;
      const boardingStatus = pendingBoarding ? {
        status: pendingBoarding.status, startedAt: pendingBoarding.startedAt,
        selectedOutpoints: structuredClone(pendingBoarding.selectedOutpoints), commitmentTxid: pendingBoarding.commitmentTxid,
        inputSats: pendingBoarding.inputSats, amountSats: pendingBoarding.expectedOutputs[0]?.value,
        outputOutpoints: structuredClone(pendingBoarding.outputOutpoints), error: pendingBoarding.error,
      } : undefined;
      return { ...active, mode: "compact-offchain", network: "mutinynet", profileId: profile?.profileId,
        bootstrapPhase: live.phase, phase: live.phase, ready: live.phase === "ready" && Boolean(core), compatible: true,
        syntheticFunding: false, supportsBoarding: true, onboardAvailable: onboardAvailable(),
        funding: { arkAddress: fundingAddress, boardingAddress, availableSats: available,
          requiredSats: requiredResourceFunds(RESOURCE_NAMES.filter((name) => !saved.heads[name]), BigInt(saved.state.reserves.BTC)), boarding,
          onboarding: boardingStatus },
        operator: { arkUrl, signerPubkey: info.signerPubkey, emulatorPubkey: emulatorKey,
          maxTxWeight: operatorLimit?.toString(), effectiveMaxTxWeight: (operatorLimit === undefined || operatorLimit > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : operatorLimit).toString(),
          exitTimelock: { type: "seconds", value: delay.toString() } } };
    };
    return {
      exportState, bootstrap, refreshFunding, onboardFunding,
      destination: (owner) => core?.destination(owner) ?? profile?.destinations[owner]?.scriptPubKey.slice(4) ?? "",
      compiledArtifacts: () => core?.compiledArtifacts() ?? (profile ? { compactProfile: { profileId: profile.profileId, validatorHash: profile.validatorHash, profile } } : {}),
      snapshot,
      settle: async (prepared) => {
        if (!core) throw new Error("Mutinynet compact pool has not been bootstrapped");
        const receipt = await core.settle(prepared);
        live.pendingSettlement = undefined;
        activeSubmission = undefined;
        // The engine owns the accepted-phase checkpoint. Persisting here would
        // pair the advanced native heads with the pre-acceptance protocol state.
        return receipt;
      },
      reconcile: async (prepared, submission) => {
        if (!core) return undefined;
        const receipt = await core.reconcile(prepared, submission);
        if (receipt) { live.pendingSettlement = undefined; activeSubmission = undefined; }
        return receipt;
      },
      close: async () => { await core?.close(); await wallet?.dispose(); },
    };
  } catch (error) {
    await core?.close();
    await wallet?.dispose();
    throw error;
  }
}
