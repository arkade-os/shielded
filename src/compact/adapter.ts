import {
  asset,
  buildOffchainTx,
  ConditionMultisigTapscript,
  CSVMultisigTapscript,
  Extension,
  P2A,
  scriptFromTapLeafScript,
  Transaction,
  UnknownPacket,
  VtxoScript,
  type ArkTxInput,
  type TapLeafScript,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { concatBytes } from "@noble/hashes/utils.js";

export const COMPACT_PACKET_TYPE = 0x84;
export const COMPACT_PACKET_LENGTH = 133;
const COMPACT_MAGIC = Uint8Array.of(0x53, 0x43, 0x4d, 0x50); // SCMP
const BINDING_DOMAIN = new TextEncoder().encode("ARKADE_COMPACT_BINDING_V1\0");
const BODY_DOMAIN = new TextEncoder().encode("ARKADE_COMPACT_NATIVE_BODY_V1\0");

export interface CompactPacket {
  readonly version: 1;
  readonly profileId: Uint8Array;
  readonly oldStateHash: Uint8Array;
  readonly newStateHash: Uint8Array;
  readonly bindingHash: Uint8Array;
}

export interface CompactClosure {
  readonly profileId: Uint8Array;
  readonly exitTimelock: RelativeTimelock;
  readonly script: Uint8Array;
  readonly tapTree: Uint8Array;
  readonly tapLeafScript: TapLeafScript;
  readonly pkScript: Uint8Array;
  readonly exitLeafScript: TapLeafScript;
}

export interface CompactInput {
  readonly coin: {
    readonly txid: string;
    readonly vout: number;
    readonly value: number;
    /** The raw transaction that created this VTXO. Required for provenance checks. */
    readonly sourceTx: Uint8Array;
  };
  readonly tapTree: Uint8Array;
  readonly tapLeafScript: TapLeafScript;
}

export interface CompactOutput {
  readonly script: Uint8Array;
  readonly amount: bigint;
}

export interface CompactAssetAllocation {
  readonly assetId: string;
  readonly inputs: readonly { vin: number; amount: bigint }[];
  readonly outputs: readonly { vout: number; amount: bigint }[];
}

export interface BuildCompactSpendOptions {
  readonly profileId: Uint8Array;
  readonly oldStateHash: Uint8Array;
  readonly newStateHash: Uint8Array;
  /** Canonically serialized full proof/public-signal sidecar transcript. */
  readonly sidecarTranscript: Uint8Array;
  readonly inputs: readonly CompactInput[];
  readonly outputs: readonly CompactOutput[];
  readonly checkpoint: CSVMultisigTapscript.Type;
  readonly exitTimelock: RelativeTimelock;
  readonly serverPubkey: Uint8Array;
  readonly emulatorPubkey: Uint8Array;
  readonly assets?: readonly CompactAssetAllocation[];
}

export interface BuiltCompactSpend {
  readonly arkTx: Transaction;
  readonly checkpoints: Transaction[];
  readonly extensionIndex: number;
  readonly anchorIndex: number;
  readonly packet: CompactPacket;
  readonly packetBytes: Uint8Array;
}

/**
 * Make the two-signer native closure used by the registered compact profile.
 * The script commits the profile id, then requires both operator keys. It does
 * not itself verify the proof; that remains the registered verifier's job.
 */
export function createCompactClosure(
  profileId: Uint8Array,
  serverPubkey: Uint8Array,
  emulatorPubkey: Uint8Array,
  exitTimelock: RelativeTimelock,
): CompactClosure {
  assert32("profileId", profileId);
  assert32("serverPubkey", serverPubkey);
  assert32("emulatorPubkey", emulatorPubkey);
  if (equalBytes(serverPubkey, emulatorPubkey)) throw new Error("Compact closure requires distinct server and emulator keys");

  // A 32-byte direct push is canonical here: 0x20 <profile> OP_DROP.
  const conditionScript = concatBytes(Uint8Array.of(32), profileId, Uint8Array.of(0x75, 0x51));
  const script = ConditionMultisigTapscript.encode({ conditionScript, pubkeys: [serverPubkey, emulatorPubkey] }).script;
  // Shared reserves cannot grant a unilateral exit to an individual user.
  // Keep the operator's existing CSV recovery authority explicit.
  const exitScript = CSVMultisigTapscript.encode({ timelock: exitTimelock, pubkeys: [emulatorPubkey] }).script;
  const tree = new VtxoScript([script, exitScript]);
  return {
    profileId: profileId.slice(),
    exitTimelock: { type: exitTimelock.type, value: exitTimelock.value },
    script,
    tapTree: tree.encode(),
    tapLeafScript: tree.findLeaf(hex.encode(script)),
    pkScript: tree.pkScript,
    exitLeafScript: tree.findLeaf(hex.encode(exitScript)),
  };
}

export function encodeCompactPacket(packet: CompactPacket): Uint8Array {
  if (packet.version !== 1) throw new Error(`Unsupported compact packet version ${packet.version}`);
  assert32("profileId", packet.profileId);
  assert32("oldStateHash", packet.oldStateHash);
  assert32("newStateHash", packet.newStateHash);
  assert32("bindingHash", packet.bindingHash);
  return concatBytes(COMPACT_MAGIC, Uint8Array.of(packet.version), packet.profileId,
    packet.oldStateHash, packet.newStateHash, packet.bindingHash);
}

export function decodeCompactPacket(bytes: Uint8Array): CompactPacket {
  if (bytes.length !== COMPACT_PACKET_LENGTH) throw new Error(`Compact packet must be ${COMPACT_PACKET_LENGTH} bytes`);
  if (!equalBytes(bytes.subarray(0, 4), COMPACT_MAGIC)) throw new Error("Invalid compact packet magic");
  if (bytes[4] !== 1) throw new Error(`Unsupported compact packet version ${bytes[4]}`);
  return {
    version: 1,
    profileId: bytes.slice(5, 37),
    oldStateHash: bytes.slice(37, 69),
    newStateHash: bytes.slice(69, 101),
    bindingHash: bytes.slice(101, 133),
  };
}

/** Return the compact payload from an SDK transaction, or null if absent. */
export function extractCompactPacket(tx: Transaction): CompactPacket | null {
  const extension = Extension.fromTx(tx);
  const packet = extension.getPacketByType(COMPACT_PACKET_TYPE);
  if (!packet) return null;
  return decodeCompactPacket(packet.serialize());
}

/**
 * Canonical serialization of transaction effects for the sidecar binding.
 * It includes ordered inputs (outpoint, sequence, prevout script and amount)
 * and ordered outputs (script and amount), while removing only packet 0x84
 * from the extension. The native asset packet remains byte-for-byte present.
 */
export function canonicalNativeBody(tx: Transaction): Uint8Array {
  const extensionIndexes: number[] = [];
  for (let index = 0; index < tx.outputsLength; index++) {
    const output = tx.getOutput(index);
    if (output.script && Extension.isExtension(output.script)) extensionIndexes.push(index);
  }
  if (extensionIndexes.length !== 1) throw new Error("Compact transaction must contain exactly one Arkade extension");
  const extensionIndex = extensionIndexes[0];
  const extensionOutput = tx.getOutput(extensionIndex);
  const extension = Extension.fromBytes(extensionOutput.script!);
  const packets = extension.getPackets();
  if (!packets.some((packet) => packet.type() === COMPACT_PACKET_TYPE)) throw new Error("Compact packet is missing");
  if (packets.some((packet) => packet.type() !== 0 && packet.type() !== COMPACT_PACKET_TYPE)) {
    throw new Error("Compact extension may contain only native assets and packet 0x84");
  }
  const strippedPackets = packets.filter((packet) => packet.type() !== COMPACT_PACKET_TYPE);
  // Retain the native asset packet exactly. With no asset packet, OP_RETURN is
  // the canonical empty-extension placeholder after removing packet 0x84.
  const strippedExtensionScript = strippedPackets.length ? Extension.create(strippedPackets).serialize() : Uint8Array.of(0x6a);

  const parts: Uint8Array[] = [BODY_DOMAIN, u32le(tx.version), u32le(tx.lockTime), compactSize(tx.inputsLength)];
  for (let index = 0; index < tx.inputsLength; index++) {
    const input = tx.getInput(index);
    if (input.txid === undefined) throw new Error(`Missing input txid at ${index}`);
    const txid = txidWireBytes(input.txid, index);
    const vout = input.index;
    if (typeof vout !== "number" || !Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error(`Invalid input vout at ${index}`);
    const witnessUtxo = input.witnessUtxo;
    if (!witnessUtxo?.script || typeof witnessUtxo.amount !== "bigint" || witnessUtxo.amount < 0n) {
      throw new Error(`Compact input ${index} is missing a valid prevout`);
    }
    const sequence = input.sequence ?? 0xffffffff;
    parts.push(txid, u32le(vout), u32le(sequence),
      u64le(witnessUtxo.amount), varSlice(witnessUtxo.script));
  }
  parts.push(compactSize(tx.outputsLength));
  for (let index = 0; index < tx.outputsLength; index++) {
    const output = tx.getOutput(index);
    if (!output.script || typeof output.amount !== "bigint" || output.amount < 0n) throw new Error(`Invalid output ${index}`);
    const script = index === extensionIndex ? strippedExtensionScript : output.script;
    parts.push(u64le(output.amount), varSlice(script));
  }
  return concatBytes(...parts);
}

export function nativeEffectDigest(tx: Transaction): Uint8Array {
  return sha256(canonicalNativeBody(tx));
}

export function compactBindingHash(sidecarTranscript: Uint8Array, tx: Transaction): Uint8Array {
  if (sidecarTranscript.length === 0) throw new Error("Compact sidecar transcript is required");
  return bindingHashForBody(sidecarTranscript, canonicalNativeBody(tx));
}

/** Assemble SDK-native VTXO spending transactions with a 133-byte compact packet. */
export async function buildCompactSpend(options: BuildCompactSpendOptions): Promise<BuiltCompactSpend> {
  assert32("profileId", options.profileId);
  assert32("oldStateHash", options.oldStateHash);
  assert32("newStateHash", options.newStateHash);
  if (options.sidecarTranscript.length === 0) throw new Error("Compact sidecar transcript is required");
  if (options.inputs.length === 0) throw new Error("A compact spend needs an input");
  if (options.outputs.length === 0) throw new Error("A compact spend needs an output");

  const seen = new Set<string>();
  let inputTotal = 0n;
  const sdkInputs: ArkTxInput[] = [];
  for (const [vin, input] of options.inputs.entries()) {
    if (!input.coin.sourceTx) throw new Error(`Compact input ${vin} requires its creating transaction`);
    if (!Number.isSafeInteger(input.coin.value) || input.coin.value <= 0) throw new Error(`Invalid native value for input ${vin}`);
    if (!Number.isInteger(input.coin.vout) || input.coin.vout < 0) throw new Error(`Invalid vout for input ${vin}`);
    if (!/^[0-9a-fA-F]{64}$/.test(input.coin.txid)) throw new Error(`Invalid txid for input ${vin}`);
    const outpoint = `${input.coin.txid.toLowerCase()}:${input.coin.vout}`;
    if (seen.has(outpoint)) throw new Error(`Duplicate compact input ${outpoint}`);
    seen.add(outpoint);

    const previous = Transaction.fromRaw(input.coin.sourceTx);
    if (previous.id.toLowerCase() !== input.coin.txid.toLowerCase()) throw new Error(`Previous transaction ID mismatch at input ${vin}`);
    const previousOutput = previous.getOutput(input.coin.vout);
    const inputScript = VtxoScript.decode(input.tapTree).pkScript;
    validateProfileInput(input, options.profileId, options.serverPubkey, options.emulatorPubkey, options.exitTimelock, vin);
    if (!previousOutput?.script || previousOutput.amount !== BigInt(input.coin.value) || !equalBytes(previousOutput.script, inputScript)) {
      throw new Error(`Previous output does not match compact VTXO at input ${vin}`);
    }
    sdkInputs.push({ txid: input.coin.txid, vout: input.coin.vout, value: input.coin.value,
      tapTree: input.tapTree, tapLeafScript: input.tapLeafScript });
    inputTotal += BigInt(input.coin.value);
  }
  if (options.outputs.some((output) => output.amount <= 0n)) throw new Error("Compact outputs must be positive");
  if (options.outputs.some((output) => output.script.length === 0)) throw new Error("Compact outputs need locking scripts");
  const outputTotal = options.outputs.reduce((sum, output) => sum + output.amount, 0n);
  if (inputTotal !== outputTotal) throw new Error(`Native backing must be exact: inputs ${inputTotal}, outputs ${outputTotal}`);
  validateCompactAssets(options.inputs, options.assets ?? [], options.outputs.length);

  const packets = [];
  if (options.assets?.length) packets.push(assetPacket(options.assets));
  const placeholder = encodeCompactPacket({ version: 1, profileId: options.profileId,
    oldStateHash: options.oldStateHash, newStateHash: options.newStateHash, bindingHash: new Uint8Array(32) });
  packets.push(new UnknownPacket(COMPACT_PACKET_TYPE, placeholder));
  const extension = Extension.create(packets);
  const outputs = [...options.outputs, extension.txOut()];
  const { arkTx, checkpoints } = buildOffchainTx(sdkInputs, outputs, options.checkpoint);
  const canonicalBody = canonicalNativeBody(arkTx);
  const bindingHash = bindingHashForBody(options.sidecarTranscript, canonicalBody);
  const packet: CompactPacket = { version: 1, profileId: options.profileId.slice(), oldStateHash: options.oldStateHash.slice(),
    newStateHash: options.newStateHash.slice(), bindingHash };
  const packetBytes = encodeCompactPacket(packet);
  const finalPackets = [];
  if (options.assets?.length) finalPackets.push(assetPacket(options.assets));
  finalPackets.push(new UnknownPacket(COMPACT_PACKET_TYPE, packetBytes));
  const finalExtension = Extension.create(finalPackets);
  arkTx.updateOutput(options.outputs.length, finalExtension.txOut());
  if (!equalBytes(canonicalBody, canonicalNativeBody(arkTx))) {
    throw new Error("Compact packet replacement changed the canonical native body");
  }
  return { arkTx, checkpoints, extensionIndex: options.outputs.length, anchorIndex: options.outputs.length + 1, packet, packetBytes };
}

function validateProfileInput(input: CompactInput, profileId: Uint8Array, serverPubkey: Uint8Array, emulatorPubkey: Uint8Array,
  exitTimelock: RelativeTimelock, vin: number): void {
  assert32("serverPubkey", serverPubkey);
  assert32("emulatorPubkey", emulatorPubkey);
  const script = scriptFromTapLeafScript(input.tapLeafScript);
  const decoded = ConditionMultisigTapscript.decode(script);
  const expectedCondition = concatBytes(Uint8Array.of(32), profileId, Uint8Array.of(0x75, 0x51));
  if (!equalBytes(decoded.params.conditionScript, expectedCondition) || decoded.params.pubkeys.length !== 2 ||
      !equalBytes(decoded.params.pubkeys[0], serverPubkey) || !equalBytes(decoded.params.pubkeys[1], emulatorPubkey)) {
    throw new Error(`Compact input ${vin} does not use the registered profile closure`);
  }
  const tree = VtxoScript.decode(input.tapTree);
  const expectedLeaf = tree.findLeaf(hex.encode(script));
  if (!equalBytes(expectedLeaf[0].internalKey, input.tapLeafScript[0].internalKey) ||
      !equalBytes(expectedLeaf[1], input.tapLeafScript[1]) || expectedLeaf[0].merklePath.length !== input.tapLeafScript[0].merklePath.length ||
      expectedLeaf[0].merklePath.some((path, index) => !equalBytes(path, input.tapLeafScript[0].merklePath[index]))) {
    throw new Error(`Compact input ${vin} has a mismatched tapleaf proof`);
  }
  const exitPaths = tree.scripts.flatMap((candidate) => {
    try { return [CSVMultisigTapscript.decode(candidate)]; } catch { return []; }
  });
  if (exitPaths.length !== 1 || exitPaths[0].params.pubkeys.length !== 1 || !equalBytes(exitPaths[0].params.pubkeys[0], emulatorPubkey) ||
      exitPaths[0].params.timelock.type !== exitTimelock.type || exitPaths[0].params.timelock.value !== exitTimelock.value) {
    throw new Error(`Compact input ${vin} must retain the profile CSV recovery path`);
  }
}

function validateCompactAssets(inputs: readonly CompactInput[], allocations: readonly CompactAssetAllocation[], outputCount: number): void {
  const held = new Map<string, Map<number, bigint>>();
  for (const [vin, input] of inputs.entries()) {
    const previous = Transaction.fromRaw(input.coin.sourceTx);
    let packet;
    try { packet = Extension.fromTx(previous).getAssetPacket(); } catch { packet = null; }
    for (const [groupIndex, group] of (packet?.groups ?? []).entries()) {
      const quantity = group.outputs.filter((entry) => entry.vout === input.coin.vout).reduce((sum, entry) => sum + entry.amount, 0n);
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
    if (supplied.has(id)) throw new Error(`Duplicate compact native asset group ${id}`);
    supplied.add(id);
    const actual = held.get(id);
    const seen = new Set<number>();
    for (const { vin, amount } of allocation.inputs) {
      if (!Number.isInteger(vin) || vin < 0 || vin >= inputs.length || seen.has(vin) || amount <= 0n) throw new Error(`Invalid compact asset input ${vin}`);
      seen.add(vin);
      if (actual?.get(vin) !== amount) throw new Error(`Unauthenticated compact asset allocation ${id} at input ${vin}`);
    }
    for (const vin of actual?.keys() ?? []) if (!seen.has(vin)) throw new Error(`Omitted compact asset ${id} at input ${vin}`);
    const inputTotal = allocation.inputs.reduce((sum, entry) => sum + entry.amount, 0n);
    const outputTotal = allocation.outputs.reduce((sum, entry) => sum + entry.amount, 0n);
    if (inputTotal !== outputTotal) throw new Error(`Compact asset conservation failed for ${id}`);
    if (allocation.outputs.some(({ vout, amount }) => !Number.isInteger(vout) || vout < 0 || vout >= outputCount || amount <= 0n)) {
      throw new Error(`Invalid compact asset output for ${id}`);
    }
  }
  for (const id of held.keys()) if (!supplied.has(id)) throw new Error(`Omitted compact native asset group ${id}`);
}

function assetPacket(allocations: readonly CompactAssetAllocation[]) {
  return asset.Packet.create(allocations.map((allocation) => asset.AssetGroup.create(
    asset.AssetId.fromString(allocation.assetId), null,
    allocation.inputs.map(({ vin, amount }) => asset.AssetInput.create(vin, amount)),
    allocation.outputs.map(({ vout, amount }) => asset.AssetOutput.create(vout, amount)), [])));
}

function assert32(name: string, bytes: Uint8Array): void {
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function reverse(bytes: Uint8Array): Uint8Array { return Uint8Array.from(bytes).reverse(); }
function bindingHashForBody(transcript: Uint8Array, body: Uint8Array): Uint8Array {
  return sha256(concatBytes(BINDING_DOMAIN, u32be(transcript.length), transcript, u32be(body.length), body));
}
function txidWireBytes(txid: string | Uint8Array, index: number): Uint8Array {
  if (typeof txid === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`Invalid input txid at ${index}`);
    return reverse(hex.decode(txid));
  }
  if (!(txid instanceof Uint8Array) || txid.length !== 32) throw new Error(`Invalid input txid at ${index}`);
  return txid.slice();
}
function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("u32 out of range");
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}
function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("u32 out of range");
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}
function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i++) { bytes[i] = Number(remaining & 0xffn); remaining >>= 8n; }
  return bytes;
}
function compactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("CompactSize out of range");
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return concatBytes(Uint8Array.of(0xfd), Uint8Array.of(value & 0xff, value >>> 8));
  if (value <= 0xffffffff) return concatBytes(Uint8Array.of(0xfe), u32le(value));
  throw new Error("CompactSize is too large");
}
function varSlice(bytes: Uint8Array): Uint8Array { return concatBytes(compactSize(bytes.length), bytes); }
