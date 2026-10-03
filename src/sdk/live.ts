import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import {
  arkade, asset, ArkAddress, ConditionMultisigTapscript, CSVMultisigTapscript, Extension,
  // @ts-ignore SDK runtime export is missing from bundled declarations.
  MultisigTapscript,
  InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider, RestEmulatorProvider,
  RestIndexerProvider, SingleKey, Transaction, Wallet, matchServerCheckpoints,
  verifyTapscriptSignatures, type Recipient,
} from "@arkade-os/sdk";
import {
  createSdkRuntime, foldVerificationKeyDomain, verificationKeyWitness, statePacket,
  type NativeCheckpoint, type NativeSubmission, type NativeVmResult, type SdkRuntime, type SdkRuntimeOptions,
} from "./runtime.ts";
import { coinFromTransaction, instantiateArtifact, type VmBridgeRequest } from "./adapter.ts";

export const MUTINYNET_ARK_URL = "https://mutinynet.arkade.sh";
export const MUTINYNET_EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const MUTINYNET_EMULATOR_KEY = "03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a";
const FUNDING = 200_000n;
const TOKEN_SUPPLY = 10_000_000n;
const RESOURCE_NAMES = ["gate", "lane", "btcVault", "tokenVault"] as const;
const ISSUE_NAMES = ["lane", "btcVault", "tokenVault", "token"] as const;
type BootstrapResponse = Awaited<ReturnType<RestArkProvider["submitTx"]>>;

export interface LiveBoardingReceipt {
  requestId?: string;
  requestIds?: string[];
  commitmentTxid: string;
  selectedOutpoints: { txid: string; vout: number }[];
  outputOutpoints: { txid: string; vout: number }[];
  amountSats: number;
  startedAt: number;
}

export interface LiveCheckpoint {
  seedHex: string;
  compactEmulatorSecret?: string;
  arkUrl: string;
  emulatorUrl: string;
  phase: "funding-required" | "issuing" | "profile-registration" | "funding-programs" | "ready";
  issued: Partial<Record<typeof ISSUE_NAMES[number], string>>;
  issuanceTransactions?: Partial<Record<typeof ISSUE_NAMES[number], string>>;
  pendingBootstrap?: { step: string; txid: string; request: VmBridgeRequest; response?: BootstrapResponse };
  pendingSettlement?: { txid: string; result: NativeVmResult };
  pendingBoarding?: {
    status: "submitting" | "unknown" | "accepted";
    requestId?: string;
    requestIds?: string[];
    selectedOutpoints: { txid: string; vout: number }[];
    selectedValues: { txid: string; vout: number; value: number }[];
    walletOutpoints: { txid: string; vout: number }[];
    expectedOutputs: { script: string; value: number }[];
    outputOutpoints?: { txid: string; vout: number }[];
    inputSats: number;
    baselineVtxos: { txid: string; vout: number }[];
    startedAt: number;
    commitmentTxid?: string;
    commitmentTx?: string;
    events: { type: string; id: string; txid?: string; commitmentTxid?: string; commitmentTx?: string; reason?: string }[];
    error?: string;
  };
  boardingReceipts?: LiveBoardingReceipt[];
}

function assertSameBody(actual: Transaction, expected: Transaction) {
  if (actual.id !== expected.id || hex.encode(actual.unsignedTx) !== hex.encode(expected.unsignedTx)) {
    throw new Error("Remote signer changed the submitted transaction body");
  }
}

function restoreSignedPsbt(raw: Transaction, original: Transaction): Transaction {
  assertSameBody(raw, original);
  for (let vin = 0; vin < raw.inputsLength; vin++) {
    const witness = raw.getInput(vin).finalScriptWitness;
    const leaf = original.getInput(vin).tapLeafScript?.[0];
    if (!witness || !leaf || witness.length < 4 || hex.encode(witness.at(-2)!) !== hex.encode(leaf[1].subarray(0, -1)) || hex.encode(witness.at(-1)!) !== hex.encode(TaprootControlBlock.encode(leaf[0]))) throw new Error("Indexed transaction lacks the exact submitted spend witness");
    const script = leaf[1].subarray(0, -1);
    const signers: Uint8Array[] = (ConditionMultisigTapscript.isScriptValid(script) === true ? ConditionMultisigTapscript.decode(script) : MultisigTapscript.decode(script)).params.pubkeys;
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    original.updateInput(vin, { tapScriptSig: signers.map((pubKey, index) => [{ pubKey, leafHash }, witness[signers.length - index - 1]]) });
  }
  return original;
}

export function verifyRemoteResponse(request: VmBridgeRequest, result: { signedArkTx: string; signedCheckpointTxs: string[] }, serverKey: string) {
  const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
  const signed = Transaction.fromPSBT(base64.decode(result.signedArkTx));
  assertSameBody(signed, expected);
  const checkpoints = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
  for (const [index, tx] of [signed, ...matchServerCheckpoints(result.signedCheckpointTxs, checkpoints, "emulator").map((entry) => {
    assertSameBody(entry.server, entry.local);
    return entry.server;
  })].entries()) {
    for (let vin = 0; vin < tx.inputsLength; vin++) {
      const original = index === 0 ? expected : checkpoints.find((entry) => entry.id === tx.id)!;
      const leaf = original.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error("Missing submitted covenant spend leaf");
      const script = leaf[1].subarray(0, -1);
      const signers = (ConditionMultisigTapscript.isScriptValid(script) === true ? ConditionMultisigTapscript.decode(script) : MultisigTapscript.decode(script)).params.pubkeys.map((key: Uint8Array) => hex.encode(key));
      if (!signers.includes(serverKey)) throw new Error("Covenant leaf lacks the pinned operator signer");
      verifyTapscriptSignatures(tx, vin, signers, undefined, undefined, tapLeafHash(script, leaf[1].at(-1)!));
      if (hex.encode(tx.getInput(vin).witnessUtxo!.script) !== hex.encode(original.getInput(vin).witnessUtxo!.script) || tx.getInput(vin).witnessUtxo!.amount !== original.getInput(vin).witnessUtxo!.amount) {
        throw new Error("Remote signer changed submitted previous-output metadata");
      }
    }
  }
  return signed;
}

export async function createLiveRuntime(options: SdkRuntimeOptions): Promise<SdkRuntime> {
  if (!options.onCheckpoint) throw new Error("Mutinynet requires durable checkpoint storage before funding");
  const restored = options.checkpoint;
  const arkUrl = options.arkUrl ?? restored?.live?.arkUrl ?? MUTINYNET_ARK_URL;
  const emulatorUrl = options.emulatorUrl ?? restored?.live?.emulatorUrl ?? MUTINYNET_EMULATOR_URL;
  for (const endpoint of [arkUrl, emulatorUrl]) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Mutinynet providers require HTTPS without embedded credentials");
  }
  if (restored && (restored.network !== "mutinynet" || !restored.live || restored.live.arkUrl !== arkUrl || restored.live.emulatorUrl !== emulatorUrl)) throw new Error("Cannot change a persisted pool's network providers");
  const provider = new RestArkProvider(arkUrl);
  const indexer = new RestIndexerProvider(arkUrl);
  const emulator = new RestEmulatorProvider(emulatorUrl);
  const [info, emulatorInfo] = await Promise.all([provider.getInfo(), emulator.getInfo()]);
  if (info.network !== "mutinynet") throw new Error("Live shielded runtime only supports Mutinynet; mainnet is forbidden");
  if (emulatorInfo.signerPubkey !== MUTINYNET_EMULATOR_KEY) throw new Error("Unexpected Mutinynet emulator signer");
  const serverKey = info.signerPubkey.slice(-64);
  if (restored && (restored.serverKey !== serverKey || restored.emulatorKey !== emulatorInfo.signerPubkey || restored.checkpointScript !== info.checkpointTapscript)) throw new Error("Persisted pool signer or checkpoint policy changed; migration is required");
  let saved: NativeCheckpoint = restored ? structuredClone(restored) : {
    version: 1, network: "mutinynet", domain: BigInt(options.domain ?? 20260930001n).toString(), state: structuredClone(options.initialState),
    serverKey, emulatorKey: emulatorInfo.signerPubkey, aliceSecret: randomBytes(32).toString("hex"), bobSecret: randomBytes(32).toString("hex"),
    checkpointScript: info.checkpointTapscript, identities: {}, issuanceRaw: "", genesisRaw: "", heads: {}, funding: { BTC: FUNDING.toString(), DEMO: TOKEN_SUPPLY.toString() }, receipts: [],
    live: { seedHex: randomBytes(32).toString("hex"), arkUrl, emulatorUrl, phase: "funding-required", issued: {}, issuanceTransactions: {} },
  };
  let live = saved.live!;
  let core: SdkRuntime | undefined;
  const exportState = (): NativeCheckpoint => ({ ...structuredClone(core?.exportState() ?? saved), live: structuredClone(live) });
  const persist = async () => { saved = exportState(); await options.onCheckpoint!(saved); };
  await persist();
  const identity = SingleKey.fromHex(live.seedHex);
  const wallet = await Wallet.create({ identity, arkProvider: provider, indexerProvider: indexer,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() }, walletMode: "static" });
  try {
  const fundingAddress = await wallet.getAddress();
  const boardingAddress = await wallet.getBoardingAddress();
  let available = 0;
  let boardingBalance = { confirmed: 0, unconfirmed: 0, total: 0 };
  let busy = false;
  let blockedReason: string | undefined;
  const template = await createSdkRuntime({ ...options, checkpoint: undefined, network: "local-emulator", execute: undefined, onCheckpoint: undefined, onSubmission: undefined });
  const profile = template.compiledArtifacts();
  const witness = [] as Uint8Array[];
  for (const name of ["intent", "transition"] as const) {
    const key = options.verificationKeys[name] ?? options.verificationKeys[`${name}Key`] ?? options.verificationKeys[`${name}Vk`];
    const folded = await foldVerificationKeyDomain(key as Parameters<typeof foldVerificationKeyDomain>[0], BigInt(saved.domain));
    witness.push(...verificationKeyWitness(folded, name).map((value) => arkade.witnessRefToBytes(value, {}, {})));
  }
  const codeBytes = ["gate", "lane", "tokenVault"].reduce((sum, name) => sum + (profile[name] as { functions: { name: string; scriptBytes: number }[] }).functions.find((fn) => fn.name === (name === "gate" ? "apply" : "advance"))!.scriptBytes, 0);
  const minimumWeight = 4n * BigInt(codeBytes + RawWitness.encode(witness).length);
  await template.close();
  if (info.maxTxWeight && minimumWeight > info.maxTxWeight) blockedReason = `Current proof profile needs at least ${minimumWeight} weight units; operator limit is ${info.maxTxWeight}. Bootstrap is blocked before assets or programs are funded.`;
  const originalSubmit = provider.submitTx.bind(provider);
  let step: string | undefined;
  provider.submitTx = async (arkTx, checkpoints) => {
    if (!step || live.pendingBootstrap) throw new Error("Bootstrap submission requires a durable, unambiguous step");
    const tx = Transaction.fromPSBT(base64.decode(arkTx));
    live.pendingBootstrap = { step, txid: tx.id, request: { arkTx, checkpoints } };
    await persist();
    const response = await originalSubmit(arkTx, checkpoints);
    const signed = Transaction.fromPSBT(base64.decode(response.finalArkTx));
    assertSameBody(signed, tx);
    if (response.arkTxid !== tx.id) throw new Error("Operator changed bootstrap transaction ID");
    for (let vin = 0; vin < signed.inputsLength; vin++) {
      const leaf = tx.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error("Missing bootstrap transaction spend leaf");
      verifyTapscriptSignatures(signed, vin, [serverKey], undefined, undefined, tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    for (const { server, local } of matchServerCheckpoints(response.signedCheckpointTxs, checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry))), "bootstrap")) {
      assertSameBody(server, local);
      const leaf = local.getInput(0).tapLeafScript?.[0];
      if (!leaf) throw new Error("Missing bootstrap checkpoint spend leaf");
      verifyTapscriptSignatures(server, 0, [serverKey], undefined, undefined, tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    live.pendingBootstrap.response = response;
    await persist();
    return response;
  };
  const queryAccepted = async (request: VmBridgeRequest): Promise<Transaction | undefined> => {
    const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
    const checkpoints = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
    const { txs } = await indexer.getVirtualTxs([expected.id]);
    const candidates = txs.map((raw) => Transaction.fromRaw(hex.decode(raw)));
    const tx = candidates.find((entry) => entry.id === expected.id);
    if (!tx) return undefined;
    assertSameBody(tx, expected);
    const inputs = checkpoints.map((cp) => ({ txid: hex.encode(cp.getInput(0).txid!), vout: cp.getInput(0).index! }));
    const { vtxos } = await indexer.getVtxos({ outpoints: inputs });
    if (vtxos.length !== inputs.length || inputs.some((input, index) => !vtxos.some((coin) => coin.txid === input.txid && coin.vout === input.vout && coin.isSpent && coin.spentBy === checkpoints[index].id && coin.arkTxId === expected.id))) return undefined;
    const outputs = Array.from({ length: expected.outputsLength }, (_, vout) => ({ txid: expected.id, vout })).filter(({ vout }) => expected.getOutput(vout).amount! > 0n);
    const indexedOutputs = (await indexer.getVtxos({ outpoints: outputs })).vtxos;
    if (outputs.some(({ vout }) => !indexedOutputs.some((coin) => coin.txid === expected.id && coin.vout === vout && !coin.isSpent && !coin.isSwept && !coin.isUnrolled && coin.value === Number(expected.getOutput(vout).amount!) && coin.script === hex.encode(expected.getOutput(vout).script!)))) return undefined;
    return tx;
  };
  const execute = async (request: VmBridgeRequest): Promise<NativeVmResult> => {
    const started = performance.now();
    const response = await emulator.submitTx(request.arkTx, request.checkpoints);
    const signed = verifyRemoteResponse(request, response, serverKey);
    const result: NativeVmResult = { ok: true, arkTx: response.signedArkTx, checkpoints: response.signedCheckpointTxs, txid: signed.id,
      executedInputs: signed.inputsLength, signatureCount: [signed, ...response.signedCheckpointTxs.map((entry) => Transaction.fromPSBT(base64.decode(entry)))].reduce((total, tx) => total + Array.from({ length: tx.inputsLength }, (_, index) => tx.getInput(index).tapScriptSig?.length ?? 0).reduce((a, b) => a + b, 0), 0), durationMs: performance.now() - started, backend: "mutinynet-emulator" };
    live.pendingSettlement = { txid: signed.id, result };
    await persist();
    return result;
  };
  const recoverSubmission = async (submission: NativeSubmission): Promise<NativeVmResult | undefined> => {
    if (live.pendingSettlement?.txid === submission.txid) {
      verifyRemoteResponse(submission.request, { signedArkTx: live.pendingSettlement.result.arkTx!, signedCheckpointTxs: live.pendingSettlement.result.checkpoints! }, serverKey);
      return live.pendingSettlement.result;
    }
    const accepted = await queryAccepted(submission.request);
    if (!accepted) return undefined;
    const expected = restoreSignedPsbt(accepted, Transaction.fromPSBT(base64.decode(submission.request.arkTx)));
    const requestedCheckpoints = submission.request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
    const raws = (await indexer.getVirtualTxs(requestedCheckpoints.map((entry) => entry.id))).txs.map((entry) => Transaction.fromRaw(hex.decode(entry)));
    if (requestedCheckpoints.some((entry) => !raws.some((raw) => raw.id === entry.id))) return undefined;
    const checkpoints = requestedCheckpoints.map((entry) => base64.encode(restoreSignedPsbt(raws.find((raw) => raw.id === entry.id)!, entry).toPSBT()));
    const response = { signedArkTx: base64.encode(expected.toPSBT()), signedCheckpointTxs: checkpoints };
    verifyRemoteResponse(submission.request, response, serverKey);
    return { ok: true, arkTx: response.signedArkTx, checkpoints, txid: accepted.id,
      executedInputs: accepted.inputsLength, signatureCount: 0, durationMs: 0, backend: "mutinynet-indexer-reconciled" };
  };
  const startCore = async () => {
    core = await createSdkRuntime({ ...options, checkpoint: { ...saved, live }, initialState: saved.state, execute, recoverSubmission,
      onSubmission: async (prepared, submission) => {
        if (info.maxTxWeight && BigInt(submission.native.estimatedSignedWeight) > info.maxTxWeight) throw new Error(`Transaction requires ${submission.native.estimatedSignedWeight} weight units; operator limit is ${info.maxTxWeight}`);
        await options.onSubmission?.(prepared, submission);
      } });
  };
  if (live.phase === "ready") await startCore();
  const finishBootstrap = async (): Promise<string | undefined> => {
    const pending = live.pendingBootstrap;
    if (!pending) return undefined;
    if (await queryAccepted(pending.request)) return pending.txid;
    if (pending.response) {
      const checkpoints = await Promise.all(pending.response.signedCheckpointTxs.map(async (entry) => base64.encode((await identity.sign(Transaction.fromPSBT(base64.decode(entry)), [0])).toPSBT())));
      await provider.finalizeTx(pending.txid, checkpoints);
    } else {
      throw new Error(`Bootstrap ${pending.step} outcome is unknown; no transaction will be resubmitted`);
    }
    return pending.txid;
  };
  const refreshFunding = async () => { const balance = await wallet.getBalance(); available = balance.available; boardingBalance = balance.boarding; };
  const bootstrap = async () => {
    if (busy) throw new Error("Native bootstrap is already running");
    if (blockedReason) throw new Error(blockedReason);
    if (core) return;
    busy = true;
    try {
      await refreshFunding();
      if (!live.pendingBootstrap && available < Number(FUNDING + 3_000n + 330n)) throw new Error(`Funding required: send at least ${FUNDING + 3_330n} test sats to ${fundingAddress}`);
      live.phase = "issuing";
      await persist();
      for (const name of ISSUE_NAMES) {
        if (live.issued[name]) continue;
        step = `issue:${name}`;
        if (live.pendingBootstrap && live.pendingBootstrap.step !== step) throw new Error("Persisted bootstrap step does not match issued identities");
        const resumed = await finishBootstrap();
        const result = resumed ? { arkTxId: resumed, assetId: asset.AssetId.create(resumed, 0).toString() } : await wallet.assetManager.issue({ amount: name === "token" ? TOKEN_SUPPLY : 1n, metadata: { name: `Shielded PoC ${name}`, ticker: name === "token" ? "DEMO" : `SH-${name}` } });
        const raw = (await indexer.getVirtualTxs([result.arkTxId])).txs[0];
        if (!raw || Transaction.fromRaw(hex.decode(raw)).id !== result.arkTxId) throw new Error("Issued identity ancestry is not yet available; retry bootstrap without reissuing");
        live.issued[name] = result.assetId;
        (live.issuanceTransactions ??= {})[name] = raw;
        saved.identities[name] = result.assetId;
        saved.issuanceRaw = raw;
        live.pendingBootstrap = undefined;
        await persist();
      }
      live.phase = "funding-programs";
      await persist();
      const temporary = await createSdkRuntime({ ...options, checkpoint: { ...saved, live }, initialState: saved.state, network: "mutinynet", execute });
      const contracts = temporary.compiledArtifacts();
      const recipients = RESOURCE_NAMES.map((name, index) => {
      const contract = contracts[name] as { pkScript: string; tapTree: string };
        const args = index === 0 ? [{ assetId: live.issued.token!, amount: TOKEN_SUPPLY }] : [{ assetId: live.issued[name as "lane" | "btcVault" | "tokenVault"]!, amount: 1n }];
        const publicKey = hex.decode(contract.pkScript).subarray(2);
        return { address: new ArkAddress(hex.decode(serverKey), publicKey, "tark").encode(), amount: index === 0 ? Number(FUNDING) : 1_000, assets: args, tapTree: hex.decode(contract.tapTree),
          ...(index === 0 ? { extensions: [{ type: 0x83, payload: statePacket(saved.state).data }] } : {}) } as Recipient;
      }) as [Recipient, ...Recipient[]];
      await temporary.close();
      step = "fund-programs";
      if (live.pendingBootstrap && live.pendingBootstrap.step !== step) throw new Error("Unexpected pending bootstrap step");
      const txid = await finishBootstrap() ?? await wallet.send({ recipients });
      const raw = (await indexer.getVirtualTxs([txid])).txs.find((entry) => Transaction.fromRaw(hex.decode(entry)).id === txid);
      if (!raw) throw new Error("Program funding ancestry is not yet available; retry bootstrap without resending");
      const genesis = Transaction.fromRaw(hex.decode(raw));
      const packet = Extension.fromTx(genesis).getAssetPacket();
      if (!packet) throw new Error("Program funding transaction omitted native assets");
      for (const [vout, name] of RESOURCE_NAMES.entries()) {
        if (hex.encode(genesis.getOutput(vout).script!) !== (contracts[name] as { pkScript: string }).pkScript) throw new Error("Operator changed funded Program outputs");
        if (genesis.getOutput(vout).amount !== (vout === 0 ? FUNDING : 1_000n)) throw new Error("Operator changed Program funding values");
        const expectedAsset = vout === 0 ? live.issued.token : live.issued[name as "lane" | "btcVault" | "tokenVault"];
        const held = packet.groups.flatMap((group, index) => group.outputs.filter((entry) => entry.vout === vout).map((entry) => ({ id: (group.assetId ?? asset.AssetId.create(genesis.id, index)).toString(), amount: entry.amount })));
        if (held.length !== 1 || held[0].id !== expectedAsset || held[0].amount !== (vout === 0 ? TOKEN_SUPPLY : 1n)) throw new Error("Program funding transaction changed native identity allocation");
        const coin = coinFromTransaction(genesis, vout);
        saved.heads[name] = { ...coin, sourceTx: hex.encode(coin.sourceTx!) };
      }
      saved.genesisRaw = raw;
      live.phase = "ready";
      live.pendingBootstrap = undefined;
      await persist();
      await startCore();
    } finally { busy = false; step = undefined; }
  };
  const recipientArtifact = JSON.parse(await readFile(resolve(options.artifactsDirectory ?? "artifacts", "poc_recipient.json"), "utf8")) as arkade.ContractArtifact;
  const destinations = Object.fromEntries(await Promise.all((["alice", "bob"] as const).map(async (name) => {
    const key = await SingleKey.fromHex(saved[name === "alice" ? "aliceSecret" : "bobSecret"]).xOnlyPublicKey();
    const recipient = instantiateArtifact(recipientArtifact, { owner: key, exitDelay: 144n }, { serverKey: hex.decode(serverKey), emulatorKey: hex.decode(saved.emulatorKey), userKey: key });
    return [name, hex.encode(recipient.script.pkScript.subarray(2))];
  }))) as Record<"alice" | "bob", string>;
  return {
    exportState, bootstrap, refreshFunding, destination: (owner) => core?.destination(owner) ?? destinations[owner],
    compiledArtifacts: () => core?.compiledArtifacts() ?? {},
    snapshot: () => ({ ...(core?.snapshot() ?? {}), mode: "mutinynet", network: "mutinynet", syntheticFunding: false,
      bootstrapPhase: live.phase, phase: live.phase, compatible: !blockedReason, ready: Boolean(core), blockedReason,
      funding: { arkAddress: fundingAddress, boardingAddress, availableSats: available, requiredSats: Number(FUNDING + 3_330n), boarding: boardingBalance },
      operator: { arkUrl, emulatorUrl, signerPubkey: info.signerPubkey, emulatorPubkey: emulatorInfo.signerPubkey, maxTxWeight: info.maxTxWeight?.toString(), minimumProfileWeight: minimumWeight.toString() } }),
    settle: async (prepared) => {
      if (!core) throw new Error("Mutinynet pool has not been bootstrapped");
      const receipt = await core.settle(prepared);
      live.pendingSettlement = undefined;
      return receipt;
    },
    reconcile: async (prepared, submission) => {
      if (!core) return undefined;
      const receipt = await core.reconcile(prepared, submission);
      if (receipt) live.pendingSettlement = undefined;
      return receipt;
    },
    close: async () => { await core?.close(); await wallet.dispose(); },
  };
  } catch (error) {
    await core?.close();
    await wallet.dispose();
    throw error;
  }
}
