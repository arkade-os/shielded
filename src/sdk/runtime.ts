import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
// @ts-ignore ffjavascript does not ship declarations.
import { buildBn128 } from "ffjavascript";
import { base64, hex } from "@scure/base";
import {
  arkade,
  asset,
  ASSET_CARRIER_SATS,
  CSVMultisigTapscript,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import type { PreparedSettlement, ProtocolState, Owner, Groth16Proof } from "../../packages/protocol/src/types.ts";
import {
  bridgeRequest,
  buildCovenantSpend,
  coinFromTransaction,
  instantiateArtifact,
  offlineNativeFixture,
  opaquePacket,
  spendSummary,
  transferAssetPacket,
  type AssetAllocation,
  type CompiledContract,
  type CovenantInput,
  type NativeOutput,
  type ParamValue,
  type PacketData,
  type ResourceCoin,
  type VmBridgeRequest,
} from "./adapter.ts";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const CARRIER = 1_000n;
const INITIAL_FUNDING = 10_000_000n;
export const DEFAULT_VM_BINARY = process.env.SHIELDED_VM_BIN ?? fileURLToPath(new URL(
  `../../bin/${process.platform === "win32" ? "shielded-vm.exe" : "shielded-vm"}`, import.meta.url));

export interface NativeVmResult {
  ok: boolean;
  error?: string;
  arkTx?: string;
  checkpoints?: string[];
  txid?: string;
  executedInputs?: number;
  signatureCount?: number;
  durationMs: number;
  backend: string;
}

export interface NativeReceipt {
  id: string;
  operation: PreparedSettlement["operation"];
  txid: string;
  backend: string;
  executedInputs: number;
  signatureCount: number;
  vmMs: number;
  native: ReturnType<typeof spendSummary>;
  publicSignalCounts: { intent: number; transition: number };
  signedArkTx: string;
  signedCheckpoints: string[];
  proofTimes: PreparedSettlement["proofTimes"];
}

export interface SdkRuntimeOptions {
  verificationKeys: Record<string, unknown>;
  initialState: ProtocolState;
  domain?: bigint | string | number;
  artifactsDirectory?: string;
  vmBinary?: string;
  execute?: (request: VmBridgeRequest) => Promise<NativeVmResult>;
}

export interface SdkRuntime {
  settle(prepared: PreparedSettlement): Promise<NativeReceipt>;
  destination(owner: Owner): string;
  snapshot(): Record<string, unknown>;
  compiledArtifacts(): Record<string, unknown>;
  close(): Promise<void>;
}

interface VkJson {
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

function fieldBytes(value: bigint | string | number): Uint8Array {
  const scalar = BigInt(value);
  if (scalar < 0n || scalar >= FR) throw new Error("Noncanonical BN254 public field");
  const bytes = new Uint8Array(32);
  let remaining = scalar;
  for (let i = 0; i < 32; i++) { bytes[i] = Number(remaining & 255n); remaining >>= 8n; }
  return bytes;
}

export function encodeFields(values: readonly (bigint | string | number)[]): Uint8Array {
  const result = new Uint8Array(values.length * 32);
  values.forEach((value, index) => result.set(fieldBytes(value), index * 32));
  return result;
}

function littleEndian(bytes: Uint8Array): bigint {
  return bytes.reduceRight((value, byte) => (value << 8n) + BigInt(byte), 0n);
}

function statePacket(state: ProtocolState): PacketData {
  return { type: 0x83, data: encodeFields([
    state.noteRoot, state.spentRoot, state.historyRoot, state.noteCount, state.historyCount,
  ]) };
}

function sameState(left: ProtocolState, right: ProtocolState): boolean {
  return left.noteRoot === right.noteRoot && left.spentRoot === right.spentRoot &&
    left.historyRoot === right.historyRoot && left.noteCount === right.noteCount &&
    left.historyCount === right.historyCount && left.revision === right.revision &&
    left.reserves.BTC === right.reserves.BTC && left.reserves.DEMO === right.reserves.DEMO;
}

function addKeyArgs(args: Record<string, ParamValue>, prefix: string, key: VkJson, count: number) {
  if (key.IC.length !== count + 1) throw new Error(`${prefix} requires ${count} public signals`);
  args[`${prefix}.alpha.x`] = BigInt(key.vk_alpha_1[0]);
  args[`${prefix}.alpha.y`] = BigInt(key.vk_alpha_1[1]);
  for (const [name, point] of [
    ["betaNeg", key.vk_beta_2], ["gammaNeg", key.vk_gamma_2], ["deltaNeg", key.vk_delta_2],
  ] as const) {
    args[`${prefix}.${name}.xc1`] = BigInt(point[0][1]);
    args[`${prefix}.${name}.xc0`] = BigInt(point[0][0]);
    args[`${prefix}.${name}.yc1`] = (FQ - BigInt(point[1][1])) % FQ;
    args[`${prefix}.${name}.yc0`] = (FQ - BigInt(point[1][0])) % FQ;
  }
  for (const [index, point] of key.IC.entries()) {
    args[`${prefix}.icX.${index}`] = BigInt(point[0]);
    args[`${prefix}.icY.${index}`] = BigInt(point[1]);
  }
}

/** The fixed deployment domain is checked by the covenant and folded into IC0. */
export async function foldVerificationKeyDomain(key: VkJson, domain: bigint): Promise<VkJson> {
  const curve = await buildBn128(true);
  try {
    const result = structuredClone(key);
    const constant = curve.G1.fromObject(key.IC[0].map(BigInt));
    const domainPoint = curve.G1.fromObject(key.IC[1].map(BigInt));
    const product = curve.G1.timesFr(domainPoint, curve.Fr.e(domain));
    result.IC[0] = curve.G1.toObject(curve.G1.toAffine(curve.G1.add(constant, product))).map(String);
    return result;
  } finally { await curve.terminate(); }
}

export function verificationKeyWitness(key: VkJson, name: "intent" | "transition"): bigint[] {
  const args: Record<string, ParamValue> = {};
  addKeyArgs(args, "key", key, name === "intent" ? 25 : 30);
  return [
    ...Object.values(args).slice(0, 14).map((value) => BigInt(value as bigint)),
    ...key.IC.map((point) => BigInt(point[0])),
    ...key.IC.map((point) => BigInt(point[1])),
  ];
}

export function verificationKeyHash(witness: readonly bigint[], name: "intent" | "transition"): Uint8Array {
  let digest = sha256(new TextEncoder().encode(`ArkShieldPocVk:${name === "intent" ? "Intent" : "Transition"}:v1`));
  for (const coordinate of witness) {
    if (coordinate < 0n || coordinate >= 1n << 255n) throw new Error("Noncanonical pairing coordinate");
    const value = new Uint8Array(32);
    let remaining = coordinate;
    for (let i = 0; i < 32; i++) { value[i] = Number(remaining & 255n); remaining >>= 8n; }
    const body = new Uint8Array(64);
    body.set(digest); body.set(value, 32);
    digest = sha256(body);
  }
  return digest;
}

export function proofArguments(proof: Groth16Proof): bigint[] {
  return [
    proof.pi_a[0], proof.pi_a[1],
    proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0],
    proof.pi_c[0], proof.pi_c[1],
  ].map(BigInt);
}

function addAssetArgs(args: Record<string, ParamValue>, prefix: string, id: ReturnType<typeof asset.AssetId.create>) {
  // Native asset opcodes compare the Go chainhash internal byte order. The
  // SDK packet serialization uses canonical display order, so only script
  // constructor coordinates reverse the txid (the packet remains unchanged).
  args[`${prefix}.txid`] = id.txid.slice().reverse();
  args[`${prefix}.gidx`] = BigInt(id.groupIndex);
}

function chooseKey(keys: Record<string, unknown>, name: string): VkJson {
  const key = keys[name] ?? keys[`${name}Key`] ?? keys[`${name}Vk`];
  if (!key || typeof key !== "object") throw new Error(`Missing ${name} verification key`);
  return key as VkJson;
}

/** One child process per attempt keeps rejected VM mutations isolated. */
export function executeVmBinary(binary: string, request: VmBridgeRequest): Promise<NativeVmResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Emulator bridge exited ${code}: ${stderr.slice(-2_000)}`));
      try {
        const line = stdout.trim().split("\n").at(-1);
        if (!line) throw new Error("Emulator returned no response");
        resolveResult(JSON.parse(line) as NativeVmResult);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request) + "\n");
  });
}

export async function createSdkRuntime(options: SdkRuntimeOptions): Promise<SdkRuntime> {
  const directory = resolve(options.artifactsDirectory ?? "artifacts");
  const artifactFiles = { gate: "poc_gate.json", lane: "poc_lane.json", btcVault: "poc_btc_vault.json", tokenVault: "poc_token_vault.json", recipient: "poc_recipient.json" };
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(artifactFiles).map(async ([name, file]) =>
    [name, JSON.parse(await readFile(resolve(directory, file), "utf8")) as arkade.ContractArtifact])));

  // These are public fixture identities, provisioned with the SDK. They do not
  // come from user wallets and are never used in the live regtest adapter.
  const server = SingleKey.fromHex("01".repeat(32));
  const emulator = SingleKey.fromHex("02".repeat(32));
  const alice = SingleKey.fromHex("03".repeat(32));
  const bob = SingleKey.fromHex("04".repeat(32));
  const serverKey = await server.xOnlyPublicKey();
  const keys = { serverKey, emulatorKey: await emulator.compressedPublicKey() };
  const checkpoint = CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144n }, pubkeys: [serverKey] });
  const recipients = {
    alice: instantiateArtifact(artifacts.recipient, { owner: await alice.xOnlyPublicKey(), exitDelay: 144n }, { ...keys, userKey: await alice.xOnlyPublicKey() }),
    bob: instantiateArtifact(artifacts.recipient, { owner: await bob.xOnlyPublicKey(), exitDelay: 144n }, { ...keys, userKey: await bob.xOnlyPublicKey() }),
  };
  const payoutScripts = { alice: recipients.alice.script.pkScript, bob: recipients.bob.script.pkScript };
  const destinationFields = {
    alice: (littleEndian(sha256(payoutScripts.alice.subarray(2))) % FR).toString(),
    bob: (littleEndian(sha256(payoutScripts.bob.subarray(2))) % FR).toString(),
  };
  const destinations = {
    alice: hex.encode(payoutScripts.alice.subarray(2)),
    bob: hex.encode(payoutScripts.bob.subarray(2)),
  };

  // Issue first, then bind the resulting identities into the Programs. This
  // avoids committing an asset's own issuance transaction ID into itself.
  const initialTokenReserve = BigInt(options.initialState.reserves.DEMO);
  const issuance = offlineNativeFixture(
    [{ script: payoutScripts.alice, amount: INITIAL_FUNDING + 3n * CARRIER + BigInt(options.initialState.reserves.BTC) }],
    [asset.Packet.create([1n, 1n, 1n, INITIAL_FUNDING + initialTokenReserve].map((quantity) =>
      asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, quantity)], [])))],
  );
  const identities = {
    lane: asset.AssetId.create(issuance.id, 0),
    btcVault: asset.AssetId.create(issuance.id, 1),
    tokenVault: asset.AssetId.create(issuance.id, 2),
    token: asset.AssetId.create(issuance.id, 3),
  };
  const domain = BigInt(options.domain ?? 20260930001n);
  const intentKey = await foldVerificationKeyDomain(chooseKey(options.verificationKeys, "intent"), domain);
  const transitionKey = await foldVerificationKeyDomain(chooseKey(options.verificationKeys, "transition"), domain);
  const intentKeyWitness = verificationKeyWitness(intentKey, "intent");
  const transitionKeyWitness = verificationKeyWitness(transitionKey, "transition");
  const gateArgs: Record<string, ParamValue> = {
    domain,
    intentKeyHash: verificationKeyHash(intentKeyWitness, "intent"),
    transitionKeyHash: verificationKeyHash(transitionKeyWitness, "transition"),
  };
  addAssetArgs(gateArgs, "laneIdentity", identities.lane);
  addAssetArgs(gateArgs, "btcIdentity", identities.btcVault);
  addAssetArgs(gateArgs, "tokenIdentity", identities.tokenVault);
  addAssetArgs(gateArgs, "tokenAsset", identities.token);
  const gate = instantiateArtifact(artifacts.gate, gateArgs, keys);
  const apply = gate.script.compiled.find((fn) => fn.name === "apply");
  const seal = gate.script.compiled.find((fn) => fn.name === "seal");
  if (!apply?.arkadeScript || !seal?.arkadeScript) throw new Error("Gate artifact requires apply and seal covenants");
  const sharedArgs: Record<string, ParamValue> = {
    gateProgram: gate.script.pkScript.subarray(2),
    gateClosure: arkade.arkadeScriptHash(apply.arkadeScript),
    applyClosure: arkade.arkadeScriptHash(apply.arkadeScript),
    sealClosure: arkade.arkadeScriptHash(seal.arkadeScript),
  };
  const resource = (artifact: arkade.ContractArtifact, id: ReturnType<typeof asset.AssetId.create>, token = false) => {
    const args = { ...sharedArgs };
    addAssetArgs(args, "identity", id);
    if (token) addAssetArgs(args, "tokenAsset", identities.token);
    return instantiateArtifact(artifact, args, keys);
  };
  const contracts = { gate, lane: resource(artifacts.lane, identities.lane), btcVault: resource(artifacts.btcVault, identities.btcVault), tokenVault: resource(artifacts.tokenVault, identities.tokenVault, true) };
  let state = structuredClone(options.initialState);
  let gateFundingBtc = INITIAL_FUNDING;
  let gateFundingToken = INITIAL_FUNDING;
  let closed = false;
  let busy = false;
  const genesisAssetPacket = transferAssetPacket([
    { assetId: identities.lane.toString(), inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 1, amount: 1n }] },
    { assetId: identities.btcVault.toString(), inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 2, amount: 1n }] },
    { assetId: identities.tokenVault.toString(), inputs: [{ vin: 0, amount: 1n }], outputs: [{ vout: 3, amount: 1n }] },
    { assetId: identities.token.toString(), inputs: [{ vin: 0, amount: INITIAL_FUNDING + initialTokenReserve }], outputs: [
      { vout: 0, amount: INITIAL_FUNDING },
      ...(initialTokenReserve ? [{ vout: 3, amount: initialTokenReserve }] : []),
    ] },
  ]);
  const genesis = offlineNativeFixture([
    { script: gate.script.pkScript, amount: gateFundingBtc },
    { script: contracts.lane.script.pkScript, amount: CARRIER },
    { script: contracts.btcVault.script.pkScript, amount: CARRIER + BigInt(state.reserves.BTC) },
    { script: contracts.tokenVault.script.pkScript, amount: CARRIER },
  ], [genesisAssetPacket, opaquePacket(statePacket(state))], { txid: issuance.id, vout: 0 });
  const heads: Record<string, ResourceCoin> = {
    gate: coinFromTransaction(genesis, 0), lane: coinFromTransaction(genesis, 1),
    btcVault: coinFromTransaction(genesis, 2), tokenVault: coinFromTransaction(genesis, 3),
  };
  const receipts: NativeReceipt[] = [];
  const execute = options.execute ?? ((request) => executeVmBinary(options.vmBinary ?? DEFAULT_VM_BINARY, request));

  const compiledArtifacts = () => Object.fromEntries(Object.entries({ ...contracts, aliceRecipient: recipients.alice, bobRecipient: recipients.bob }).map(([name, contract]) => [name, {
    contractName: contract.program.name,
    source: `contracts/poc/${name.endsWith("Recipient") ? "recipient" : name === "btcVault" ? "btc_vault" : name === "tokenVault" ? "token_vault" : name}.ark`,
    program: JSON.parse(arkade.stringifyArtifact(contract.program)),
    pkScript: hex.encode(contract.script.pkScript),
    functions: contract.script.compiled.map((fn) => ({ name: fn.name, scriptBytes: fn.arkadeScript?.length ?? 0, tapleafBytes: fn.leafScript.length })),
  }]));

  return {
    destination: (owner) => destinations[owner],
    compiledArtifacts,
    snapshot: () => ({
      mode: "offline-emulator",
      nativeAssets: Object.fromEntries(Object.entries(identities).map(([name, id]) => [name, id.toString()])),
      gateFunding: { BTC: gateFundingBtc.toString(), DEMO: gateFundingToken.toString() },
      reserves: { ...state.reserves },
      heads: Object.fromEntries(Object.entries(heads).map(([name, coin]) => [name, { txid: coin.txid, vout: coin.vout, value: coin.value }])),
      destinations,
      destinationFields,
      genesis: { issuanceTxid: issuance.id, resourceTxid: genesis.id, syntheticFunding: true },
      artifacts: compiledArtifacts(),
      receipts: receipts.map(({ signedArkTx: _ark, signedCheckpoints: _cps, ...receipt }) => receipt),
    }),
    close: async () => { closed = true; },
    settle: async (prepared) => {
      if (closed) throw new Error("SDK runtime is closed");
      if (busy) throw new Error("Another native lane settlement is in flight");
      if (!sameState(state, prepared.oldState)) throw new Error("Native lane changed; rebase the public transition proof");
      if (prepared.intentSignals.length !== 25 || prepared.transitionSignals.length !== 30) throw new Error("Wrong proof profile signal counts");
      busy = true;
      try {
        const isSeal = prepared.operation === "seal";
        const inputs: CovenantInput[] = [{
          contract: gate,
          coin: heads.gate,
          functionName: isSeal ? "seal" : "apply",
          callArgs: isSeal ? [...transitionKeyWitness, ...proofArguments(prepared.transitionProof)] : [
            ...intentKeyWitness,
            ...transitionKeyWitness,
            ...proofArguments(prepared.intentProof ?? (() => { throw new Error("Missing wallet intent proof"); })()),
            ...proofArguments(prepared.transitionProof),
          ],
        }, { contract: contracts.lane, coin: heads.lane, functionName: "advance", callArgs: [] }];
        const depositBtc = BigInt(prepared.boundary.deposit.BTC);
        const depositToken = BigInt(prepared.boundary.deposit.DEMO);
        const withdrawBtc = BigInt(prepared.boundary.withdrawal.BTC);
        const withdrawToken = BigInt(prepared.boundary.withdrawal.DEMO);
        if ((depositBtc || withdrawBtc) && (depositToken || withdrawToken)) throw new Error("PoC boundary supports one asset at a time");
        const selectedVault = depositBtc || withdrawBtc ? "btcVault" : depositToken || withdrawToken ? "tokenVault" : undefined;
        if (selectedVault) inputs.push({ contract: contracts[selectedVault], coin: heads[selectedVault], functionName: "advance", callArgs: [] });
        const tokenPayoutCarrier = withdrawToken ? BigInt(ASSET_CARRIER_SATS) : 0n;
        const nextGateBtc = gateFundingBtc - depositBtc - tokenPayoutCarrier;
        const nextGateToken = gateFundingToken - depositToken;
        if (nextGateBtc < 0n || nextGateToken < 0n) throw new Error("Offline funding resource exhausted");
        const outputs: NativeOutput[] = [
          { script: gate.script.pkScript, amount: nextGateBtc },
          { script: contracts.lane.script.pkScript, amount: CARRIER },
        ];
        if (selectedVault) outputs.push({ script: contracts[selectedVault].script.pkScript, amount: selectedVault === "btcVault" ? CARRIER + BigInt(prepared.newState.reserves.BTC) : CARRIER });
        if (withdrawBtc || withdrawToken) {
          const owner = (Object.entries(destinations).find(([name, destination]) => destination === prepared.boundary.destination || destinationFields[name as Owner] === prepared.boundary.destination)?.[0]) as Owner | undefined;
          if (!owner) throw new Error("Payout destination is outside this demo's SDK wallets");
          outputs.push({ script: payoutScripts[owner], amount: withdrawBtc || tokenPayoutCarrier });
        }
        const assetAllocations: AssetAllocation[] = [{ assetId: identities.lane.toString(), inputs: [{ vin: 1, amount: 1n }], outputs: [{ vout: 1, amount: 1n }] }];
        if (selectedVault) assetAllocations.push({ assetId: identities[selectedVault].toString(), inputs: [{ vin: 2, amount: 1n }], outputs: [{ vout: 2, amount: 1n }] });
        const tokenInputs = gateFundingToken > 0n ? [{ vin: 0, amount: gateFundingToken }] : [];
        const tokenOutputs = nextGateToken > 0n ? [{ vout: 0, amount: nextGateToken }] : [];
        if (selectedVault === "tokenVault") {
          if (state.reserves.DEMO) tokenInputs.push({ vin: 2, amount: BigInt(state.reserves.DEMO) });
          if (prepared.newState.reserves.DEMO) tokenOutputs.push({ vout: 2, amount: BigInt(prepared.newState.reserves.DEMO) });
          if (withdrawToken) tokenOutputs.push({ vout: 3, amount: withdrawToken });
        }
        if (tokenInputs.length) assetAllocations.push({ assetId: identities.token.toString(), inputs: tokenInputs, outputs: tokenOutputs });
        const packets: PacketData[] = [
          { type: 0x80, data: encodeFields(prepared.intentSignals.slice(0, 13)) },
          { type: 0x81, data: encodeFields(prepared.intentSignals.slice(13, 25)) },
          { type: 0x82, data: encodeFields(prepared.transitionSignals.slice(19)) },
          statePacket(prepared.newState),
        ];
        const spend = await buildCovenantSpend({ inputs, outputs, checkpoint, packets, assets: assetAllocations });
        const result = await execute(bridgeRequest(spend));
        if (!result.ok) throw new Error(result.error ?? "Arkade emulator rejected transaction");
        if (!result.arkTx || !result.checkpoints || !result.txid) throw new Error("Incomplete emulator receipt");
        const signed = Transaction.fromPSBT(base64.decode(result.arkTx));
        if (signed.id !== spend.arkTx.id || result.txid !== signed.id) throw new Error("Emulator returned a different transaction");
        const receipt: NativeReceipt = {
          id: prepared.id, operation: prepared.operation, txid: signed.id,
          backend: result.backend, executedInputs: result.executedInputs ?? 0, signatureCount: result.signatureCount ?? 0,
          vmMs: result.durationMs, native: spendSummary(spend), publicSignalCounts: { intent: 25, transition: 30 },
          signedArkTx: result.arkTx, signedCheckpoints: result.checkpoints, proofTimes: prepared.proofTimes,
        };
        // Mutate native heads only after all VM checks and response binding pass.
        heads.gate = coinFromTransaction(signed, 0);
        heads.lane = coinFromTransaction(signed, 1);
        if (selectedVault) heads[selectedVault] = coinFromTransaction(signed, 2);
        gateFundingBtc = nextGateBtc;
        gateFundingToken = nextGateToken;
        state = structuredClone(prepared.newState);
        receipts.push(receipt);
        return receipt;
      } finally { busy = false; }
    },
  };
}
