import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProtocol, DOMAIN, FIELD, type ProtocolKernel, type PreparedSettlement,
  type Asset, type Owner } from '../packages/protocol/src/index.ts';
import { createSdkRuntime, DEFAULT_VM_BINARY, type SdkRuntime, type NativeReceipt } from './sdk/runtime.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets: Asset[] = ['BTC', 'DEMO'];
const owners: Owner[] = ['alice', 'bob'];
type Input = Record<string, unknown>;
type Activity = Record<string, unknown>;
type WithdrawalProjection = { owner: Owner; asset: Asset; amount: number };
type PendingCompletion = { prepared: PreparedSettlement; receipt: NativeReceipt; summary: string;
  withdrawal?: WithdrawalProjection; completed: boolean };
export interface DemoEngine {
  snapshot(): Record<string, unknown>;
  action(action: string, body: Input): Promise<unknown>;
  close(): void;
}

export async function createDemoEngine(): Promise<DemoEngine> {
  let kernel: ProtocolKernel;
  let native: SdkRuntime;
  let activities: Activity[] = [];
  let lastSpend: PreparedSettlement | undefined;
  let publicBalances: Record<Owner, Record<Asset, number>> = { alice: { BTC: 0, DEMO: 0 }, bob: { BTC: 0, DEMO: 0 } };
  let pendingCompletion: PendingCompletion | undefined;
  let busy = false;
  let closed = false;
  const initialize = async () => {
    kernel = await createProtocol();
    native = await createSdkRuntime({ verificationKeys: kernel.verificationKeys(),
      initialState: kernel.snapshot().state, domain: DOMAIN,
      artifactsDirectory: resolve(root, 'artifacts'), vmBinary: DEFAULT_VM_BINARY });
  };
  await initialize();
  const compiler = JSON.parse(await readFile(resolve(root, 'artifacts/compiler-profile.json'), 'utf8')) as Record<string, unknown>;
  const artifactView = async () => Promise.all(Object.values(native.compiledArtifacts()).map(async value => {
    const item = value as { contractName: string; source: string; program: unknown; pkScript: string;
      functions: { name: string; scriptBytes: number; tapleafBytes: number }[] };
    return { name: item.contractName, source: await readFile(resolve(root, item.source), 'utf8'),
      path: item.source, program: item.program, programHex: item.pkScript,
      scriptBytes: Math.max(...item.functions.map(fn => fn.scriptBytes)), functions: item.functions,
      compilerCommit: compiler.recordedCheckoutCommit, compilerProfile: compiler };
  }));
  let artifacts = await artifactView();
  const owner = (value: unknown, fallback: Owner): Owner => {
    const selected = value ?? fallback;
    if (!owners.includes(selected as Owner)) throw new Error('Choose Alice or Bob');
    return selected as Owner;
  };
  const selectedAsset = (value: unknown): Asset => {
    if (value === undefined || value === 'BTC') return 'BTC';
    if (value === 'TOKEN' || value === 'DEMO') return 'DEMO';
    throw new Error('Choose BTC or the demonstration token');
  };
  const amount = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value >= 2 ** 48) {
      throw new Error('Amount must be a positive 48-bit integer');
    }
    return value;
  };
  const add = (entry: Activity) => { activities.push({ id: `${Date.now()}-${activities.length}`, timestamp: new Date().toISOString(), ...entry }); };
  const complete = async (pending: PendingCompletion) => {
    await kernel.commit(pending.prepared, pending.receipt);
    if (pending.completed) { pendingCompletion = undefined; return; }
    pending.completed = true;
    const { prepared, receipt, summary, withdrawal } = pending;
    if (prepared.intentSignals[2] !== '0') lastSpend = prepared;
    if (withdrawal) publicBalances[withdrawal.owner][withdrawal.asset] += withdrawal.amount;
    add({ type: prepared.operation, status: 'accepted', summary, txid: receipt.txid,
      proofMs: prepared.proofTimes.intentMs + prepared.proofTimes.transitionMs, vmMs: receipt.vmMs,
      inputCount: receipt.native.nativeInputs, outputCount: receipt.native.nativeOutputs,
      proofVerified: true, vmVerified: true, signatureCount: receipt.signatureCount,
      statement: createHash('sha256').update(JSON.stringify({ intent: prepared.intentSignals, transition: prepared.transitionSignals })).digest('hex'),
      nullifiers: prepared.intentSignals[2] === '0' ? [] : [prepared.intentSignals[2]],
      commitments: prepared.ciphertextRecords.map(record => record.commitment),
      ciphertexts: prepared.ciphertextRecords.map(record => record.ciphertext),
      proof: { intent: prepared.intentProof, transition: prepared.transitionProof,
        intentSignals: prepared.intentSignals, transitionSignals: prepared.transitionSignals },
      nativeTx: receipt.native, backend: receipt.backend, boundary: prepared.boundary,
      finality: 'Emulator co-signed; synthetic local genesis; no arkd/Bitcoin settlement',
    });
    pendingCompletion = undefined;
  };
  const retryCompletion = async (pending: PendingCompletion) => {
    try { await complete(pending); }
    catch { await complete(pending); }
  };
  const execute = async (prepared: PreparedSettlement, summary: string,
    withdrawal?: WithdrawalProjection): Promise<NativeReceipt> => {
    if (!await kernel.verify(prepared)) throw new Error('Groth16 proof verification failed');
    const receipt = await native.settle(prepared);
    const pending = { prepared, receipt, summary, withdrawal, completed: false };
    pendingCompletion = pending;
    await retryCompletion(pending);
    return receipt;
  };
  const snapshot = () => {
    const current = kernel.snapshot();
    const nativeState = native.snapshot() as { gateFunding: Record<Asset, string>; heads: unknown; nativeAssets: unknown; genesis: unknown };
    const wallets = owners.map(id => ({ id, name: id === 'alice' ? 'Alice' : 'Bob', address: current.wallets[id].address,
      publicBalance: { BTC: publicBalances[id].BTC, TOKEN: publicBalances[id].DEMO },
      notes: current.wallets[id].notes.map(note => ({ id: `note-${note.index}`, asset: note.asset === 'DEMO' ? 'TOKEN' : 'BTC',
        amount: note.amount, status: note.spent ? 'spent' : note.spendable ? 'spendable' : 'unsealed',
        commitment: note.commitment, owner: id, ciphertext: note.ciphertext.join(','), index: note.index })),
    }));
    return { status: { ready: !closed, mode: 'local-emulator', network: 'Local emulator · synthetic genesis',
      compiler: 'arkadec → Program', proof: 'Groth16 / BN254', vm: 'Arkade Service.SubmitTx', sdk: '@arkade-os/sdk 0.4.77 + OP_PUT',
      message: pendingCompletion ? 'A native transaction was accepted; local completion will retry before the next action' :
        busy ? 'Generating proofs and executing compiled covenants…' : 'Real proofs and emulator co-signing; local demonstration funding' },
      wallets: [...wallets, { id: 'faucet', name: 'Demo funding', address: '', notes: [],
        publicBalance: { BTC: nativeState.gateFunding.BTC, TOKEN: nativeState.gateFunding.DEMO } }],
      reserves: assets.map(asset => ({ asset: asset === 'DEMO' ? 'TOKEN' : asset,
        reserve: current.state.reserves[asset], liabilities: owners.reduce((total, id) => total + current.wallets[id].notes
          .filter(note => !note.spent && note.asset === asset).reduce((sum, note) => sum + note.amount, 0), 0) })),
      epoch: current.state.historyCount, lanes: [{ id: 0, noteRoot: current.state.noteRoot, nullifierRoot: current.state.spentRoot,
        noteCount: current.state.noteCount, historyRoot: current.state.historyRoot, revision: current.state.revision }],
      activity: structuredClone(activities), artifacts,
      profile: current.profile, anchors: current.anchors, encryptedLog: current.encryptedLog,
      native: { heads: nativeState.heads, assets: nativeState.nativeAssets, genesis: nativeState.genesis },
      privacy: { localWalletHarness: true, observerViewIsDisplayFilter: true, walletKeysReturned: false },
    };
  };
  return {
    snapshot,
    close() { closed = true; void native.close(); },
    async action(action, body) {
      if (closed) throw new Error('Demo is closed');
      if (busy) throw new Error('Another action is already in progress');
      busy = true;
      try {
        if (action !== 'reset' && pendingCompletion) await retryCompletion(pendingCompletion);
        const from = owner(body.from, 'alice');
        const to = owner(body.to, from === 'alice' ? 'bob' : 'alice');
        const asset = selectedAsset(body.asset);
        switch (action) {
          case 'reset':
            pendingCompletion = undefined; await native.close(); await initialize(); activities = []; lastSpend = undefined;
            publicBalances = { alice: { BTC: 0, DEMO: 0 }, bob: { BTC: 0, DEMO: 0 } };
            artifacts = await artifactView(); return { reset: true };
          case 'shield': return await execute(await kernel.prepareShield(from, asset, amount(body.amount)), `${from} received backed ${asset} notes; waiting for a seal`);
          case 'seal': return await execute(await kernel.prepareSeal(), 'Current note root accepted as an anchor; nullifiers preserved');
          case 'transfer':
            if (from === to) throw new Error('Choose different sender and recipient wallets');
            return await execute(await kernel.prepareTransfer(from, to, asset, amount(body.amount)), `${from} → ${to}; private ${asset} payment, reserve vault untouched`);
          case 'withdraw': {
            const quantity = amount(body.amount);
            return await execute(await kernel.prepareWithdraw(from, asset, quantity, native.destination(from)),
              `${from} received the exact authorized native ${asset} payout`, { owner: from, asset, amount: quantity });
          }
          case 'recover': {
            const notes = kernel.recover(from).filter(note => !note.spent);
            const balances = Object.fromEntries(assets.map(a => [a, notes.filter(note => note.asset === a).reduce((sum, note) => sum + note.amount, 0)]));
            add({ type: 'recover', status: 'accepted', summary: `${from}: scanned encrypted records and recovered ${notes.length} unspent notes`, recovery: { noteCount: notes.length, balances } });
            return { noteCount: notes.length, balances };
          }
          case 'replay': {
            if (!lastSpend) throw new Error('Complete a transfer or withdrawal before replaying its spent note');
            try { await kernel.rebase(lastSpend); }
            catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (!/nullifier already spent/i.test(reason)) throw error;
              add({ type: 'replay', status: 'rejected', summary: 'The current nullifier dictionary rejected a second spend', error: reason, proofVerified: false, rejectedAt: 'public-state proof preparation' });
              return { rejected: true, reason, stage: 'current nullifier state' };
            }
            throw new Error('Replay unexpectedly produced an applicable state proof');
          }
          case 'tamper': {
            const wallet = kernel.snapshot().wallets[from];
            const candidate = wallet.notes.find(note => !note.spent && note.spendable);
            const prepared = candidate
              ? await kernel.prepareTransfer(from, to, candidate.asset, Math.max(1, Math.floor(candidate.amount / 4)))
              : await kernel.prepareShield(from, asset, Math.min(amount(body.amount ?? 1000), 1000));
            const tampered = structuredClone(prepared);
            tampered.intentSignals[3] = ((BigInt(tampered.intentSignals[3]) + 1n) % FIELD).toString();
            const before = JSON.stringify(native.snapshot());
            try { await native.settle(tampered); }
            catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (!/execute arkade script|invalid .*proof|pairing|equalverify/i.test(reason)) throw error;
              if (JSON.stringify(native.snapshot()) !== before) throw new Error('Rejected transaction changed native state');
              add({ type: 'tamper', status: 'rejected', summary: 'Compiled covenant rejected substituted output commitment', error: reason, proofVerified: false, vmVerified: false, rejectedAt: 'actual emulator VM' });
              return { rejected: true, reason, stage: 'actual emulator VM' };
            }
            throw new Error('Tampered public effects unexpectedly passed the emulator');
          }
          case 'rebase': {
            const prepared = await kernel.prepareTransfer(from, to, asset, amount(body.amount));
            const originalProof = JSON.stringify(prepared.intentProof);
            const originalSignals = JSON.stringify(prepared.intentSignals);
            await execute(await kernel.prepareSeal(), 'Competing seal changed the native lane while the wallet intent remained pending');
            const rebased = await kernel.rebase(prepared);
            if (JSON.stringify(rebased.intentProof) !== originalProof) throw new Error('Rebase changed the wallet proof');
            if (JSON.stringify(rebased.intentSignals) !== originalSignals) throw new Error('Rebase changed the wallet signals');
            const transitionProofRegenerated = JSON.stringify(rebased.transitionProof) !== JSON.stringify(prepared.transitionProof) &&
              JSON.stringify(rebased.transitionSignals) !== JSON.stringify(prepared.transitionSignals);
            const receipt = await execute(rebased, 'Applied to fresh lane state with the exact same private wallet proof');
            return { receipt, walletProofUnchanged: JSON.stringify(rebased.intentProof) === originalProof &&
              JSON.stringify(rebased.intentSignals) === originalSignals, transitionProofRegenerated };
          }
          default: throw new Error('Unknown action');
        }
      } finally { busy = false; }
    },
  };
}
