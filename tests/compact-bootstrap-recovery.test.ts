import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { asset, CSVMultisigTapscript, Extension, P2A, RestArkProvider, RestIndexerProvider, SingleKey, Transaction, Wallet } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import {
  assertRecoverableCheckpoint, journalBeforeNetwork, loadCheckpointReadonly, recoveryPlan, runRecovery,
  assertFundingSourceState, validateFundingAllocation, verifyBootstrapResponse,
} from '../tools/compact-bootstrap-recovery.ts';
import { buildCompactSpend, createCompactClosure } from '../src/compact/adapter.ts';
import { EngineStore } from '../src/storage.ts';
import { offlineNativeFixture, transferAssetPacket } from '../src/sdk/adapter.ts';

const operator = SingleKey.fromHex('08'.repeat(32));
const wallet = SingleKey.fromHex('09'.repeat(32));
const exitTimelock = { type: 'seconds' as const, value: 2048n };

test('funding proof accepts registered gate assets plus wallet change and empty BTC-only inputs', () => {
  const ids = Array.from({ length: 4 }, (_, i) => makeAssetId(i + 1));
  const fixture = fundingFixture(ids, p2tr(20));
  const evidence = validate(fixture, new Set(ids), ids[3]!);
  assert.equal(evidence.outputs.get(0)?.get(ids[3]!), 10_000_000n);
  assert.equal(evidence.outputs.get(1)?.get(ids[0]!), 1n);
  assert.equal(evidence.outputs.get(1)?.get(ids[1]!), 1n);
  assert.equal(fixture.sourceAssets.get(2)?.size, 0);
  assert.equal(fixture.sourceAssets.get(4)?.size, 0);
});

test('funding proof rejects unknown assets, misplaced gate marker, stolen change and imbalance', () => {
  const ids = Array.from({ length: 5 }, (_, i) => makeAssetId(i + 11));
  const registered = new Set(ids.slice(0, 4));
  assert.throws(() => validate(fundingFixture(ids, p2tr(30)), registered, ids[4]!), /unregistered asset identity/);
  assert.throws(() => validate(fundingFixture(ids.slice(0, 4), p2tr(30), { markerVout: 1 }),
    new Set(ids.slice(0, 4)), ids[3]!), /allocation or conservation/);
  assert.throws(() => validate(fundingFixture(ids.slice(0, 4), p2tr(30), { changeVout: 2 }),
    new Set(ids.slice(0, 4)), ids[3]!), /outside the wallet/);
  assert.throws(() => validate(fundingFixture(ids.slice(0, 4), p2tr(30), { markerAmount: 10_000_001n }),
    new Set(ids.slice(0, 4)), ids[3]!), /allocation or conservation/);
});

test('funding proof rejects indexed source mismatches and duplicate groups', () => {
  const ids = Array.from({ length: 4 }, (_, i) => makeAssetId(i + 21));
  const changed = fundingFixture(ids, p2tr(40));
  changed.sourceAssets.set(0, new Map([[ids[3]!, 9_999_999n]]));
  assert.throws(() => validate(changed, new Set(ids), ids[3]!), /input provenance or conservation/);
  assert.throws(() => validate(fundingFixture(ids, p2tr(40), { duplicateTokenGroup: true }),
    new Set(ids), ids[3]!), /duplicate asset group/);
});

test('response verifier combines the wallet request signature with a signed operator response', { timeout: 60_000 }, async () => {
  const f = await bootstrapFixture();
  const verified = verifyBootstrapResponse(f.request, f.response, f.serverKey);
  const signers = verified.ark.getInput(0).tapScriptSig!.map(([key]) => hex.encode(key.pubKey));
  assert.ok(signers.includes(f.serverKey));
  assert.ok(signers.includes(f.walletKey));
  assert.equal(verified.checkpoints.length, f.request.checkpoints.length);
});

test('response verifier rejects altered body, prevout, leaf metadata, missing operator signatures and bad wallet signature', { timeout: 60_000 }, async () => {
  const f = await bootstrapFixture();

  const body = clone(f.response);
  const bodyTx = Transaction.fromPSBT(f.baseArk.toPSBT());
  bodyTx.updateOutput(0, { amount: bodyTx.getOutput(0).amount! + 1n });
  const signedBody = await operator.sign(bodyTx);
  body.finalArkTx = base64.encode(signedBody.toPSBT());
  assert.throws(() => verifyBootstrapResponse(f.request, body, f.serverKey), /changed the submitted bootstrap transaction body/);

  const prevout = clone(f.response);
  const prevoutTx = Transaction.fromPSBT(f.baseArk.toPSBT());
  const witness = prevoutTx.getInput(0).witnessUtxo!;
  prevoutTx.updateInput(0, { witnessUtxo: { ...witness, amount: witness.amount + 1n } });
  prevout.finalArkTx = base64.encode((await operator.sign(prevoutTx)).toPSBT());
  assert.throws(() => verifyBootstrapResponse(f.request, prevout, f.serverKey), /previous-output or spend-leaf metadata/);

  const leaf = clone(f.response);
  const leafTx = Transaction.fromPSBT(f.baseArk.toPSBT());
  const input = leafTx.getInput(0);
  const scriptLeaf = input.tapLeafScript![0]!;
  const control = structuredClone(scriptLeaf[0]);
  control.version ^= 1;
  leafTx.updateInput(0, { tapLeafScript: [[control, scriptLeaf[1]]] });
  leaf.finalArkTx = base64.encode((await operator.sign(leafTx)).toPSBT());
  assert.throws(() => verifyBootstrapResponse(f.request, leaf, f.serverKey), /spend-leaf metadata changed/);

  const noArkSignature = clone(f.response);
  noArkSignature.finalArkTx = f.request.arkTx;
  assert.throws(() => verifyBootstrapResponse(f.request, noArkSignature, f.serverKey), /pinned operator signature/);

  const noCheckpointSignature = clone(f.response);
  noCheckpointSignature.signedCheckpointTxs = f.request.checkpoints;
  assert.throws(() => verifyBootstrapResponse(f.request, noCheckpointSignature, f.serverKey), /signature|checkpoint/i);

  const localTx = Transaction.fromPSBT(f.baseArk.toPSBT());
  const signatures = Transaction.fromPSBT(base64.decode(f.request.arkTx)).getInput(0).tapScriptSig!;
  const broken = Uint8Array.from(signatures[0]![1]);
  broken[0] ^= 1;
  localTx.updateInput(0, { tapScriptSig: [[signatures[0]![0], broken]] });
  assert.throws(() => verifyBootstrapResponse({ ...f.request, arkTx: base64.encode(localTx.toPSBT()) },
    f.response, f.serverKey), /Invalid signature/);
});

test('funding source state permits only the exact post-Submit checkpoint and Ark spend', { timeout: 60_000 }, async () => {
  const f = await bootstrapFixture();
  const checkpoint = Transaction.fromPSBT(base64.decode(f.request.checkpoints[0]!));
  const source = checkpoint.getInput(0);
  const checkpointId = checkpoint.id.toLowerCase();
  const arkTxid = f.response.arkTxid.toLowerCase();
  const coin = { txid: hex.encode(source.txid!).toLowerCase(), vout: source.index!, isSpent: false,
    isSwept: false, isUnrolled: false };
  const submission = { request: f.request, response: f.response, serverKey: f.serverKey };

  assert.doesNotThrow(() => assertFundingSourceState({ coin, checkpointId, arkTxid }));
  assert.throws(() => assertFundingSourceState({ coin: { ...coin, isSpent: true, spentBy: checkpointId, arkTxId: arkTxid },
    checkpointId, arkTxid }), /spent before a verified Submit response/);
  assert.doesNotThrow(() => assertFundingSourceState({
    coin: { ...coin, isSpent: true, spentBy: checkpointId, arkTxId: arkTxid }, checkpointId, arkTxid, submission,
  }));

  const spent = { ...coin, isSpent: true, spentBy: checkpointId, arkTxId: arkTxid };
  assert.throws(() => assertFundingSourceState({ coin: { ...spent, spentBy: 'b'.repeat(64) }, checkpointId, arkTxid, submission }), /exact signed checkpoint and Ark transaction/);
  assert.throws(() => assertFundingSourceState({ coin: { ...spent, arkTxId: 'c'.repeat(64) }, checkpointId, arkTxid, submission }), /exact signed checkpoint and Ark transaction/);
  assert.throws(() => assertFundingSourceState({ coin: spent, checkpointId: 'd'.repeat(64), arkTxid, submission }), /exact source checkpoint/);
  assert.throws(() => assertFundingSourceState({ coin: spent, checkpointId, arkTxid: 'e'.repeat(64), submission }), /does not match the exact pending Ark transaction/);
  assert.throws(() => assertFundingSourceState({ coin: { ...spent, isSwept: true }, checkpointId, arkTxid, submission }), /swept or unrolled/);
  assert.throws(() => assertFundingSourceState({ coin: { ...spent, isUnrolled: true }, checkpointId, arkTxid, submission }), /swept or unrolled/);
  assert.throws(() => assertFundingSourceState({ coin: spent, checkpointId, arkTxid }), /spent before a verified Submit response/);
});

test('recovery preflight accepts clean funding state and rejects dirty, mismatched or incomplete state', () => {
  const clean = recoveryCheckpoint();
  assertRecoverableCheckpoint(clean);
  assert.deepEqual(recoveryPlan(clean).missing, ['gate', 'lane', 'btcVault', 'tokenVault']);
  const mutations: ((value: any) => void)[] = [
    (value) => { value.native.state.noteCount = 1; },
    (value) => { value.native.state.reserves.BTC = 1; },
    (value) => { value.activities.push({ type: 'deposit' }); },
    (value) => { value.native.compact.profileId = 'f'.repeat(64); },
    (value) => { value.native.live.pendingBootstrap.response = undefined; },
    (value) => { value.native.live.issuanceTransactions.token = undefined; },
    (value) => { value.native.heads.lane = {}; },
    (value) => { value.native.live.pendingBoarding = { status: 'pending' }; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(clean);
    mutate(altered);
    assert.throws(() => assertRecoverableCheckpoint(altered));
  }
  const acceptedBoarding = structuredClone(clean);
  const point = { txid: 'd'.repeat(64), vout: 0 };
  acceptedBoarding.native.live.pendingBoarding = {
    status: 'accepted', requestId: 'boarding-request', requestIds: ['boarding-request'],
    selectedOutpoints: [point], selectedValues: [{ ...point, value: 20_000 }], walletOutpoints: [point],
    expectedOutputs: [{ script: hex.encode(p2tr(90)), value: 19_000 }], outputOutpoints: [{ ...point, vout: 1 }],
    inputSats: 20_000, baselineVtxos: [], startedAt: 1, commitmentTxid: 'e'.repeat(64),
    commitmentTx: 'saved-commitment', events: [{ type: 'accepted', id: 'event-id' }],
  };
  assert.throws(() => assertRecoverableCheckpoint(acceptedBoarding), /before any boarding request or receipt/);

  const archivedBoarding = structuredClone(clean);
  archivedBoarding.native.live.boardingReceipts = [{ requestId: 'boarding-request', requestIds: ['boarding-request'],
    commitmentTxid: 'e'.repeat(64), selectedOutpoints: [point], outputOutpoints: [{ ...point, vout: 1 }],
    amountSats: 19_000, startedAt: 1 }];
  assert.throws(() => assertRecoverableCheckpoint(archivedBoarding), /before any boarding request or receipt/);

  const noPending = structuredClone(clean);
  noPending.native.live.pendingBootstrap = undefined;
  assert.throws(() => assertRecoverableCheckpoint(noPending), /durable pending funding request/);
});

test('readonly encrypted loader authenticates and leaves the database and key files unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-recovery-'));
  const key = 'ab'.repeat(32);
  let store: EngineStore | undefined;
  try {
    store = EngineStore.open(directory, key);
    store.save(recoveryCheckpoint());
    store.close();
    store = undefined;
    const path = join(directory, 'shielded.sqlite');
    const before = digest(readFileSync(path));
    assert.throws(() => loadCheckpointReadonly(directory), /key is missing/);
    assert.equal(loadCheckpointReadonly(directory, key).profileId, 'c'.repeat(64));
    assert.throws(() => loadCheckpointReadonly(directory, 'cd'.repeat(32)), /failed authentication/);
    assert.equal(digest(readFileSync(path)), before);
    assert.equal(existsSync(join(directory, '.key')), false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('apply recovery rejects an unknown pending submit before any provider, wallet, or storage write', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'shielded-recovery-'));
  const key = 'ef'.repeat(32);
  const checkpoint = recoveryCheckpoint();
  checkpoint.native.live.pendingBootstrap.response = undefined;
  let providerCalls = 0;
  let submitCalls = 0;
  let finalizeCalls = 0;
  let walletCalls = 0;
  t.mock.method(RestArkProvider.prototype, 'getInfo', async () => { providerCalls++; throw new Error('unexpected provider call'); });
  t.mock.method(RestArkProvider.prototype, 'submitTx', async () => { submitCalls++; throw new Error('unexpected submit'); });
  t.mock.method(RestArkProvider.prototype, 'finalizeTx', async () => { finalizeCalls++; throw new Error('unexpected finalize'); });
  t.mock.method(RestIndexerProvider.prototype, 'getVirtualTxs', async () => { providerCalls++; throw new Error('unexpected indexer call'); });
  t.mock.method(RestIndexerProvider.prototype, 'getVtxos', async () => { providerCalls++; throw new Error('unexpected indexer call'); });
  t.mock.method(Wallet, 'create', async () => { walletCalls++; throw new Error('unexpected wallet creation'); });
  let store: EngineStore | undefined;
  try {
    store = EngineStore.open(directory, key);
    store.save(checkpoint);
    store.close();
    store = undefined;
    const dbPath = join(directory, 'shielded.sqlite');
    const before = digest(readFileSync(dbPath));
    await assert.rejects(runRecovery({ directory, storageKey: key, apply: true }), /signed operator response|ambiguous/);
    assert.equal(providerCalls, 0);
    assert.equal(submitCalls, 0);
    assert.equal(finalizeCalls, 0);
    assert.equal(walletCalls, 0);
    assert.equal(digest(readFileSync(dbPath)), before);
    assert.equal(existsSync(join(directory, '.key')), false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('network submission waits for durable journaling and stops when persistence fails', async () => {
  const calls: string[] = [];
  assert.equal(await journalBeforeNetwork(async () => { calls.push('journal'); }, async () => {
    calls.push('submit');
    return 'response';
  }), 'response');
  assert.deepEqual(calls, ['journal', 'submit']);
  calls.length = 0;
  await assert.rejects(journalBeforeNetwork(async () => { calls.push('journal'); throw new Error('disk full'); },
    async () => { calls.push('submit'); }));
  assert.deepEqual(calls, ['journal']);
});

function validate(f: ReturnType<typeof fundingFixture>, registeredIds: ReadonlySet<string>, markerId: string) {
  return validateFundingAllocation({ tx: f.tx, registeredIds, expectedAtHead: new Map([[markerId, 10_000_000n]]),
    sourceAssets: f.sourceAssets, walletChangeScripts: new Set([hex.encode(f.walletScript)]) });
}

function fundingFixture(ids: string[], walletScript: Uint8Array, options: {
  markerVout?: number; markerAmount?: bigint; changeVout?: number; duplicateTokenGroup?: boolean;
} = {}) {
  const [lane, vault, , token, extra] = ids;
  const transfers = [
    { assetId: token!, inputs: [{ vin: 0, amount: 10_000_000n }], outputs: [{ vout: options.markerVout ?? 0, amount: options.markerAmount ?? 10_000_000n }] },
    { assetId: lane!, inputs: [{ vin: 1, amount: 1n }], outputs: [{ vout: options.changeVout ?? 1, amount: 1n }] },
    { assetId: vault!, inputs: [{ vin: 3, amount: 1n }], outputs: [{ vout: options.changeVout ?? 1, amount: 1n }] },
  ];
  let packet = transferAssetPacket(transfers);
  if (extra) packet = asset.Packet.create([...packet.groups, asset.AssetGroup.create(asset.AssetId.fromString(extra), null,
    [asset.AssetInput.create(2, 7n)], [asset.AssetOutput.create(1, 7n)], [])]);
  if (options.duplicateTokenGroup) packet = asset.Packet.create([...packet.groups, asset.AssetGroup.create(
    asset.AssetId.fromString(token!), null, [asset.AssetInput.create(0, 10_000_000n)],
    [asset.AssetOutput.create(options.markerVout ?? 0, options.markerAmount ?? 10_000_000n)], [])]);
  const tx = new Transaction({ version: 3, lockTime: 0 });
  for (let vin = 0; vin < 5; vin++) tx.addInput({
    txid: (vin + 1).toString(16).padStart(2, '0').repeat(32), index: vin, sequence: 0xfffffffd,
  });
  tx.addOutput({ script: p2tr(70), amount: 200_000n });
  tx.addOutput({ script: walletScript, amount: 15_000n });
  tx.addOutput({ script: p2tr(71), amount: 20_000n });
  tx.addOutput(Extension.create([packet]).txOut());
  tx.addOutput(P2A);
  const sourceAssets = new Map<number, Map<string, bigint>>([
    [0, new Map([[token!, 10_000_000n]])], [1, new Map([[lane!, 1n]])],
    [2, new Map(extra ? [[extra, 7n]] : [])], [3, new Map([[vault!, 1n]])], [4, new Map()],
  ]);
  return { tx, sourceAssets, walletScript };
}

function makeAssetId(seed: number): string {
  const tx = offlineNativeFixture([{ script: p2tr(seed), amount: BigInt(seed) }]);
  return asset.AssetId.create(tx.id, 0).toString();
}

function p2tr(_seed: number): Uint8Array {
  return Uint8Array.of(0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(_seed)));
}

async function bootstrapFixture() {
  const walletKey = await wallet.xOnlyPublicKey();
  const serverKey = await operator.xOnlyPublicKey();
  const profileId = new Uint8Array(32).fill(4);
  const closure = createCompactClosure(profileId, serverKey, walletKey, exitTimelock);
  const checkpoint = CSVMultisigTapscript.encode({ timelock: exitTimelock, pubkeys: [serverKey, walletKey] });
  const source = offlineNativeFixture([{ script: closure.pkScript, amount: 10_000n }]);
  const spend = await buildCompactSpend({
    profileId, oldStateHash: new Uint8Array(32).fill(5), newStateHash: new Uint8Array(32).fill(6), sidecarTranscript: Uint8Array.of(1),
    inputs: [{ coin: { txid: source.id, vout: 0, value: 10_000, sourceTx: source.toBytes(false, false) },
      tapTree: closure.tapTree, tapLeafScript: closure.tapLeafScript }],
    outputs: [{ script: closure.pkScript, amount: 10_000n }], checkpoint, exitTimelock,
    serverPubkey: serverKey, emulatorPubkey: walletKey,
  });
  const localArk = await wallet.sign(spend.arkTx);
  const serverArk = await operator.sign(spend.arkTx);
  return {
    baseArk: Transaction.fromPSBT(spend.arkTx.toPSBT()),
    request: { arkTx: base64.encode(localArk.toPSBT()), checkpoints: spend.checkpoints.map((tx) => base64.encode(tx.toPSBT())) },
    response: { arkTxid: spend.arkTx.id, finalArkTx: base64.encode(serverArk.toPSBT()),
      signedCheckpointTxs: await Promise.all(spend.checkpoints.map(async (tx) =>
        base64.encode((await operator.sign(tx, [0])).toPSBT()))) },
    serverKey: hex.encode(serverKey), walletKey: hex.encode(walletKey),
  };
}

function clone<T>(value: T): T { return structuredClone(value); }

function recoveryCheckpoint(): any {
  const names = ['lane', 'btcVault', 'tokenVault', 'token'];
  const ids = names.map((_, i) => makeAssetId(i + 81));
  const identities = Object.fromEntries(names.map((name, i) => [name, ids[i]]));
  const issuanceTransactions = Object.fromEntries(names.map((name, i) => [name, `${i + 1}`.repeat(64)]));
  return { version: 2, proofTransport: 'compact', profileId: 'c'.repeat(64),
    protocol: { encryptedLog: [], receipts: [], nullifiers: [] },
    native: { version: 1, network: 'mutinynet', state: { noteCount: 0, historyCount: 0, reserves: { BTC: 0, DEMO: 0 } },
      heads: {}, identities, issuanceRaw: issuanceTransactions.token, genesisRaw: '', funding: { BTC: '0', DEMO: '0' },
      receipts: [], compact: { profileId: 'c'.repeat(64) }, live: {
        phase: 'funding-programs', issued: identities, issuanceTransactions,
        pendingBootstrap: { step: 'fund:gate', txid: 'a'.repeat(64), request: { arkTx: 'saved-request' }, response: { arkTxid: 'a'.repeat(64) } },
        boardingReceipts: [],
      } }, activities: [], publicBalances: {}, requests: {} };
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
