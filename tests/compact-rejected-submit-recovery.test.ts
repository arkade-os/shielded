import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { ConditionWitness, SingleKey, Transaction, setArkPsbtField } from '@arkade-os/sdk';
import { base64 } from '@scure/base';
import { createDemoEngine, promoteAcceptedCheckpoint, type DemoEngine } from '../src/engine.ts';
import { createCompactClosure } from '../src/compact/adapter.ts';
import { verifyCompactResponse } from '../src/compact/signer.ts';
import { serializeCompactSidecar } from '../src/compact/verifier.ts';
import { offlineNativeFixture } from '../src/sdk/adapter.ts';
import { EngineStore } from '../src/storage.ts';
import { loadCheckpointReadonly } from '../tools/compact-bootstrap-recovery.ts';
import { assertFailedRequestConditionWitnessAbsent, prepareRejectedSubmissionArchive } from '../tools/compact-rejected-submit-recovery.ts';
import type { NativeVmResult } from '../src/sdk/runtime.ts';

const server = SingleKey.fromHex('31'.repeat(32));
const emulator = SingleKey.fromHex('32'.repeat(32));
const FIXED_TXID = '557fcf2a0a2b50abbd2081c30862e3d9a4ae6300abd1bd83de6e834ce3f59756';
const FIXED_KEY = 'compact-mutinynet-v1-btc-shield';
const FIXED_ERROR = 'failed to finalize ark tx: failed to read condition witness: EOF';
const STORAGE_KEY = '36'.repeat(32);

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});

type Leaf = NonNullable<ReturnType<Transaction['getInput']>['tapLeafScript']>[number];
function request(compactLeaf: Leaf | undefined, checkpointCompactLeaf?: Leaf, csvLeaf?: Leaf) {
  const make = (tapLeafScript?: Leaf) => {
    const tx = new Transaction();
    tx.addInput({ txid: '11'.repeat(32), index: 0, ...(tapLeafScript ? { tapLeafScript: [tapLeafScript] } : {}) });
    tx.addOutput({ script: Uint8Array.of(0x51), amount: 1_000n });
    return tx;
  };
  const compact = make(compactLeaf);
  const checkpoint = make(checkpointCompactLeaf);
  const csv = make(csvLeaf);
  const other = make();
  return { arkTx: base64.encode(compact.toPSBT()), checkpoints: [
    base64.encode(checkpoint.toPSBT()), base64.encode(csv.toPSBT()), base64.encode(other.toPSBT()),
  ] };
}

test('legacy rejected request requires absent condition metadata only on its registered compact leaf', async () => {
  const profileId = new Uint8Array(32).fill(7);
  const closure = createCompactClosure(profileId, await server.xOnlyPublicKey(), await emulator.xOnlyPublicKey(),
    { type: 'seconds', value: 2048n });
  const raw = request(closure.tapLeafScript, closure.tapLeafScript);
  assert.doesNotThrow(() => assertFailedRequestConditionWitnessAbsent(raw, closure.script));

  const tx = Transaction.fromPSBT(base64.decode(raw.checkpoints[0]!));
  setArkPsbtField(tx, 0, ConditionWitness, []);
  const withRepairedField = { ...raw, checkpoints: [base64.encode(tx.toPSBT()), ...raw.checkpoints.slice(1)] };
  assert.throws(() => assertFailedRequestConditionWitnessAbsent(withRepairedField, closure.script), /unexpectedly contains condition witness metadata/);
});

test('ordinary CSV inputs without the compact closure do not require a condition witness field', async () => {
  const closure = createCompactClosure(new Uint8Array(32).fill(8), await server.xOnlyPublicKey(), await emulator.xOnlyPublicKey(),
    { type: 'seconds', value: 2048n });
  const raw = request(closure.tapLeafScript, closure.exitLeafScript);
  assert.doesNotThrow(() => assertFailedRequestConditionWitnessAbsent(raw, closure.script));
  const decoded = Transaction.fromPSBT(base64.decode(raw.checkpoints[1]!));
  assert.equal(decoded.getInput(0).unknown?.some(([key]) => key.type === 222 && Buffer.from(key.key).equals(Buffer.from('condition'))) ?? false, false);
});

test('failed request must include at least one input for the profile-registered compact leaf', async () => {
  const closure = createCompactClosure(new Uint8Array(32).fill(9), await server.xOnlyPublicKey(), await emulator.xOnlyPublicKey(),
    { type: 'seconds', value: 2048n });
  const raw = request(undefined, undefined);
  assert.throws(() => assertFailedRequestConditionWitnessAbsent(raw, closure.script), /no input for the registered compact condition leaf/);
});

async function capturedFixture() {
  const serverKey = hexKey(await server.xOnlyPublicKey());
  const emulatorPub = await emulator.xOnlyPublicKey();
  const emulatorKey = hexKey(emulatorPub);
  const closure = createCompactClosure(new Uint8Array(32).fill(12), await server.xOnlyPublicKey(), emulatorPub,
    { type: 'seconds', value: 2048n });
  const genesis = offlineNativeFixture([
    { script: closure.pkScript, amount: 200_000n }, { script: closure.pkScript, amount: 1_000n },
    { script: closure.pkScript, amount: 101_000n }, { script: closure.pkScript, amount: 1_000n },
  ]);
  const names = ['gate', 'lane', 'btcVault', 'tokenVault'] as const;
  const heads = Object.fromEntries(names.map((name, vout) => [name, {
    txid: genesis.id, vout, value: Number(genesis.getOutput(vout).amount), sourceTx: Buffer.from(genesis.toBytes()).toString('hex'),
  }]));
  const checkpoints: Transaction[] = [];
  for (const vout of [0, 1, 2]) {
    const checkpoint = new Transaction();
    checkpoint.addInput({ txid: genesis.id, index: vout, witnessUtxo: { amount: genesis.getOutput(vout).amount!, script: closure.pkScript },
      tapLeafScript: [closure.tapLeafScript] });
    checkpoint.addOutput({ script: closure.pkScript, amount: genesis.getOutput(vout).amount! });
    checkpoints.push(await emulator.sign(checkpoint));
  }
  const ark = new Transaction();
  checkpoints.forEach((checkpoint) => ark.addInput({ txid: checkpoint.id, index: 0,
    witnessUtxo: { amount: checkpoint.getOutput(0).amount!, script: closure.pkScript }, tapLeafScript: [closure.tapLeafScript] }));
  ark.addOutput({ script: closure.pkScript, amount: 0n });
  const unsignedRequest = { arkTx: base64.encode(ark.toPSBT()), checkpoints: checkpoints.map((tx) => base64.encode(tx.toPSBT())) };
  const signedArk = await emulator.sign(Transaction.fromPSBT(ark.toPSBT()));
  const signedCheckpoints = await Promise.all(checkpoints.map((tx) => emulator.sign(Transaction.fromPSBT(tx.toPSBT()))));
  const signedRequest = { arkTx: base64.encode(signedArk.toPSBT()), checkpoints: signedCheckpoints.map((tx) => base64.encode(tx.toPSBT())) };
  const txid = ark.id.toLowerCase();
  const body = { from: 'alice', asset: 'BTC', amount: 100_000 };
  const bodyHash = createHash('sha256').update(JSON.stringify({ action: 'shield', body })).digest('hex');
  const proof = { pi_a: ['0', '0', '1'], pi_b: [['0', '0'], ['0', '0'], ['1', '0']], pi_c: ['0', '0', '1'], protocol: 'groth16', curve: 'bn128' };
  const oldState = { noteRoot: '1', spentRoot: '1', historyRoot: '1', noteCount: 0, historyCount: 0, revision: 0, reserves: { BTC: 0, DEMO: 0 } };
  const prepared = {
    id: 'proof-sidecar-fixture', operation: 'shield' as const, intentProof: proof, transitionProof: proof,
    intentSignals: ['1'], transitionSignals: ['1'], oldState, newState: { ...oldState, noteRoot: '2', revision: 1 },
    ciphertextRecords: [], boundary: { deposit: { BTC: 100_000, DEMO: 0 }, withdrawal: { BTC: 0, DEMO: 0 }, destination: 'fixture' },
  };
  const sidecar = { operation: prepared.operation, intentProof: prepared.intentProof, transitionProof: prepared.transitionProof,
    intentSignals: prepared.intentSignals, transitionSignals: prepared.transitionSignals, oldState: prepared.oldState,
    newState: prepared.newState, ciphertextRecords: prepared.ciphertextRecords, boundary: prepared.boundary } as const;
  const checkpoint: any = {
    version: 2, proofTransport: 'compact', profileId: 'profile-fixture', protocol: { encryptedLog: [], receipts: [], nullifiers: [] },
    native: {
      network: 'mutinynet', emulatorKey, identities: { lane: 'asset-lane', btcVault: 'asset-btc', tokenVault: 'asset-token-vault', token: 'asset-token' },
      state: { noteCount: 0, historyCount: 0, reserves: { BTC: 0, DEMO: 0 } }, heads,
      receipts: [], compactEmulatorSecret: '32'.repeat(32), funding: { BTC: '200000', DEMO: '10000000' },
      compact: { version: 1, profileId: 'profile-fixture', sidecars: {} },
      live: {
        phase: 'ready', issued: { lane: 'asset-lane', btcVault: 'asset-btc', tokenVault: 'asset-token-vault', token: 'asset-token' },
        issuanceTransactions: { lane: 'tx-lane', btcVault: 'tx-btc', tokenVault: 'tx-token-vault', token: 'tx-token' },
        readySettlement: { stage: 'submit-attempted', txid, request: unsignedRequest, networkRequest: signedRequest },
      },
    },
    activities: [], publicBalances: {}, requests: { [FIXED_KEY]: { bodyHash, status: 'pending' } },
    pendingCompletion: { phase: 'submitted', completed: false, requestId: FIXED_KEY,
      submission: { txid, request: unsignedRequest, compactSidecar: sidecar }, prepared },
  };
  const evidence = { version: 1, httpStatus: 422, error: FIXED_ERROR, txid, idempotencyKey: FIXED_KEY, action: 'shield',
    body: { from: 'alice' as const, asset: 'BTC' as const, amount: 100_000 as const },
    stage: 'submit-attempted', resultPresent: false, pendingPhase: 'submitted' } as const;
  return { checkpoint, evidence, txid, bodyHash, serverKey };
}

function hexKey(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex'); }

async function signedTransportFixture() {
  const serverX = await server.xOnlyPublicKey(), emulatorX = await emulator.xOnlyPublicKey();
  const serverKey = hexKey(serverX), emulatorKey = hexKey(emulatorX);
  const closure = createCompactClosure(new Uint8Array(32).fill(19), serverX, emulatorX, { type: 'seconds', value: 2048n });
  const checkpointTransactions: Transaction[] = [];
  for (let index = 0; index < 3; index++) {
    const checkpoint = new Transaction();
    checkpoint.addInput({ txid: `${(40 + index).toString(16).padStart(2, '0')}`.repeat(32), index: 0,
      witnessUtxo: { amount: 1_000n, script: closure.pkScript }, tapLeafScript: [closure.tapLeafScript] });
    checkpoint.addOutput({ script: closure.pkScript, amount: 1_000n });
    checkpointTransactions.push(checkpoint);
  }
  const localCheckpoints = await Promise.all(checkpointTransactions.map((tx) => emulator.sign(tx)));
  const ark = new Transaction();
  localCheckpoints.forEach((checkpoint) => ark.addInput({ txid: checkpoint.id, index: 0,
    witnessUtxo: { amount: 1_000n, script: closure.pkScript }, tapLeafScript: [closure.tapLeafScript] }));
  ark.addOutput({ script: closure.pkScript, amount: 3_000n });
  const localArk = await emulator.sign(ark);
  const signedArk = await server.sign(Transaction.fromPSBT(localArk.toPSBT()));
  const signedCheckpoints = await Promise.all(localCheckpoints.map((tx) => server.sign(Transaction.fromPSBT(tx.toPSBT()))));
  const request = { arkTx: base64.encode(localArk.toPSBT()), checkpoints: localCheckpoints.map((tx) => base64.encode(tx.toPSBT())) };
  const result = { ok: true, arkTx: base64.encode(signedArk.toPSBT()), checkpoints: signedCheckpoints.map((tx) => base64.encode(tx.toPSBT())),
    txid: signedArk.id, durationMs: 0, backend: 'signed-test-fixture' } satisfies NativeVmResult;
  verifyCompactResponse(request, result, serverKey, emulatorKey);
  return { request, result, serverKey, emulatorKey };
}

test('engine promotes only a final exact-receipt checkpoint before persisting protocol completion', async () => {
  const transport = await signedTransportFixture();
  const receipt = { id: 'prepared-id', operation: 'shield', txid: transport.result.txid, network: 'mutinynet',
    finality: 'operator-preconfirmed', signedArkTx: transport.result.arkTx, signedCheckpoints: transport.result.checkpoints };
  const prepared = { id: receipt.id, operation: 'shield', newState: { noteRoot: 'new-state' } };
  const submission = { txid: receipt.txid, request: transport.request };
  const pending: any = { phase: 'submitted', prepared: { id: receipt.id, operation: 'shield' },
    submission };
  pending.prepared = prepared;
  const finalCheckpoint: any = { network: 'mutinynet', compact: { profileId: 'registered-profile' }, receipts: [receipt],
    state: structuredClone(prepared.newState), live: {} };
  assert.equal(promoteAcceptedCheckpoint(finalCheckpoint, pending, 'registered-profile'), true);
  assert.equal(pending.phase, 'accepted');
  assert.deepEqual(pending.receipt, receipt);

  const mismatches: Array<[any, any]> = [
    [{ ...finalCheckpoint, receipts: [] }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, receipts: [{ ...receipt, txid: 'cd'.repeat(32) }] }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, receipts: [{ ...receipt, id: 'other-prepared-id' }] }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, receipts: [{ ...receipt, operation: 'transfer' }] }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, state: { noteRoot: 'stale-state' } }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, live: { readySettlement: { txid: receipt.txid } } }, { ...pending, phase: 'submitted', receipt: undefined }],
    [{ ...finalCheckpoint, compact: { profileId: 'different-profile' } }, { ...pending, phase: 'submitted', receipt: undefined }],
  ];
  for (const [checkpoint, incomplete] of mismatches) {
    if (checkpoint.live?.readySettlement || checkpoint.state?.noteRoot === 'stale-state') {
      assert.throws(() => promoteAcceptedCheckpoint(checkpoint, incomplete, 'registered-profile'));
    }
    else assert.equal(promoteAcceptedCheckpoint(checkpoint, incomplete, 'registered-profile'), false);
    assert.equal(incomplete.phase, 'submitted', 'incomplete or unrelated checkpoint cannot commit the private state');
  }
});

test('durable callbacks keep submitted phase until the exact advanced final checkpoint', { timeout: 30_000 }, async () => {
  const transport = await signedTransportFixture();
  const receipt = { id: 'powercut-prepared-id', operation: 'shield', txid: transport.result.txid, network: 'mutinynet',
    finality: 'operator-preconfirmed', signedArkTx: transport.result.arkTx, signedCheckpoints: transport.result.checkpoints };
  const prepared = { id: receipt.id, operation: 'shield', newState: { noteRoot: 'advanced-state' } };
  const pending: any = { phase: 'submitted', prepared, submission: { txid: receipt.txid, request: transport.request } };
  const oldNative: any = { network: 'mutinynet', state: { noteRoot: 'old-state' }, profileId: 'registered-profile',
    compact: { profileId: 'registered-profile', pendingAcceptance: { txid: receipt.txid, result: transport.result }, sidecars: {} },
    receipts: [], live: {} };
  const envelope: any = { version: 2, proofTransport: 'compact', profileId: 'registered-profile', native: oldNative,
    protocol: { noteRoot: 'old-state' }, activities: [], publicBalances: {}, pendingCompletion: structuredClone(pending), requests: {} };
  const directory = mkdtempSync(join(tmpdir(), 'shielded-accepted-powercut-'));
  const store = EngineStore.open(directory, STORAGE_KEY);
  try {
    assert.equal(promoteAcceptedCheckpoint(oldNative, envelope.pendingCompletion, 'registered-profile'), false,
      'the core pre-acceptance callback carries only old state plus pending acceptance, not a completed receipt');
    store.save(envelope);

    const advancedNative = { ...structuredClone(oldNative), state: structuredClone(prepared.newState),
      compact: { version: 1, profileId: 'registered-profile', sidecars: {} }, receipts: [receipt], live: {} };
    assert.equal(promoteAcceptedCheckpoint(advancedNative, envelope.pendingCompletion, 'registered-profile'), true,
      'only the final advanced checkpoint may atomically promote the engine journal');
    envelope.native = advancedNative;
    assert.throws(() => { store.save(envelope); throw new Error('simulated power loss after atomic checkpoint write'); },
      /simulated power loss after atomic checkpoint write/);
    store.close();

    const reopened = loadCheckpointReadonly(directory, STORAGE_KEY) as any;
    assert.equal(reopened.pendingCompletion.phase, 'accepted');
    assert.deepEqual(reopened.pendingCompletion.receipt, receipt);
    assert.deepEqual(reopened.native.state, prepared.newState);
    assert.deepEqual(reopened.native.receipts, [receipt]);
  } finally {
    try { store.close(); } catch { /* closed after the simulated durable boundary */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejected submit archive is an exact state delta and survives encrypted checkpoint reopen', async () => {
  const fixture = await capturedFixture();
  const before = structuredClone(fixture.checkpoint);
  const archived = prepareRejectedSubmissionArchive(fixture.checkpoint, fixture.evidence, fixture.txid, FIXED_KEY);
  assert.deepEqual(fixture.checkpoint, before, 'planning is side-effect free');
  assert.equal(archived.pendingCompletion, undefined);
  assert.equal((archived.native.live as any).readySettlement, undefined);
  assert.deepEqual(archived.requests[FIXED_KEY], { bodyHash: fixture.bodyHash, status: 'rejected', error: FIXED_ERROR });
  const saved = (archived.native.live as any).rejectedSubmissions[fixture.txid];
  assert.equal(saved.pendingCompletion.phase, 'submitted');
  assert.equal(saved.readySettlement.stage, 'submit-attempted');
  assert.ok(saved.compactSidecar);
  assert.equal(saved.compactSidecar, base64.encode(serializeCompactSidecar(fixture.checkpoint.pendingCompletion.submission.compactSidecar)));
  const directory = mkdtempSync(join(tmpdir(), 'shielded-rejected-submit-'));
  const store = EngineStore.open(directory, STORAGE_KEY);
  try {
    store.save(archived);
    store.close();
    assert.deepEqual(loadCheckpointReadonly(directory, STORAGE_KEY), JSON.parse(JSON.stringify(archived)));
    assert.throws(() => loadCheckpointReadonly(directory, '37'.repeat(32)), /failed authentication/);
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mismatched, accepted, and non-empty cases fail before changing the source checkpoint', async () => {
  const variants = [
    (c: any, e: any) => { e.error = 'timeout after send'; },
    (c: any, e: any) => { e.stage = 'finalize-attempted'; },
    (c: any, e: any) => { c.native.live.readySettlement.stage = 'response-stored'; c.native.live.readySettlement.result = { ok: true }; },
    (c: any) => { c.activities.push({ type: 'activity' }); },
    (c: any) => { c.requests[FIXED_KEY].bodyHash = '00'.repeat(32); },
    (c: any) => { c.pendingCompletion.submission.txid = '01'.repeat(32); },
    (c: any) => { c.native.compact.sidecars[c.pendingCompletion.prepared.id] = base64.encode(serializeCompactSidecar(c.pendingCompletion.submission.compactSidecar)); },
  ];
  for (const mutate of variants) {
    const fixture = await capturedFixture();
    mutate(fixture.checkpoint, fixture.evidence);
    const before = structuredClone(fixture.checkpoint);
    assert.throws(() => prepareRejectedSubmissionArchive(fixture.checkpoint, fixture.evidence, fixture.txid, FIXED_KEY));
    assert.deepEqual(fixture.checkpoint, before);
  }
});

test('persisted rejected idempotency key returns the recorded failure without running an action', { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-rejected-key-'));
  let engine: DemoEngine | undefined;
  const key = 'rejected-fixture';
  const body = { from: 'alice', amount: 1200 };
  const bodyHash = createHash('sha256').update(JSON.stringify({ action: 'shield', body })).digest('hex');
  try {
    engine = await createDemoEngine({ dataDirectory: directory, storageKey: STORAGE_KEY, proofTransport: 'inline' });
    await engine.close(); engine = undefined;
    const store = EngineStore.open(directory, STORAGE_KEY);
    try {
      const checkpoint = store.load<any>();
      checkpoint.requests[key] = { bodyHash, status: 'rejected', error: FIXED_ERROR };
      store.save(checkpoint);
    } finally { store.close(); }
    engine = await createDemoEngine({ dataDirectory: directory, storageKey: STORAGE_KEY, proofTransport: 'inline' });
    const before = engine.snapshot();
    await assert.rejects(engine.action('shield', body, key), new RegExp(FIXED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await assert.rejects(engine.action('shield', { ...body, amount: 1201 }, key), /different action body/);
    assert.deepEqual(engine.snapshot(), before);
  } finally {
    await engine?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
