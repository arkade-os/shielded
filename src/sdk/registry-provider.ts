import { createHash } from "node:crypto";
import { base64, hex } from "@scure/base";
import { ConditionMultisigTapscript, Extension, matchServerCheckpoints, MultisigTapscript, Transaction, verifyTapscriptSignatures } from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import type { VmBridgeRequest } from "./adapter.ts";

export interface RegisteredEmulatorInfo {
  version: "shielded-registry/1";
  signerPubkey: string;
  registryProtocol: "shielded-registered-v1";
  registryHash: string;
  registeredPrograms: string[];
  maxSidecarBytes: number;
}

export interface RegistryProviderOptions {
  url: string;
  signerPubkey: string;
  operatorSignerPubkey: string;
  registryHash: string;
  programs: Readonly<Record<string, string>>;
  requiredProgramIds: readonly string[];
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const HASH = /^[0-9a-f]{64}$/;
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/;
const MAX_SIDECAR = 128 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;

function endpoint(raw: string, allowLoopbackHttp: boolean): URL {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error("Registry endpoint cannot contain credentials, query, or fragment");
  if (url.protocol !== "https:" && !(allowLoopbackHttp && local && url.protocol === "http:")) throw new Error("Registry endpoint requires HTTPS; HTTP is allowed only for explicit loopback tests");
  return url;
}

function canonicalHash(value: string, field: string): string {
  if (!HASH.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function canonicalEmulatorKey(value: string): string {
  if (!COMPRESSED_KEY.test(value)) throw new Error("Invalid pinned compressed emulator key");
  return value;
}

export function computeRegistryHash(programs: Readonly<Record<string, string>>): string {
  const rawEntries = Object.entries(programs);
  if (rawEntries.length < 1 || rawEntries.length > 32) throw new Error("Registry must contain between 1 and 32 programs");
  const entries = rawEntries.map(([id, program]) => {
    const normalized = canonicalHash(id, "registered program ID");
    if (!/^(?:[0-9a-f]{2})+$/.test(program) || program.length / 2 > 10_000 || hex.encode(sha256(hex.decode(program))) !== normalized) throw new Error("Registered program bytes do not match their ID or limits");
    return [normalized, program] as const;
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(entries)), "utf8").digest("hex");
}

async function readJsonBounded(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE) throw new Error("Registry response exceeds size limit");
  if (!response.body) throw new Error("Registry response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error("Registry response exceeds size limit"); }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error("Registry returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Registry returned an invalid response object");
  return parsed as Record<string, unknown>;
}

export function decodeRegistryInfo(value: Record<string, unknown>): RegisteredEmulatorInfo {
  if (value.version !== "shielded-registry/1" || value.registryProtocol !== "shielded-registered-v1") throw new Error("Unsupported registered emulator protocol");
  const signerPubkey = canonicalEmulatorKey(String(value.signerPubkey ?? ""));
  const registryHash = canonicalHash(String(value.registryHash ?? ""), "registry hash");
  if (!Array.isArray(value.registeredPrograms) || value.registeredPrograms.some((id) => typeof id !== "string" || !HASH.test(id))) throw new Error("Invalid registered program list");
  const registeredPrograms = value.registeredPrograms as string[];
  if (registeredPrograms.some((id, index) => index > 0 && registeredPrograms[index - 1]! >= id)) throw new Error("Registered program list must be unique and sorted");
  if (!Number.isSafeInteger(value.maxSidecarBytes) || Number(value.maxSidecarBytes) < 1 || Number(value.maxSidecarBytes) > MAX_SIDECAR) throw new Error("Invalid registered sidecar limit");
  return { version: "shielded-registry/1", signerPubkey, registryProtocol: "shielded-registered-v1", registryHash, registeredPrograms: [...registeredPrograms], maxSidecarBytes: Number(value.maxSidecarBytes) };
}

function readSidecar(raw: Uint8Array): { vin: number; id: string }[] {
  let offset = 0;
  const take = (length: number) => {
    if (!Number.isInteger(length) || length < 0 || offset + length > raw.length) throw new Error("Malformed registry sidecar");
    const value = raw.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const u16 = () => { const bytes = take(2); return bytes[0]! | (bytes[1]! << 8); };
  const header = take(2);
  if (header[0] !== 0x53 || header[1] !== 1) throw new Error("Unsupported registry sidecar format");
  for (let type = 0x80; type <= 0x83; type++) {
    const size = u16();
    if (size > 520) throw new Error("Invalid registry public packet size");
    take(size);
  }
  if (u16() !== 160) throw new Error("Invalid registry sidecar state");
  take(160);
  const count = take(1)[0]!;
  if (count < 1 || count > 4) throw new Error("Invalid registry sidecar input count");
  const entries: { vin: number; id: string }[] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const vin = u16();
    if (vin <= previous) throw new Error("Noncanonical registry sidecar inputs");
    previous = vin;
    entries.push({ vin, id: hex.encode(take(32)) });
    const witnesses = u16();
    if (witnesses > 1000) throw new Error("Invalid registry witness count");
    for (let w = 0; w < witnesses; w++) {
      const size = u16();
      if (size > 520) throw new Error("Registry witness exceeds VM limit");
      take(size);
    }
  }
  if (offset !== raw.length) throw new Error("Trailing registry sidecar bytes");
  return entries;
}

function emulatorTweak(basePubkey: string, program: Uint8Array): string {
  const point = schnorr.utils.lift_x(BigInt(`0x${basePubkey.slice(-64)}`));
  const tagged = schnorr.utils.taggedHash("ArkScriptHash", program);
  const scalar = BigInt(`0x${hex.encode(tagged)}`) % secp256k1.Point.CURVE().n;
  return hex.encode(schnorr.utils.pointToBytes(point.add(schnorr.Point.BASE.multiply(scalar))));
}

function covenantSigners(script: Uint8Array): string[] {
  return (ConditionMultisigTapscript.isScriptValid(script) === true ? ConditionMultisigTapscript.decode(script) : MultisigTapscript.decode(script)).params.pubkeys.map(hex.encode);
}

function verifyEmulatorResponse(request: VmBridgeRequest, result: { signedArkTx: string; signedCheckpointTxs: string[] }, info: RegisteredEmulatorInfo, options: RegistryProviderOptions) {
  const expectedArk = Transaction.fromPSBT(base64.decode(request.arkTx));
  const signedArk = Transaction.fromPSBT(base64.decode(result.signedArkTx));
  const arkEnvelope = Extension.fromTx(expectedArk).getEmulatorPacket();
  if (!arkEnvelope) throw new Error("Missing registered emulator packet");
  const checkpointToInput = new Map<string, number>();
  for (let vin = 0; vin < expectedArk.inputsLength; vin++) {
    const input = expectedArk.getInput(vin);
    if (input.index !== 0 || checkpointToInput.has(hex.encode(input.txid!))) throw new Error("Ark input does not reference a unique registered checkpoint output");
    checkpointToInput.set(hex.encode(input.txid!), vin);
  }
  const verifySigned = (signed: Transaction, expected: Transaction, sourceVins: readonly number[]) => {
    if (signed.id !== expected.id || !Buffer.from(signed.unsignedTx).equals(Buffer.from(expected.unsignedTx))) throw new Error("Registered emulator changed the submitted transaction body");
    if (signed.inputsLength !== expected.inputsLength) throw new Error("Registered emulator changed transaction inputs");
    for (let vin = 0; vin < expected.inputsLength; vin++) {
      const original = expected.getInput(vin);
      const actual = signed.getInput(vin);
      const leaf = original.tapLeafScript?.[0];
      const signedLeaf = actual.tapLeafScript?.[0];
      if (!leaf || !signedLeaf || !Buffer.from(TaprootControlBlock.encode(leaf[0])).equals(Buffer.from(TaprootControlBlock.encode(signedLeaf[0]))) || !Buffer.from(leaf[1]).equals(Buffer.from(signedLeaf[1])) || original.witnessUtxo?.amount !== actual.witnessUtxo?.amount || !Buffer.from(original.witnessUtxo?.script ?? []).equals(Buffer.from(actual.witnessUtxo?.script ?? []))) throw new Error("Registered emulator changed covenant or previous-output metadata");
      const sourceVin = sourceVins[vin];
      const entry = arkEnvelope.entries.find((candidate) => candidate.vin === sourceVin);
      if (!entry || entry.script.length !== 34 || entry.script[0] !== 32 || entry.script[33] !== 0x6a) throw new Error("Missing registered program envelope");
      const id = hex.encode(entry.script.subarray(1, 33));
      const programHex = options.programs[id];
      if (!programHex || hex.encode(sha256(hex.decode(programHex))) !== id || !info.registeredPrograms.includes(id)) throw new Error("Input program is not locally pinned and registered");
      const expectedSidecar = readSidecar(base64.decode(request.sidecar!)).find((item) => item.vin === sourceVin);
      if (!expectedSidecar || expectedSidecar.id !== id) throw new Error("Sidecar program does not match the input envelope");
      const script = leaf[1].subarray(0, -1);
      const signers = covenantSigners(script);
      const emulatorKey = emulatorTweak(info.signerPubkey, entry.script);
      if (signers.length !== 2 || !signers.includes(emulatorKey) || !signers.includes(options.operatorSignerPubkey)) throw new Error("Covenant leaf signer set differs from the pinned operator and emulator keys");
      if ((actual.tapScriptSig ?? []).some(([key]) => hex.encode(key.pubKey) === options.operatorSignerPubkey)) throw new Error("Emulator response contains an operator signature outside its signing stage");
      verifyTapscriptSignatures(signed, vin, [emulatorKey], undefined, undefined, tapLeafHash(script, leaf[1].at(-1)!));
    }
  };
  verifySigned(signedArk, expectedArk, Array.from({ length: expectedArk.inputsLength }, (_, vin) => vin));
  const checkpoints = request.checkpoints.map((entry) => Transaction.fromPSBT(base64.decode(entry)));
  const pairs = matchServerCheckpoints(result.signedCheckpointTxs, checkpoints, "registered emulator");
  const checkpointInputs = new Set<number>();
  for (const pair of pairs) {
    if (pair.local.inputsLength !== 1 || pair.local.outputsLength < 1) throw new Error("Registered checkpoint must spend exactly one prior VTXO");
    const sourceVin = checkpointToInput.get(pair.local.id);
    const oldInput = pair.local.getInput(0);
    const arkInput = sourceVin === undefined ? undefined : expectedArk.getInput(sourceVin);
    const oldLeaf = oldInput.tapLeafScript?.[0];
    const arkLeaf = arkInput?.tapLeafScript?.[0];
    const checkpointOutput = pair.local.getOutput(0);
    if (sourceVin === undefined || !oldLeaf || !arkLeaf || oldInput.witnessUtxo?.amount !== arkInput?.witnessUtxo?.amount || !Buffer.from(oldLeaf[1]).equals(Buffer.from(arkLeaf[1])) || checkpointOutput.amount !== arkInput.witnessUtxo?.amount || !Buffer.from(checkpointOutput.script ?? []).equals(Buffer.from(arkInput.witnessUtxo?.script ?? []))) throw new Error("Checkpoint does not match its Ark input's prior covenant");
    if (checkpointInputs.has(sourceVin)) throw new Error("Duplicate registered checkpoint input");
    checkpointInputs.add(sourceVin);
    const sourceVins = [sourceVin];
    verifySigned(pair.server, pair.local, sourceVins);
  }
  return signedArk;
}

export class RegisteredEmulatorProvider {
  readonly #base: URL;
  readonly #options: RegistryProviderOptions;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #info?: RegisteredEmulatorInfo;

  constructor(options: RegistryProviderOptions) {
    this.#base = endpoint(options.url, options.allowLoopbackHttp === true);
    const programs = Object.fromEntries(Object.entries(options.programs).map(([id, program]) => [canonicalHash(id, "registered program ID"), program]));
    if (computeRegistryHash(programs) !== options.registryHash) throw new Error("Local registered program bytes do not match pinned registry hash");
    const required = options.requiredProgramIds.map((id) => canonicalHash(id, "required program ID"));
    if (!required.length || new Set(required).size !== required.length || required.some((id) => !(id in programs))) throw new Error("Required registered program IDs must be nonempty, unique, and pinned locally");
    this.#options = { ...options, signerPubkey: canonicalEmulatorKey(options.signerPubkey), operatorSignerPubkey: canonicalHash(options.operatorSignerPubkey, "pinned Ark operator signer key"), registryHash: canonicalHash(options.registryHash, "pinned registry hash"), programs, requiredProgramIds: required };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000) throw new Error("Invalid registry request timeout");
  }

  async getInfo(): Promise<RegisteredEmulatorInfo> {
    const response = await this.#fetch(new URL("/v1/info", this.#base), { method: "GET", signal: AbortSignal.timeout(this.#timeout), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Registered emulator info failed (${response.status})`);
    const info = decodeRegistryInfo(await readJsonBounded(response));
    const expectedPrograms = Object.keys(this.#options.programs).sort();
    if (info.signerPubkey !== this.#options.signerPubkey || info.registryHash !== this.#options.registryHash || expectedPrograms.length !== info.registeredPrograms.length || expectedPrograms.some((id, index) => info.registeredPrograms[index] !== id) || this.#options.requiredProgramIds.some((id) => !info.registeredPrograms.includes(id))) throw new Error("Registered emulator identity or capabilities do not match pinned deployment");
    this.#info = info;
    return info;
  }

  async submitTx(request: VmBridgeRequest): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }> {
    const info = this.#info ?? await this.getInfo();
    if (!request.sidecar) throw new Error("Registered emulator request lacks its proof sidecar");
    const sidecar = base64.decode(request.sidecar);
    if (!sidecar.length || sidecar.length > info.maxSidecarBytes || sidecar.length > MAX_SIDECAR) throw new Error("Registry sidecar exceeds registered limits");
    const tx = Transaction.fromPSBT(base64.decode(request.arkTx));
    const nativePacket = Extension.fromTx(tx).getPacketByType(0x84);
    if (!nativePacket || !Buffer.from(nativePacket.serialize()).equals(Buffer.from(sha256(sidecar)))) throw new Error("Native transaction does not commit to this exact registry sidecar");
    const sidecarEntries = readSidecar(sidecar);
    const emulatorPacket = Extension.fromTx(tx).getEmulatorPacket();
    if (!emulatorPacket || emulatorPacket.entries.length !== sidecarEntries.length) throw new Error("Native emulator packet does not match registry sidecar inputs");
    for (const { vin, id } of sidecarEntries) {
      const programHex = this.#options.programs[id];
      const entry = emulatorPacket.entries.find((candidate) => candidate.vin === vin);
      if (!programHex || !info.registeredPrograms.includes(id) || !entry || entry.script.length !== 34 || entry.script[0] !== 32 || entry.script[33] !== 0x6a || hex.encode(entry.script.subarray(1, 33)) !== id) throw new Error("Sidecar program is not bound to its registered native input");
      const script = tx.getInput(vin).tapLeafScript?.[0]?.[1].subarray(0, -1);
      if (!script) throw new Error("Missing registered covenant leaf");
      const signers = covenantSigners(script);
      if (signers.length !== 2 || !signers.includes(emulatorTweak(info.signerPubkey, entry.script)) || !signers.includes(this.#options.operatorSignerPubkey)) throw new Error("Registered covenant leaf does not match pinned signer keys");
    }
    const body = JSON.stringify({ arkTx: request.arkTx, checkpointTxs: request.checkpoints, registrySidecar: base64.encode(sidecar) });
    const response = await this.#fetch(new URL("/v1/tx", this.#base), { method: "POST", signal: AbortSignal.timeout(this.#timeout), headers: { accept: "application/json", "content-type": "application/json" }, body });
    if (!response.ok) throw new Error(`Registered emulator submission failed (${response.status}); outcome may be unknown`);
    const value = await readJsonBounded(response);
    if (typeof value.signedArkTx !== "string" || !Array.isArray(value.signedCheckpointTxs) || value.signedCheckpointTxs.some((entry) => typeof entry !== "string")) throw new Error("Registered emulator returned an invalid signed response");
    verifyEmulatorResponse(request, { signedArkTx: value.signedArkTx, signedCheckpointTxs: value.signedCheckpointTxs as string[] }, info, this.#options);
    return { signedArkTx: value.signedArkTx, signedCheckpointTxs: value.signedCheckpointTxs as string[] };
  }
}
