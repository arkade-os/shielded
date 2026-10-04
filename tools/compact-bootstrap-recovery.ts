import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { base64, hex } from '@scure/base';
import {
  ArkAddress, asset, ConditionCSVMultisigTapscript, ConditionMultisigTapscript, CSVMultisigTapscript,
  Extension, InMemoryContractRepository, InMemoryWalletRepository, MultisigTapscript, RestArkProvider,
  RestIndexerProvider, SingleKey, Transaction, Wallet, matchServerCheckpoints, verifyTapscriptSignatures,
  type ArkInfo,
} from '@arkade-os/sdk';
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { createProtocol } from '../packages/protocol/src/index.ts';
import { createCompactDestination, createCompactProfile } from '../src/compact/runtime.ts';
import type { CompactProfileConfig } from '../src/compact/profile.ts';
import { createCompactReadyLiveRuntime } from '../src/compact/ready-live.ts';
import { coinFromTransaction, type VmBridgeRequest } from '../src/sdk/adapter.ts';
import type { NativeCheckpoint } from '../src/sdk/runtime.ts';
import { EngineStore } from '../src/storage.ts';

const HARD_WEIGHT_LIMIT = 4_000n;
const TOKEN_SUPPLY = 10_000_000n;
const GATE_FUNDING = 200_000n;
const CARRIER = 1_000n;
const RESOURCE_NAMES = ['gate', 'lane', 'btcVault', 'tokenVault'] as const;
const ISSUE_NAMES = ['lane', 'btcVault', 'tokenVault', 'token'] as const;
type ResourceName = typeof RESOURCE_NAMES[number];
type IssueName = typeof ISSUE_NAMES[number];
type BootstrapResponse = Awaited<ReturnType<RestArkProvider['submitTx']>>;
type RecoveryHeadRecord = { request: VmBridgeRequest; response: BootstrapResponse; finalizedCheckpointTxs: string[] };
type RecoveryJournal = { version: 1; profileId: string; heads: Partial<Record<ResourceName, RecoveryHeadRecord>> };
type BootstrapJournal = NonNullable<NonNullable<NativeCheckpoint['live']>['pendingBootstrap']> & {
  recoveryOwned?: true;
  finalizedCheckpointTxs?: string[];
};
type StoredEngine = {
  version: 2;
  proofTransport: 'compact';
  profileId: string;
  protocol: import('../packages/protocol/src/types.ts').ProtocolCheckpoint;
  native: NativeCheckpoint & { live: NonNullable<NativeCheckpoint['live']> & {
    pendingBootstrap?: BootstrapJournal; bootstrapRecovery?: RecoveryJournal;
  } };
  activities: unknown[];
  publicBalances: unknown;
  pendingCompletion?: unknown;
  requests: Record<string, unknown>;
};

type FundingEvidence = { id: string; inputs: Map<number, Map<string, bigint>>; outputs: Map<number, Map<string, bigint>> };

function keyBytes(configured: string | undefined, path: string): Buffer {
  if (configured !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(configured)) throw new Error('SHIELDED_STORAGE_KEY must be 32 bytes of hexadecimal key material.');
    return Buffer.from(configured, 'hex');
  }
  const keyPath = join(path, '.key');
  if (!existsSync(keyPath)) throw new Error('Encrypted checkpoint key is missing.');
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Encrypted checkpoint key is invalid.');
  return key;
}

export function decryptCheckpointRow(row: { iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }, key: Uint8Array): StoredEngine {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAuthTag(row.tag);
  return JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')) as StoredEngine;
}

export function loadCheckpointReadonly(directory: string, configuredKey?: string): StoredEngine {
  const root = resolve(directory);
  const dbPath = join(root, 'shielded.sqlite');
  if (!existsSync(dbPath)) throw new Error('Encrypted Shielded checkpoint database is missing.');
  const key = keyBytes(configuredKey, root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT iv, tag, ciphertext FROM checkpoint WHERE id=1').get() as
      { iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array } | undefined;
    if (!row) throw new Error('Encrypted Shielded checkpoint is empty.');
    return decryptCheckpointRow(row, key);
  } catch (error) {
    if (error instanceof Error && /Encrypted Shielded/.test(error.message)) throw error;
    throw new Error('Encrypted Shielded checkpoint failed authentication or could not be read.');
  } finally { db.close(); }
}

function compactAssetIdentity(raw: string): string {
  const identity = asset.AssetId.fromString(raw).toString();
  if (identity !== raw) throw new Error('Checkpoint contains a noncanonical asset identity.');
  return identity;
}

export function assertRecoverableCheckpoint(checkpoint: StoredEngine): void {
  const native = checkpoint.native;
  const live = native?.live;
  if (checkpoint.version !== 2 || checkpoint.proofTransport !== 'compact' || !checkpoint.profileId ||
      !native || native.network !== 'mutinynet' || live?.phase !== 'funding-programs') {
    throw new Error('Recovery requires a compact Mutinynet checkpoint in funding-programs phase.');
  }
  if (checkpoint.pendingCompletion || checkpoint.activities.length || native.receipts.length || live.pendingSettlement ||
      native.compact?.pendingAcceptance || native.state.noteCount !== 0 || native.state.historyCount !== 0 ||
      native.state.reserves.BTC !== 0 || native.state.reserves.DEMO !== 0 || checkpoint.protocol.encryptedLog.length ||
      checkpoint.protocol.receipts.length || checkpoint.protocol.nullifiers.length) {
    throw new Error('Recovery is limited to a clean pool with no notes, reserves, activities, receipts, or pending settlement.');
  }
  const issued = live.issued;
  if (ISSUE_NAMES.some((name) => !issued[name] || !live.issuanceTransactions?.[name]) ||
      ISSUE_NAMES.some((name) => native.identities[name] !== issued[name])) {
    throw new Error('Recovery requires all four durably issued asset identities and ancestry.');
  }
  const identitySet = new Set(ISSUE_NAMES.map((name) => compactAssetIdentity(issued[name]!)));
  if (identitySet.size !== ISSUE_NAMES.length) throw new Error('Recovery requires four distinct registered asset identities.');
  if (native.compact?.profileId !== checkpoint.profileId || live.pendingBoarding || (live.boardingReceipts?.length ?? 0) > 0) {
    throw new Error('Recovery is limited to the treasury wallet before any boarding request or receipt.');
  }
  const prefix = RESOURCE_NAMES.filter((_, index) => RESOURCE_NAMES.slice(0, index + 1).every((name) => native.heads[name]));
  if (Object.keys(native.heads).length !== prefix.length) throw new Error('Recovery requires a contiguous resource-head prefix.');
  const gate = native.heads.gate;
  if (gate ? native.genesisRaw !== gate.sourceTx || native.funding.BTC !== GATE_FUNDING.toString() || native.funding.DEMO !== TOKEN_SUPPLY.toString()
    : native.genesisRaw !== '' || native.funding.BTC !== '0' || native.funding.DEMO !== '0') {
    throw new Error('Saved genesis or gate funding does not match the adopted resource prefix.');
  }
  const pending = live.pendingBootstrap;
  const next = RESOURCE_NAMES[prefix.length];
  if (pending && (!next || pending.step !== `fund:${next}` || !pending.request?.arkTx ||
      pending.txid.toLowerCase() !== pending.response?.arkTxid.toLowerCase())) {
    throw new Error('Saved bootstrap request is ambiguous or lacks its signed operator response; it will not be resubmitted.');
  }
  if (!pending && prefix.length === 0) throw new Error('Recovery requires a durable pending funding request or an adopted resource prefix.');
  if (live.bootstrapRecovery && live.bootstrapRecovery.profileId !== checkpoint.profileId) throw new Error('Recovery journal profile changed.');
  if (prefix.some((name) => !live.bootstrapRecovery?.heads[name])) throw new Error('An adopted head is missing its durable signed recovery evidence.');
}

function sameBody(actual: Transaction, expected: Transaction): void {
  if (actual.id.toLowerCase() !== expected.id.toLowerCase() ||
      !Buffer.from(actual.unsignedTx).equals(Buffer.from(expected.unsignedTx))) {
    throw new Error('Arkade changed the submitted bootstrap transaction body.');
  }
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

function sameMetadata(actual: Transaction, expected: Transaction): void {
  if (actual.inputsLength !== expected.inputsLength) throw new Error('Bootstrap input count changed.');
  for (let vin = 0; vin < expected.inputsLength; vin++) {
    const a = actual.getInput(vin);
    const e = expected.getInput(vin);
    const al = a.tapLeafScript ?? [];
    const el = e.tapLeafScript ?? [];
    if ((a.tapKeySig?.length ?? 0) > 0 || (a.finalScriptSig?.length ?? 0) > 0 || (a.finalScriptWitness?.length ?? 0) > 0 ||
        (e.tapKeySig?.length ?? 0) > 0 || (e.finalScriptSig?.length ?? 0) > 0 || (e.finalScriptWitness?.length ?? 0) > 0) {
      throw new Error('Bootstrap PSBT contains pre-finalized or key-path signatures.');
    }
    if (a.witnessUtxo?.amount !== e.witnessUtxo?.amount || !sameBytes(a.witnessUtxo?.script, e.witnessUtxo?.script) ||
        a.sighashType !== e.sighashType || !sameBytes(a.tapInternalKey, e.tapInternalKey) ||
        !sameBytes(a.tapMerkleRoot, e.tapMerkleRoot) || al.length !== el.length || al.some(([control, script], index) => {
          const [expectedControl, expectedScript] = el[index] ?? [];
          return !expectedControl || !expectedScript || !Buffer.from(script).equals(Buffer.from(expectedScript)) ||
            !Buffer.from(TaprootControlBlock.encode(control)).equals(Buffer.from(TaprootControlBlock.encode(expectedControl)));
        })) throw new Error('Bootstrap previous-output or spend-leaf metadata changed.');
    const an = a.nonWitnessUtxo; const en = e.nonWitnessUtxo;
    if (Boolean(an) !== Boolean(en)) throw new Error('Bootstrap non-witness previous transaction metadata changed.');
    if (an && en && (an.version !== en.version || an.lockTime !== en.lockTime || an.inputs.length !== en.inputs.length ||
        an.outputs.length !== en.outputs.length || an.inputs.some((input, index) => {
          const other = en.inputs[index];
          return !other || !sameBytes(input.txid, other.txid) || input.index !== other.index ||
            input.sequence !== other.sequence || !sameBytes(input.finalScriptSig, other.finalScriptSig);
        }) || an.outputs.some((output, index) => {
          const other = en.outputs[index];
          return !other || output.amount !== other.amount || !sameBytes(output.script, other.script);
        }))) throw new Error('Bootstrap non-witness previous transaction changed.');
  }
}

function signerKeys(script: Uint8Array): string[] {
  if (ConditionMultisigTapscript.isScriptValid(script) === true) return ConditionMultisigTapscript.decode(script).params.pubkeys.map(hex.encode);
  if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) return ConditionCSVMultisigTapscript.decode(script).params.pubkeys.map(hex.encode);
  try { return CSVMultisigTapscript.decode(script).params.pubkeys.map(hex.encode); }
  catch { return MultisigTapscript.decode(script).params.pubkeys.map(hex.encode); }
}

function verifyPartials(tx: Transaction, expected: Transaction, vin: number, serverKey: string, requireServer: boolean): void {
  const leaves = expected.getInput(vin).tapLeafScript ?? [];
  const signatures = tx.getInput(vin).tapScriptSig ?? [];
  const seen = new Set<string>();
  const servers = new Set<string>();
  for (const [key, signature] of signatures) {
    const pubkey = hex.encode(key.pubKey);
    const leafHash = hex.encode(key.leafHash);
    const pair = `${pubkey}:${leafHash}`;
    if (key.pubKey.length !== 32 || key.leafHash.length !== 32 || (signature.length !== 64 && signature.length !== 65) || seen.has(pair)) {
      throw new Error('Bootstrap response contains malformed or duplicate signatures.');
    }
    seen.add(pair);
    const leaf = leaves.find(([, script]) => hex.encode(tapLeafHash(script.subarray(0, -1), script.at(-1)!)) === leafHash);
    if (!leaf) throw new Error('Bootstrap response signed an unsubmitted tapleaf.');
    const keys = signerKeys(leaf[1].subarray(0, -1));
    if (!keys.includes(pubkey)) throw new Error('Bootstrap response contains a signature from a non-leaf signer.');
    verifyTapscriptSignatures(tx, vin, [pubkey], keys.filter((candidate) => candidate !== pubkey), undefined, key.leafHash);
    if (pubkey === serverKey) servers.add(leafHash);
  }
  if (servers.size > 1 || requireServer && servers.size !== 1) throw new Error('Bootstrap response lacks one pinned operator signature per input.');
}

export function verifyBootstrapResponse(request: VmBridgeRequest, response: BootstrapResponse, serverKey: string): {
  ark: Transaction; checkpoints: Transaction[];
} {
  const expectedArk = Transaction.fromPSBT(base64.decode(request.arkTx));
  const returnedArk = Transaction.fromPSBT(base64.decode(response.finalArkTx));
  if (response.arkTxid.toLowerCase() !== expectedArk.id.toLowerCase()) throw new Error('Bootstrap response transaction ID changed.');
  sameBody(returnedArk, expectedArk);
  sameMetadata(returnedArk, expectedArk);
  for (let vin = 0; vin < expectedArk.inputsLength; vin++) {
    verifyPartials(expectedArk, expectedArk, vin, serverKey, false);
    verifyPartials(returnedArk, expectedArk, vin, serverKey, true);
  }
  for (let vin = 0; vin < expectedArk.inputsLength; vin++) {
    const leaf = expectedArk.getInput(vin).tapLeafScript?.find(([, script]) => {
      const hash = hex.encode(tapLeafHash(script.subarray(0, -1), script.at(-1)!));
      return (returnedArk.getInput(vin).tapScriptSig ?? []).some(([key]) => hex.encode(key.leafHash) === hash && hex.encode(key.pubKey) === serverKey);
    });
    if (!leaf) throw new Error('Bootstrap Ark transaction has no operator-signed leaf.');
    const leafHash = tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!);
    const keys = signerKeys(leaf[1].subarray(0, -1));
    if (!keys.includes(serverKey)) throw new Error('Bootstrap spend leaf does not contain the pinned operator.');
    const combined = [...(returnedArk.getInput(vin).tapScriptSig ?? [])];
    for (const local of expectedArk.getInput(vin).tapScriptSig ?? []) {
      if (!Buffer.from(local[0].leafHash).equals(Buffer.from(leafHash))) throw new Error('Submitted wallet signature uses a different bootstrap spend leaf.');
      const duplicate = combined.find(([key]) => Buffer.from(key.pubKey).equals(Buffer.from(local[0].pubKey)) &&
        Buffer.from(key.leafHash).equals(Buffer.from(local[0].leafHash)));
      if (duplicate) {
        if (!Buffer.from(duplicate[1]).equals(Buffer.from(local[1]))) throw new Error('Bootstrap operator response conflicts with a saved wallet signature.');
      } else combined.push(local);
    }
    if (combined.length !== (returnedArk.getInput(vin).tapScriptSig ?? []).length) returnedArk.updateInput(vin, { tapScriptSig: combined });
    if ((returnedArk.getInput(vin).tapScriptSig ?? []).some(([key]) => !Buffer.from(key.leafHash).equals(Buffer.from(leafHash)))) {
      throw new Error('Bootstrap Ark transaction contains signatures for multiple spend leaves.');
    }
    verifyTapscriptSignatures(returnedArk, vin, keys, undefined, undefined, leafHash);
  }
  const localCheckpoints = request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
  const matched = matchServerCheckpoints(response.signedCheckpointTxs, localCheckpoints, 'compact bootstrap recovery');
  const checkpoints = matched.map(({ server, local }) => {
    sameBody(server, local);
    sameMetadata(server, local);
    for (let vin = 0; vin < server.inputsLength; vin++) verifyPartials(server, local, vin, serverKey, true);
    return server;
  });
  return { ark: returnedArk, checkpoints };
}

function signedWeight(tx: Transaction): number {
  const estimated = Transaction.fromPSBT(tx.toPSBT());
  for (let vin = 0; vin < estimated.inputsLength; vin++) {
    const leaf = estimated.getInput(vin).tapLeafScript?.[0];
    if (!leaf) throw new Error(`Bootstrap input ${vin} has no spend leaf.`);
    if (estimated.getInput(vin).finalScriptWitness) continue;
    const script = leaf[1].subarray(0, -1);
    const keys = signerKeys(script).map(hex.decode);
    const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
    const signatures = keys.map((pubKey) => (estimated.getInput(vin).tapScriptSig ?? []).find(([key]) =>
      Buffer.from(key.pubKey).equals(Buffer.from(pubKey)) && Buffer.from(key.leafHash).equals(Buffer.from(leafHash)))?.[1]);
    const complete = signatures.every(Boolean);
    estimated.updateInput(vin, { finalScriptWitness: [
      ...signatures.slice().reverse().map((signature) => signature ?? new Uint8Array(complete ? 64 : 65)),
      leaf[1].subarray(0, -1), TaprootControlBlock.encode(leaf[0]),
    ] });
  }
  const base = estimated.toBytes(false, false).length;
  return estimated.toBytes(true, true).length + 3 * base;
}

function enforceWeight(tx: Transaction, limit: bigint): void {
  const weight = BigInt(signedWeight(tx));
  if (weight > limit) throw new Error(`Bootstrap transaction requires ${weight} WU; effective limit is ${limit} WU.`);
}

function assetPacketEvidence(tx: Transaction): FundingEvidence {
  const packet = Extension.fromTx(tx).getAssetPacket();
  if (!packet) throw new Error('Program funding transaction has no native asset packet.');
  const inputs = new Map<number, Map<string, bigint>>();
  const outputs = new Map<number, Map<string, bigint>>();
  const ids = new Set<string>();
  for (let index = 0; index < packet.groups.length; index++) {
    const group = packet.groups[index]!;
    if (!group.assetId || group.controlAsset) throw new Error('Program funding may not issue, reissue, or control native assets.');
    if (!group.inputs.length || !group.outputs.length) throw new Error('Program funding contains an empty native asset group.');
    const id = group.assetId.toString();
    if (ids.has(id)) throw new Error('Program funding contains duplicate native asset groups.');
    ids.add(id);
    for (const entry of group.inputs) {
      if (!Number.isInteger(entry.vin) || entry.vin < 0 || entry.vin >= tx.inputsLength || entry.amount <= 0n) throw new Error('Program funding has an invalid asset input.');
      const map = inputs.get(entry.vin) ?? new Map<string, bigint>();
      if (map.has(id)) throw new Error('Program funding repeats an asset input.');
      map.set(id, entry.amount); inputs.set(entry.vin, map);
    }
    for (const entry of group.outputs) {
      if (!Number.isInteger(entry.vout) || entry.vout < 0 || entry.vout >= tx.outputsLength || entry.amount <= 0n) throw new Error('Program funding has an invalid asset output.');
      const map = outputs.get(entry.vout) ?? new Map<string, bigint>();
      if (map.has(id)) throw new Error('Program funding repeats an asset output.');
      map.set(id, entry.amount); outputs.set(entry.vout, map);
    }
  }
  return { id: tx.id, inputs, outputs };
}

export function validateFundingAllocation(args: {
  tx: Transaction;
  registeredIds: ReadonlySet<string>;
  expectedAtHead: ReadonlyMap<string, bigint>;
  sourceAssets: ReadonlyMap<number, ReadonlyMap<string, bigint>>;
  walletChangeScripts: ReadonlySet<string>;
}): FundingEvidence {
  const evidence = assetPacketEvidence(args.tx);
  for (let vin = 0; vin < args.tx.inputsLength; vin++) {
    const actual = evidence.inputs.get(vin) ?? new Map<string, bigint>();
    const source = args.sourceAssets.get(vin);
    if (!source || actual.size !== source.size || [...source].some(([id, amount]) => actual.get(id) !== amount)) {
      throw new Error('Program funding native input provenance or conservation is invalid.');
    }
  }
  const groupIds = new Set([...evidence.inputs.values()].flatMap((map) => [...map.keys()]));
  const outputIds = new Set([...evidence.outputs.values()].flatMap((map) => [...map.keys()]));
  if ([...groupIds, ...outputIds].some((id) => !args.registeredIds.has(id))) throw new Error('Program funding contains an unregistered asset identity.');
  for (const id of new Set([...groupIds, ...outputIds, ...args.expectedAtHead.keys()])) {
    let inputs = 0n; let outputs = 0n; let head = 0n;
    for (const map of evidence.inputs.values()) inputs += map.get(id) ?? 0n;
    for (const [vout, map] of evidence.outputs) {
      const amount = map.get(id) ?? 0n;
      outputs += amount;
      if (vout === 0) head = amount;
      else if (amount && !args.walletChangeScripts.has(hex.encode(args.tx.getOutput(vout).script!).toLowerCase())) {
        throw new Error('Program funding sends native asset change outside the wallet.');
      }
    }
    if (inputs !== outputs || head !== (args.expectedAtHead.get(id) ?? 0n)) throw new Error('Program funding native asset allocation or conservation is invalid.');
  }
  return evidence;
}

function mapEqual(left: ReadonlyMap<string, bigint>, right: ReadonlyMap<string, bigint>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function outputAssets(evidence: FundingEvidence, vout: number): Map<string, bigint> {
  return evidence.outputs.get(vout) ?? new Map();
}

function parseIndexed(raws: readonly string[], txid: string): Transaction {
  const matches = raws.map((raw) => Transaction.fromPSBT(base64.decode(raw))).filter((tx) => tx.id.toLowerCase() === txid.toLowerCase());
  if (matches.length !== 1) throw new Error('Indexer did not return exactly one transaction matching the saved body.');
  return matches[0]!;
}

function outpoint(txid: Uint8Array, vout: number): string { return `${hex.encode(txid).toLowerCase()}:${vout}`; }

function indexedAssets(assets: readonly { assetId: string; amount: string | bigint }[] | undefined): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const entry of assets ?? []) {
    const id = compactAssetIdentity(entry.assetId);
    if (map.has(id)) throw new Error('Indexer returned duplicate asset identities.');
    map.set(id, BigInt(entry.amount));
  }
  return map;
}

type LinkedSpend = { checkpointId: string; arkTxid: string; hasResponse: boolean };
function linkedFundingSpend(native: NativeCheckpoint, parentTxid: string, vout: number): LinkedSpend | undefined {
  const live = native.live as (typeof native.live & { bootstrapRecovery?: RecoveryJournal; pendingBootstrap?: BootstrapJournal }) | undefined;
  const records = [
    ...Object.values(live?.bootstrapRecovery?.heads ?? {}).map((record) => ({ request: record.request, hasResponse: true })),
    live?.pendingBootstrap?.request ? { request: live.pendingBootstrap.request, hasResponse: Boolean(live.pendingBootstrap.response) } : undefined,
  ].filter((record): record is NonNullable<typeof record> => Boolean(record));
  const matches: LinkedSpend[] = [];
  const target = `${parentTxid.toLowerCase()}:${vout}`;
  for (const record of records) {
    const request = record.request;
    const ark = Transaction.fromPSBT(base64.decode(request.arkTx));
    for (const raw of request.checkpoints) {
      const checkpoint = Transaction.fromPSBT(base64.decode(raw));
      const source = checkpoint.getInput(0);
      if (!source.txid || source.index === undefined || outpoint(source.txid, source.index) !== target) continue;
      const arkVin = Array.from({ length: ark.inputsLength }, (_, vin) => vin).find((vin) => {
        const input = ark.getInput(vin);
        return input.txid && input.index === 0 && hex.encode(input.txid).toLowerCase() === checkpoint.id.toLowerCase();
      });
      if (arkVin === undefined) throw new Error('Linked funding checkpoint is not present in its Ark request.');
      matches.push({ checkpointId: checkpoint.id.toLowerCase(), arkTxid: ark.id.toLowerCase(), hasResponse: record.hasResponse });
    }
  }
  if (matches.length > 1) throw new Error('Multiple durable funding requests claim the same wallet change output.');
  return matches[0];
}

function assertSecureArkEndpoint(endpoint: string): void {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error('Saved Mutinynet endpoint is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Recovery requires an HTTPS Mutinynet endpoint without embedded credentials.');
}

function resourceOutput(name: ResourceName, native: NativeCheckpoint): { amount: bigint; expected: Map<string, bigint> } {
  const identities = native.live!.issued;
  const btc = BigInt(native.state.reserves.BTC);
  const demo = BigInt(native.state.reserves.DEMO);
  const expected = new Map<string, bigint>();
  if (name === 'gate') { expected.set(identities.token!, TOKEN_SUPPLY); return { amount: GATE_FUNDING, expected }; }
  if (name === 'lane') { expected.set(identities.lane!, 1n); return { amount: CARRIER, expected }; }
  if (name === 'btcVault') { expected.set(identities.btcVault!, 1n); return { amount: CARRIER + btc, expected }; }
  expected.set(identities.tokenVault!, 1n);
  if (demo) expected.set(identities.token!, demo);
  return { amount: CARRIER, expected };
}

function readWalletScripts(wallet: Awaited<ReturnType<typeof Wallet.create>>): Promise<Set<string>> {
  return wallet.getScriptMap().then((scripts) => new Set([...scripts.keys()].map((script) => script.toLowerCase())));
}

function assetMap(assets: readonly { assetId: string; amount: string | bigint }[] | undefined): Map<string, bigint> {
  const actual = new Map<string, bigint>();
  for (const entry of assets ?? []) {
    const id = compactAssetIdentity(entry.assetId);
    if (actual.has(id)) throw new Error('Indexer returned duplicate native asset identities.');
    actual.set(id, BigInt(entry.amount));
  }
  return actual;
}

function exactAssets(assets: readonly { assetId: string; amount: string | bigint }[] | undefined, expected: ReadonlyMap<string, bigint>): boolean {
  return mapEqual(assetMap(assets), expected);
}


type FundingSourceCoin = {
  txid: string; vout: number; isSpent?: boolean; isSwept?: boolean; isUnrolled?: boolean;
  spentBy?: string; arkTxId?: string; arkTxid?: string;
};
type VerifiedSourceUse = { checkpointId: string; arkTxid: string };
type VerifiedSourceUses = Map<string, VerifiedSourceUse>;

function verifyFundingSubmission(request: VmBridgeRequest, response: BootstrapResponse, serverKey: string, expectedTxid: string): VerifiedSourceUses {
  const verified = verifyBootstrapResponse(request, response, serverKey);
  const ark = verified.ark;
  if (ark.id.toLowerCase() !== expectedTxid.toLowerCase() || response.arkTxid.toLowerCase() !== ark.id.toLowerCase()) {
    throw new Error('Saved signed response does not match the exact pending Ark transaction.');
  }
  if (request.checkpoints.length !== ark.inputsLength) throw new Error('Signed response does not cover every Ark input with one checkpoint.');
  const uses: VerifiedSourceUses = new Map();
  const usedVins = new Set<number>();
  for (const checkpoint of request.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)))) {
    if (checkpoint.inputsLength !== 1 || checkpoint.outputsLength < 1) throw new Error('Signed response checkpoint has no exact source input.');
    const source = checkpoint.getInput(0);
    if (!source.txid || source.index === undefined || !source.witnessUtxo) throw new Error('Signed response checkpoint lacks source prevout metadata.');
    const vins = Array.from({ length: ark.inputsLength }, (_, vin) => vin).filter((vin) => {
      const input = ark.getInput(vin);
      return Boolean(input.txid && input.index === 0 && hex.encode(input.txid).toLowerCase() === checkpoint.id.toLowerCase());
    });
    if (vins.length !== 1 || usedVins.has(vins[0]!)) throw new Error('Signed response does not bind each checkpoint to one unique Ark input.');
    usedVins.add(vins[0]!);
    const output = checkpoint.getOutput(0);
    const arkInput = ark.getInput(vins[0]!);
    if (!output.script || arkInput.witnessUtxo?.amount !== output.amount || !sameBytes(arkInput.witnessUtxo?.script, output.script)) {
      throw new Error('Signed response checkpoint continuation differs from its Ark input.');
    }
    const point = `${hex.encode(source.txid).toLowerCase()}:${source.index}`;
    if (uses.has(point)) throw new Error('Signed response repeats a source VTXO.');
    uses.set(point, { checkpointId: checkpoint.id.toLowerCase(), arkTxid: ark.id.toLowerCase() });
  }
  if (usedVins.size !== ark.inputsLength) throw new Error('Signed response omits an Ark input checkpoint.');
  return uses;
}

function checkFundingSourceState(coin: FundingSourceCoin, point: { txid: string; vout: number; checkpoint: Transaction },
  arkTxid: string, authorized: VerifiedSourceUses | undefined): void {
  if (coin.isSwept || coin.isUnrolled) throw new Error('Funding source is swept or unrolled.');
  if (coin.isSpent) {
    const use = authorized?.get(`${point.txid}:${point.vout}`);
    const spentArk = (coin.arkTxId ?? coin.arkTxid)?.toLowerCase();
    if (!use || use.checkpointId !== point.checkpoint.id.toLowerCase() || use.arkTxid !== arkTxid.toLowerCase() ||
        coin.spentBy?.toLowerCase() !== use.checkpointId || spentArk !== use.arkTxid) {
      throw new Error('Funding source spend is not linked to the exact signed checkpoint and Ark transaction.');
    }
  } else if (coin.spentBy || coin.arkTxId || coin.arkTxid) {
    throw new Error('Indexer reports spend linkage for an unspent funding source.');
  }
}

export function assertFundingSourceState(args: {
  coin: FundingSourceCoin;
  checkpointId: string;
  arkTxid: string;
  submission?: { request: VmBridgeRequest; response: BootstrapResponse; serverKey: string };
}): void {
  const point = args.submission?.request.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)))
    .find((checkpoint) => checkpoint.id.toLowerCase() === args.checkpointId.toLowerCase());
  if (args.submission && !point) throw new Error('Signed response does not contain the exact source checkpoint.');
  if (!args.submission && args.coin.isSpent) throw new Error('Funding source is spent before a verified Submit response.');
  const source = point?.getInput(0);
  if (point && (!source?.txid || source.index === undefined || hex.encode(source.txid).toLowerCase() !== args.coin.txid.toLowerCase() ||
      source.index !== args.coin.vout)) throw new Error('Signed response does not spend this exact indexed source outpoint.');
  const uses = args.submission ? verifyFundingSubmission(args.submission.request, args.submission.response,
    args.submission.serverKey, args.arkTxid) : undefined;
  checkFundingSourceState(args.coin, { txid: args.coin.txid.toLowerCase(), vout: args.coin.vout,
    checkpoint: point ?? ({ id: args.checkpointId } as Transaction) }, args.arkTxid, uses);
}

async function validateFundingCandidate(args: {
  name: ResourceName;
  request: VmBridgeRequest;
  native: NativeCheckpoint;
  serverKey: string;
  programScript: Uint8Array;
  indexer: RestIndexerProvider;
  walletScripts: ReadonlySet<string>;
  walletIdentity: ReturnType<typeof SingleKey.fromHex>;
  limit: bigint;
  acceptedResponse?: { txid: string; response: BootstrapResponse };
}): Promise<Transaction> {
  const ark = Transaction.fromPSBT(base64.decode(args.request.arkTx));
  const acceptedUses = args.acceptedResponse ? verifyFundingSubmission(args.request, args.acceptedResponse.response,
    args.serverKey, args.acceptedResponse.txid) : undefined;
  enforceWeight(ark, args.limit);
  if (args.request.checkpoints.length !== ark.inputsLength) throw new Error('Funding request does not have one checkpoint per Ark input.');
  const points: { txid: string; vout: number; arkVin: number; checkpoint: Transaction }[] = [];
  const usedVins = new Set<number>();
  for (const raw of args.request.checkpoints) {
    const checkpoint = Transaction.fromPSBT(base64.decode(raw));
    enforceWeight(checkpoint, args.limit);
    if (checkpoint.inputsLength !== 1 || checkpoint.outputsLength < 1) throw new Error('Funding checkpoint must have one source input and a continuation output.');
    const arkVin = Array.from({ length: ark.inputsLength }, (_, vin) => vin).find((vin) => {
      const input = ark.getInput(vin);
      return Boolean(input.txid && input.index === 0 && hex.encode(input.txid).toLowerCase() === checkpoint.id.toLowerCase());
    });
    if (arkVin === undefined || usedVins.has(arkVin)) throw new Error('Funding checkpoints do not map uniquely to Ark input outpoints.');
    usedVins.add(arkVin);
    const continuation = checkpoint.getOutput(0);
    const arkInput = ark.getInput(arkVin);
    if (!continuation.script || arkInput.witnessUtxo?.amount !== continuation.amount || !sameBytes(arkInput.witnessUtxo?.script, continuation.script)) {
      throw new Error('Funding Ark input differs from its checkpoint continuation.');
    }
    for (let vin = 0; vin < ark.inputsLength; vin++) verifyPartials(ark, ark, vin, args.serverKey, false);
    const source = checkpoint.getInput(0);
    if (!source.txid || source.index === undefined || !source.witnessUtxo) throw new Error('Funding checkpoint lacks exact source prevout metadata.');
    points.push({ txid: hex.encode(source.txid).toLowerCase(), vout: source.index, arkVin, checkpoint });
  }
  if (usedVins.size !== ark.inputsLength || new Set(points.map(({ txid, vout }) => `${txid}:${vout}`)).size !== points.length) {
    throw new Error('Funding checkpoints omit or repeat source inputs.');
  }
  const sourceResult = await args.indexer.getVtxos({ outpoints: points.map(({ txid, vout }) => ({ txid, vout })) });
  if (sourceResult.vtxos.length !== points.length) throw new Error('Indexer lacks exact funding source VTXOs.');
  const sourceAssets = new Map<number, Map<string, bigint>>();
  for (const point of points) {
    const matches = sourceResult.vtxos.filter((coin) => coin.txid.toLowerCase() === point.txid && coin.vout === point.vout);
    if (matches.length !== 1) throw new Error('Indexer returned duplicate or missing funding source VTXOs.');
    const coin = matches[0]!;
    const witness = point.checkpoint.getInput(0).witnessUtxo!;
    if (coin.value !== Number(witness.amount) || coin.script.toLowerCase() !== hex.encode(witness.script).toLowerCase()) {
      throw new Error('Funding source differs from the submitted checkpoint metadata.');
    }
    checkFundingSourceState(coin, point, ark.id, acceptedUses);
    sourceAssets.set(point.arkVin, indexedAssets(coin.assets));
  }
  const registered = new Set(Object.values(args.native.live!.issued).filter((id): id is string => Boolean(id)).map(compactAssetIdentity));
  const expected = resourceOutput(args.name, args.native);
  const evidence = validateFundingAllocation({ tx: ark, registeredIds: registered, expectedAtHead: expected.expected,
    sourceAssets, walletChangeScripts: args.walletScripts });
  const head = ark.getOutput(0);
  if (!head.script || !Buffer.from(head.script).equals(Buffer.from(args.programScript)) || head.amount !== expected.amount ||
      !mapEqual(outputAssets(evidence, 0), expected.expected)) throw new Error('Funding candidate does not create the exact registered program head.');
  for (let vout = 1; vout < ark.outputsLength; vout++) {
    const output = ark.getOutput(vout);
    if (output.amount !== undefined && output.amount > 0n &&
        !args.walletScripts.has(hex.encode(output.script!).toLowerCase())) throw new Error('Funding candidate sends wallet change outside the owner wallet.');
  }
  const walletPubkey = hex.encode(await args.walletIdentity.xOnlyPublicKey());
  for (let vin = 0; vin < ark.inputsLength; vin++) {
    const candidates = (ark.getInput(vin).tapLeafScript ?? []).filter(([, script]) => signerKeys(script.subarray(0, -1)).includes(walletPubkey));
    if (candidates.length !== 1) throw new Error('Funding candidate does not have one wallet-owned spend leaf per input.');
    const leafHash = tapLeafHash(candidates[0]![1].subarray(0, -1), candidates[0]![1].at(-1)!);
    const local = (ark.getInput(vin).tapScriptSig ?? []).filter(([key]) => hex.encode(key.pubKey) === walletPubkey && Buffer.from(key.leafHash).equals(Buffer.from(leafHash)));
    if (local.length !== 1) throw new Error('Funding candidate is missing its exact wallet signature.');
  }
  return ark;
}

async function validateAcceptedResource(args: {
  name: ResourceName;
  txid: string;
  request: VmBridgeRequest;
  response: BootstrapResponse;
  native: NativeCheckpoint;
  info: ArkInfo;
  serverKey: string;
  programScript: Uint8Array;
  indexer: RestIndexerProvider;
  walletScripts: ReadonlySet<string>;
  identity: ReturnType<typeof SingleKey.fromHex>;
  finalizeIfNeeded: boolean;
}): Promise<Transaction> {
  const verified = verifyBootstrapResponse(args.request, args.response, args.serverKey);
  const limit = args.info.maxTxWeight === undefined || args.info.maxTxWeight > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : args.info.maxTxWeight;
  enforceWeight(verified.ark, limit);
  const fullCheckpoints = await Promise.all(verified.checkpoints.map(async (checkpoint) => {
    const signed = await args.identity.sign(checkpoint, Array.from({ length: checkpoint.inputsLength }, (_, vin) => vin));
    sameBody(signed, checkpoint); sameMetadata(signed, checkpoint);
    for (let vin = 0; vin < signed.inputsLength; vin++) {
      const leaf = checkpoint.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error('Bootstrap checkpoint is missing its submitted tapleaf.');
      verifyTapscriptSignatures(signed, vin, signerKeys(leaf[1].subarray(0, -1)), undefined, undefined,
        tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    enforceWeight(signed, limit);
    return signed;
  }));
  for (const checkpoint of fullCheckpoints) enforceWeight(checkpoint, limit);

  const expected = Transaction.fromPSBT(base64.decode(args.request.arkTx));
  const indexedArk = parseIndexed((await args.indexer.getVirtualTxs([expected.id])).txs, expected.id);
  sameBody(indexedArk, expected); sameMetadata(indexedArk, expected);
  if (indexedArk.id.toLowerCase() !== args.txid.toLowerCase()) throw new Error('Accepted Ark transaction ID does not match the saved request.');
  const requestedCheckpoints = args.request.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)));
  if (requestedCheckpoints.length !== fullCheckpoints.length) throw new Error('Accepted response checkpoint count changed.');
  if (requestedCheckpoints.length !== expected.inputsLength) throw new Error('Bootstrap request does not have one checkpoint for each Ark input.');
  const checkpointPoints: { txid: string; vout: number; checkpointId: string; checkpoint: Transaction; arkVin: number }[] = [];
  const orderedInputs = Array.from({ length: expected.inputsLength }, (_, vin) => {
    const input = expected.getInput(vin);
    if (!input.txid || input.index === undefined) throw new Error('Bootstrap Ark input lacks an outpoint.');
    return { txid: hex.encode(input.txid).toLowerCase(), vout: input.index };
  });
  const mappedVins = new Set<number>();
  for (const checkpoint of requestedCheckpoints) {
    if (checkpoint.inputsLength !== 1 || checkpoint.outputsLength < 1) throw new Error('Bootstrap checkpoint must have one input and a continuation output.');
    const indexed = parseIndexed((await args.indexer.getVirtualTxs([checkpoint.id])).txs, checkpoint.id);
    sameBody(indexed, checkpoint); sameMetadata(indexed, checkpoint);
    const arkVin = orderedInputs.findIndex((point) => point.txid === checkpoint.id.toLowerCase() && point.vout === 0);
    if (arkVin < 0 || mappedVins.has(arkVin)) throw new Error('Bootstrap checkpoint does not map uniquely to an Ark input.');
    mappedVins.add(arkVin);
    const arkInput = expected.getInput(arkVin);
    const checkpointHead = checkpoint.getOutput(0);
    if (!checkpointHead.script || arkInput.witnessUtxo?.amount !== checkpointHead.amount ||
        !sameBytes(arkInput.witnessUtxo?.script, checkpointHead.script)) {
      throw new Error('Ark input does not spend the exact checkpoint continuation output.');
    }
    const input = checkpoint.getInput(0);
    if (!input.txid || input.index === undefined || !input.witnessUtxo) throw new Error('Bootstrap checkpoint has an incomplete original wallet prevout.');
    checkpointPoints.push({ txid: hex.encode(input.txid).toLowerCase(), vout: input.index, checkpointId: checkpoint.id, checkpoint, arkVin });
  }
  if (mappedVins.size !== expected.inputsLength) throw new Error('Bootstrap checkpoints do not cover every Ark input.');
  const spentResult = await args.indexer.getVtxos({ outpoints: checkpointPoints.map(({ txid, vout }) => ({ txid, vout })) });
  if (spentResult.vtxos.length !== checkpointPoints.length || checkpointPoints.some((point) => {
    const matches = spentResult.vtxos.filter((coin) => coin.txid.toLowerCase() === point.txid.toLowerCase() && coin.vout === point.vout);
    return matches.length !== 1 || !matches[0]!.isSpent || matches[0]!.spentBy?.toLowerCase() !== point.checkpointId.toLowerCase() ||
      (matches[0]!.arkTxId ?? (matches[0] as unknown as { arkTxid?: string }).arkTxid)?.toLowerCase() !== args.txid.toLowerCase();
  })) throw new Error('Indexer does not prove each checkpoint input was spent by the accepted Ark transaction.');

  const sourcePoints = checkpointPoints.map(({ txid, vout }) => ({ txid, vout }));
  if (new Set(sourcePoints.map((point) => `${point.txid}:${point.vout}`)).size !== sourcePoints.length) throw new Error('Bootstrap checkpoints repeat an original source outpoint.');
  const sourceCoins = await args.indexer.getVtxos({ outpoints: sourcePoints });
  if (sourceCoins.vtxos.length !== sourcePoints.length) throw new Error('Indexer lacks exact native asset source coins.');
  const expectedSourceAssets = new Map<number, Map<string, bigint>>();
  for (const point of checkpointPoints) {
    const matches = sourceCoins.vtxos.filter((coin) => coin.txid.toLowerCase() === point.txid.toLowerCase() && coin.vout === point.vout);
    if (matches.length !== 1) throw new Error('Indexer returned duplicate or missing native asset source coins.');
    const source = matches[0]!;
    const previous = point.checkpoint.getInput(0).witnessUtxo!;
    if (source.value !== Number(previous.amount) || source.script.toLowerCase() !== hex.encode(previous.script).toLowerCase()) {
      throw new Error('Checkpoint input metadata does not match the exact indexed source VTXO.');
    }
    expectedSourceAssets.set(point.arkVin, indexedAssets(source.assets));
  }
  const identities = new Set(Object.values(args.native.live!.issued).filter((value): value is string => Boolean(value)).map(compactAssetIdentity));
  const target = resourceOutput(args.name, args.native);
  const evidence = validateFundingAllocation({ tx: indexedArk, registeredIds: identities, expectedAtHead: target.expected,
    sourceAssets: expectedSourceAssets, walletChangeScripts: args.walletScripts });
  const expectedAmount = target.amount;
  const head = indexedArk.getOutput(0);
  if (!head.script || !Buffer.from(head.script).equals(Buffer.from(args.programScript)) || head.amount !== expectedAmount) {
    throw new Error('Program funding head has the wrong profile closure or native output value.');
  }
  const positiveOutputs = Array.from({ length: indexedArk.outputsLength }, (_, vout) => ({ vout, output: indexedArk.getOutput(vout) }))
    .filter(({ output }) => output.amount !== undefined && output.amount > 0n);
  const received = await args.indexer.getVtxos({ outpoints: positiveOutputs.map(({ vout }) => ({ txid: indexedArk.id, vout })) });
  if (received.vtxos.length !== positiveOutputs.length) throw new Error('Indexer did not accept every positive program funding output.');
  for (const { vout, output } of positiveOutputs) {
    const matches = received.vtxos.filter((coin) => coin.txid.toLowerCase() === indexedArk.id.toLowerCase() && coin.vout === vout);
    const expectedScript = hex.encode(output.script!).toLowerCase();
    const expectedAssets = outputAssets(evidence, vout);
    if (matches.length !== 1 || matches[0]!.isSwept || matches[0]!.isUnrolled ||
        matches[0]!.value !== Number(output.amount) || matches[0]!.script.toLowerCase() !== expectedScript ||
        vout !== 0 && !args.walletScripts.has(expectedScript) || !exactAssets(matches[0]!.assets, expectedAssets)) {
      throw new Error('Program funding output is not an exact accepted head or wallet-owned change output.');
    }
    const coin = matches[0]!;
    if (vout === 0 && coin.isSpent) throw new Error('Registered program head was already spent.');
    if (vout > 0 && coin.isSpent) {
      const linked = linkedFundingSpend(args.native, indexedArk.id, vout);
      if (!linked?.hasResponse || coin.spentBy?.toLowerCase() !== linked.checkpointId ||
          (coin.arkTxId ?? (coin as unknown as { arkTxid?: string }).arkTxid)?.toLowerCase() !== linked.arkTxid) {
        throw new Error('Spent wallet change is not linked to a durable signed funding request.');
      }
    }
  }
  return indexedArk;
}

type RecoveryContext = {
  provider: RestArkProvider;
  indexer: RestIndexerProvider;
  wallet: Awaited<ReturnType<typeof Wallet.create>>;
  walletIdentity: ReturnType<typeof SingleKey.fromHex>;
  info: ArkInfo;
  serverKey: string;
  profile: Awaited<ReturnType<typeof createCompactProfile>>['profile'];
  closure: Awaited<ReturnType<typeof createCompactProfile>>['closure'];
  walletScripts: Set<string>;
  verificationKeys: Record<string, unknown>;
  initialState: import('../packages/protocol/src/types.ts').ProtocolState;
};

function profileId(checkpoint: StoredEngine): string {
  const result = checkpoint.native.compact?.profileId;
  if (!result || result !== checkpoint.profileId) throw new Error('Saved engine and native profile IDs do not match.');
  return result;
}

async function validateIssuance(checkpoint: StoredEngine, indexer: RestIndexerProvider): Promise<void> {
  const native = checkpoint.native;
  const live = native.live!;
  const expectedToken = TOKEN_SUPPLY + BigInt(native.state.reserves.DEMO);
  for (const name of ISSUE_NAMES) {
    const tx = Transaction.fromRaw(hex.decode(live.issuanceTransactions![name]!));
    const expectedId = asset.AssetId.create(tx.id, 0).toString();
    const amount = name === 'token' ? expectedToken : 1n;
    if (live.issued[name] !== expectedId || native.identities[name] !== expectedId) throw new Error(`Saved ${name} identity is not derived from its actual issuance transaction.`);
    const packet = Extension.fromTx(tx).getAssetPacket();
    const group = packet?.groups[0];
    if (!packet || packet.groups.length !== 1 || !group || group.assetId !== null || group.controlAsset || group.inputs.length ||
        group.outputs.length !== 1 || group.outputs[0]!.vout !== 0 || group.outputs[0]!.amount !== amount) {
      throw new Error(`Saved ${name} issuance transaction does not prove the registered identity.`);
    }
    const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: tx.id, vout: 0 }] });
    const output = tx.getOutput(0);
    if (vtxos.length !== 1 || !output.script || vtxos[0]!.value !== Number(output.amount) ||
        vtxos[0]!.script.toLowerCase() !== hex.encode(output.script).toLowerCase() ||
        !exactAssets(vtxos[0]!.assets, new Map([[expectedId, amount]])) || vtxos[0]!.isSwept || vtxos[0]!.isUnrolled) {
      throw new Error(`Saved ${name} issuance output does not match its accepted transaction.`);
    }
    if (vtxos[0]!.isSpent) {
      const linked = linkedFundingSpend(native, tx.id, 0);
      if (!linked?.hasResponse || vtxos[0]!.spentBy?.toLowerCase() !== linked.checkpointId ||
          (vtxos[0]!.arkTxId ?? (vtxos[0] as unknown as { arkTxid?: string }).arkTxid)?.toLowerCase() !== linked.arkTxid) {
        throw new Error(`Spent ${name} issuance output lacks a linked durable funding request.`);
      }
    }
  }
  if (native.issuanceRaw !== live.issuanceTransactions!.token) throw new Error('Saved canonical token issuance ancestry changed.');
}

async function createContext(checkpoint: StoredEngine): Promise<RecoveryContext> {
  const native = checkpoint.native;
  const live = native.live!;
  assertSecureArkEndpoint(live.arkUrl);
  const provider = new RestArkProvider(live.arkUrl);
  const indexer = new RestIndexerProvider(live.arkUrl);
  const info = await provider.getInfo();
  if (info.network !== 'mutinynet') throw new Error('Recovery only supports the pinned Mutinynet network.');
  const serverKey = info.signerPubkey.slice(-64).toLowerCase();
  const walletIdentity = SingleKey.fromHex(live.seedHex);
  const emulatorIdentity = SingleKey.fromHex(live.compactEmulatorSecret!);
  const emulatorKey = hex.encode(await emulatorIdentity.xOnlyPublicKey());
  if (serverKey !== native.serverKey.toLowerCase() || emulatorKey !== native.emulatorKey.toLowerCase() ||
      info.checkpointTapscript !== native.checkpointScript || BigInt(info.unilateralExitDelay) !== 2048n) {
    throw new Error('Mutinynet signer, checkpoint policy, or exit delay differs from the registered profile.');
  }
  const protocol = await createProtocol({ checkpoint: checkpoint.protocol, secureKeys: true });
  const snapshot = protocol.snapshot();
  if (snapshot.wallets.alice.notes.length || snapshot.wallets.bob.notes.length || snapshot.receipts.length ||
      snapshot.encryptedLog.length || snapshot.nullifiers.length || snapshot.state.noteCount || snapshot.state.historyCount ||
      snapshot.state.reserves.BTC || snapshot.state.reserves.DEMO) {
    throw new Error('Recovery requires an empty protocol state with no notes or nullifiers.');
  }
  const alice = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(native.aliceSecret).xOnlyPublicKey(), { type: 'seconds', value: 2048n });
  const bob = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(native.bobSecret).xOnlyPublicKey(), { type: 'seconds', value: 2048n });
  const registered = await createCompactProfile({
    relationVersion: 'ark-shield-poc-v1', domain: native.domain,
    verificationKeys: protocol.verificationKeys() as CompactProfileConfig['verificationKeys'], serverKey, emulatorKey,
    checkpointScript: info.checkpointTapscript,
    exitTimelock: { type: 'seconds', value: '2048' }, identities: live.issued as CompactProfileConfig['identities'],
    destinations: { alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field }, bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field } },
  });
  if (registered.profile.profileId !== profileId(checkpoint)) {
    throw new Error('Recomputed compact verifier profile differs from the persisted profile.');
  }
  await validateIssuance(checkpoint, indexer);
  const wallet = await Wallet.create({ identity: walletIdentity, arkProvider: provider, indexerProvider: indexer,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() }, walletMode: 'static' });
  return { provider, indexer, wallet, walletIdentity, info, serverKey, profile: registered.profile, closure: registered.closure,
    walletScripts: await readWalletScripts(wallet), verificationKeys: protocol.verificationKeys(), initialState: snapshot.state };
}

function expectedResource(name: ResourceName, native: NativeCheckpoint): { amount: bigint; assets: { assetId: string; amount: bigint }[] } {
  const target = resourceOutput(name, native);
  return { amount: target.amount, assets: [...target.expected].map(([assetId, amount]) => ({ assetId, amount })) };
}

async function isAccepted(name: ResourceName, request: VmBridgeRequest, txid: string, checkpoint: StoredEngine,
  context: RecoveryContext): Promise<boolean> {
  const expected = Transaction.fromPSBT(base64.decode(request.arkTx));
  const txs = (await context.indexer.getVirtualTxs([expected.id])).txs;
  if (!txs.length) return false;
  const indexed = parseIndexed(txs, expected.id);
  sameBody(indexed, expected); sameMetadata(indexed, expected);
  if (indexed.id.toLowerCase() !== txid.toLowerCase()) return false;
  const checkpoints = request.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)));
  if (checkpoints.length !== expected.inputsLength) throw new Error('Saved checkpoint inputs do not cover the submitted transaction.');
  const points = checkpoints.map((cp) => {
    const input = cp.getInput(0);
    if (!input.txid || input.index === undefined) throw new Error('Saved checkpoint input lacks a source outpoint.');
    return { txid: hex.encode(input.txid).toLowerCase(), vout: input.index, checkpointId: cp.id.toLowerCase() };
  });
  if (new Set(points.map((point) => `${point.txid}:${point.vout}`)).size !== points.length) throw new Error('Saved checkpoints repeat a source outpoint.');
  const spent = await context.indexer.getVtxos({ outpoints: points.map(({ txid: parent, vout }) => ({ txid: parent, vout })) });
  if (spent.vtxos.length !== points.length || !points.every((point) => {
    const found = spent.vtxos.filter((coin) => coin.txid.toLowerCase() === point.txid && coin.vout === point.vout);
    return found.length === 1 && found[0]!.isSpent && found[0]!.spentBy?.toLowerCase() === point.checkpointId &&
      (found[0]!.arkTxId ?? (found[0] as unknown as { arkTxid?: string }).arkTxid)?.toLowerCase() === txid.toLowerCase();
  })) return false;
  const target = resourceOutput(name, checkpoint.native);
  const head = indexed.getOutput(0);
  const evidence = assetPacketEvidence(indexed);
  if (!head.script || !Buffer.from(head.script).equals(Buffer.from(context.closure.pkScript)) || head.amount !== target.amount ||
      !mapEqual(outputAssets(evidence, 0), target.expected)) return false;
  const positive = Array.from({ length: indexed.outputsLength }, (_, vout) => ({ vout, output: indexed.getOutput(vout) }))
    .filter(({ output }) => output.amount !== undefined && output.amount > 0n);
  const received = await context.indexer.getVtxos({ outpoints: positive.map(({ vout }) => ({ txid: indexed.id, vout })) });
  if (received.vtxos.length !== positive.length) return false;
  for (const { vout, output } of positive) {
    const script = hex.encode(output.script!).toLowerCase();
    const matches = received.vtxos.filter((coin) => coin.txid.toLowerCase() === indexed.id.toLowerCase() && coin.vout === vout);
    if (matches.length !== 1 || matches[0]!.value !== Number(output.amount) || matches[0]!.script.toLowerCase() !== script ||
        matches[0]!.isSwept || matches[0]!.isUnrolled || !exactAssets(matches[0]!.assets, outputAssets(evidence, vout)) ||
        (vout === 0 && matches[0]!.isSpent) || (vout > 0 && !context.walletScripts.has(script))) return false;
    if (vout > 0 && matches[0]!.isSpent) {
      const linked = linkedFundingSpend(checkpoint.native, indexed.id, vout);
      if (!linked?.hasResponse || matches[0]!.spentBy?.toLowerCase() !== linked.checkpointId ||
          (matches[0]!.arkTxId ?? (matches[0] as unknown as { arkTxid?: string }).arkTxid)?.toLowerCase() !== linked.arkTxid) return false;
    }
  }
  return true;
}

function signAndVerifyCheckpoints(checkpoints: Transaction[], identity: ReturnType<typeof SingleKey.fromHex>, serverKey: string,
  limit: bigint): Promise<string[]> {
  return Promise.all(checkpoints.map(async (checkpoint) => {
    const signed = await identity.sign(checkpoint, Array.from({ length: checkpoint.inputsLength }, (_, vin) => vin));
    sameBody(signed, checkpoint); sameMetadata(signed, checkpoint);
    for (let vin = 0; vin < signed.inputsLength; vin++) {
      const leaf = checkpoint.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error('Bootstrap checkpoint is missing its submitted spend leaf.');
      const keys = signerKeys(leaf[1].subarray(0, -1));
      if (!keys.includes(serverKey)) throw new Error('Bootstrap checkpoint spend leaf lacks the pinned operator.');
      verifyTapscriptSignatures(signed, vin, keys, undefined, undefined, tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    enforceWeight(signed, limit);
    return base64.encode(signed.toPSBT());
  }));
}

function verifyFinalizedCheckpoints(request: VmBridgeRequest, response: BootstrapResponse, finals: readonly string[], serverKey: string,
  limit: bigint): string[] {
  const expected = request.checkpoints.map((raw) => Transaction.fromPSBT(base64.decode(raw)));
  const server = matchServerCheckpoints(response.signedCheckpointTxs, expected, 'bootstrap recovery response').map((entry) => entry.server);
  const signed = matchServerCheckpoints([...finals], expected, 'bootstrap recovery finalize').map((entry) => entry.server);
  if (server.length !== signed.length) throw new Error('Finalized checkpoint count does not match the signed response.');
  for (let index = 0; index < signed.length; index++) {
    const tx = signed[index]!; const source = expected.find((candidate) => candidate.id === tx.id)!;
    sameBody(tx, source); sameMetadata(tx, source);
    const serverTx = server[index]!;
    for (let vin = 0; vin < tx.inputsLength; vin++) {
      const finalSigs = tx.getInput(vin).tapScriptSig ?? [];
      for (const [serverKeyData, serverSignature] of serverTx.getInput(vin).tapScriptSig ?? []) {
        const copied = finalSigs.filter(([key]) => Buffer.from(key.pubKey).equals(Buffer.from(serverKeyData.pubKey)) &&
          Buffer.from(key.leafHash).equals(Buffer.from(serverKeyData.leafHash)));
        if (copied.length !== 1 || !Buffer.from(copied[0]![1]).equals(Buffer.from(serverSignature))) {
          throw new Error('Finalized checkpoint changed an operator signature from its signed response.');
        }
      }
      verifyPartials(tx, source, vin, serverKey, true);
      const leaf = source.getInput(vin).tapLeafScript?.[0];
      if (!leaf) throw new Error('Finalized checkpoint has no submitted spend leaf.');
      verifyTapscriptSignatures(tx, vin, signerKeys(leaf[1].subarray(0, -1)), undefined, undefined,
        tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!));
    }
    enforceWeight(tx, limit);
  }
  return signed.map((tx) => base64.encode(tx.toPSBT()));
}

export async function journalBeforeNetwork<T>(persist: () => Promise<void>, networkWrite: () => Promise<T>): Promise<T> {
  await persist();
  return networkWrite();
}

function effectiveLimit(info: ArkInfo): bigint {
  return info.maxTxWeight === undefined || info.maxTxWeight > HARD_WEIGHT_LIMIT ? HARD_WEIGHT_LIMIT : info.maxTxWeight;
}

function recoveryHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function adoptHead(checkpoint: StoredEngine, context: RecoveryContext, name: ResourceName,
  request: VmBridgeRequest, response: BootstrapResponse, signedCheckpoints: string[]): Promise<void> {
  const pending = checkpoint.native.live!.pendingBootstrap;
  const txid = pending?.txid ?? response.arkTxid;
  const accepted = await validateAcceptedResource({ name, txid, request, response, native: checkpoint.native, info: context.info,
    serverKey: context.serverKey, programScript: context.closure.pkScript, indexer: context.indexer,
    walletScripts: context.walletScripts, identity: context.walletIdentity, finalizeIfNeeded: false });
  if (!checkpoint.native.live!.bootstrapRecovery) checkpoint.native.live!.bootstrapRecovery = { version: 1, profileId: checkpoint.profileId, heads: {} };
  const journal = checkpoint.native.live!.bootstrapRecovery!;
  if (journal.profileId !== checkpoint.profileId) throw new Error('Bootstrap recovery journal profile changed.');
  journal.heads[name] = { request: structuredClone(request), response: structuredClone(response), finalizedCheckpointTxs: [...signedCheckpoints] };
  const sourceTx = hex.encode(accepted.toBytes());
  checkpoint.native.heads[name] = { ...coinFromTransaction(accepted, 0), sourceTx };
  if (name === 'gate') {
    checkpoint.native.genesisRaw = sourceTx;
    checkpoint.native.funding = { BTC: GATE_FUNDING.toString(), DEMO: TOKEN_SUPPLY.toString() };
  }
  checkpoint.native.live!.pendingBootstrap = undefined;
}

async function validateSavedPrefix(checkpoint: StoredEngine, context: RecoveryContext): Promise<void> {
  const names = RESOURCE_NAMES.filter((name) => checkpoint.native.heads[name]);
  for (const name of names) {
    const head = checkpoint.native.heads[name]!;
    const record = checkpoint.native.live!.bootstrapRecovery?.heads[name];
    if (!record || record.response.arkTxid.toLowerCase() !== head.txid.toLowerCase()) throw new Error(`Saved ${name} head lacks signed recovery evidence.`);
    const validated = await validateAcceptedResource({ name, txid: head.txid, request: record.request, response: record.response,
      native: checkpoint.native, info: context.info, serverKey: context.serverKey, programScript: context.closure.pkScript,
      indexer: context.indexer, walletScripts: context.walletScripts, identity: context.walletIdentity, finalizeIfNeeded: false });
    if (validated.id.toLowerCase() !== head.txid.toLowerCase() || head.vout !== 0 ||
        head.sourceTx !== hex.encode(validated.toBytes()) || head.value !== Number(validated.getOutput(0).amount)) {
      throw new Error(`Saved ${name} head differs from its signed indexed recovery evidence.`);
    }
    verifyFinalizedCheckpoints(record.request, record.response, record.finalizedCheckpointTxs, context.serverKey, effectiveLimit(context.info));
  }
}

async function verifyReadyRestore(checkpoint: StoredEngine, context: RecoveryContext): Promise<void> {
  const candidate = structuredClone(checkpoint.native);
  candidate.issuanceRaw = candidate.live!.issuanceTransactions!.token!;
  candidate.live!.phase = 'ready';
  const restored = await createCompactReadyLiveRuntime({ verificationKeys: context.verificationKeys, initialState: context.initialState,
    domain: BigInt(candidate.domain), checkpoint: candidate, network: 'mutinynet', arkUrl: candidate.live!.arkUrl,
    onCheckpoint: async () => {} });
  try {
    const snapshot = restored.snapshot() as { ready?: boolean; profileId?: string; heads?: Record<string, unknown>; bootstrapPhase?: string };
    if (snapshot.ready !== true || snapshot.profileId !== checkpoint.profileId ||
        RESOURCE_NAMES.some((name) => !snapshot.heads?.[name]) || snapshot.bootstrapPhase !== 'ready') {
      throw new Error('Read-only compact runtime restore did not confirm the registered ready profile and four heads.');
    }
  } finally { await restored.close(); }
}

async function recoverWithContext(checkpoint: StoredEngine, context: RecoveryContext, store: EngineStore): Promise<void> {
  const live = checkpoint.native.live!;
  const limit = effectiveLimit(context.info);
  const originalSubmit = context.provider.submitTx.bind(context.provider);
  const originalFinalize = context.provider.finalizeTx.bind(context.provider);
  let activeStep: string | undefined;
  const persist = async () => { store.save(checkpoint); };
  context.provider.submitTx = async (arkTx, checkpointTxs) => {
    if (!activeStep || live.pendingBootstrap) throw new Error('Recovery refuses an unjournaled or duplicate native submission.');
    const request: VmBridgeRequest = { arkTx, checkpoints: checkpointTxs };
    const submitted = await validateFundingCandidate({ name: activeStep.slice('fund:'.length) as ResourceName, request,
      native: checkpoint.native, serverKey: context.serverKey, programScript: context.closure.pkScript,
      indexer: context.indexer, walletScripts: context.walletScripts, walletIdentity: context.walletIdentity, limit });
    live.pendingBootstrap = { step: activeStep, txid: submitted.id, request, recoveryOwned: true };
    const response = await journalBeforeNetwork(persist, () => originalSubmit(arkTx, checkpointTxs));
    const verified = verifyBootstrapResponse(request, response, context.serverKey);
    enforceWeight(verified.ark, limit);
    live.pendingBootstrap.response = { ...response, finalArkTx: base64.encode(verified.ark.toPSBT()) };
    await persist();
    return live.pendingBootstrap.response;
  };
  context.provider.finalizeTx = async (txid, checkpointTxs) => {
    const pending = live.pendingBootstrap;
    if (!pending || !pending.recoveryOwned || pending.txid.toLowerCase() !== txid.toLowerCase() || !pending.response) throw new Error('Recovery refuses to finalize a transaction without its exact tool-owned durable response.');
    const name = pending.step.slice('fund:'.length) as ResourceName;
    await validateFundingCandidate({ name, request: pending.request, native: checkpoint.native, serverKey: context.serverKey,
      programScript: context.closure.pkScript, indexer: context.indexer, walletScripts: context.walletScripts,
      walletIdentity: context.walletIdentity, limit, acceptedResponse: { txid: pending.txid, response: pending.response } });
    const full = verifyFinalizedCheckpoints(pending.request, pending.response, checkpointTxs, context.serverKey, limit);
    pending.finalizedCheckpointTxs = full;
    await persist();
    await originalFinalize(txid, full);
  };

  await validateSavedPrefix(checkpoint, context);
  for (const name of RESOURCE_NAMES) {
    if (checkpoint.native.heads[name]) continue;
    const pending = live.pendingBootstrap;
    const step = `fund:${name}`;
    if (pending && pending.step !== step) throw new Error('Unresolved funding journal does not match the next resource.');
    if (pending) {
      if (!pending.response) throw new Error('A funding outcome has no durable signed response; no retry or resubmission is allowed.');
      const response = pending.response;
      const request = pending.request;
      const remote = verifyBootstrapResponse(request, response, context.serverKey);
      enforceWeight(remote.ark, limit);
      const signedCheckpoints = await signAndVerifyCheckpoints(remote.checkpoints, context.walletIdentity, context.serverKey, limit);
      if (!await isAccepted(name, request, pending.txid, checkpoint, context)) {
        if (!pending.recoveryOwned || pending.finalizedCheckpointTxs) throw new Error('Funding finalize outcome is unknown; the legacy transaction will not be resent.');
        const journal = live.pendingBootstrap;
        if (!journal) throw new Error('Pending bootstrap journal disappeared before finalize.');
        journal.finalizedCheckpointTxs = signedCheckpoints;
        await persist();
        await context.provider.finalizeTx(pending.txid, signedCheckpoints);
        if (!await isAccepted(name, request, pending.txid, checkpoint, context)) throw new Error('Original funding finalize has not been accepted by the indexer.');
      }
      await adoptHead(checkpoint, context, name, request, response, signedCheckpoints);
      await persist();
      continue;
    }
    if (!checkpoint.native.live!.bootstrapRecovery?.heads || !Object.keys(checkpoint.native.heads).length) {
      throw new Error('No durable pending transaction or adopted resource prefix exists; refusing to begin a new recovery flow.');
    }
    activeStep = step;
    const assetSpec = expectedResource(name, checkpoint.native);
    const address = new ArkAddress(hex.decode(context.serverKey), context.closure.pkScript.subarray(2), 'tark').encode();
    let txid: string;
    try {
      txid = await context.wallet.send({ recipients: [{ address, amount: Number(assetSpec.amount), assets: assetSpec.assets,
        tapTree: context.closure.tapTree } as never] });
    } finally { activeStep = undefined; }
    const submitted = live.pendingBootstrap;
    if (!submitted || submitted.step !== step || submitted.txid.toLowerCase() !== txid.toLowerCase() || !submitted.response) {
      throw new Error('SDK send returned without its exact durable signed recovery journal.');
    }
    const signedCheckpoints = submitted.finalizedCheckpointTxs;
    if (!signedCheckpoints) throw new Error('SDK did not durably journal the fully signed checkpoints before finalize.');
    if (!await isAccepted(name, submitted.request, submitted.txid, checkpoint, context)) throw new Error('SDK funding transaction is not accepted by the indexer.');
    await adoptHead(checkpoint, context, name, submitted.request, submitted.response, signedCheckpoints);
    await persist();
  }
  if (RESOURCE_NAMES.some((name) => !checkpoint.native.heads[name])) throw new Error('Recovery did not produce all four verified resource heads.');
  checkpoint.native.issuanceRaw = live.issuanceTransactions!.token!;
  await verifyReadyRestore(checkpoint, context);
  live.phase = 'ready';
  await persist();
}

export function recoveryPlan(checkpoint: StoredEngine): { profileId: string; phase: string; pendingTxid?: string; adopted: string[]; missing: ResourceName[] } {
  assertRecoverableCheckpoint(checkpoint);
  const adopted = RESOURCE_NAMES.filter((name) => Boolean(checkpoint.native.heads[name]));
  return { profileId: checkpoint.profileId, phase: checkpoint.native.live!.phase,
    pendingTxid: checkpoint.native.live!.pendingBootstrap?.txid, adopted,
    missing: RESOURCE_NAMES.filter((name) => !checkpoint.native.heads[name]) };
}

export async function runRecovery(options: { directory: string; storageKey?: string; apply?: boolean }): Promise<{
  profileId: string; phase: string; pendingTxid?: string; pendingAction?: 'finalize-original'; adopted: string[]; missing: ResourceName[];
}> {
  const initial = loadCheckpointReadonly(options.directory, options.storageKey);
  const plan = recoveryPlan(initial);
  let context: RecoveryContext | undefined;
  let store: EngineStore | undefined;
  try {
    assertRecoverableCheckpoint(initial);
    context = await createContext(initial);
    await validateSavedPrefix(initial, context);
    const pending = initial.native.live!.pendingBootstrap;
    let pendingAction: 'finalize-original' | undefined;
    if (pending) {
      const accepted = await isAccepted(pending.step.slice('fund:'.length) as ResourceName, pending.request, pending.txid, initial, context);
      if (accepted) {
        await validateAcceptedResource({ name: pending.step.slice('fund:'.length) as ResourceName, txid: pending.txid,
          request: pending.request, response: pending.response!, native: initial.native, info: context.info,
          serverKey: context.serverKey, programScript: context.closure.pkScript, indexer: context.indexer,
          walletScripts: context.walletScripts, identity: context.walletIdentity, finalizeIfNeeded: false });
      } else {
        if (!pending.recoveryOwned || pending.finalizedCheckpointTxs || !pending.response) {
          throw new Error('Pending funding outcome is ambiguous; recovery will not retry Submit or Finalize.');
        }
        await validateFundingCandidate({ name: pending.step.slice('fund:'.length) as ResourceName, request: pending.request,
          native: initial.native, serverKey: context.serverKey, programScript: context.closure.pkScript,
          indexer: context.indexer, walletScripts: context.walletScripts, walletIdentity: context.walletIdentity,
          limit: effectiveLimit(context.info), acceptedResponse: { txid: pending.txid, response: pending.response } });
        pendingAction = 'finalize-original';
      }
    }
    if (options.apply) {
      store = EngineStore.open(options.directory, options.storageKey);
      const latest = store.load<StoredEngine>();
      if (!latest) throw new Error('Encrypted checkpoint disappeared after the read-only preflight.');
      if (recoveryHash(latest) !== recoveryHash(initial)) throw new Error('Encrypted checkpoint changed after the read-only preflight.');
      await recoverWithContext(latest, context, store);
      return { profileId: latest.profileId, phase: latest.native.live!.phase, adopted: [...RESOURCE_NAMES], missing: [] };
    }
    return { ...plan, pendingAction };
  } finally { await context?.wallet.dispose(); store?.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let apply = false;
  let dataDirectory: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--data-dir' && !dataDirectory && args[index + 1] && !args[index + 1]!.startsWith('--')) dataDirectory = args[++index]!;
    else throw new Error('Usage: node --import tsx tools/compact-bootstrap-recovery.ts [--data-dir DIR] [--apply]');
  }
  const directory = resolve(dataDirectory ?? process.env.SHIELDED_DATA_DIR ?? './data');
  const plan = await runRecovery({ directory, storageKey: process.env.SHIELDED_STORAGE_KEY, apply });
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...plan })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
