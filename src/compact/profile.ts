import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asset } from "@arkade-os/sdk";
import type { ProtocolState } from "../../packages/protocol/src/types.ts";

export const COMPACT_VALIDATOR_VERSION = "ark-shield-compact-validator-v1" as const;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMPLEMENTATION_FILES = [
  "src/compact/profile.ts",
  "src/compact/verifier.ts",
  "src/compact/adapter.ts",
  "src/compact/runtime.ts",
  "src/compact/live.ts",
  "src/compact/signer.ts",
  "src/sdk/adapter.ts",
  "src/sdk/runtime.ts",
  "src/sdk/live.ts",
  "package-lock.json",
] as const;

export interface CompactVerificationKey {
  protocol?: string;
  curve?: string;
  nPublic?: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

export interface CompactProfileConfig {
  readonly relationVersion: string;
  readonly domain: string;
  readonly verificationKeys: Readonly<{ intent: CompactVerificationKey; transition: CompactVerificationKey }>;
  readonly serverKey: string;
  readonly emulatorKey: string;
  readonly checkpointScript: string;
  readonly exitTimelock: Readonly<{ type: "seconds" | "blocks"; value: string }>;
  readonly identities: Readonly<Record<"lane" | "btcVault" | "tokenVault" | "token", string>>;
  readonly destinations: Readonly<Record<string, { scriptPubKey: string; field: string }>>;
}

export interface CompactVerifierProfile extends CompactProfileConfig {
  readonly profileId: string;
  readonly validatorVersion: typeof COMPACT_VALIDATOR_VERSION;
  readonly validatorHash: string;
}

const profiles = new Map<string, CompactVerifierProfile>();

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Compact profile contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.some((item) => item === undefined)) throw new Error("Compact canonical arrays cannot contain undefined values");
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("Compact profile contains an unsupported value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validHex(value: string, bytes?: number): boolean {
  return typeof value === "string" && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0 && (bytes === undefined || value.length === bytes * 2);
}

function validateKey(key: CompactVerificationKey, count: number, label: string) {
  if (key?.protocol !== "groth16" || key.curve !== "bn128" || key.nPublic !== count) throw new Error(`Invalid ${label} Groth16 profile metadata`);
  if (!key || !Array.isArray(key.IC) || key.IC.length !== count + 1 || key.vk_alpha_1?.length !== 3 || key.vk_beta_2?.length !== 3 || key.vk_gamma_2?.length !== 3 || key.vk_delta_2?.length !== 3) {
    throw new Error(`Invalid ${label} Groth16 verification key`);
  }
  if (key.vk_beta_2.some((point) => !Array.isArray(point) || point.length !== 2) || key.vk_gamma_2.some((point) => !Array.isArray(point) || point.length !== 2) || key.vk_delta_2.some((point) => !Array.isArray(point) || point.length !== 2) || key.IC.some((point) => !Array.isArray(point) || point.length !== 3)) {
    throw new Error(`Invalid ${label} Groth16 verification key point shape`);
  }
  const coordinates = [...key.vk_alpha_1, ...key.vk_beta_2.flat(), ...key.vk_gamma_2.flat(), ...key.vk_delta_2.flat(), ...key.IC.flat()];
  const baseField = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  if (coordinates.some((value) => typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= baseField)) {
    throw new Error(`Invalid ${label} Groth16 verification key coordinate`);
  }
}

function fieldForDestination(scriptPubKey: string): string {
  const bytes = Buffer.from(scriptPubKey, "hex");
  const digest = createHash("sha256").update(bytes.subarray(2)).digest();
  return (BigInt(`0x${Buffer.from(digest).reverse().toString("hex")}`) % FIELD).toString();
}

async function implementationHash(): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const path of IMPLEMENTATION_FILES) {
    let bytes = await readFile(`${ROOT}/${path}`);
    if (/\.(ts|json)$/.test(path)) bytes = normalizeCompactSource(bytes);
    parts.push(new TextEncoder().encode(`${path}\0${bytes.length}\0`), bytes);
  }
  return hash(Buffer.concat(parts));
}

export function normalizeCompactSource(bytes: Uint8Array): Buffer {
  return Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Registers a server-owned profile once; clients never supply profile config. */
export async function registerCompactProfile(config: CompactProfileConfig): Promise<CompactVerifierProfile> {
  if (!config || typeof config.relationVersion !== "string" || !config.relationVersion || !/^(0|[1-9][0-9]*)$/.test(config.domain) || BigInt(config.domain) >= FIELD) {
    throw new Error("Invalid compact relation or domain");
  }
  if (!validHex(config.serverKey, 32) || !validHex(config.emulatorKey, 32) || config.serverKey !== config.serverKey.toLowerCase() || config.emulatorKey !== config.emulatorKey.toLowerCase() || config.serverKey === config.emulatorKey || !validHex(config.checkpointScript) || !config.checkpointScript) {
    throw new Error("Invalid compact signer or checkpoint profile");
  }
  const exitValue = BigInt(config.exitTimelock?.value ?? "0");
  const maxExit = config.exitTimelock?.type === "seconds" ? 65535n * 512n : 65535n;
  if (!config.exitTimelock || !["seconds", "blocks"].includes(config.exitTimelock.type) || !/^[1-9][0-9]*$/.test(config.exitTimelock.value) || exitValue > maxExit || (config.exitTimelock.type === "seconds" && exitValue % 512n !== 0n)) {
    throw new Error("Invalid compact CSV exit timelock");
  }
  validateKey(config.verificationKeys?.intent, 25, "intent");
  validateKey(config.verificationKeys?.transition, 30, "transition");
  const identities: string[] = [];
  for (const name of ["lane", "btcVault", "tokenVault", "token"] as const) {
    const id = config.identities?.[name];
    if (typeof id !== "string" || !id) throw new Error(`Missing compact asset identity ${name}`);
    let canonicalId: string;
    try { canonicalId = asset.AssetId.fromString(id).toString(); } catch { throw new Error(`Invalid compact asset identity ${name}`); }
    if (canonicalId !== id) throw new Error(`Non-canonical compact asset identity ${name}`);
    identities.push(id);
  }
  if (new Set(identities).size !== identities.length) throw new Error("Compact asset identities must be distinct");
  const destinationEntries = Object.entries(config.destinations ?? {});
  if (!destinationEntries.length || destinationEntries.some(([name, value]) => !name || !value || !validHex(value.scriptPubKey, 34) || value.scriptPubKey.slice(0, 4).toLowerCase() !== "5120" || !/^(0|[1-9][0-9]*)$/.test(value.field) || BigInt(value.field) >= FIELD || value.field !== fieldForDestination(value.scriptPubKey))) {
    throw new Error("Invalid compact destination map");
  }
  const validatorHash = await implementationHash();
  const descriptor = structuredClone({ ...config, validatorVersion: COMPACT_VALIDATOR_VERSION, validatorHash });
  const profileId = hash(`ArkShieldCompactProfile\0${canonical(descriptor)}`);
  const existing = profiles.get(profileId);
  if (existing) {
    if (!same(existing, { ...descriptor, profileId })) throw new Error("Compact profile ID collision");
    return existing;
  }
  const profile = freezeDeep({ ...descriptor, profileId }) as CompactVerifierProfile;
  profiles.set(profileId, profile);
  return profile;
}

export function getCompactProfile(profileId: string): CompactVerifierProfile {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("Compact verifier profile is not registered");
  return profile;
}

export function canonicalCompactJson(value: unknown): string { return canonical(value); }
export function compactSha256(value: Uint8Array | string): string { return hash(value); }

export function hashProtocolState(state: ProtocolState): string {
  return hash(`ArkShieldCompactState\0${canonical(state)}`);
}
