import assert from 'node:assert/strict';
import test, { after } from 'node:test';
// @ts-ignore circomlibjs lacks declarations for these runtime builders.
import { buildBabyjub, buildPoseidon } from 'circomlibjs';
import { createProtocol, DOMAIN, type EncryptedRecord, type ProtocolCheckpoint } from '../packages/protocol/src/index.ts';

const { poseidon, babyjub } = await primitives();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function treeRoot(leaves: bigint[]): bigint {
  let level = leaves.slice();
  for (let depth = 0; depth < 8; depth++) {
    level = Array.from({ length: level.length / 2 }, (_, i) => hash([level[2 * i]!, level[2 * i + 1]!]));
  }
  return level[0]!;
}

function dummyRecord(index: number): EncryptedRecord {
  const commitment = '1';
  const ciphertext = Array<string>(7).fill('0');
  return { index, commitment, ciphertext, leaf: hash([1n, ...Array<bigint>(7).fill(0n)]).toString(),
    createdRevision: Math.floor(index / 2) + 1 };
}

function receiptsAndCommits(checkpoint: ProtocolCheckpoint, count: number): void {
  checkpoint.receipts = Array.from({ length: count }, (_, i) => ({ txid: 'fixture-' + i }));
  checkpoint.committed = Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [(i + 1).toString(16).padStart(24, '0'), (i + 1).toString(16).padStart(64, '0')]));
}

function buildFullNoteCheckpoint(base: ProtocolCheckpoint): ProtocolCheckpoint {
  const checkpoint = structuredClone(base);
  const records = Array.from({ length: 256 }, (_, index) => dummyRecord(index));
  const noteLeaves = records.map(record => BigInt(record.leaf));
  const zeros = Array<bigint>(256).fill(0n);
  checkpoint.encryptedLog = records;
  checkpoint.nullifiers = [];
  checkpoint.anchors = [];
  checkpoint.trees = { notes: noteLeaves.map(String), spent: zeros.map(String), history: zeros.map(String) };
  checkpoint.state = { noteRoot: treeRoot(noteLeaves).toString(), spentRoot: treeRoot(zeros).toString(),
    historyRoot: treeRoot(zeros).toString(), noteCount: 256, historyCount: 0, revision: 128, reserves: { BTC: 0, DEMO: 0 } };
  receiptsAndCommits(checkpoint, 128);
  return checkpoint;
}

function buildFullHistoryCheckpoint(base: ProtocolCheckpoint): ProtocolCheckpoint {
  const checkpoint = structuredClone(base);
  const zeros = Array<bigint>(256).fill(0n);
  const emptyNoteRoot = treeRoot(zeros);
  const historyLeaf = hash([DOMAIN, emptyNoteRoot]);
  const historyLeaves = Array<bigint>(256).fill(historyLeaf);
  checkpoint.encryptedLog = [];
  checkpoint.nullifiers = [];
  checkpoint.anchors = Array.from({ length: 256 }, () => ({ root: emptyNoteRoot.toString(), count: 0, leaves: zeros.map(String) }));
  checkpoint.trees = { notes: zeros.map(String), spent: zeros.map(String), history: historyLeaves.map(String) };
  checkpoint.state = { noteRoot: emptyNoteRoot.toString(), spentRoot: treeRoot(zeros).toString(),
    historyRoot: treeRoot(historyLeaves).toString(), noteCount: 0, historyCount: 256, revision: 256, reserves: { BTC: 0, DEMO: 0 } };
  receiptsAndCommits(checkpoint, 256);
  return checkpoint;
}

async function primitives() {
  // @ts-ignore circomlibjs does not bundle declarations for these builders.
  const poseidon = await buildPoseidon();
  // @ts-ignore circomlibjs does not bundle declarations for these builders.
  const babyjub = await buildBabyjub();
  return { poseidon, babyjub };
}

function point(babyjub: any, values: bigint[]): any[] {
  return values.map(value => babyjub.F.e(value));
}

function pointValues(babyjub: any, values: any[]): bigint[] {
  return values.map(value => BigInt(babyjub.F.toObject(value)));
}

function encryptedRecord(checkpoint: ProtocolCheckpoint, owner: 'alice' | 'bob', amount: bigint, rho: bigint,
  index: number, ephemeralScalar: bigint): EncryptedRecord {
  const wallet = checkpoint.wallets[owner];
  const spend = BigInt(wallet.spend);
  const view = BigInt(wallet.view);
  const ownerTag = hash([DOMAIN, spend]);
  const recipient = pointValues(babyjub, babyjub.mulPointEscalar(babyjub.Base8, view));
  const ephemeral = pointValues(babyjub, babyjub.mulPointEscalar(babyjub.Base8, ephemeralScalar));
  const shared = pointValues(babyjub, babyjub.mulPointEscalar(point(babyjub, recipient), ephemeralScalar));
  const plain = [amount, 0n, ownerTag, rho];
  const encrypted = plain.map((value, i) => {
    const sum = value + hash([DOMAIN, shared[0]!, shared[1]!, BigInt(100 + i)]);
    return (sum % FIELD + FIELD) % FIELD;
  });
  const tag = hash([DOMAIN, shared[0]!, shared[1]!, ...encrypted, 200n]);
  const ciphertext = [...ephemeral, ...encrypted, tag].map(String);
  const commitment = hash([DOMAIN, amount, 0n, ownerTag, rho]);
  const leaf = hash([commitment, ...ciphertext.map(BigInt)]);
  return { index, commitment: commitment.toString(), ciphertext, leaf: leaf.toString(), createdRevision: 1 };
}

function buildCollidingNullifierCheckpoint(base: ProtocolCheckpoint): { checkpoint: ProtocolCheckpoint; aliceNullifier: bigint; bobNullifier: bigint } {
  const checkpoint = structuredClone(base);
  const aliceSpend = BigInt(checkpoint.wallets.alice.spend);
  const bobSpend = BigInt(checkpoint.wallets.bob.spend);
  const aliceRho = 1234567n;
  const aliceNullifier = hash([DOMAIN, aliceSpend, aliceRho]);
  let bobRho = 2n;
  let bobNullifier = hash([DOMAIN, bobSpend, bobRho]);
  while (bobNullifier === aliceNullifier || (bobNullifier & 255n) !== (aliceNullifier & 255n)) {
    bobRho++;
    bobNullifier = hash([DOMAIN, bobSpend, bobRho]);
  }

  const records = [
    encryptedRecord(checkpoint, 'alice', 100n, aliceRho, 0, 17n),
    encryptedRecord(checkpoint, 'bob', 50n, bobRho, 1, 19n),
  ];
  const noteLeaves = Array<bigint>(256).fill(0n);
  noteLeaves[0] = BigInt(records[0]!.leaf);
  noteLeaves[1] = BigInt(records[1]!.leaf);
  const noteRoot = treeRoot(noteLeaves);
  const historyLeaves = Array<bigint>(256).fill(0n);
  historyLeaves[0] = hash([DOMAIN, noteRoot]);
  const spentLeaves = Array<bigint>(256).fill(0n);
  spentLeaves[Number(bobNullifier & 255n)] = bobNullifier;

  checkpoint.encryptedLog = records;
  checkpoint.nullifiers = [bobNullifier.toString()];
  checkpoint.anchors = [{ root: noteRoot.toString(), count: 2, leaves: noteLeaves.map(String) }];
  checkpoint.trees = { notes: noteLeaves.map(String), spent: spentLeaves.map(String), history: historyLeaves.map(String) };
  checkpoint.state = { noteRoot: noteRoot.toString(), spentRoot: treeRoot(spentLeaves).toString(),
    historyRoot: treeRoot(historyLeaves).toString(), noteCount: 2, historyCount: 1, revision: 2, reserves: { BTC: 150, DEMO: 0 } };
  receiptsAndCommits(checkpoint, 2);
  return { checkpoint, aliceNullifier, bobNullifier };
}

test('full note tree rejects the next shield before settlement and leaves checkpoint unchanged', { timeout: 180_000 }, async () => {
  const initial = await createProtocol();
  const checkpoint = buildFullNoteCheckpoint(initial.exportState());
  const protocol = await createProtocol({ checkpoint });
  const before = protocol.exportState();
  let settlementCalls = 0;

  await assert.rejects(async () => {
    const prepared = await protocol.prepareShield('alice', 'BTC', 1);
    settlementCalls++;
    await protocol.commit(prepared, { txid: 'must-not-submit' });
  }, /Note tree full/);

  assert.equal(settlementCalls, 0);
  assert.deepEqual(protocol.exportState(), before);
});

test('full anchor history rejects the next seal before settlement and leaves checkpoint unchanged', { timeout: 180_000 }, async () => {
  const initial = await createProtocol();
  const checkpoint = buildFullHistoryCheckpoint(initial.exportState());
  const protocol = await createProtocol({ checkpoint });
  const before = protocol.exportState();
  let settlementCalls = 0;

  await assert.rejects(async () => {
    const prepared = await protocol.prepareSeal();
    settlementCalls++;
    await protocol.commit(prepared, { txid: 'must-not-submit' });
  }, /Anchor history full/);

  assert.equal(settlementCalls, 0);
  assert.deepEqual(protocol.exportState(), before);
});

test('distinct nullifiers that collide in the depth-eight slot fail before settlement and preserve recoverable notes', { timeout: 180_000 }, async () => {
  const initial = await createProtocol();
  const { checkpoint, aliceNullifier, bobNullifier } = buildCollidingNullifierCheckpoint(initial.exportState());
  assert.notEqual(aliceNullifier, bobNullifier);
  assert.equal(aliceNullifier & 255n, bobNullifier & 255n);

  const protocol = await createProtocol({ checkpoint });
  assert.equal(protocol.recover('alice').find(note => note.index === 0)?.spendable, true);
  assert.equal(protocol.recover('bob').find(note => note.index === 1)?.spent, true);
  const before = protocol.exportState();
  let settlementCalls = 0;

  await assert.rejects(async () => {
    const prepared = await protocol.prepareTransfer('alice', 'bob', 'BTC', 10);
    settlementCalls++;
    await protocol.commit(prepared, { txid: 'must-not-submit' });
  }, /Depth-8 nullifier slot collision/);

  assert.equal(settlementCalls, 0);
  assert.deepEqual(protocol.exportState(), before);
});

after(async () => {
  const globals = globalThis as typeof globalThis & { curve_bn128?: { terminate(): Promise<void> } };
  await globals.curve_bn128?.terminate();
});

