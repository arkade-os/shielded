import { createHash } from "node:crypto";
// @ts-ignore snarkjs ships no declarations.
import * as snarkjs from "snarkjs";
import {
  CSVMultisigTapscript,
  Extension,
  ASSET_CARRIER_SATS,
  P2A,
  Transaction,
  VtxoScript,
  verifyTapscriptSignatures,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
// @ts-ignore circomlibjs does not ship declarations.
import { buildPoseidon } from "circomlibjs";
import type { ProtocolState, PreparedSettlement } from "../../packages/protocol/src/types.ts";
import { canonicalNativeBody, extractCompactPacket } from "./adapter.ts";
import { getCompactProfile, hashProtocolState, canonicalCompactJson, type CompactVerifierProfile } from "./profile.ts";

export type CompactSidecar = Pick<PreparedSettlement,
  "operation" | "intentProof" | "transitionProof" | "intentSignals" | "transitionSignals" |
  "oldState" | "newState" | "ciphertextRecords" | "boundary">;

export interface CompactNativeHead {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  /** Full raw transaction that created this head. */
  readonly sourceTx: string;
}

export interface CompactNativeState {
  readonly profileId: string;
  readonly protocol: ProtocolState;
  readonly funding: Readonly<{ BTC: number; DEMO: number }>;
  readonly heads: Readonly<Partial<Record<"gate" | "lane" | "btcVault" | "tokenVault", CompactNativeHead>>>;
}

export interface VerifiedCompactTransition {
  readonly profileId: string;
  readonly transactionId: string;
  readonly protocol: ProtocolState;
  readonly funding: Readonly<{ BTC: number; DEMO: number }>;
  readonly heads: Readonly<Partial<Record<"gate" | "lane" | "btcVault" | "tokenVault", CompactNativeHead>>>;
}

const INTENT_SIGNALS = 25;
const TRANSITION_SIGNALS = 30;
const BINDING_DOMAIN = new TextEncoder().encode("ARKADE_COMPACT_BINDING_V1\0");
const TRANSCRIPT_DOMAIN = "ArkShieldCompactTranscriptV1\0";
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const RESOURCE_CARRIER_SATS = 1_000n;
let poseidonPromise: Promise<any> | undefined;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function framed(bytes: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return concat(length, bytes);
}

function same(a: unknown, b: unknown): boolean {
  return canonicalCompactJson(a) === canonicalCompactJson(b);
}

function validField(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < FIELD;
}

function validateState(state: ProtocolState): void {
  if (!state || !validField(state.noteRoot) || !validField(state.spentRoot) || !validField(state.historyRoot) ||
      !Number.isSafeInteger(state.noteCount) || state.noteCount < 0 || state.noteCount > 256 || state.noteCount % 2 !== 0 ||
      !Number.isSafeInteger(state.historyCount) || state.historyCount < 0 || state.historyCount > 256 ||
      !Number.isSafeInteger(state.revision) || state.revision !== state.noteCount / 2 + state.historyCount ||
      !Number.isSafeInteger(state.reserves?.BTC) || state.reserves.BTC < 0 ||
      !Number.isSafeInteger(state.reserves?.DEMO) || state.reserves.DEMO < 0) {
    throw new Error("Compact protocol state is malformed or outside the bounded profile");
  }
}

function validateBoundary(sidecar: CompactSidecar, profile: CompactVerifierProfile): void {
  if (!["shield", "transfer", "withdraw", "seal"].includes(sidecar.operation)) throw new Error("Unsupported compact operation");
  const { deposit, withdrawal, destination } = sidecar.boundary;
  for (const asset of ["BTC", "DEMO"] as const) {
    for (const [kind, value] of [["deposit", deposit?.[asset]], ["withdrawal", withdrawal?.[asset]]] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 48) throw new Error(`Invalid compact ${kind} amount for ${asset}`);
    }
    if (deposit[asset] && withdrawal[asset]) throw new Error("Compact PoC cannot deposit and withdraw the same asset in one operation");
  }
  if ((deposit.BTC || withdrawal.BTC) && (deposit.DEMO || withdrawal.DEMO)) throw new Error("Compact PoC supports one native asset boundary per operation");
  const active = (Object.values(deposit).reduce((a, b) => a + b, 0) > 0) || (Object.values(withdrawal).reduce((a, b) => a + b, 0) > 0);
  if (sidecar.operation === "seal") {
    if (active || destination !== "0" || sidecar.intentProof !== undefined || sidecar.ciphertextRecords.length !== 0 || sidecar.intentSignals.some((signal, index) => signal !== (index === 0 ? profile.domain : "0"))) {
      throw new Error("Invalid compact seal sidecar");
    }
  } else {
    if (!sidecar.intentProof || sidecar.ciphertextRecords.length !== 2 || sidecar.intentSignals[0] !== profile.domain) throw new Error("Invalid compact intent sidecar");
    const mapped = Object.values(profile.destinations).find((item) => item.field === destination);
    if (destination !== "0" && !mapped) throw new Error("Compact withdrawal destination is not registered");
    if (sidecar.operation === "withdraw" && !mapped) throw new Error("Compact withdrawal requires a registered destination");
    if (sidecar.operation !== "withdraw" && destination !== "0") throw new Error("Only compact withdrawals may set a destination");
    if (sidecar.operation === "shield" && Object.values(withdrawal).some(Boolean)) throw new Error("Shield operation cannot withdraw reserves");
    if (sidecar.operation === "withdraw" && Object.values(deposit).some(Boolean)) throw new Error("Withdraw operation cannot deposit reserves");
    if (sidecar.operation === "transfer" && (active || destination !== "0")) throw new Error("Transfer cannot change native reserves");
    for (let i = 0; i < 2; i++) {
      const record = sidecar.ciphertextRecords[i];
      if (!record || record.index !== sidecar.oldState.noteCount + i || record.createdRevision !== sidecar.newState.revision ||
          !validField(record.commitment) || record.ciphertext?.length !== 7 || record.ciphertext.some((v) => !validField(v)) || !validField(record.leaf)) {
        throw new Error(`Malformed compact encrypted record ${i}`);
      }
      if (sidecar.intentSignals[3 + i] !== record.commitment || record.ciphertext.some((value, j) => sidecar.intentSignals[5 + i * 7 + j] !== value)) {
        throw new Error(`Compact encrypted record ${i} does not match proof public signals`);
      }
    }
    const boundarySignals = [deposit.BTC, deposit.DEMO, withdrawal.BTC, withdrawal.DEMO].map(String);
    if (boundarySignals.some((value, index) => sidecar.intentSignals[19 + index] !== value) || sidecar.intentSignals[23] !== destination) {
      throw new Error("Compact intent signals do not match native boundary metadata");
    }
  }
}

async function validateRecordLeaves(sidecar: CompactSidecar): Promise<void> {
  poseidonPromise ??= buildPoseidon();
  const poseidon = await poseidonPromise;
  for (const [index, record] of sidecar.ciphertextRecords.entries()) {
    const leaf = poseidon([BigInt(record.commitment), ...record.ciphertext.map(BigInt)]);
    if (poseidon.F.toString(leaf) !== record.leaf) throw new Error(`Compact encrypted record ${index} leaf does not match its commitment and ciphertext`);
  }
}

function validateTransition(sidecar: CompactSidecar, profile: CompactVerifierProfile, trusted: CompactNativeState): void {
  validateState(sidecar.oldState);
  validateState(sidecar.newState);
  validateState(trusted.protocol);
  if (!Number.isSafeInteger(trusted.funding?.BTC) || trusted.funding.BTC < 0 || !Number.isSafeInteger(trusted.funding?.DEMO) || trusted.funding.DEMO < 0) {
    throw new Error("Authenticated compact native funding is malformed");
  }
  if (!same(sidecar.oldState, trusted.protocol)) throw new Error("Compact sidecar does not extend the authenticated current state");
  const seal = sidecar.operation === "seal";
  const old = sidecar.oldState;
  const next = sidecar.newState;
  const deposit = sidecar.boundary.deposit;
  const withdrawal = sidecar.boundary.withdrawal;
  const expected = {
    noteRoot: sidecar.transitionSignals[21],
    spentRoot: sidecar.transitionSignals[23],
    historyRoot: sidecar.transitionSignals[25],
    noteCount: Number(sidecar.transitionSignals[27]),
    historyCount: Number(sidecar.transitionSignals[29]),
    revision: old.revision + 1,
    reserves: { BTC: old.reserves.BTC + deposit.BTC - withdrawal.BTC, DEMO: old.reserves.DEMO + deposit.DEMO - withdrawal.DEMO },
  };
  if (!validField(expected.noteRoot) || !validField(expected.spentRoot) || !validField(expected.historyRoot) ||
      expected.noteCount !== old.noteCount + (seal ? 0 : 2) || expected.historyCount !== old.historyCount + (seal ? 1 : 0) ||
      expected.reserves.BTC < 0 || expected.reserves.DEMO < 0 || !same(next, expected)) {
    throw new Error("Compact new state is inconsistent with its transition public signals and native boundary");
  }
  const words: string[] = [profile.domain, sidecar.intentSignals[1], sidecar.intentSignals[2], ...sidecar.intentSignals.slice(3, 19)];
  if (words.some((v, i) => v !== sidecar.transitionSignals[i])) throw new Error("Compact intent and transition public signals disagree");
  if (sidecar.transitionSignals[19] !== (seal ? "1" : "0") ||
      sidecar.transitionSignals[20] !== old.noteRoot || sidecar.transitionSignals[22] !== old.spentRoot || sidecar.transitionSignals[24] !== old.historyRoot ||
      sidecar.transitionSignals[26] !== String(old.noteCount) || sidecar.transitionSignals[28] !== String(old.historyCount)) {
    throw new Error("Compact transition public signals do not begin at the registered current state");
  }
}

function parseRawHead(head: CompactNativeHead, name: string): Transaction {
  if (!/^[0-9a-f]{64}$/i.test(head.txid) || !Number.isInteger(head.vout) || head.vout < 0 || !Number.isSafeInteger(head.value) || head.value <= 0 || !/^(?:[0-9a-f]{2})+$/i.test(head.sourceTx)) {
    throw new Error(`Malformed authenticated compact ${name} head`);
  }
  const tx = Transaction.fromRaw(hex.decode(head.sourceTx));
  const output = tx.getOutput(head.vout);
  if (tx.id.toLowerCase() !== head.txid.toLowerCase() || !output?.script || output.amount !== BigInt(head.value)) throw new Error(`Compact ${name} source transaction does not authenticate its outpoint`);
  return tx;
}

function validateTransaction(profile: CompactVerifierProfile, sidecar: CompactSidecar, transaction: Transaction, checkpoints: readonly Transaction[], trusted: CompactNativeState, requireSignatures: boolean): void {
  if (trusted.profileId !== profile.profileId) throw new Error("Compact checkpoint profile mismatch");
  // The operator must provide only the heads consumed by this operation, in
  // canonical gate/lane/one-vault order. No caller-controlled prevout is accepted.
  const needsVault = Boolean(sidecar.boundary.deposit.BTC || sidecar.boundary.withdrawal.BTC || sidecar.boundary.deposit.DEMO || sidecar.boundary.withdrawal.DEMO);
  const required = [trusted.heads.gate, trusted.heads.lane, ...(needsVault ? [sidecar.boundary.deposit.BTC || sidecar.boundary.withdrawal.BTC ? trusted.heads.btcVault : trusted.heads.tokenVault] : [])];
  if (required.some((head) => !head) || transaction.inputsLength !== required.length || checkpoints.length !== required.length) throw new Error("Compact transaction/checkpoint package does not spend the exact authenticated native heads");
  const closure = expectedCompactClosure(profile);
  for (let index = 0; index < required.length; index++) {
    const head = required[index]!;
    const previous = parseRawHead(head, index === 0 ? "gate" : index === 1 ? "lane" : "vault");
    const input = transaction.getInput(index);
    const checkpoint = checkpoints[index];
    if (!checkpoint || checkpoint.inputsLength !== 1 || checkpoint.outputsLength !== 2) throw new Error(`Compact checkpoint ${index} has an invalid shape`);
    const cpInput = checkpoint.getInput(0);
    const cpOutput = checkpoint.getOutput(0);
    const originalOutput = previous.getOutput(head.vout)!;
    if (!cpInput.txid || txidFromWire(cpInput.txid) !== head.txid.toLowerCase()) throw new Error(`Compact checkpoint ${index} source txid mismatch: ${cpInput.txid ? hex.encode(cpInput.txid) : "missing"} vs ${head.txid}`);
    if (cpInput.index !== head.vout) throw new Error(`Compact checkpoint ${index} source vout mismatch`);
    if (cpInput.witnessUtxo?.amount !== BigInt(head.value)) throw new Error(`Compact checkpoint ${index} source value mismatch`);
    if (!equalBytes(cpInput.witnessUtxo.script, originalOutput.script!)) throw new Error(`Compact checkpoint ${index} prevout script mismatch`);
    if (!equalBytes(originalOutput.script!, closure.pkScript)) throw new Error(`Compact checkpoint ${index} head does not match profile closure`);
    if (cpInput.sighashType !== undefined && cpInput.sighashType !== 0) throw new Error("Compact checkpoints require SIGHASH_DEFAULT");
    if (cpInput.tapLeafScript?.length !== 1) throw new Error("Compact checkpoint input must carry exactly one tapleaf");
    if (!sameTapLeaf(cpInput.tapLeafScript[0], closure.tapLeafScript)) throw new Error("Compact checkpoint tapleaf/control block differs from registered profile leaf");
    if (cpInput.tapKeySig?.length || cpInput.finalScriptSig?.length || cpInput.finalScriptWitness?.length) throw new Error("Compact checkpoint input has unexpected key-path or finalized witness data");
    const checkpointScript = CSVMultisigTapscript.decode(hex.decode(profile.checkpointScript));
    const checkpointTree = new VtxoScript([checkpointScript.script, closure.script]);
    const expectedCheckpointOutput = checkpointTree.pkScript;
    if (!cpOutput?.script || cpOutput.amount !== BigInt(head.value) || !equalBytes(cpOutput.script, expectedCheckpointOutput) ||
        !equalBytes(checkpoint.getOutput(1)?.script ?? new Uint8Array(), P2A.script) || checkpoint.getOutput(1)?.amount !== P2A.amount) {
      throw new Error(`Compact checkpoint ${index} output does not match the registered checkpoint policy`);
    }
    if (requireSignatures) verifyExactTapscriptSignatures(checkpoint, 0, [profile.serverKey, profile.emulatorKey], closure.script);
    else assertUnsignedCompactInput(cpInput, `checkpoint ${index}`);
    const expectedCheckpointLeaf = checkpointTree.findLeaf(hex.encode(closure.script));
    if (!input.txid || txidFromWire(input.txid) !== checkpoint.id.toLowerCase() || input.index !== 0 || input.witnessUtxo?.amount !== BigInt(head.value) ||
        !input.witnessUtxo.script || !equalBytes(input.witnessUtxo.script, expectedCheckpointOutput) ||
        input.sighashType !== undefined && input.sighashType !== 0 || input.tapKeySig?.length || input.finalScriptSig?.length || input.finalScriptWitness?.length ||
        input.tapLeafScript?.length !== 1 || !sameTapLeaf(input.tapLeafScript[0], expectedCheckpointLeaf)) {
      throw new Error(`Compact virtual transaction input ${index} does not spend its exact checkpoint`);
    }
    if (requireSignatures) verifyExactTapscriptSignatures(transaction, index, [profile.serverKey, profile.emulatorKey], expectedCheckpointLeaf[1].subarray(0, -1));
    else assertUnsignedCompactInput(input, `ark transaction ${index}`);
  }
  validateNativeOutputs(profile, sidecar, transaction, trusted, closure.pkScript);
  const extension = Extension.fromTx(transaction);
  const packets = extension.getPackets();
  if (packets.filter((packet) => packet.type() === 0x84).length !== 1 || packets.filter((packet) => packet.type() === 0).length > 1) {
    throw new Error("Compact extension contains duplicate compact or asset packets");
  }
  const packet = extractCompactPacket(transaction);
  if (!packet || hex.encode(packet.profileId) !== profile.profileId || hex.encode(packet.oldStateHash) !== hashProtocolState(sidecar.oldState) || hex.encode(packet.newStateHash) !== hashProtocolState(sidecar.newState)) {
    throw new Error("Compact transaction packet does not match the registered profile and sidecar states");
  }
  const actualBinding = compactBindingHash(sidecar, transaction);
  if (!equalBytes(actualBinding, packet.bindingHash)) throw new Error("Compact transaction effects are not bound to the proof sidecar");
  const nativeBody = canonicalNativeBody(transaction);
  if (!nativeBody.length) throw new Error("Compact transaction has no canonical native body");
  validateAssetConservation(transaction, profile, required);
  validateAssetOutputs(transaction, profile, sidecar, trusted, required);
}

function sameTapLeaf(actual: NonNullable<ReturnType<Transaction["getInput"]>["tapLeafScript"]>[number], expected: [any, Uint8Array]): boolean {
  const [actualMeta, actualScript] = actual;
  const [expectedMeta, expectedScript] = expected;
  return equalBytes(actualScript, expectedScript) && equalBytes(TaprootControlBlock.encode(actualMeta), TaprootControlBlock.encode(expectedMeta));
}

function assertUnsignedCompactInput(input: ReturnType<Transaction["getInput"]>, name: string): void {
  if (input.tapScriptSig?.length || input.tapKeySig?.length || input.finalScriptSig?.length || input.finalScriptWitness?.length) {
    throw new Error(`Unsigned compact ${name} already contains attacker-controlled signatures or witness`);
  }
}

function verifyExactTapscriptSignatures(tx: Transaction, inputIndex: number, signers: string[], script: Uint8Array): void {
  const input = tx.getInput(inputIndex);
  if (input.tapKeySig?.length || input.finalScriptSig?.length || input.finalScriptWitness?.length) throw new Error(`Compact input ${inputIndex} contains unexpected key-path or finalized witness data`);
  const sigs = input.tapScriptSig ?? [];
  const expected = [...signers].sort();
  const actual = sigs.map(([metadata]) => hex.encode(metadata.pubKey)).sort();
  if (actual.length !== 2 || actual.some((key, index) => key !== expected[index])) throw new Error(`Compact input ${inputIndex} has unexpected taproot signers`);
  const leafHash = hex.encode(tapLeafHash(script, 0xc0));
  if (sigs.some(([metadata]) => hex.encode(metadata.leafHash) !== leafHash)) throw new Error(`Compact input ${inputIndex} signatures do not commit to the registered collaborative leaf`);
  verifyTapscriptSignatures(tx, inputIndex, signers, [], [0], hex.decode(leafHash));
}

function expectedCompactClosure(profile: CompactVerifierProfile) {
  const { createCompactClosure } = adapterModule;
  return createCompactClosure(hex.decode(profile.profileId), hex.decode(profile.serverKey), hex.decode(profile.emulatorKey), {
    type: profile.exitTimelock.type,
    value: BigInt(profile.exitTimelock.value),
  });
}

function validateAssetConservation(transaction: Transaction, profile: CompactVerifierProfile,
  required: readonly (CompactNativeHead | undefined)[]): void {
  const assetPackets = Extension.fromTx(transaction).getPackets().filter((packet) => packet.type() === 0);
  if (assetPackets.length > 1) throw new Error("Compact transaction contains duplicate asset packets");
  if (!assetPackets.length) throw new Error("Compact transaction omitted native asset conservation packet");
  const assetPacket = Extension.fromTx(transaction).getAssetPacket();
  const seen = new Set<string>();
  const expectedInputs = new Map<string, Map<number, bigint>>();
  for (const [vin, head] of required.entries()) {
    if (!head) throw new Error("Compact state lacks a required native input head");
    const source = parseRawHead(head, `asset input ${vin}`);
    const sourcePacket = Extension.fromTx(source).getAssetPacket();
    for (const [groupIndex, group] of (sourcePacket?.groups ?? []).entries()) {
      const amount = group.outputs.filter((output) => output.vout === head.vout).reduce((sum, output) => sum + output.amount, 0n);
      if (amount <= 0n) continue;
      const id = group.assetId?.toString() ?? `derived:${source.id}:${groupIndex}`;
      const byVin = expectedInputs.get(id) ?? new Map<number, bigint>();
      byVin.set(vin, (byVin.get(vin) ?? 0n) + amount);
      expectedInputs.set(id, byVin);
    }
  }
  for (const group of assetPacket?.groups ?? []) {
    const id = group.assetId?.toString();
    if (!id || seen.has(id)) throw new Error("Compact transaction contains duplicate or unresolved native asset identities");
    seen.add(id);
    if (!Object.values(profile.identities).includes(id)) throw new Error("Compact transaction contains an unregistered native asset identity");
    const expected = expectedInputs.get(id);
    const actual = new Map<number, bigint>();
    for (const input of group.inputs) {
      if (!Number.isInteger(input.vin) || input.vin < 0 || input.vin >= required.length || input.amount <= 0n || actual.has(input.vin)) throw new Error(`Compact asset ${id} has invalid or duplicate input allocation`);
      actual.set(input.vin, input.amount);
    }
    if (!same([...actual.entries()].sort(([a], [b]) => a - b).map(([vin, amount]) => [vin, amount.toString()]),
      [...(expected ?? new Map()).entries()].sort(([a], [b]) => a - b).map(([vin, amount]) => [vin, amount.toString()]))) {
      throw new Error(`Compact asset ${id} inputs do not match source transaction provenance`);
    }
    const inputTotal = group.inputs.reduce((sum, input) => sum + input.amount, 0n);
    const outputTotal = group.outputs.reduce((sum, output) => sum + output.amount, 0n);
    if (inputTotal !== outputTotal) throw new Error(`Compact native asset ${id} is not conserved`);
  }
  for (const id of expectedInputs.keys()) if (!seen.has(id)) throw new Error(`Compact transaction omitted source native asset ${id}`);
}

function validateAssetOutputs(transaction: Transaction, profile: CompactVerifierProfile, sidecar: CompactSidecar,
  trusted: CompactNativeState, required: readonly (CompactNativeHead | undefined)[]): void {
  const groups = Extension.fromTx(transaction).getAssetPacket()!.groups;
  const selectedVault = sidecar.boundary.deposit.BTC || sidecar.boundary.withdrawal.BTC ? "btcVault"
    : sidecar.boundary.deposit.DEMO || sidecar.boundary.withdrawal.DEMO ? "tokenVault" : undefined;
  const expected = new Map<string, { vout: number; amount: bigint }[]>();
  expected.set(profile.identities.lane, [{ vout: 1, amount: 1n }]);
  if (selectedVault) expected.set(profile.identities[selectedVault], [{ vout: 2, amount: 1n }]);
  const gateToken = trusted.funding.DEMO - sidecar.boundary.deposit.DEMO;
  expected.set(profile.identities.token, [
    ...(gateToken ? [{ vout: 0, amount: BigInt(gateToken) }] : []),
    ...(selectedVault === "tokenVault" && sidecar.newState.reserves.DEMO ? [{ vout: 2, amount: BigInt(sidecar.newState.reserves.DEMO) }] : []),
    ...(sidecar.boundary.withdrawal.DEMO ? [{ vout: 3, amount: BigInt(sidecar.boundary.withdrawal.DEMO) }] : []),
  ]);
  const expectedIds = new Set<string>();
  for (const [vin, head] of required.entries()) {
    if (!head) throw new Error("Compact state lacks a required native input head");
    const source = parseRawHead(head, `output asset input ${vin}`);
    const sourcePacket = Extension.fromTx(source).getAssetPacket();
    for (const [groupIndex, sourceGroup] of (sourcePacket?.groups ?? []).entries()) {
      const quantity = sourceGroup.outputs.filter((entry) => entry.vout === head.vout).reduce((sum, entry) => sum + entry.amount, 0n);
      if (quantity > 0n) expectedIds.add(sourceGroup.assetId?.toString() ?? `derived:${source.id}:${groupIndex}`);
    }
  }
  const actualIds = new Set(groups.map((group) => group.assetId?.toString()));
  for (const id of expectedIds) {
    const group = groups.find((item) => item.assetId?.toString() === id);
    const outputs = group?.outputs ?? [];
    const expectedOutputs = expected.get(id) ?? [];
    if (!same(outputs.map(({ vout, amount }) => ({ vout, amount: amount.toString() })), expectedOutputs.map(({ vout, amount }) => ({ vout, amount: amount.toString() })))) {
      throw new Error(`Compact native asset ${id} is allocated to unexpected outputs`);
    }
  }
  if (groups.length !== expectedIds.size || [...actualIds].some((id) => !id || !expectedIds.has(id))) throw new Error("Compact transaction asset identities do not match registered input resources");
  if (required.length !== (selectedVault ? 3 : 2)) throw new Error("Compact asset input count does not match the selected native resources");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function txidFromWire(value: Uint8Array): string { return hex.encode(value).toLowerCase(); }

const adapterModule = await import("./adapter.ts");

/** Canonical proof transcript; metadata, settlement IDs and timings are excluded. */
export function serializeCompactSidecar(sidecar: CompactSidecar): Uint8Array {
  return new TextEncoder().encode(TRANSCRIPT_DOMAIN + canonicalCompactJson(sidecar));
}

/** Packet binding uses length framing to prevent transcript/body boundary ambiguity. */
export function compactBindingHash(sidecar: CompactSidecar, transaction: Transaction): Uint8Array {
  return createHash("sha256").update(concat(BINDING_DOMAIN, framed(serializeCompactSidecar(sidecar)), framed(canonicalNativeBody(transaction)))).digest();
}

/** Verify real Groth16 proofs and authenticated native effects before returning a candidate checkpoint. */
export async function verifyCompactSubmission(
  profileId: string,
  sidecar: CompactSidecar,
  signedTransaction: Transaction,
  checkpoints: readonly Transaction[],
  trusted: CompactNativeState,
): Promise<VerifiedCompactTransition> {
  const profile = getCompactProfile(profileId);
  if (!sidecar || !signedTransaction || !trusted || trusted.profileId !== profileId) throw new Error("Compact verifier context is incomplete");
  await verifyCompactProof(profileId, sidecar, trusted);
  validateTransaction(profile, sidecar, signedTransaction, checkpoints, trusted, true);
  const heads = await nextHeads(signedTransaction, trusted, sidecar);
  return Object.freeze({ profileId, transactionId: signedTransaction.id, protocol: structuredClone(sidecar.newState), funding: nextFunding(trusted, sidecar), heads });
}

/** Validate proof, ancestry, outputs and packet before any signing; returns no acceptance permit. */
export async function verifyCompactUnsignedSubmission(
  profileId: string,
  sidecar: CompactSidecar,
  unsignedTransaction: Transaction,
  checkpoints: readonly Transaction[],
  trusted: CompactNativeState,
): Promise<void> {
  await verifyCompactProof(profileId, sidecar, trusted);
  validateTransaction(getCompactProfile(profileId), sidecar, unsignedTransaction, checkpoints, trusted, false);
}

/** Verify only proof and state before requesting signatures; does not issue a native permit. */
export async function verifyCompactProof(profileId: string, sidecar: CompactSidecar, trusted: CompactNativeState): Promise<void> {
  const profile = getCompactProfile(profileId);
  if (!sidecar || !trusted || trusted.profileId !== profileId) throw new Error("Compact verifier context is incomplete");
  if (sidecar.intentSignals?.length !== INTENT_SIGNALS || sidecar.transitionSignals?.length !== TRANSITION_SIGNALS) throw new Error("Compact proof has the wrong public signal count");
  if (sidecar.intentSignals.some((value) => !validField(value)) || sidecar.transitionSignals.some((value) => !validField(value))) throw new Error("Compact proof contains malformed public signals");
  validateBoundary(sidecar, profile);
  validateTransition(sidecar, profile, trusted);
  await validateRecordLeaves(sidecar);
  const intentValid = sidecar.operation === "seal" || await snarkjs.groth16.verify(profile.verificationKeys.intent, sidecar.intentSignals, sidecar.intentProof);
  const transitionValid = await snarkjs.groth16.verify(profile.verificationKeys.transition, sidecar.transitionSignals, sidecar.transitionProof);
  if (!intentValid || !transitionValid) throw new Error("Compact Groth16 proof verification failed");
}

function nextFunding(trusted: CompactNativeState, sidecar: CompactSidecar): { BTC: number; DEMO: number } {
  const next = {
    BTC: trusted.funding.BTC - sidecar.boundary.deposit.BTC - (sidecar.boundary.withdrawal.DEMO ? ASSET_CARRIER_SATS : 0),
    DEMO: trusted.funding.DEMO - sidecar.boundary.deposit.DEMO,
  };
  if (next.BTC < 0 || next.DEMO < 0 || !Number.isSafeInteger(next.BTC) || !Number.isSafeInteger(next.DEMO)) throw new Error("Compact native funding underflow or overflow");
  return next;
}

function validateNativeOutputs(profile: CompactVerifierProfile, sidecar: CompactSidecar, transaction: Transaction, trusted: CompactNativeState, closureScript: Uint8Array): void {
  const deposit = sidecar.boundary.deposit;
  const withdrawal = sidecar.boundary.withdrawal;
  const selectedVault = deposit.BTC || withdrawal.BTC ? "btcVault" : deposit.DEMO || withdrawal.DEMO ? "tokenVault" : undefined;
  const hasPayout = withdrawal.BTC > 0 || withdrawal.DEMO > 0;
  const count = 2 + Number(Boolean(selectedVault)) + Number(hasPayout) + 2;
  if (transaction.outputsLength !== count) throw new Error("Compact transaction has extra or missing native outputs");
  const gateBtc = trusted.funding.BTC - deposit.BTC - (withdrawal.DEMO ? ASSET_CARRIER_SATS : 0);
  const gateToken = trusted.funding.DEMO - deposit.DEMO;
  if (gateBtc < 0 || gateToken < 0) throw new Error("Compact native funding is insufficient");
  const expect = (index: number, script: Uint8Array, amount: bigint) => {
    const output = transaction.getOutput(index);
    if (!output?.script || !equalBytes(output.script, script) || output.amount !== amount) throw new Error(`Compact native output ${index} does not match the registered state transition (amount=${output?.amount}, expected=${amount}, scriptMatch=${Boolean(output?.script && equalBytes(output.script, script))})`);
  };
  expect(0, closureScript, BigInt(gateBtc));
  expect(1, closureScript, RESOURCE_CARRIER_SATS);
  let index = 2;
  if (selectedVault) {
    expect(index++, closureScript, selectedVault === "btcVault" ? RESOURCE_CARRIER_SATS + BigInt(sidecar.newState.reserves.BTC) : RESOURCE_CARRIER_SATS);
  }
  if (hasPayout) {
    const destination = Object.values(profile.destinations).find((entry) => entry.field === sidecar.boundary.destination);
    if (!destination) throw new Error("Compact payout destination is not registered");
    expect(index++, hex.decode(destination.scriptPubKey), BigInt(withdrawal.BTC || (withdrawal.DEMO ? ASSET_CARRIER_SATS : 0)));
  }
  const extensionOutput = transaction.getOutput(index++);
  const anchorOutput = transaction.getOutput(index);
  if (!extensionOutput?.script || extensionOutput.amount !== 0n || !Extension.isExtension(extensionOutput.script) || !anchorOutput?.script ||
      !equalBytes(anchorOutput.script, P2A.script) || anchorOutput.amount !== P2A.amount) throw new Error("Compact transaction extension or anchor output is malformed");
  const tokenGroup = Extension.fromTx(transaction).getAssetPacket()?.groups.find((group) => group.assetId?.toString() === profile.identities.token);
  const tokenAllocations = tokenGroup?.outputs ?? [];
  const expectedToken = [
    ...(gateToken > 0 ? [{ vout: 0, amount: BigInt(gateToken) }] : []),
    ...(selectedVault === "tokenVault" && sidecar.newState.reserves.DEMO ? [{ vout: 2, amount: BigInt(sidecar.newState.reserves.DEMO) }] : []),
    ...(withdrawal.DEMO ? [{ vout: 3, amount: BigInt(withdrawal.DEMO) }] : []),
  ];
  if (!same(tokenAllocations.map(({ vout, amount }) => ({ vout, amount: amount.toString() })), expectedToken.map(({ vout, amount }) => ({ vout, amount: amount.toString() })))) {
    throw new Error("Compact native token outputs do not match funding, reserve, and withdrawal state");
  }
}

async function nextHeads(transaction: Transaction, trusted: CompactNativeState, sidecar: CompactSidecar): Promise<CompactNativeState["heads"]> {
  const raw = transaction.toBytes(true, true);
  const txid = transaction.id;
  const next: Partial<Record<"gate" | "lane" | "btcVault" | "tokenVault", CompactNativeHead>> = structuredClone(trusted.heads);
  next.gate = headAt(transaction, txid, raw, 0);
  next.lane = headAt(transaction, txid, raw, 1);
  if (trusted.heads.btcVault && (sidecar.boundary.deposit.BTC || sidecar.boundary.withdrawal.BTC)) next.btcVault = headAt(transaction, txid, raw, 2);
  if (trusted.heads.tokenVault && (sidecar.boundary.deposit.DEMO || sidecar.boundary.withdrawal.DEMO)) next.tokenVault = headAt(transaction, txid, raw, 2);
  return next;
}

function headAt(transaction: Transaction, txid: string, raw: Uint8Array, vout: number): CompactNativeHead {
  const output = transaction.getOutput(vout);
  if (!output?.script || output.amount === undefined || output.amount <= 0n || output.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Compact successor output ${vout} is invalid`);
  return { txid, vout, value: Number(output.amount), sourceTx: hex.encode(raw) };
}
