import { base64, hex } from "@scure/base";
import {
  ConditionCSVMultisigTapscript, ConditionMultisigTapscript, CSVMultisigTapscript,
  Extension, MultisigTapscript, RestArkProvider, RestIndexerProvider, SingleKey, Transaction,
  asset, verifyTapscriptSignatures,
} from "@arkade-os/sdk";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { createCompactDestination, createCompactRuntime } from "./runtime.ts";
import { createCompactClosure } from "./adapter.ts";
import { registerCompactProfile, type CompactProfileConfig } from "./profile.ts";
import { verifyCompactUnsignedSubmission } from "./verifier.ts";
import { signCompactEmulator, verifyCompactResponse } from "./signer.ts";
import type { NativeCheckpoint, NativeSubmission, NativeVmResult, SdkRuntime, SdkRuntimeOptions } from "../sdk/runtime.ts";
import type { VmBridgeRequest } from "../sdk/adapter.ts";

const DEFAULT_ARK_URL = "https://mutinynet.arkade.sh";
const EXIT_SECONDS = 2048n;
const HARD_WEIGHT_LIMIT = 4_000n;
const RESOURCES = ["gate", "lane", "btcVault", "tokenVault"] as const;
type Resource = typeof RESOURCES[number];
type JournalStage = "prepared" | "submit-attempted" | "response-stored" | "finalize-attempted";
type ReadyJournal = { txid: string; request: VmBridgeRequest; networkRequest?: VmBridgeRequest; stage: JournalStage; result?: NativeVmResult };
type ReadyLive = Omit<NonNullable<NativeCheckpoint["live"]>, "pendingSettlement"> & {
  pendingSettlement?: { txid: string; result: NativeVmResult }; readySettlement?: ReadyJournal; bootstrapRecovery?: BootstrapRecovery;
};
type ReadyCheckpoint = Omit<NativeCheckpoint, "live"> & { live: ReadyLive;
  compact: NonNullable<NativeCheckpoint["compact"]> & { profileId: string } };
type BootstrapRecovery = { version: 1; profileId: string; heads: Partial<Record<Resource,
  { request: VmBridgeRequest; response: { arkTxid: string }; finalizedCheckpointTxs: string[] }>> };

function sameBody(actual: Transaction, expected: Transaction): void {
  if (actual.id !== expected.id || !Buffer.from(actual.unsignedTx).equals(Buffer.from(expected.unsignedTx))) {
    throw new Error("Arkade changed the submitted transaction body");
  }
}
function signerKeys(script: Uint8Array): Uint8Array[] {
  if (ConditionMultisigTapscript.isScriptValid(script) === true) return ConditionMultisigTapscript.decode(script).params.pubkeys;
  if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) return ConditionCSVMultisigTapscript.decode(script).params.pubkeys;
  try { return CSVMultisigTapscript.decode(script).params.pubkeys; }
  catch { return MultisigTapscript.decode(script).params.pubkeys; }
}
function signedWeight(tx: Transaction): number {
  const estimated = Transaction.fromPSBT(tx.toPSBT());
  for (let vin = 0; vin < estimated.inputsLength; vin++) {
    const leaf = estimated.getInput(vin).tapLeafScript?.[0];
    if (!leaf) throw new Error(`Cannot estimate signed weight without input ${vin} spend leaf`);
    if (estimated.getInput(vin).finalScriptWitness) continue;
    const script = leaf[1].subarray(0, -1), keys = signerKeys(script);
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    const signatures = keys.map((pubKey) => (estimated.getInput(vin).tapScriptSig ?? []).find(([key]) =>
      Buffer.from(key.pubKey).equals(Buffer.from(pubKey)) && Buffer.from(key.leafHash).equals(Buffer.from(leafHash)))?.[1]);
    const complete = signatures.every(Boolean);
    estimated.updateInput(vin, { finalScriptWitness: [...signatures.slice().reverse().map((sig) => sig ?? new Uint8Array(complete ? 64 : 65)),
      script, TaprootControlBlock.encode(leaf[0])] });
  }
  const base = estimated.toBytes(false, false).length;
  return estimated.toBytes(true, true).length + 3 * base;
}
function effectiveLimit(operatorLimit?: bigint): bigint {
  if (operatorLimit !== undefined && operatorLimit <= 0n) throw new Error("Mutinynet operator reported an invalid transaction weight limit");
  return operatorLimit === undefined || operatorLimit > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : operatorLimit;
}
function assertWeight(tx: Transaction, limit: bigint): void {
  const weight = BigInt(signedWeight(tx));
  if (weight > limit) throw new Error(`Mutinynet transaction requires ${weight} WU; effective limit is ${limit} WU`);
}
function restoreIndexedPsbt(indexed: Transaction, submitted: Transaction): Transaction {
  sameBody(indexed, submitted);
  for (let vin = 0; vin < indexed.inputsLength; vin++) {
    const witness = indexed.getInput(vin).finalScriptWitness;
    const leaf = submitted.getInput(vin).tapLeafScript?.[0];
    if (!witness || !leaf || witness.length < 3 ||
        !Buffer.from(witness.at(-2)!).equals(Buffer.from(leaf[1].subarray(0, -1))) ||
        !Buffer.from(witness.at(-1)!).equals(Buffer.from(TaprootControlBlock.encode(leaf[0])))) {
      throw new Error("Indexed transaction does not contain the exact submitted profile witness");
    }
    const script = leaf[1].subarray(0, -1), keys = signerKeys(script), leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    submitted.updateInput(vin, { tapScriptSig: keys.map((pubKey, index) => [{ pubKey, leafHash }, witness[keys.length - index - 1]]) });
  }
  return submitted;
}
function txFromIndexer(raws: readonly string[], txid: string): Transaction | undefined {
  return raws.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id.toLowerCase() === txid.toLowerCase());
}
function outpoint(txid: string, vout: number): string { return `${txid.toLowerCase()}:${vout}`; }
export function assertReadyCheckpoint(raw: NativeCheckpoint | undefined): asserts raw is ReadyCheckpoint {
  const checkpoint = raw as ReadyCheckpoint | undefined;
  if (!checkpoint || checkpoint.network !== "mutinynet" || checkpoint.live?.phase !== "ready" || !checkpoint.compact?.profileId) {
    throw new Error("Compact ready transport requires a durably registered ready Mutinynet checkpoint");
  }
  if (checkpoint.live.pendingBootstrap || checkpoint.live.pendingBoarding) {
    throw new Error("Ready compact checkpoint has an unresolved bootstrap or boarding journal");
  }
  if (!checkpoint.live.seedHex || !checkpoint.live.compactEmulatorSecret || checkpoint.live.emulatorUrl !== "inprocess://compact-verifier") {
    throw new Error("Encrypted compact pool signing identity is incomplete");
  }
  if (!checkpoint.genesisRaw || !checkpoint.issuanceRaw || RESOURCES.some((name) => !checkpoint.heads[name])) {
    throw new Error("Ready compact checkpoint lacks all four funded resource heads");
  }
  const recovery = checkpoint.live.bootstrapRecovery as BootstrapRecovery | undefined;
  if (!recovery || recovery.version !== 1 || recovery.profileId !== checkpoint.compact.profileId ||
      RESOURCES.some((name) => {
        const entry = recovery.heads[name];
        if (!entry || entry.response.arkTxid.toLowerCase() !== Transaction.fromPSBT(base64.decode(entry.request.arkTx)).id.toLowerCase() ||
            entry.finalizedCheckpointTxs.length !== entry.request.checkpoints.length) return true;
        return false;
      })) {
    throw new Error("Ready compact checkpoint lacks identified accepted bootstrap receipts for all resource heads");
  }
  const pending = checkpoint.live.readySettlement;
  const legacy = checkpoint.live.pendingSettlement;
  if (legacy) throw new Error("Legacy compact settlement journal has no exact ready-transport request; refusing recovery");
  if (pending && (!pending.txid || !pending.request || !["prepared", "submit-attempted", "response-stored", "finalize-attempted"].includes(pending.stage))) {
    throw new Error("Legacy compact settlement journal lacks an identified request stage; refusing recovery");
  }
}

function assertEmulatorSignedRequest(unsigned: VmBridgeRequest, signed: VmBridgeRequest, emulatorKey: string): void {
  if (unsigned.checkpoints.length !== signed.checkpoints.length) throw new Error("Emulator changed compact checkpoint count");
  for (const [index, [signedPsbt, expectedPsbt]] of [[signed.arkTx, unsigned.arkTx], ...signed.checkpoints.map((value, i) => [value, unsigned.checkpoints[i]!] as [string, string])].entries()) {
    const actual = Transaction.fromPSBT(base64.decode(signedPsbt));
    const expected = Transaction.fromPSBT(base64.decode(expectedPsbt));
    sameBody(actual, expected);
    if (actual.inputsLength !== expected.inputsLength) throw new Error("Emulator changed compact transaction inputs");
    for (let vin = 0; vin < actual.inputsLength; vin++) {
      const a = actual.getInput(vin), e = expected.getInput(vin), leaf = e.tapLeafScript?.[0], actualLeaf = a.tapLeafScript?.[0];
      if (!leaf || !actualLeaf || a.witnessUtxo?.amount !== e.witnessUtxo?.amount ||
          !a.witnessUtxo?.script || !e.witnessUtxo?.script || !Buffer.from(a.witnessUtxo.script).equals(Buffer.from(e.witnessUtxo.script)) ||
          !Buffer.from(leaf[1]).equals(Buffer.from(actualLeaf[1])) ||
          !Buffer.from(TaprootControlBlock.encode(leaf[0])).equals(Buffer.from(TaprootControlBlock.encode(actualLeaf[0])))) {
        throw new Error("Emulator changed compact prevout or registered spend leaf");
      }
      const script = leaf[1].subarray(0, -1), leafHash = tapLeafHash(script, leaf[1].at(-1)!);
      const signatures = a.tapScriptSig ?? [];
      if (signatures.some(([key]) => hex.encode(key.pubKey) !== emulatorKey)) throw new Error("Compact submission contains a signer other than the pinned emulator");
      verifyTapscriptSignatures(actual, vin, [emulatorKey], undefined, undefined, leafHash);
    }
  }
}

export function readyRecoveryAction(stage: JournalStage): "resume-submit" | "reconcile-submit" | "finalize-response" | "reconcile-finalization" {
  if (stage === "prepared") return "resume-submit";
  if (stage === "submit-attempted") return "reconcile-submit";
  if (stage === "response-stored") return "finalize-response";
  return "reconcile-finalization";
}
function requestEqual(a: VmBridgeRequest, b: VmBridgeRequest): boolean {
  return a.arkTx === b.arkTx && a.checkpoints.length === b.checkpoints.length && a.checkpoints.every((item, i) => item === b.checkpoints[i]);
}

/** Restores an already-funded pool. This adapter has no bootstrap or boarding surface. */
export async function createCompactReadyLiveRuntime(options: SdkRuntimeOptions): Promise<SdkRuntime> {
  if (!options.onCheckpoint) throw new Error("Mutinynet compact mode requires encrypted durable storage before restore");
  if ((options.network ?? options.checkpoint?.network) !== "mutinynet") throw new Error("Ready compact adapter only supports Mutinynet");
  assertReadyCheckpoint(options.checkpoint);
  const saved = structuredClone(options.checkpoint) as ReadyCheckpoint;
  if (saved.domain !== BigInt(options.domain ?? saved.domain).toString() ||
      JSON.stringify(saved.state) !== JSON.stringify(options.initialState)) {
    throw new Error("Compact ready checkpoint does not match its protocol domain or state");
  }
  const arkUrl = options.arkUrl ?? saved.live.arkUrl ?? DEFAULT_ARK_URL;
  const parsedUrl = new URL(arkUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || saved.live.arkUrl !== arkUrl) {
    throw new Error("Cannot change a persisted compact pool's secure Arkade provider");
  }
  const provider = new RestArkProvider(arkUrl), indexer = new RestIndexerProvider(arkUrl);
  const info = await provider.getInfo();
  if (info.network !== "mutinynet") throw new Error("Compact ready adapter only supports Mutinynet");
  const serverKey = info.signerPubkey.slice(-64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(serverKey) || !info.checkpointTapscript) throw new Error("Mutinynet returned an invalid operator signer or checkpoint policy");
  if (BigInt(info.unilateralExitDelay) !== EXIT_SECONDS) throw new Error("Unexpected Mutinynet unilateral exit delay");
  const emulatorIdentity = SingleKey.fromHex(saved.live.compactEmulatorSecret!);
  const emulatorKey = hex.encode(await emulatorIdentity.xOnlyPublicKey());
  if (saved.serverKey !== serverKey || saved.emulatorKey !== emulatorKey || saved.checkpointScript !== info.checkpointTapscript) {
    throw new Error("Mutinynet operator signer or checkpoint policy changed; encrypted migration is required");
  }
  const alice = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(saved.aliceSecret).xOnlyPublicKey(),
    { type: "seconds", value: EXIT_SECONDS });
  const bob = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(saved.bobSecret).xOnlyPublicKey(),
    { type: "seconds", value: EXIT_SECONDS });
  // Rebuild the original registration input. Never feed the derived profile object back as config.
  const compactProfile: CompactProfileConfig = {
    relationVersion: "ark-shield-poc-v1", domain: saved.domain,
    verificationKeys: options.verificationKeys as CompactProfileConfig["verificationKeys"],
    serverKey, emulatorKey, checkpointScript: info.checkpointTapscript,
    exitTimelock: { type: "seconds", value: EXIT_SECONDS.toString() },
    identities: saved.live.issued as CompactProfileConfig["identities"],
    destinations: {
      alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field },
      bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field },
    },
  };
  const profile = await registerCompactProfile(compactProfile);
  if (profile.profileId !== saved.compact.profileId) throw new Error("Compact verifier profile changed; refusing to restore this checkpoint");
  const limit = effectiveLimit(info.maxTxWeight);
  const checkpointTx = (await import("@arkade-os/sdk")).CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
  const journal = () => saved.live.readySettlement;
  let core: SdkRuntime | undefined;
  const persist = async () => {
    const checkpoint = core?.exportState() ?? saved;
    checkpoint.live = structuredClone(saved.live);
    await options.onCheckpoint!(checkpoint);
  };
  const queryAccepted = async (request: VmBridgeRequest, durableResult?: NativeVmResult): Promise<NativeVmResult | undefined> => {
    const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
    const indexedRaw = await indexer.getVirtualTxs([expected.id]);
    const indexed = txFromIndexer(indexedRaw.txs, expected.id);
    if (!indexed) return undefined;
    let signed: Transaction;
    let checkpoints: Transaction[];
    if (durableResult) {
      const verified = verifyCompactResponse(request, durableResult, serverKey, emulatorKey);
      sameBody(indexed, verified.arkTx);
      signed = verified.arkTx;
      checkpoints = verified.checkpoints;
    } else {
      signed = restoreIndexedPsbt(indexed, expected);
      const requestedCheckpoints = request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
      const checkpointRaw = await indexer.getVirtualTxs(requestedCheckpoints.map((tx) => tx.id));
      checkpoints = requestedCheckpoints.map((requested) => {
        const found = txFromIndexer(checkpointRaw.txs, requested.id);
        if (!found) throw new Error("Accepted compact transaction is missing indexed checkpoint ancestry");
        return restoreIndexedPsbt(found, requested);
      });
    }
    const requestedCheckpoints = request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
    const spendPoints = requestedCheckpoints.map((tx) => {
      const input = tx.getInput(0);
      if (!input.txid || input.index === undefined) throw new Error("Compact checkpoint spend input is incomplete");
      return { txid: hex.encode(input.txid).toLowerCase(), vout: input.index, checkpoint: tx.id };
    });
    const spent = (await indexer.getVtxos({ outpoints: spendPoints.map(({ txid, vout }) => ({ txid, vout })) })).vtxos;
    if (spendPoints.some((point) => !spent.some((coin) => outpoint(coin.txid, coin.vout) === outpoint(point.txid, point.vout) &&
        coin.isSpent && coin.spentBy?.toLowerCase() === point.checkpoint.toLowerCase() && coin.arkTxId?.toLowerCase() === expected.id.toLowerCase()))) {
      throw new Error("Indexed compact checkpoint inputs do not link to the accepted Ark transaction");
    }
    const outputPoints = Array.from({ length: expected.outputsLength }, (_, vout) => ({ txid: expected.id, vout }))
      .filter(({ vout }) => expected.getOutput(vout).amount! > 0n);
    const outputs = (await indexer.getVtxos({ outpoints: outputPoints })).vtxos;
    if (outputPoints.some(({ vout }) => !outputs.some((coin) => coin.txid.toLowerCase() === expected.id.toLowerCase() && coin.vout === vout &&
        !coin.isSpent && !coin.isSwept && !coin.isUnrolled && coin.value === Number(expected.getOutput(vout).amount!) &&
        coin.script === hex.encode(expected.getOutput(vout).script!)))) return undefined;
    const result: NativeVmResult = { ok: true, arkTx: base64.encode(signed.toPSBT()), checkpoints: checkpoints.map((tx) => base64.encode(tx.toPSBT())),
      txid: signed.id, executedInputs: signed.inputsLength, signatureCount: 0, durationMs: 0, backend: "mutinynet-indexer-reconciled" };
    verifyCompactResponse(request, result, serverKey, emulatorKey);
    assertWeight(signed, limit);
    checkpoints.forEach((tx) => assertWeight(tx, limit));
    return result;
  };
  const finalize = async (request: VmBridgeRequest, result: NativeVmResult): Promise<void> => {
    const signed = verifyCompactResponse(request, result, serverKey, emulatorKey);
    assertWeight(signed.arkTx, limit);
    signed.checkpoints.forEach((tx) => assertWeight(tx, limit));
    await provider.finalizeTx(signed.arkTx.id, signed.checkpoints.map((tx) => base64.encode(tx.toPSBT())));
  };
  const execute = async (request: VmBridgeRequest): Promise<NativeVmResult> => {
    const active = journal();
    if (!active || active.stage !== "prepared") throw new Error("Compact ready submission has no fresh durable request");
    assertEmulatorSignedRequest(active.request, request, emulatorKey);
    const ark = Transaction.fromPSBT(base64.decode(request.arkTx));
    const checkpoints = request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
    const pendingSubmission = currentSubmission;
    if (!pendingSubmission?.compactSidecar) throw new Error("Compact ready journal omitted its Groth16 proof sidecar");
    const unsignedArk = Transaction.fromPSBT(base64.decode(pendingSubmission.request.arkTx));
    const unsignedCheckpoints = pendingSubmission.request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
    sameBody(ark, unsignedArk);
    await verifyCompactUnsignedSubmission(profile.profileId, pendingSubmission.compactSidecar, unsignedArk, unsignedCheckpoints,
      { profileId: profile.profileId, protocol: structuredClone(saved.state),
        funding: { BTC: Number(saved.funding.BTC), DEMO: Number(saved.funding.DEMO) },
        heads: Object.fromEntries(Object.entries(saved.heads).map(([name, head]) => [name, { ...head }])) as never });
    assertWeight(ark, limit); checkpoints.forEach((tx) => assertWeight(tx, limit));
    active.networkRequest = structuredClone(request);
    active.stage = "submit-attempted";
    await persist();
    const response = await provider.submitTx(request.arkTx, request.checkpoints);
    const result: NativeVmResult = { ok: true, arkTx: response.finalArkTx, checkpoints: response.signedCheckpointTxs,
      txid: response.arkTxid, executedInputs: ark.inputsLength, signatureCount: ark.inputsLength * 2,
      durationMs: 0, backend: "mutinynet-arkade-registered-compact" };
    const signed = verifyCompactResponse(request, result, serverKey, emulatorKey);
    if (response.arkTxid.toLowerCase() !== ark.id.toLowerCase() || signed.arkTx.id !== ark.id) throw new Error("Mutinynet changed the compact transaction ID");
    assertWeight(signed.arkTx, limit); signed.checkpoints.forEach((tx) => assertWeight(tx, limit));
    result.arkTx = base64.encode(signed.arkTx.toPSBT());
    result.checkpoints = signed.checkpoints.map((tx) => base64.encode(tx.toPSBT()));
    active.result = structuredClone(result);
    active.stage = "response-stored";
    await persist();
    active.stage = "finalize-attempted";
    await persist();
    await finalize(request, result);
    return result;
  };
  let currentSubmission: NativeSubmission | undefined;
  try {
    // Validate the recorded current resource heads against the registered profile and exact indexer status.
    const closureScript = createCompactClosure(hex.decode(profile.profileId), hex.decode(serverKey), hex.decode(emulatorKey),
      { type: "seconds", value: EXIT_SECONDS }).pkScript;
    const assetOutputs = (tx: Transaction, identity: string, vout: number): bigint[] => {
      const packet = Extension.fromTx(tx).getAssetPacket();
      if (!packet) throw new Error("Current compact source transaction omitted native asset identities");
      return packet.groups.flatMap((group, index) =>
        (group.assetId ?? asset.AssetId.create(tx.id, index)).toString() === identity
          ? group.outputs.filter((entry) => entry.vout === vout).map((entry) => entry.amount) : []);
    };
    for (const name of RESOURCES) {
      const head = saved.heads[name]!, source = Transaction.fromRaw(hex.decode(head.sourceTx));
      const output = source.getOutput(head.vout);
      const expectedSats = name === "gate" ? BigInt(saved.funding.BTC) :
        name === "btcVault" ? 1_000n + BigInt(saved.state.reserves.BTC) : 1_000n;
      if (source.id !== head.txid || !output?.script || !Buffer.from(output.script).equals(Buffer.from(closureScript)) ||
          output.amount !== BigInt(head.value) || output.amount !== expectedSats) throw new Error(`Current ${name} head does not match the registered profile closure or treasury amount`);
      const identity = name === "gate" ? saved.live.issued.token : saved.live.issued[name];
      const expected = name === "gate" ? BigInt(saved.funding.DEMO) : 1n;
      if (expected > 0n) {
        if (!identity) throw new Error(`Current ${name} head has no registered asset identity`);
        const quantities = assetOutputs(source, identity, head.vout);
        if (quantities.length !== 1 || quantities[0] !== expected) throw new Error(`Current ${name} head is not bound to its registered asset identity`);
      }
      if (name === "tokenVault" && BigInt(saved.state.reserves.DEMO) > 0n) {
        const quantities = assetOutputs(source, saved.live.issued.token!, head.vout);
        if (quantities.length !== 1 || quantities[0] !== BigInt(saved.state.reserves.DEMO)) {
          throw new Error("Current token vault does not contain the registered DEMO reserve");
        }
      }
    }
    const pending = journal();
    const previousPoints = RESOURCES.map((name) => ({ name, ...saved.heads[name]! }));
    const indexed = (await indexer.getVtxos({ outpoints: previousPoints.map(({ txid, vout }) => ({ txid, vout })) })).vtxos;
    for (const point of previousPoints) {
      const matches = indexed.filter((coin) => outpoint(coin.txid, coin.vout) === outpoint(point.txid, point.vout));
      if (matches.length !== 1) throw new Error("Indexer is missing or duplicated a current compact resource head");
      const coin = matches[0]!;
      if (coin.value !== point.value || coin.script !== hex.encode(closureScript)) throw new Error("Indexer current compact resource value or script changed");
      if (coin.isSwept || coin.isUnrolled) throw new Error("A current compact resource head was swept or unrolled");
      if (coin.isSpent) {
        if (!pending || pending.stage === "prepared") throw new Error("A current compact resource head was spent before a recorded network attempt");
        const request = pending.request;
        const matchingCheckpoint = request?.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt))).find((tx) => {
          const input = tx.getInput(0); return input.txid && input.index !== undefined && outpoint(hex.encode(input.txid), input.index) === outpoint(point.txid, point.vout);
        });
        if (!matchingCheckpoint || coin.spentBy?.toLowerCase() !== matchingCheckpoint.id.toLowerCase() ||
            coin.arkTxId?.toLowerCase() !== pending!.txid.toLowerCase()) throw new Error("A current compact resource head has an unrelated spend");
      }
    }
    const onSubmission = async (_prepared: Parameters<NonNullable<SdkRuntimeOptions["onSubmission"]>>[0], submission: NativeSubmission) => {
      if (journal()) throw new Error("A previous compact settlement remains unresolved");
      currentSubmission = structuredClone(submission);
      saved.live.readySettlement = { txid: submission.txid, request: structuredClone(submission.request), stage: "prepared" };
      await options.onSubmission?.(_prepared, submission);
      await persist();
    };
    const onCheckpoint = async (checkpoint: NativeCheckpoint) => {
      checkpoint.live = structuredClone(saved.live);
      if (checkpoint.compact?.pendingAcceptance) {
        const active = journal();
        if (!active || active.txid !== checkpoint.compact.pendingAcceptance.txid || !active.result) {
          throw new Error("Compact accepted checkpoint has no matching durable transport response");
        }
      }
      await options.onCheckpoint!(checkpoint);
      Object.assign(saved, structuredClone(checkpoint));
    };
    core = await createCompactRuntime({ ...options, checkpoint: saved, network: "mutinynet", compactProfile, emulatorIdentity,
      weightLimit: limit, execute,
      onSubmission,
      onCheckpoint,
      recoverSubmission: async (submission) => {
        const active = journal();
        if (!active || active.txid !== submission.txid || !requestEqual(active.request, submission.request)) {
          throw new Error("Compact ready recovery has no exact identified network request");
        }
        currentSubmission = structuredClone(submission);
        const action = readyRecoveryAction(active.stage);
        if (action === "resume-submit") return execute(await signCompactEmulator(active.request, emulatorIdentity));
        if (action === "reconcile-submit") {
          const accepted = await queryAccepted(active.request);
          if (!accepted) return undefined;
          active.result = structuredClone(accepted); active.stage = "response-stored"; await persist();
          return accepted;
        }
        if (!active.result) throw new Error("Compact response journal is missing its verified signed response");
        verifyCompactResponse(active.request, active.result, serverKey, emulatorKey);
        if (action === "finalize-response") {
          active.stage = "finalize-attempted"; await persist();
          await finalize(active.request, active.result);
          return active.result;
        }
        return await queryAccepted(active.request, active.result);
      },
    });
    const readySnapshot = core.snapshot() as { profileId?: string; heads?: Record<string, unknown> };
    if (readySnapshot.profileId !== saved.compact.profileId || RESOURCES.some((name) => !readySnapshot.heads?.[name])) {
      throw new Error("Compact core did not restore the exact registered profile and four resource heads");
    }
    return {
      ...core,
      snapshot: () => ({ ...core!.snapshot(), mode: "compact-offchain", network: "mutinynet", phase: "ready", bootstrapPhase: "ready",
        ready: true, compatible: true, syntheticFunding: false, supportsBoarding: false, onboardAvailable: false,
        funding: { requiredSats: 0, allocated: core!.exportState().funding }, operator: { arkUrl, signerPubkey: info.signerPubkey,
          emulatorPubkey: emulatorKey, maxTxWeight: info.maxTxWeight?.toString(), effectiveMaxTxWeight: limit.toString(),
          exitTimelock: { type: "seconds", value: EXIT_SECONDS.toString() } } }),
      exportState: () => { const checkpoint = core!.exportState(); checkpoint.live = structuredClone(saved.live); return checkpoint; },
      settle: async (prepared) => {
        const receipt = await core!.settle(prepared);
        const live = structuredClone(saved.live);
        Object.assign(saved, structuredClone(core!.exportState()));
        saved.live = live;
        saved.live.readySettlement = undefined;
        currentSubmission = undefined;
        return receipt;
      },
      reconcile: async (prepared, submission) => {
        currentSubmission = structuredClone(submission);
        const receipt = await core!.reconcile(prepared, submission);
        if (receipt && journal()?.txid === submission.txid) {
          const live = structuredClone(saved.live);
          Object.assign(saved, structuredClone(core!.exportState()));
          saved.live = live;
          saved.live.readySettlement = undefined;
        }
        return receipt;
      },
      close: async () => { await core!.close(); },
    };
  } catch (error) {
    await core?.close();
    throw error;
  }
}