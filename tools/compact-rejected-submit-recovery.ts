import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { base64, hex } from '@scure/base';
import {
  RestArkProvider, RestIndexerProvider, SingleKey, Transaction, verifyTapscriptSignatures,
} from '@arkade-os/sdk';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { TaprootControlBlock } from '@scure/btc-signer/psbt.js';
import { createProtocol } from '../packages/protocol/src/index.ts';
import { createCompactDestination, createCompactProfile } from '../src/compact/runtime.ts';
import { verifyCompactUnsignedSubmission, serializeCompactSidecar, type CompactSidecar } from '../src/compact/verifier.ts';
import { EngineStore } from '../src/storage.ts';
import { loadCheckpointReadonly } from './compact-bootstrap-recovery.ts';
import type { NativeCheckpoint } from '../src/sdk/runtime.ts';
import type { VmBridgeRequest } from '../src/sdk/adapter.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_TXID = '557fcf2a0a2b50abbd2081c30862e3d9a4ae6300abd1bd83de6e834ce3f59756';
const EXPECTED_KEY = 'compact-mutinynet-v1-btc-shield';
const REJECTION = 'failed to finalize ark tx: failed to read condition witness: EOF';
const RESOURCES = ['gate', 'lane', 'btcVault', 'tokenVault'] as const;
const ISSUE_NAMES = ['lane', 'btcVault', 'tokenVault', 'token'] as const;

type AnyRecord = Record<string, any>;
type EngineCheckpoint = ReturnType<typeof loadCheckpointReadonly> & AnyRecord;
type RejectionEvidence = {
  version: 1; httpStatus: 422; error: string; txid: string; idempotencyKey: string;
  action: 'shield'; body: { from: 'alice'; asset: 'BTC'; amount: 100_000 };
  actionStartedAt?: string; errorObservedAt?: string; capturedAt?: string;
  stage: 'submit-attempted'; resultPresent: false; pendingPhase: 'submitted'; provenance?: AnyRecord;
};
type ReadonlyInspection = {
  network: string; signerPubkey: string; checkpointTapscript: string; unilateralExitDelay: bigint;
  indexedArk: string; sourceCoins: Array<{ txid: string; vout: number; value: number; script: string; isSpent: boolean; isSwept: boolean; isUnrolled: boolean; spentBy?: string; arkTxId?: string }>;
  positiveOutputs: Array<{ txid: string; vout: number }>;
};
type RejectedArchive = {
  version: 1; txid: string; idempotencyKey: string; bodyHash: string; error: string; archivedAt: string;
  evidence: RejectionEvidence; pendingCompletion: unknown; readySettlement: unknown; request: VmBridgeRequest; compactSidecar: string;
};

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, name: string): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} is malformed.`);
  return value as AnyRecord;
}
function txid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) fail('Transaction ID is malformed.');
  return value.toLowerCase();
}
function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && Buffer.from(left).equals(Buffer.from(right));
}
function parseRequest(request: VmBridgeRequest): { ark: Transaction; checkpoints: Transaction[] } {
  if (!request || typeof request.arkTx !== 'string' || !Array.isArray(request.checkpoints) || request.checkpoints.length !== 3) {
    fail('The saved failed submission is not the exact three-checkpoint request.');
  }
  try {
    return { ark: Transaction.fromPSBT(base64.decode(request.arkTx)),
      checkpoints: request.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt))) };
  } catch { return fail('The saved failed submission contains an invalid PSBT.'); }
}
function sameBody(actual: Transaction, expected: Transaction): void {
  if (actual.id.toLowerCase() !== expected.id.toLowerCase() || !sameBytes(actual.unsignedTx, expected.unsignedTx)) {
    fail('Saved submitted transaction body differs from the exact failed request.');
  }
}
function hashJson(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sourcePoint(tx: Transaction): string {
  const input = tx.getInput(0);
  if (!input.txid || input.index === undefined) fail('A saved checkpoint input lacks its exact source outpoint.');
  return `${hex.encode(input.txid).toLowerCase()}:${input.index}`;
}
function verifyEmulatorRequest(unsigned: VmBridgeRequest, submitted: VmBridgeRequest, emulatorKey: string): void {
  const expected = parseRequest(unsigned); const actual = parseRequest(submitted);
  sameBody(actual.ark, expected.ark);
  const pairs: Array<[Transaction, Transaction]> = [[actual.ark, expected.ark], ...actual.checkpoints.map((tx, i) => [tx, expected.checkpoints[i]!] as [Transaction, Transaction])];
  for (const [signed, before] of pairs) {
    sameBody(signed, before);
    for (let vin = 0; vin < signed.inputsLength; vin++) {
      const a = signed.getInput(vin); const b = before.getInput(vin);
      const leaf = b.tapLeafScript?.[0]; const actualLeaf = a.tapLeafScript?.[0];
      if (!leaf || !actualLeaf || a.sighashType !== b.sighashType || (a.sighashType !== undefined && a.sighashType !== 0) ||
          a.witnessUtxo?.amount !== b.witnessUtxo?.amount || !sameBytes(a.witnessUtxo?.script, b.witnessUtxo?.script) ||
          !sameBytes(leaf[1], actualLeaf[1]) || !sameBytes(TaprootControlBlock.encode(leaf[0]), TaprootControlBlock.encode(actualLeaf[0]))) {
        fail('The signed request changed a registered prevout or spend leaf.');
      }
      const script = leaf[1].subarray(0, -1); const leafHash = tapLeafHash(script, leaf[1].at(-1)!);
      const signatures = a.tapScriptSig ?? [];
      if (signatures.length !== 1 || hex.encode(signatures[0]![0].pubKey) !== emulatorKey ||
          !sameBytes(signatures[0]![0].leafHash, leafHash)) fail('The failed request is not signed only by the registered emulator.');
      try { verifyTapscriptSignatures(signed, vin, [emulatorKey], undefined, undefined, leafHash); }
      catch { fail('The saved emulator signature is invalid.'); }
    }
  }
}

/** The captured legacy failure omitted the field only on registered compact condition leaves.
 * Ordinary Ark CSV checkpoint leaves are not conditional and must not be rewritten. */
export function assertFailedRequestConditionWitnessAbsent(request: VmBridgeRequest, compactLeafScript: Uint8Array): void {
  const parsed = parseRequest(request);
  let matched = 0;
  for (const tx of [parsed.ark, ...parsed.checkpoints]) {
    for (let vin = 0; vin < tx.inputsLength; vin++) {
      const input = tx.getInput(vin);
      const compactLeaf = (input.tapLeafScript ?? []).some(([, script]) =>
        script.length > 1 && Buffer.from(script.subarray(0, -1)).equals(Buffer.from(compactLeafScript)));
      if (!compactLeaf) continue;
      matched++;
      const fields = (input.unknown ?? []).filter(([key]) =>
        key.type === 222 && Buffer.from(key.key).equals(Buffer.from('condition')));
      if (fields.length !== 0) fail('The captured legacy failed request unexpectedly contains condition witness metadata.');
    }
  }
  if (!matched) fail('The failed request contains no input for the registered compact condition leaf.');
}

function validateEvidence(checkpoint: EngineCheckpoint, evidence: RejectionEvidence, expectedTxid: string, idempotencyKey: string) {
  const native = record(checkpoint.native, 'Native checkpoint');
  const live = record(native.live, 'Live checkpoint');
  const pending = record(checkpoint.pendingCompletion, 'Pending completion');
  const ready = record(live.readySettlement, 'Ready settlement');
  const request = record(ready.networkRequest, 'Submitted network request') as VmBridgeRequest;
  const original = record(ready.request, 'Prepared SDK request') as VmBridgeRequest;
  const prepared = record(pending.prepared, 'Prepared operation');
  const expectedHash = hashJson({ action: 'shield', body: { from: 'alice', asset: 'BTC', amount: 100_000 } });
  const cached = record(checkpoint.requests?.[idempotencyKey], 'Idempotency record');
  const acceptedSidecars = record(native.compact?.sidecars, 'Compact sidecars');
  const submittedSidecar = pending.submission?.compactSidecar as CompactSidecar | undefined;
  const sidecarRaw = submittedSidecar ? base64.encode(serializeCompactSidecar(submittedSidecar)) : undefined;
  if (evidence.version !== 1 || evidence.httpStatus !== 422 || typeof evidence.error !== 'string' ||
      !evidence.error.toLowerCase().includes(REJECTION.toLowerCase()) || txid(evidence.txid) !== expectedTxid ||
      evidence.idempotencyKey !== idempotencyKey || evidence.action !== 'shield' ||
      evidence.body?.from !== 'alice' || evidence.body?.asset !== 'BTC' || evidence.body?.amount !== 100_000 ||
      evidence.stage !== 'submit-attempted' || evidence.resultPresent !== false || evidence.pendingPhase !== 'submitted') {
    fail('Evidence does not identify the exact returned Submit rejection.');
  }
  if (checkpoint.version !== 2 || checkpoint.proofTransport !== 'compact' || !checkpoint.profileId ||
      native.network !== 'mutinynet' || live.phase !== 'ready' || native.compact?.profileId !== checkpoint.profileId ||
      pending.phase !== 'submitted' || pending.completed !== false || pending.requestId !== idempotencyKey ||
      pending.receipt !== undefined || pending.submission?.txid?.toLowerCase() !== expectedTxid ||
      prepared.operation !== 'shield' || ready.stage !== 'submit-attempted' || ready.result !== undefined ||
      ready.txid?.toLowerCase() !== expectedTxid || !request || !original || !sidecarRaw ||
      acceptedSidecars[prepared.id] !== undefined ||
      checkpoint.activities.length !== 0 || (native.receipts ?? []).some((receipt: AnyRecord) => receipt?.txid?.toLowerCase() === expectedTxid) ||
      live.pendingBootstrap || live.pendingBoarding || (live.boardingReceipts?.length ?? 0) !== 0 ||
      native.pendingSettlement || native.compact?.pendingAcceptance ||
      Number(native.state?.noteCount) !== 0 || Number(native.state?.historyCount) !== 0 ||
      Number(native.state?.reserves?.BTC) !== 0 || Number(native.state?.reserves?.DEMO) !== 0 ||
      (checkpoint.protocol?.encryptedLog?.length ?? -1) !== 0 || (checkpoint.protocol?.receipts?.length ?? -1) !== 0 ||
      (checkpoint.protocol?.nullifiers?.length ?? -1) !== 0) {
    fail('Encrypted state is not the exact empty-protocol failed-shield checkpoint.');
  }
  const deposit = record(prepared.boundary?.deposit, 'Shield deposit');
  const withdrawal = record(prepared.boundary?.withdrawal, 'Shield withdrawal');
  if (deposit.BTC !== 100_000 || deposit.DEMO !== 0 || withdrawal.BTC !== 0 || withdrawal.DEMO !== 0) {
    fail('Prepared proof boundary is not the exact Alice BTC shield request.');
  }
  if (cached.bodyHash !== expectedHash || cached.status !== 'pending' || cached.result !== undefined || cached.error !== undefined) {
    fail('The saved idempotency record does not match the unresolved shield request.');
  }
  const heads = record(native.heads, 'Resource heads');
  if (Object.keys(heads).length !== RESOURCES.length || RESOURCES.some((name) => !heads[name])) fail('The four registered resource heads are incomplete.');
  const otherPending = Object.entries(checkpoint.requests).filter(([requestKey, value]) => requestKey !== idempotencyKey && (value as AnyRecord)?.status === 'pending');
  if (otherPending.length) fail('Another idempotent request is still pending.');
  if ((live.rejectedSubmissions?.[expectedTxid]) !== undefined) fail('This exact rejected transaction was already archived.');
  if (ISSUE_NAMES.some((name) => !live.issued?.[name] || native.identities?.[name] !== live.issued[name] || !live.issuanceTransactions?.[name])) {
    fail('The ready profile does not retain all four issued identity ancestries.');
  }
  const rawRequest = parseRequest(original); const signedRequest = parseRequest(request);
  if (rawRequest.ark.id.toLowerCase() !== expectedTxid || signedRequest.ark.id.toLowerCase() !== expectedTxid ||
      pending.submission?.txid?.toLowerCase() !== expectedTxid) fail('The saved prepared, submitted and pending transaction IDs differ.');
  const pendingRequest = record(pending.submission?.request, 'Engine submission request') as VmBridgeRequest;
  const pendingParsed = parseRequest(pendingRequest);
  sameBody(rawRequest.ark, pendingParsed.ark);
  if (pendingParsed.checkpoints.length !== rawRequest.checkpoints.length || pendingParsed.checkpoints.some((tx, i) => tx.id !== rawRequest.checkpoints[i]!.id)) {
    fail('Engine submission checkpoints differ from the ready journal.');
  }
  verifyEmulatorRequest(original, request, native.emulatorKey.toLowerCase());
  const points = rawRequest.checkpoints.map(sourcePoint);
  if (new Set(points).size !== 3 || points.some((point) => !RESOURCES.some((name) => {
    const head = native.heads[name]; return head && `${head.txid.toLowerCase()}:${head.vout}` === point;
  }))) fail('Failed request checkpoints do not spend three distinct current registered heads.');
  if (rawRequest.ark.inputsLength !== rawRequest.checkpoints.length || rawRequest.ark.inputsLength !== 3) {
    fail('The failed Ark body is not the captured three-input spend.');
  }
  for (let vin = 0; vin < rawRequest.checkpoints.length; vin++) {
    const input = rawRequest.ark.getInput(vin); const checkpointTx = rawRequest.checkpoints[vin]!;
    if (!input.txid || input.index !== 0 || hex.encode(input.txid).toLowerCase() !== checkpointTx.id.toLowerCase()) {
      fail('The failed Ark body does not spend the exact saved checkpoint outputs.');
    }
  }
  const compactSidecar: CompactSidecar = {
    operation: prepared.operation, intentProof: prepared.intentProof, transitionProof: prepared.transitionProof,
    intentSignals: prepared.intentSignals, transitionSignals: prepared.transitionSignals, oldState: prepared.oldState,
    newState: prepared.newState, ciphertextRecords: prepared.ciphertextRecords, boundary: prepared.boundary,
  };
  const decodedSidecar = Buffer.from(base64.decode(sidecarRaw));
  if (!decodedSidecar.equals(Buffer.from(serializeCompactSidecar(compactSidecar)))) fail('Archived Groth16 sidecar does not match the pending proof.');
  return { native, live, pending, ready, request, original, prepared, compactSidecar, bodyHash: expectedHash };
}

function evidencePath(path: string): string {
  const recoveryRoot = realpathSync(join(ROOT, '.recovery'));
  const candidate = resolve(path);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Rejection evidence must be a regular file under ignored .recovery/.');
  const resolved = realpathSync(candidate);
  const rel = relative(recoveryRoot, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(recoveryRoot, rel) !== resolved) {
    fail('Rejection evidence must be inside ignored .recovery/.');
  }
  return resolved;
}

async function inspectReadOnly(checkpoint: EngineCheckpoint, evidence: RejectionEvidence, expectedTxid: string, key: string): Promise<void> {
  const checked = validateEvidence(checkpoint, evidence, expectedTxid, key);
  const native = checked.native as NativeCheckpoint;
  const live = checked.live;
  const url = new URL(live.arkUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'mutinynet.arkade.sh' || url.username || url.password || url.port || url.pathname !== '/') {
    fail('Rejected-submit recovery only reads the pinned Mutinynet Ark endpoint.');
  }
  const provider = new RestArkProvider(url.origin);
  const indexer = new RestIndexerProvider(url.origin);
  const info = await provider.getInfo();
  const serverKey = info.signerPubkey.slice(-64).toLowerCase();
  const emulatorIdentity = SingleKey.fromHex(live.compactEmulatorSecret);
  const emulatorKey = hex.encode(await emulatorIdentity.xOnlyPublicKey());
  if (info.network !== 'mutinynet' || serverKey !== native.serverKey.toLowerCase() ||
      emulatorKey !== native.emulatorKey.toLowerCase() || info.checkpointTapscript !== native.checkpointScript ||
      BigInt(info.unilateralExitDelay) !== 2048n) fail('Current Ark signer or checkpoint policy differs from the registered profile.');
  const protocol = await createProtocol({ checkpoint: checkpoint.protocol, secureKeys: true });
  const snapshot = protocol.snapshot();
  if (snapshot.wallets.alice.notes.length || snapshot.wallets.bob.notes.length || snapshot.receipts.length ||
      snapshot.encryptedLog.length || snapshot.nullifiers.length || snapshot.state.noteCount !== 0 || snapshot.state.historyCount !== 0 ||
      snapshot.state.reserves.BTC !== 0 || snapshot.state.reserves.DEMO !== 0) fail('Protocol state is not empty.');
  const alice = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(native.aliceSecret).xOnlyPublicKey(), { type: 'seconds', value: 2048n });
  const bob = createCompactDestination(hex.decode(serverKey), await SingleKey.fromHex(native.bobSecret).xOnlyPublicKey(), { type: 'seconds', value: 2048n });
  const config = { relationVersion: 'ark-shield-poc-v1', domain: native.domain,
    verificationKeys: protocol.verificationKeys() as never, serverKey, emulatorKey,
    checkpointScript: info.checkpointTapscript, exitTimelock: { type: 'seconds' as const, value: '2048' },
    identities: live.issued, destinations: {
      alice: { scriptPubKey: hex.encode(alice.scriptPubKey), field: alice.field },
      bob: { scriptPubKey: hex.encode(bob.scriptPubKey), field: bob.field },
    } };
  const registered = await createCompactProfile(config);
  if (registered.profile.profileId !== checkpoint.profileId) fail('Recomputed verifier profile differs from encrypted checkpoint.');
  const closure = registered.closure;
  assertFailedRequestConditionWitnessAbsent(checked.request, closure.script);
  for (const name of RESOURCES) {
    const head = native.heads[name];
    const source = Transaction.fromRaw(hex.decode(head.sourceTx));
    const output = source.getOutput(head.vout);
    if (source.id.toLowerCase() !== head.txid.toLowerCase() || output.amount !== BigInt(head.value) ||
        !output.script || !Buffer.from(output.script).equals(Buffer.from(closure.pkScript))) fail(`Registered ${name} head ancestry changed.`);
  }
  const original = checked.original;
  const parsed = parseRequest(original);
  await verifyCompactUnsignedSubmission(checkpoint.profileId, checked.compactSidecar, parsed.ark, parsed.checkpoints, {
    profileId: checkpoint.profileId, protocol: structuredClone(snapshot.state),
    funding: { BTC: Number(native.funding.BTC), DEMO: Number(native.funding.DEMO) },
    heads: structuredClone(native.heads) as never,
  });
  const inputs = parsed.checkpoints.map(sourcePoint);
  const sourcePoints = RESOURCES.map((name) => ({ txid: native.heads[name].txid, vout: native.heads[name].vout }));
  const sourceResult = await indexer.getVtxos({ outpoints: sourcePoints });
  if (sourceResult.vtxos.length !== sourcePoints.length) fail('Indexer did not return every registered source head.');
  for (let index = 0; index < sourcePoints.length; index++) {
    const point = sourcePoints[index]!; const head = native.heads[RESOURCES[index]!]!;
    const found = sourceResult.vtxos.filter((coin) => coin.txid.toLowerCase() === point.txid.toLowerCase() && coin.vout === point.vout);
    const source = Transaction.fromRaw(hex.decode(head.sourceTx)); const output = source.getOutput(head.vout);
    if (found.length !== 1 || found[0]!.value !== head.value || found[0]!.script.toLowerCase() !== hex.encode(output.script!).toLowerCase() ||
        found[0]!.isSpent || found[0]!.isSwept || found[0]!.isUnrolled || found[0]!.spentBy || found[0]!.arkTxId) {
      fail('A registered resource head is missing, spent, swept or unrolled.');
    }
  }
  if (new Set(inputs).size !== 3 || inputs.some((point) => !sourcePoints.some((source) => `${source.txid.toLowerCase()}:${source.vout}` === point))) {
    fail('Captured transaction inputs differ from the registered resource heads.');
  }
  const archivedTxs = await indexer.getVirtualTxs([expectedTxid]);
  const matching = archivedTxs.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).filter((tx) => tx.id.toLowerCase() === expectedTxid);
  if (matching.length !== 1) fail('Indexer does not show the exact submitted body once.');
  sameBody(matching[0]!, parsed.ark);
  const positiveOutputs = Array.from({ length: parsed.ark.outputsLength }, (_, vout) => ({ txid: expectedTxid, vout }))
    .filter(({ vout }) => parsed.ark.getOutput(vout).amount! > 0n);
  const outputs = await indexer.getVtxos({ outpoints: positiveOutputs });
  if (outputs.vtxos.length !== 0) fail('Indexer shows an output from the rejected transaction; acceptance is not ruled out.');
}

function archiveRejected(checkpoint: EngineCheckpoint, evidence: RejectionEvidence, expectedTxid: string, key: string): EngineCheckpoint {
  const checked = validateEvidence(checkpoint, evidence, expectedTxid, key);
  const archived = structuredClone(checkpoint) as EngineCheckpoint;
  const archivedLive = archived.native.live as AnyRecord;
  const archive: RejectedArchive = {
    version: 1, txid: expectedTxid, idempotencyKey: key, bodyHash: checked.bodyHash,
    error: evidence.error, archivedAt: new Date().toISOString(), evidence: structuredClone(evidence),
    pendingCompletion: structuredClone(checkpoint.pendingCompletion),
    readySettlement: structuredClone(checked.live.readySettlement),
    request: structuredClone(checked.request),
    compactSidecar: base64.encode(serializeCompactSidecar(checked.compactSidecar)),
  };
  archivedLive.rejectedSubmissions ??= {};
  if (archivedLive.rejectedSubmissions[expectedTxid]) fail('This exact rejection is already archived.');
  archivedLive.rejectedSubmissions[expectedTxid] = archive;
  archived.pendingCompletion = undefined;
  archivedLive.readySettlement = undefined;
  archived.requests[key] = { bodyHash: checked.bodyHash, status: 'rejected', error: evidence.error };
  assertOnlyAllowedDelta(checkpoint, archived, expectedTxid, key, checked.bodyHash, evidence.error);
  return archived;
}

export function prepareRejectedSubmissionArchive(checkpoint: EngineCheckpoint, evidence: RejectionEvidence,
  expectedTxid: string, key: string): EngineCheckpoint {
  return archiveRejected(checkpoint, evidence, txid(expectedTxid), key);
}

function assertOnlyAllowedDelta(before: EngineCheckpoint, after: EngineCheckpoint, txidValue: string, key: string,
  bodyHash: string, error: string): void {
  const expected = structuredClone(before) as EngineCheckpoint;
  const live = expected.native.live as AnyRecord;
  const currentEvidence = (live.rejectedSubmissions ?? {}) as AnyRecord;
  const archive = ((after.native.live as AnyRecord).rejectedSubmissions as AnyRecord)[txidValue];
  live.rejectedSubmissions = { ...currentEvidence, [txidValue]: archive };
  expected.pendingCompletion = undefined;
  live.readySettlement = undefined;
  expected.requests[key] = { bodyHash, status: 'rejected', error };
  if (!isDeepStrictEqual(expected, after)) fail('Recovery attempted to modify state outside the rejection archive/cache/cleared pending fields.');
}

export async function runRejectedSubmitRecovery(options: {
  directory: string; evidenceFile: string; expectedTxid: string; idempotencyKey: string;
  storageKey?: string; apply?: boolean;
}): Promise<{ mode: 'dry-run' | 'apply'; txid: string; idempotencyKey: string; archived: boolean; networkWrites: 0 }> {
  const file = evidencePath(options.evidenceFile);
  let evidence: RejectionEvidence;
  try { evidence = JSON.parse(readFileSync(file, 'utf8')) as RejectionEvidence; }
  catch { fail('Rejection evidence is missing or invalid JSON.'); }
  const txidValue = txid(options.expectedTxid);
  const key = options.idempotencyKey;
  const initial = loadCheckpointReadonly(options.directory, options.storageKey) as EngineCheckpoint;
  if (txidValue !== EXPECTED_TXID || key !== EXPECTED_KEY) fail('Recovery is pinned to the captured failed shield only.');
  validateEvidence(initial, evidence!, txidValue, key);
  await inspectReadOnly(initial, evidence!, txidValue, key);
  if (!options.apply) return { mode: 'dry-run', txid: txidValue, idempotencyKey: key, archived: false, networkWrites: 0 };

  const store = EngineStore.open(options.directory, options.storageKey);
  try {
    const latest = store.load<EngineCheckpoint>();
    if (!latest || hashJson(latest) !== hashJson(initial)) fail('Encrypted checkpoint changed after read-only preflight.');
    validateEvidence(latest, evidence!, txidValue, key);
    await inspectReadOnly(latest, evidence!, txidValue, key);
    store.save(archiveRejected(latest, evidence!, txidValue, key));
  } finally { store.close(); }
  return { mode: 'apply', txid: txidValue, idempotencyKey: key, archived: true, networkWrites: 0 };
}

async function main(): Promise<void> {
  let apply = false; let directory: string | undefined; let evidenceFile: string | undefined;
  let expectedTxid: string | undefined; let idempotencyKey: string | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!; const next = args[index + 1];
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--data-dir' && !directory && next && !next.startsWith('--')) directory = args[++index]!;
    else if (arg === '--evidence' && !evidenceFile && next && !next.startsWith('--')) evidenceFile = args[++index]!;
    else if (arg === '--expected-txid' && !expectedTxid && next && !next.startsWith('--')) expectedTxid = args[++index]!;
    else if (arg === '--idempotency-key' && !idempotencyKey && next && !next.startsWith('--')) idempotencyKey = args[++index]!;
    else fail('Usage: node --import tsx tools/compact-rejected-submit-recovery.ts --data-dir DIR --evidence .recovery/FILE --expected-txid TXID --idempotency-key KEY [--apply]');
  }
  if (!evidenceFile || !expectedTxid || !idempotencyKey) fail('Evidence, expected transaction ID and idempotency key are required.');
  if (txid(expectedTxid) !== EXPECTED_TXID || idempotencyKey !== EXPECTED_KEY) fail('Recovery is pinned to the captured failed shield only.');
  const result = await runRejectedSubmitRecovery({ directory: resolve(directory ?? process.env.SHIELDED_DATA_DIR ?? './data'),
    evidenceFile: resolve(evidenceFile), expectedTxid, idempotencyKey, storageKey: process.env.SHIELDED_STORAGE_KEY, apply });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
