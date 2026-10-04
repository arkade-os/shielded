import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { asset, buildOffchainTx, CSVMultisigTapscript, Extension, MultisigTapscript, SingleKey, Transaction, VtxoScript } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import { createCompactClosure } from '../src/compact/adapter.ts';
import { assertReadyCheckpoint } from '../src/compact/ready-live.ts';
import { offlineNativeFixture, transferAssetPacket } from '../src/sdk/adapter.ts';
import { continueFreshRegisteredBootstrap, type RecoveryContext, type StoredEngine } from '../tools/compact-bootstrap-recovery.ts';

const walletIdentity = SingleKey.fromHex('09'.repeat(32));
const serverIdentity = SingleKey.fromHex('08'.repeat(32));
const resourceNames = ['gate', 'lane', 'btcVault', 'tokenVault'] as const;
const issuedNames = ['lane', 'btcVault', 'tokenVault', 'token'] as const;
type Name = typeof resourceNames[number];
type Coin = { txid: string; vout: number; value: number; script: string; assets: { assetId: string; amount: bigint }[];
  isSpent: boolean; isSwept: boolean; isUnrolled: boolean; spentBy?: string; arkTxId?: string };
type Response = { arkTxid: string; finalArkTx: string; signedCheckpointTxs: string[] };
type MockNetwork = { sourceCoins: Map<string, Coin>; virtualTxs: Map<string, string>; pendingResponses: Map<string, Response>; resourceByTx: Map<string, Name> };

function txRaw(tx: Transaction): string { return hex.encode(tx.toBytes()); }
function assetAmounts(tx: Transaction, vout: number): { assetId: string; amount: bigint }[] {
  const packet = Extension.fromTx(tx).getAssetPacket();
  return (packet?.groups ?? []).flatMap((group) => group.outputs.filter((entry) => entry.vout === vout)
    .map((entry) => ({ assetId: group.assetId!.toString(), amount: entry.amount })));
}

function freshCheckpoint(): StoredEngine {
  const issuedTxs = Object.fromEntries(issuedNames.map((name, index) => [name,
    offlineNativeFixture([{ script: Uint8Array.of(0x51), amount: BigInt(index + 1) }])]));
  const issued = Object.fromEntries(issuedNames.map((name) => [name, asset.AssetId.create(issuedTxs[name]!.id, 0).toString()]));
  const tokenRaw = txRaw(issuedTxs.token!);
  return { version: 2, proofTransport: 'compact', profileId: 'c'.repeat(64),
    protocol: { encryptedLog: [], receipts: [], nullifiers: [], trees: { notes: [], spent: [], history: [] } } as never,
    native: { version: 1, network: 'mutinynet', domain: '1', state: { noteCount: 0, historyCount: 0, reserves: { BTC: 0, DEMO: 0 } },
      serverKey: 'a'.repeat(64), emulatorKey: 'b'.repeat(64), identities: issued, issuanceRaw: tokenRaw, genesisRaw: '',
      heads: {}, funding: { BTC: '0', DEMO: '0' }, receipts: [], compact: { version: 1, profileId: 'c'.repeat(64), sidecars: {} },
      live: { phase: 'funding-programs', issued, issuanceTransactions: Object.fromEntries(Object.entries(issuedTxs)
        .map(([name, tx]) => [name, txRaw(tx!)])), seedHex: '09'.repeat(32), compactEmulatorSecret: '0a'.repeat(32),
        arkUrl: 'https://mock.mutinynet', emulatorUrl: 'inprocess://compact-verifier', pendingBootstrap: undefined,
        boardingReceipts: [] } } as never,
    activities: [], publicBalances: {}, requests: { bootstrap: { status: 'pending',
      bodyHash: createHash('sha256').update(JSON.stringify({ action: 'bootstrap', body: {} })).digest('hex') } } };
}

async function buildHarness(checkpoint: StoredEngine, options: { loseSubmitFor?: Name; loseFinalizeFor?: Name } = {},
  network: MockNetwork = { sourceCoins: new Map(), virtualTxs: new Map(), pendingResponses: new Map(), resourceByTx: new Map() }) {
  const walletPub = await walletIdentity.xOnlyPublicKey();
  const serverPub = await serverIdentity.xOnlyPublicKey();
  const walletKey = walletIdentity;
  const forfeit = MultisigTapscript.encode({ pubkeys: [walletPub, serverPub] }).script;
  const ownerExit = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 2048n }, pubkeys: [walletPub] }).script;
  const walletTree = new VtxoScript([forfeit, ownerExit]);
  const profile = hex.decode(checkpoint.profileId);
  const closure = createCompactClosure(profile, serverPub, walletPub, { type: 'seconds', value: 2048n });
  const unroll = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 2048n }, pubkeys: [serverPub] });
  const ids = checkpoint.native.live!.issued as Record<string, string>;
  const { sourceCoins, virtualTxs, pendingResponses } = network;
  const sends: Name[] = [];
  const submits: string[] = [];
  const finalizes: string[] = [];
  const sourceFor = new Map<Name, Transaction>();
  for (const [resourceIndex, name] of resourceNames.entries()) {
    const assetName = name === 'gate' ? 'token' : name === 'lane' ? 'lane' : name === 'btcVault' ? 'btcVault' : 'tokenVault';
    const source = offlineNativeFixture([{ script: walletTree.pkScript, amount: name === 'gate' ? 300_000n : BigInt(100_000 + resourceIndex * 1_000) }]);
    sourceFor.set(name, source);
    if (!sourceCoins.has(`${source.id}:0`)) sourceCoins.set(`${source.id}:0`, { txid: source.id, vout: 0, value: Number(source.getOutput(0).amount),
      script: hex.encode(source.getOutput(0).script!), assets: [{ assetId: ids[assetName]!,
        amount: name === 'gate' ? 10_000_000n : 1n }], isSpent: false, isSwept: false, isUnrolled: false });
  }

  const provider = {
    getInfo: async () => ({ network: 'mutinynet', signerPubkey: `02${hex.encode(serverPub)}`, checkpointTapscript: 'policy',
      unilateralExitDelay: 2048n, maxTxWeight: 4_000n }),
    submitTx: async (arkRaw: string, checkpointRaws: string[]): Promise<Response> => {
      const ark = Transaction.fromPSBT(base64.decode(arkRaw));
      submits.push(ark.id);
      const response = { arkTxid: ark.id, finalArkTx: base64.encode((await serverIdentity.sign(ark)).toPSBT()),
        signedCheckpointTxs: await Promise.all(checkpointRaws.map(async (raw) => {
          const checkpoint = Transaction.fromPSBT(base64.decode(raw));
          checkpoint.updateInput(0, { tapScriptSig: [] });
          return base64.encode((await serverIdentity.sign(checkpoint, [0])).toPSBT());
        })) };
      pendingResponses.set(ark.id, response);
      const submittedName = sends[sends.length - 1]!;
      network.resourceByTx.set(ark.id, submittedName);
      if (options.loseSubmitFor === submittedName) throw new Error('mocked Submit response lost');
      return response;
    },
    finalizeTx: async (txid: string, finalCheckpointRaws: string[]): Promise<void> => {
      finalizes.push(txid);
      const response = pendingResponses.get(txid)!;
      const ark = Transaction.fromPSBT(base64.decode(response.finalArkTx));
      const requestCheckpointRaws = [...finalCheckpointRaws];
      for (const raw of requestCheckpointRaws) {
        const cp = Transaction.fromPSBT(base64.decode(raw));
        virtualTxs.set(cp.id.toLowerCase(), raw);
        const input = cp.getInput(0);
        const source = sourceCoins.get(`${hex.encode(input.txid!)}:${input.index}`)!;
        source.isSpent = true; source.spentBy = cp.id.toLowerCase(); source.arkTxId = txid.toLowerCase();
      }
      virtualTxs.set(ark.id.toLowerCase(), response.finalArkTx);
      for (let vout = 0; vout < ark.outputsLength; vout++) {
        const output = ark.getOutput(vout);
        if (!output.script || !output.amount || output.amount <= 0n) continue;
        const key = `${ark.id}:${vout}`;
        sourceCoins.set(key, { txid: ark.id, vout, value: Number(output.amount), script: hex.encode(output.script),
          assets: assetAmounts(ark, vout), isSpent: false, isSwept: false, isUnrolled: false });
      }
      if (options.loseFinalizeFor === network.resourceByTx.get(txid)) throw new Error('mocked finalize response lost after acceptance');
    },
    getPendingTxs: async () => [...pendingResponses.values()],
  };
  const indexer = {
    getVtxos: async ({ outpoints }: { outpoints: { txid: string; vout: number }[] }) => ({ vtxos: outpoints.flatMap((point) => {
      const coin = sourceCoins.get(`${point.txid.toLowerCase()}:${point.vout}`);
      return coin ? [coin] : [];
    }) }),
    getVirtualTxs: async (txids: string[]) => ({ txs: txids.flatMap((id) => {
      const tx = virtualTxs.get(id.toLowerCase()); return tx ? [tx] : [];
    }) }),
  };
  const context = { provider, indexer, walletIdentity, info: { network: 'mutinynet', maxTxWeight: 4_000n }, serverKey: hex.encode(serverPub),
    closure, walletScripts: new Set([hex.encode(walletTree.pkScript)]), verificationKeys: {}, initialState: {
      noteCount: 0, historyCount: 0, reserves: { BTC: 0, DEMO: 0 } }, wallet: {
    async send() {
      const name = resourceNames.find((candidate) => !checkpoint.native.heads[candidate]);
      if (!name) throw new Error('no resource remains');
      sends.push(name);
      const assetName = name === 'gate' ? 'token' : name === 'lane' ? 'lane' : name === 'btcVault' ? 'btcVault' : 'tokenVault';
      const source = sourceFor.get(name)!;
      const targetSats = name === 'gate' ? 200_000n : 1_000n;
      const spend = buildOffchainTx([{ txid: source.id, vout: 0, value: Number(source.getOutput(0).amount),
        tapTree: walletTree.encode(), tapLeafScript: walletTree.findLeaf(hex.encode(forfeit)) }],
      [{ script: closure.pkScript, amount: targetSats }, { script: walletTree.pkScript, amount: name === 'gate' ? 90_000n :
        BigInt(Number(source.getOutput(0).amount) - Number(targetSats) - 9_000) }], unroll);
      const packet = transferAssetPacket([{ assetId: ids[assetName]!, inputs: [{ vin: 0,
        amount: name === 'gate' ? 10_000_000n : 1n }], outputs: [{ vout: 0, amount: name === 'gate' ? 10_000_000n : 1n }] }]);
      spend.arkTx.addOutput(Extension.create([packet]).txOut());
      const signedArk = await walletKey.sign(spend.arkTx, [0]);
      const response = await provider.submitTx(base64.encode(signedArk.toPSBT()), spend.checkpoints.map((cp) => base64.encode(cp.toPSBT())));
      const finals = await Promise.all(response.signedCheckpointTxs.map(async (raw) => base64.encode((await walletKey.sign(
        Transaction.fromPSBT(base64.decode(raw)), [0])).toPSBT())));
      await provider.finalizeTx(response.arkTxid, finals);
      return response.arkTxid;
    },
    async dispose() {},
    async getScriptMap() { return new Map([[hex.encode(walletTree.pkScript), { encode: () => walletTree.encode(), forfeit: () => walletTree.findLeaf(hex.encode(forfeit)) }]]); },
    async makeGetPendingTxIntentSignature() { return {}; },
  } } as unknown as RecoveryContext;
  const dependencies = { createContext: async () => context, verifyReadyRestore: async () => {} };
  return { context, dependencies, sends, submits, finalizes, sourceCoins, virtualTxs, network };
}

async function run(checkpoint: StoredEngine, h: Awaited<ReturnType<typeof buildHarness>>, persist: (next: StoredEngine) => Promise<void>) {
  return continueFreshRegisteredBootstrap({ checkpoint, persist }, h.dependencies);
}

test('fresh bootstrap funds and authenticates all four resources; interrupted receipt prefix resumes only missing heads', { timeout: 60_000 }, async () => {
  const checkpoint = freshCheckpoint();
  const network: MockNetwork = { sourceCoins: new Map(), virtualTxs: new Map(), pendingResponses: new Map(), resourceByTx: new Map() };
  const first = await buildHarness(checkpoint, {}, network);
  let durable: StoredEngine | undefined;
  let stopped = false;
  await assert.rejects(run(checkpoint, first, async (next) => {
    durable = structuredClone(next);
    if (!stopped && next.native.heads.lane) { stopped = true; throw new Error('simulated process crash after lane receipt'); }
  }), /simulated process crash/);
  assert.deepEqual(first.sends, ['gate', 'lane']);
  assert.ok(durable);
  const restarted = await buildHarness(durable!, {}, network);
  const result = await run(durable!, restarted, async (next) => { durable = structuredClone(next); });
  assert.equal(result.native.live?.phase, 'ready');
  assert.deepEqual(restarted.sends, ['btcVault', 'tokenVault']);
  assert.equal(first.submits.length + restarted.submits.length, 4);
  assert.equal(first.finalizes.length + restarted.finalizes.length, 4);
  assert.deepEqual(resourceNames.filter((name) => !result.native.heads[name]), []);
  assert.equal(result.native.compact?.profileId, checkpoint.profileId);
  assert.equal(Object.keys(result.native.live?.bootstrapRecovery?.heads ?? {}).length, 4);
  assertReadyCheckpoint(result.native);
});

test('response-lost Submit reconciles by exact pending response and unknown accepted Finalize never resubmits', { timeout: 60_000 }, async () => {
  const checkpoint = freshCheckpoint();
  let durable = structuredClone(checkpoint);
  const network: MockNetwork = { sourceCoins: new Map(), virtualTxs: new Map(), pendingResponses: new Map(), resourceByTx: new Map() };
  const first = await buildHarness(checkpoint, { loseSubmitFor: 'gate' }, network);
  await assert.rejects(run(checkpoint, first, async (next) => { durable = structuredClone(next); }), /mocked Submit response lost/);
  assert.equal(first.submits.length, 1);
  assert.equal(first.finalizes.length, 0);
  const second = await buildHarness(durable, { loseFinalizeFor: 'gate' }, network);
  await assert.rejects(run(durable, second, async (next) => { durable = structuredClone(next); }), /mocked finalize response lost/);
  assert.equal(second.submits.length, 0);
  assert.equal(second.finalizes.length, 1);
  const third = await buildHarness(durable, {}, network);
  const result = await run(durable, third, async (next) => { durable = structuredClone(next); });
  assert.equal(result.native.live?.phase, 'ready');
  assert.deepEqual(third.sends, ['lane', 'btcVault', 'tokenVault']);
  assert.equal(third.submits.length, 3);
  assert.equal(third.finalizes.length, 3);
  assertReadyCheckpoint(result.native);
});
