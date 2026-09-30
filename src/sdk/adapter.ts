import {
  arkade,
  asset,
  attachPrevArkTxs,
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  Extension,
  EmulatorPacket,
  networks,
  P2A,
  PrevArkTxField,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  setArkPsbtField,
  Transaction,
  type ArkTxInput,
  type Identity,
  type ExtensionPacket,
  type PrevTxSource,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";

// The SDK's bundled declarations currently expose some namespace type aliases
// as values. Derive these types from its public runtime API until that upstream
// declaration issue is corrected; this remains the SDK's actual Program shape.
export type Program = ReturnType<typeof arkade.programFromArtifact>;
export type ProgramScript = InstanceType<typeof arkade.ArkadeProgramScript>;
export type ProgramKeys = ConstructorParameters<typeof arkade.ArkadeProgramScript>[2];
export type ParamValue = Parameters<typeof arkade.witnessRefToBytes>[2][string];
export type ArgValue = Parameters<typeof arkade.witnessRefToBytes>[1][string];
type WitnessRef = Parameters<typeof arkade.witnessRefToBytes>[0];

/** Every locking script used by the app originates in an arkadec artifact. */
export interface CompiledContract {
  readonly artifact: arkade.ContractArtifact;
  readonly program: Program;
  readonly args: Record<string, ParamValue>;
  readonly script: ProgramScript;
  readonly keys: ProgramKeys;
}

export function instantiateArtifact(
  artifact: arkade.ContractArtifact,
  args: Record<string, ParamValue>,
  keys: ProgramKeys,
): CompiledContract {
  const program = arkade.programFromArtifact(artifact);
  const bound = { server: keys.serverKey, ...args };
  const script = new arkade.ArkadeProgramScript(program, bound, keys);
  return { artifact, program, args: bound, script, keys };
}

export interface ResourceCoin {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  /** Raw original creating transaction, never its checkpoint or PSBT. */
  readonly sourceTx?: Uint8Array;
}

export interface CovenantInput {
  readonly contract: CompiledContract;
  readonly coin: ResourceCoin;
  readonly functionName: string;
  /** Flattened ABI arguments. The SDK arranges the actual witness order. */
  readonly callArgs: readonly ArgValue[];
}

export interface NativeOutput {
  readonly script: Uint8Array;
  readonly amount: bigint;
}

export interface PacketData {
  readonly type: number;
  readonly data: Uint8Array;
}

/** A locally allocated application packet carried by the SDK Extension. */
export function opaquePacket(packet: PacketData) {
  if (packet.type === 0 || packet.type === 1) {
    throw new Error("Application packets cannot replace native asset or emulator packets");
  }
  return { type: () => packet.type, serialize: () => packet.data };
}

export interface AssetAllocation {
  readonly assetId: string;
  readonly inputs: readonly { vin: number; amount: bigint }[];
  readonly outputs: readonly { vout: number; amount: bigint }[];
}

export function transferAssetPacket(allocations: readonly AssetAllocation[]) {
  return asset.Packet.create(
    allocations.map((allocation) =>
      asset.AssetGroup.create(
        asset.AssetId.fromString(allocation.assetId),
        null,
        allocation.inputs.map(({ vin, amount }) => asset.AssetInput.create(vin, amount)),
        allocation.outputs.map(({ vout, amount }) => asset.AssetOutput.create(vout, amount)),
        [],
      ),
    ),
  );
}

/**
 * Strict ordinary-transfer provenance check for the offline emulator harness.
 * The emulator's packet introspection sees declared allocations; production
 * arkd separately validates assets. Here every declared input is compared to
 * the actual original output's packet, and every held asset must continue.
 */
export function validateNativeAssetTransfers(
  inputs: readonly CovenantInput[],
  allocations: readonly AssetAllocation[],
  outputCount: number,
): void {
  const held = new Map<string, Map<number, bigint>>();
  for (const [vin, input] of inputs.entries()) {
    if (!input.coin.sourceTx) continue; // Live indexer/arkd supplies validation.
    const previous = Transaction.fromRaw(input.coin.sourceTx);
    let packet;
    try { packet = Extension.fromTx(previous).getAssetPacket(); } catch { packet = null; }
    for (const [groupIndex, group] of (packet?.groups ?? []).entries()) {
      const quantity = group.outputs.filter((entry) => entry.vout === input.coin.vout)
        .reduce((sum, entry) => sum + entry.amount, 0n);
      if (!quantity) continue;
      const id = group.assetId ?? asset.AssetId.create(previous.id, groupIndex);
      const byInput = held.get(id.toString()) ?? new Map<number, bigint>();
      byInput.set(vin, (byInput.get(vin) ?? 0n) + quantity);
      held.set(id.toString(), byInput);
    }
  }
  const supplied = new Set<string>();
  for (const allocation of allocations) {
    const id = asset.AssetId.fromString(allocation.assetId).toString();
    if (supplied.has(id)) throw new Error(`Duplicate native asset group ${id}`);
    supplied.add(id);
    const actual = held.get(id);
    const seen = new Set<number>();
    for (const { vin, amount } of allocation.inputs) {
      if (!Number.isInteger(vin) || vin < 0 || vin >= inputs.length || seen.has(vin)) {
        throw new Error(`Invalid native asset input ${vin}`);
      }
      seen.add(vin);
      if (inputs[vin].coin.sourceTx && actual?.get(vin) !== amount) {
        throw new Error(`Unauthenticated native asset allocation ${id} at input ${vin}`);
      }
    }
    for (const vin of actual?.keys() ?? []) {
      if (!seen.has(vin)) throw new Error(`Omitted native asset ${id} at input ${vin}`);
    }
    const inputSum = allocation.inputs.reduce((sum, entry) => sum + entry.amount, 0n);
    const outputSum = allocation.outputs.reduce((sum, entry) => sum + entry.amount, 0n);
    if (inputSum !== outputSum) throw new Error(`Native asset conservation failed for ${id}`);
    if (allocation.outputs.some(({ vout, amount }) => !Number.isInteger(vout) || vout < 0 || vout >= outputCount || amount <= 0n)) {
      throw new Error(`Invalid native asset output for ${id}`);
    }
  }
  for (const id of held.keys()) {
    if (!supplied.has(id)) throw new Error(`Omitted native asset group ${id}`);
  }
}

export interface BuildSpendOptions {
  readonly inputs: readonly CovenantInput[];
  readonly outputs: readonly NativeOutput[];
  readonly checkpoint: CSVMultisigTapscript.Type;
  readonly packets?: readonly PacketData[];
  readonly assets?: readonly AssetAllocation[];
  readonly prevTxSource?: PrevTxSource;
}

export interface BuiltCovenantSpend {
  readonly arkTx: Transaction;
  readonly checkpoints: Transaction[];
  readonly inputs: readonly CovenantInput[];
  readonly extensionIndex: number;
  readonly anchorIndex: number;
  readonly emulatorEntries: readonly {
    vin: number;
    script: Uint8Array;
    witness: Uint8Array;
  }[];
}

/**
 * SDK-native multi-input assembly. The fluent Arkade builder currently handles
 * one covenant input; buildOffchainTx is the supported primitive for lane,
 * verifier and vault inputs together.
 */
export async function buildCovenantSpend(options: BuildSpendOptions): Promise<BuiltCovenantSpend> {
  if (options.inputs.length === 0) throw new Error("A covenant spend needs an input");
  if (options.outputs.length === 0) throw new Error("A covenant spend needs an output");
  const seen = new Set<string>();
  let inputTotal = 0n;
  const sdkInputs: ArkTxInput[] = [];
  const entries: { vin: number; script: Uint8Array; witness: Uint8Array }[] = [];
  const conditions: Uint8Array[][] = [];
  for (const [vin, input] of options.inputs.entries()) {
    const outpoint = `${input.coin.txid}:${input.coin.vout}`;
    if (seen.has(outpoint)) throw new Error(`Duplicate native resource ${outpoint}`);
    seen.add(outpoint);
    if (!Number.isSafeInteger(input.coin.value) || input.coin.value < 0) {
      throw new Error(`Invalid native value for input ${vin}`);
    }
    const fn = input.contract.script.compiled.find((entry) => entry.name === input.functionName);
    if (!fn?.arkadeScript) throw new Error(`Missing covenant function ${input.functionName}`);
    const names = (fn.def.inputs ?? []).map((ref) => typeof ref === "string" ? ref : ref.name);
    if (names.length !== input.callArgs.length) {
      throw new Error(`${input.functionName}: expected ${names.length} flattened arguments, got ${input.callArgs.length}`);
    }
    const callArgs = Object.fromEntries(names.map((name, i) => [name, input.callArgs[i]]));
    const witnessBytes = (ref: WitnessRef) =>
      arkade.witnessRefToBytes(ref, callArgs, input.contract.args);
    entries.push({
      vin,
      script: fn.arkadeScript,
      witness: RawWitness.encode((fn.def.arkadeScript?.witness ?? []).map(witnessBytes)),
    });
    conditions.push((fn.def.tapscript.witness ?? []).map(witnessBytes));
    sdkInputs.push({
      txid: input.coin.txid,
      vout: input.coin.vout,
      value: input.coin.value,
      tapTree: input.contract.script.encode(),
      tapLeafScript: fn.tapLeafScript,
    });
    inputTotal += BigInt(input.coin.value);
  }
  const outputTotal = options.outputs.reduce((sum, output) => sum + output.amount, 0n);
  if (options.outputs.some((output) => output.amount < 0n)) throw new Error("Negative native output");
  if (inputTotal !== outputTotal) {
    throw new Error(`Native backing must be exact: inputs ${inputTotal}, outputs ${outputTotal}`);
  }
  const packets = [];
  validateNativeAssetTransfers(options.inputs, options.assets ?? [], options.outputs.length);
  if (options.assets?.length) packets.push(transferAssetPacket(options.assets));
  packets.push(EmulatorPacket.create(entries));
  packets.push(...(options.packets ?? []).map(opaquePacket));
  const extension = Extension.create(packets);
  const outputs = [...options.outputs, extension.txOut()];
  const { arkTx, checkpoints } = buildOffchainTx(sdkInputs, outputs, options.checkpoint);
  for (const [vin, input] of options.inputs.entries()) {
    if (input.coin.sourceTx) {
      const previous = Transaction.fromRaw(input.coin.sourceTx);
      if (previous.id !== input.coin.txid) throw new Error(`Previous transaction ID mismatch at input ${vin}`);
      const previousOutput = previous.getOutput(input.coin.vout);
      if (!previousOutput?.script || previousOutput.amount !== BigInt(input.coin.value)) {
        throw new Error(`Previous native value mismatch at input ${vin}`);
      }
      if (hex.encode(previousOutput.script) !== hex.encode(input.contract.script.pkScript)) {
        throw new Error(`Previous contract lock mismatch at input ${vin}`);
      }
      setArkPsbtField(arkTx, vin, PrevArkTxField, input.coin.sourceTx);
    }
    if (conditions[vin].length) {
      setArkPsbtField(arkTx, vin, ConditionWitness, conditions[vin]);
      setArkPsbtField(checkpoints[vin], 0, ConditionWitness, conditions[vin]);
    }
  }
  const missing = options.inputs.filter((input) => !input.coin.sourceTx);
  if (missing.length) {
    if (!options.prevTxSource) throw new Error("Missing previous transactions and no SDK indexer source supplied");
    await attachPrevArkTxs(arkTx, options.inputs.map((input) => input.coin.txid), options.prevTxSource);
  }
  return {
    arkTx,
    checkpoints,
    inputs: options.inputs,
    extensionIndex: options.outputs.length,
    anchorIndex: options.outputs.length + 1,
    emulatorEntries: entries,
  };
}

export interface VmBridgeRequest {
  readonly arkTx: string;
  readonly checkpoints: string[];
}

/** Same base64 PSBT envelope consumed by RestEmulatorProvider.submitTx. */
export function bridgeRequest(spend: BuiltCovenantSpend): VmBridgeRequest {
  return {
    arkTx: base64.encode(spend.arkTx.toPSBT()),
    checkpoints: spend.checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  };
}

export function spendSummary(spend: BuiltCovenantSpend) {
  return {
    txid: spend.arkTx.id,
    nativeInputs: spend.arkTx.inputsLength,
    nativeOutputs: spend.arkTx.outputsLength,
    checkpointCount: spend.checkpoints.length,
    extensionIndex: spend.extensionIndex,
    anchorIndex: spend.anchorIndex,
    txBytes: spend.arkTx.toBytes().length,
    psbtBytes: spend.arkTx.toPSBT().length,
    extensionBytes: spend.arkTx.getOutput(spend.extensionIndex).script!.length,
    covenantBytes: spend.emulatorEntries.map((entry) => entry.script.length),
    witnessBytes: spend.emulatorEntries.map((entry) => entry.witness.length),
    inputs: spend.inputs.map((input) => ({
      outpoint: `${input.coin.txid}:${input.coin.vout}`,
      contract: input.contract.program.name,
      function: input.functionName,
      amount: input.coin.value,
    })),
  };
}

/**
 * Offline harness genesis is explicitly synthetic. Subsequent state heads are
 * real SDK-built transactions executed against the emulator, not fabricated
 * outpoints or provider responses. Live mode obtains these outputs from arkd.
 */
export function offlineGenesis(
  outputs: readonly NativeOutput[],
  packets: readonly PacketData[] = [],
  tokenIssuance?: { vout: number; amount: bigint },
): Transaction {
  const extensionPackets: ExtensionPacket[] = packets.map(opaquePacket);
  if (tokenIssuance) {
    extensionPackets.unshift(asset.Packet.create([
      asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(tokenIssuance.vout, tokenIssuance.amount)], []),
    ]));
  }
  return offlineNativeFixture(outputs, extensionPackets);
}

export function offlineNativeFixture(
  outputs: readonly NativeOutput[],
  extensionPackets: readonly ExtensionPacket[] = [],
  sourceOutpoint?: { txid: string; vout: number },
): Transaction {
  const tx = new Transaction({ version: 3, lockTime: 0 });
  tx.addInput({ txid: sourceOutpoint?.txid ?? "11".repeat(32), index: sourceOutpoint?.vout ?? 0, sequence: 0xfffffffd });
  for (const output of outputs) tx.addOutput(output);
  if (extensionPackets.length) tx.addOutput(Extension.create([...extensionPackets]).txOut());
  tx.addOutput(P2A);
  return tx;
}

export function coinFromTransaction(tx: Transaction, vout: number): ResourceCoin {
  const output = tx.getOutput(vout);
  if (!output?.amount || output.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Missing or invalid resource output ${vout}`);
  }
  return { txid: tx.id, vout, value: Number(output.amount), sourceTx: tx.toBytes() };
}

/** Actual network providers, with an explicit regtest-only publication guard. */
export async function connectRegtest(options: {
  arkUrl: string;
  emulatorUrl: string;
  identity?: Identity;
  emulatorPubkey?: string;
}) {
  const arkProvider = new RestArkProvider(options.arkUrl);
  const indexer = new RestIndexerProvider(options.arkUrl);
  const emulator = new RestEmulatorProvider(options.emulatorUrl);
  const info = await arkProvider.getInfo();
  if (info.network !== "regtest") throw new Error("Proof-of-concept network publication requires regtest");
  const client = await arkade.Arkade.connect({
    arkade: arkProvider,
    emulator,
    indexer,
    identity: options.identity,
    network: networks.regtest,
    emulatorPubkey: options.emulatorPubkey,
  });
  return { client, arkProvider, indexer, emulator };
}

export async function submitRegtest(
  spend: BuiltCovenantSpend,
  connection: Awaited<ReturnType<typeof connectRegtest>>,
  identity?: Identity,
  userInputIndexes: number[] = [],
) {
  if (userInputIndexes.length && !identity) throw new Error("User inputs require their SDK signing identity");
  const arkTx = identity && userInputIndexes.length
    ? await identity.sign(spend.arkTx, userInputIndexes)
    : spend.arkTx;
  const checkpoints = await Promise.all(spend.checkpoints.map((checkpoint, i) =>
    identity && userInputIndexes.includes(i) ? identity.sign(checkpoint, [0]) : checkpoint));
  return connection.emulator.submitTx(
    base64.encode(arkTx.toPSBT()),
    checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  );
}
