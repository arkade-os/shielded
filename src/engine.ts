import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProtocol, DOMAIN, FIELD, type ProtocolKernel, type PreparedSettlement,
  type Asset, type Owner } from '../packages/protocol/src/index.ts';
import { createSdkRuntime, DEFAULT_VM_BINARY, type SdkRuntime, type NativeReceipt, type NativeCheckpoint, type NativeSubmission } from './sdk/runtime.ts';
import { EngineStore } from './storage.ts';
import type { ProtocolCheckpoint } from '../packages/protocol/src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets: Asset[] = ['BTC', 'DEMO'];
const owners: Owner[] = ['alice', 'bob'];
type Input = Record<string, unknown>;
type Activity = Record<string, unknown>;
type WithdrawalProjection = { owner: Owner; asset: Asset; amount: number };
type PendingCompletion = { prepared: PreparedSettlement; receipt: NativeReceipt; summary: string;
  withdrawal?: WithdrawalProjection; completed: boolean; phase: 'prepared' | 'submitted' | 'accepted';
  submission?: NativeSubmission; requestId?: string };
type StoredRequest = { bodyHash: string; status: 'pending' | 'done'; result?: unknown };
type EngineCheckpoint = { version: 1; protocol: ProtocolCheckpoint; native: NativeCheckpoint;
  activities: Activity[]; publicBalances: Record<Owner, Record<Asset, number>>;
  pendingCompletion?: Omit<PendingCompletion, 'prepared'> & { prepared: PreparedSettlement };
  requests: Record<string, StoredRequest> };
export interface DemoEngineOptions { dataDirectory?: string; network?: 'local-emulator' | 'mutinynet';
  arkUrl?: string; emulatorUrl?: string; storageKey?: string }
export interface DemoEngine {
  snapshot(): Record<string, unknown>;
  action(action: string, body: Input, requestId?: string): Promise<unknown>;
  close(): Promise<void>;
}

export async function createDemoEngine(options: DemoEngineOptions = {}): Promise<DemoEngine> {
  const configuredKey = options.storageKey === undefined ? (process.env.SHIELDED_STORAGE_KEY || undefined) : options.storageKey;
  const store = options.dataDirectory ? EngineStore.open(options.dataDirectory, configuredKey) : undefined;
  let saved: EngineCheckpoint | undefined;
  try {
    saved = store?.load<EngineCheckpoint>();
    if (saved && (saved.version !== 1 || !saved.protocol || !saved.native || !Array.isArray(saved.activities) || !saved.publicBalances || !saved.requests)) {
      throw new Error('Stored engine checkpoint is invalid; refusing to initialize empty state.');
    }
    if (saved?.pendingCompletion && !['prepared', 'submitted', 'accepted'].includes(saved.pendingCompletion.phase)) {
      throw new Error('Stored settlement phase is invalid; refusing to open this wallet.');
    }
  } catch (error) { store?.close(); throw error; }
  let kernel: ProtocolKernel;
  let native: SdkRuntime;
  let activities: Activity[] = saved?.activities ?? [];
  let lastSpend: PreparedSettlement | undefined;
  let publicBalances: Record<Owner, Record<Asset, number>> = saved?.publicBalances ?? { alice: { BTC: 0, DEMO: 0 }, bob: { BTC: 0, DEMO: 0 } };
  let pendingCompletion: PendingCompletion | undefined = saved?.pendingCompletion;
  let requests: Record<string, StoredRequest> = saved?.requests ?? {};
  let busy = false;
  let closed = false;
  let runtimeReady = false;
  let activeAction: Promise<unknown> | undefined;
  let recoveryError: string | undefined;
  const network = options.network ?? saved?.native.network ?? 'local-emulator';
  if (network === 'mutinynet' && !store) throw new Error('Mutinynet requires an encrypted persistent data directory.');
  const persist = (nativeCheckpoint?: NativeCheckpoint) => {
    if (!store) return;
    if (!runtimeReady && !nativeCheckpoint) return;
    try {
      store.save({ version: 1, protocol: kernel.exportState(), native: nativeCheckpoint ?? native.exportState(), activities,
        publicBalances, pendingCompletion, requests } satisfies EngineCheckpoint);
    } catch (error) {
      recoveryError = 'Durable checkpoint write failed; this process is read-only until restarted and reconciled.';
      throw error;
    }
  };
  const initialize = async () => {
    kernel = await createProtocol({ checkpoint: saved?.protocol, secureKeys: !!store });
    native = await createSdkRuntime({ verificationKeys: kernel.verificationKeys(),
      initialState: saved?.pendingCompletion?.phase === 'accepted' ? saved.native.state : kernel.snapshot().state, domain: DOMAIN,
      artifactsDirectory: resolve(root, 'artifacts'), vmBinary: DEFAULT_VM_BINARY,
      checkpoint: saved?.native, network, arkUrl: options.arkUrl, emulatorUrl: options.emulatorUrl,
      onSubmission: async (_prepared, submission) => {
        if (!pendingCompletion) {
          if (!store && network === 'local-emulator') return;
          throw new Error('Native submission has no durable pending intent.');
        }
        pendingCompletion.phase = 'submitted';
        pendingCompletion.submission = submission;
        persist();
      },
      onCheckpoint: async checkpoint => { persist(checkpoint); },
    });
    runtimeReady = true;
  };
  try { await initialize(); } catch (error) { store?.close(); throw error; }
  if (store && !saved) persist();
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
    if (pending.phase !== 'accepted' || !pending.receipt || pending.receipt.id !== pending.prepared.id ||
        pending.receipt.operation !== pending.prepared.operation ||
        (pending.submission && pending.receipt.txid !== pending.submission.txid)) {
      throw new Error('Cannot commit protocol state without a matching accepted native receipt.');
    }
    await kernel.commit(pending.prepared, pending.receipt);
    if (pending.completed) { pendingCompletion = undefined; persist(); return; }
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
      finality: receipt.finality === 'operator-preconfirmed' ? 'Mutinynet operator preconfirmed; verify canonical inclusion for finality' :
        'Emulator co-signed; synthetic local genesis; no arkd/Bitcoin settlement',
    });
    pendingCompletion = undefined;
    if (pending.requestId) requests[pending.requestId] = { ...requests[pending.requestId], status: 'done', result: receipt };
    persist();
  };
  const retryCompletion = async (pending: PendingCompletion) => {
    try { await complete(pending); }
    catch (error) {
      if (recoveryError) throw error;
      await complete(pending);
    }
  };
  const recoverPending = async () => {
    if (!pendingCompletion) return;
    pendingCompletion.prepared = await kernel.restorePrepared(pendingCompletion.prepared);
    if (pendingCompletion.phase === 'accepted') {
      if (!pendingCompletion.receipt) throw new Error('Accepted settlement is missing its durable receipt.');
      await retryCompletion(pendingCompletion);
      return;
    }
    if (pendingCompletion.phase === 'submitted') {
      if (!pendingCompletion.submission) throw new Error('Submitted settlement is missing its durable transaction record.');
      const receipt = await native.reconcile(pendingCompletion.prepared, pendingCompletion.submission);
      if (!receipt) throw new Error('Submission outcome is unknown; spending is blocked until the network transaction can be reconciled.');
      pendingCompletion.receipt = receipt;
      pendingCompletion.phase = 'accepted';
      persist();
      await retryCompletion(pendingCompletion);
      return;
    }
    const receipt = await native.settle(pendingCompletion.prepared);
    pendingCompletion.receipt = receipt;
    pendingCompletion.phase = 'accepted';
    persist();
    await retryCompletion(pendingCompletion);
  };
  if (store && pendingCompletion) {
    try { await recoverPending(); }
    catch (error) { recoveryError = error instanceof Error ? error.message : String(error); }
  }
  const execute = async (prepared: PreparedSettlement, summary: string,
    withdrawal?: WithdrawalProjection, requestId?: string): Promise<NativeReceipt> => {
    if (!await kernel.verify(prepared)) throw new Error('Groth16 proof verification failed');
    const pending: PendingCompletion = { prepared, receipt: undefined as unknown as NativeReceipt, summary,
      withdrawal, completed: false, phase: 'prepared', requestId };
    pendingCompletion = pending;
    persist();
    const receipt = await native.settle(prepared);
    pending.receipt = receipt;
    pending.phase = 'accepted';
    persist();
    await retryCompletion(pending);
    return receipt;
  };
  const snapshot = () => {
    const current = kernel.snapshot();
    const nativeState = native.snapshot() as { gateFunding?: Record<Asset, string>; heads: unknown; nativeAssets: unknown; genesis: unknown;
      funding?: unknown; blockedReason?: string; phase?: string; bootstrapPhase?: string; compatible?: boolean; ready?: boolean; operator?: unknown };
    const nativeBlocked = network === 'mutinynet' ? nativeState.blockedReason : undefined;
    const nativeReady = network !== 'mutinynet' || nativeState.ready !== false;
    const mutinynetActions = ['bootstrap', 'sync', ...(nativeBlocked || !nativeReady ? [] : ['shield', 'seal', 'transfer', 'withdraw', 'recover'])];
    const wallets = owners.map(id => ({ id, name: id === 'alice' ? 'Alice' : 'Bob', address: current.wallets[id].address,
      publicBalance: { BTC: publicBalances[id].BTC, TOKEN: publicBalances[id].DEMO },
      notes: current.wallets[id].notes.map(note => ({ id: `note-${note.index}`, asset: note.asset === 'DEMO' ? 'TOKEN' : 'BTC',
        amount: note.amount, status: note.spent ? 'spent' : note.spendable ? 'spendable' : 'unsealed',
        commitment: note.commitment, owner: id, ciphertext: note.ciphertext.join(','), index: note.index })),
    }));
    return { status: { ready: !closed && !recoveryError && !pendingCompletion && !nativeBlocked && nativeReady, mode: network, network: network === 'mutinynet' ? 'Mutinynet' : 'Local emulator · synthetic genesis',
      compiler: 'arkadec → Program', proof: 'Groth16 / BN254', vm: 'Arkade Service.SubmitTx', sdk: '@arkade-os/sdk 0.4.77 + OP_PUT',
      persistence: !!store, recovery: recoveryError ? 'blocked' : pendingCompletion?.phase ?? 'ready',
      finality: network === 'mutinynet' ? 'Arkade operator acceptance; query canonical tx state for finality' : 'Synthetic local emulator',
      blockedReason: recoveryError ?? nativeBlocked, phase: nativeState.phase ?? nativeState.bootstrapPhase,
      compatible: nativeState.compatible ?? !nativeBlocked, operator: nativeState.operator,
      allowedActions: closed || recoveryError || pendingCompletion ? [] : network === 'mutinynet' ? mutinynetActions :
        ['shield','seal','transfer','withdraw','recover', ...(!store ? ['reset','replay','tamper','rebase'] : [])],
      message: recoveryError ?? (pendingCompletion?.phase === 'accepted' ? 'A native transaction was accepted; local completion will retry before the next action' :
        pendingCompletion?.phase === 'submitted' ? 'A native submission outcome is unresolved; actions remain blocked' :
        pendingCompletion ? 'A prepared action is waiting for native submission' :
        nativeBlocked ?? (!nativeReady ? 'Send the displayed test funds, then bootstrap the pool' : busy ? 'Generating proofs and executing covenants…' : store ? 'Encrypted durable state is active' : 'Real proofs and emulator co-signing; local demonstration funding')) },
      wallets: network === 'mutinynet' ? wallets : [...wallets, { id: 'faucet', name: 'Demo funding', address: '', notes: [],
        publicBalance: { BTC: nativeState.gateFunding?.BTC ?? '0', TOKEN: nativeState.gateFunding?.DEMO ?? '0' } }],
      reserves: assets.map(asset => ({ asset: asset === 'DEMO' ? 'TOKEN' : asset,
        reserve: current.state.reserves[asset], liabilities: owners.reduce((total, id) => total + current.wallets[id].notes
          .filter(note => !note.spent && note.asset === asset).reduce((sum, note) => sum + note.amount, 0), 0) })),
      epoch: current.state.historyCount, lanes: [{ id: 0, noteRoot: current.state.noteRoot, nullifierRoot: current.state.spentRoot,
        noteCount: current.state.noteCount, historyRoot: current.state.historyRoot, revision: current.state.revision }],
      activity: structuredClone(activities), artifacts,
      profile: current.profile, anchors: current.anchors, encryptedLog: current.encryptedLog,
      native: { heads: nativeState.heads, assets: nativeState.nativeAssets, genesis: nativeState.genesis,
        funding: nativeState.funding, blockedReason: nativeState.blockedReason, phase: nativeState.phase,
        compatible: nativeState.compatible ?? !nativeBlocked, ready: nativeState.ready, operator: nativeState.operator },
      privacy: { localWalletHarness: true, observerViewIsDisplayFilter: true, walletKeysReturned: false },
    };
  };
  return {
    snapshot,
    async close() {
      if (closed) return;
      closed = true;
      if (activeAction) await activeAction.catch(() => {});
      try { await native.close(); } finally { store?.close(); }
    },
    async action(action, body, requestId) {
      if (closed) throw new Error('Demo is closed');
      if (recoveryError) throw new Error(recoveryError);
      if (busy) throw new Error('Another action is already in progress');
      const bodyHash = createHash('sha256').update(JSON.stringify({ action, body })).digest('hex');
      if (requestId && !/^[\x21-\x7e]{1,128}$/.test(requestId)) throw new Error('Invalid idempotency key.');
      if (network === 'mutinynet' && ['bootstrap','sync','shield','seal','transfer','withdraw','recover'].includes(action) && !requestId) {
        throw new Error('Idempotency-Key is required for Mutinynet actions.');
      }
      if (requestId) {
        const existing = requests[requestId];
        if (existing && existing.bodyHash !== bodyHash) throw new Error('Idempotency key was already used for a different action body.');
        if (existing?.status === 'done') return existing.result;
        requests[requestId] = existing ?? { bodyHash, status: 'pending' };
        persist();
      }
      busy = true;
      const running = (async () => {
        if (action !== 'reset' && pendingCompletion) {
          const pendingId = pendingCompletion.requestId;
          try { await recoverPending(); }
          catch (error) {
            if (pendingCompletion?.phase === 'submitted') recoveryError = error instanceof Error ? error.message : String(error);
            throw error;
          }
          if (requestId && requestId === pendingId && requests[requestId]?.status === 'done') return requests[requestId].result;
        }
        const from = owner(body.from, 'alice');
        const to = owner(body.to, from === 'alice' ? 'bob' : 'alice');
        const asset = selectedAsset(body.asset);
        switch (action) {
          case 'reset':
            if (store) throw new Error('Reset is disabled for persistent engines.');
            pendingCompletion = undefined; await native.close(); await initialize(); activities = []; lastSpend = undefined;
            publicBalances = { alice: { BTC: 0, DEMO: 0 }, bob: { BTC: 0, DEMO: 0 } };
            artifacts = await artifactView(); return { reset: true };
          case 'bootstrap':
            if (network !== 'mutinynet' || !native.bootstrap) throw new Error('Mutinynet bootstrap is unavailable.');
            await native.bootstrap(); persist(); return native.snapshot();
          case 'sync':
            if (network !== 'mutinynet' || !native.refreshFunding) throw new Error('Mutinynet funding sync is unavailable.');
            await native.refreshFunding(); persist(); return native.snapshot();
          case 'shield': return await execute(await kernel.prepareShield(from, asset, amount(body.amount)), `${from} received backed ${asset} notes; waiting for a seal`, undefined, requestId);
          case 'seal': return await execute(await kernel.prepareSeal(), 'Current note root accepted as an anchor; nullifiers preserved', undefined, requestId);
          case 'transfer':
            if (from === to) throw new Error('Choose different sender and recipient wallets');
            return await execute(await kernel.prepareTransfer(from, to, asset, amount(body.amount)), `${from} → ${to}; private ${asset} payment, reserve vault untouched`, undefined, requestId);
          case 'withdraw': {
            const quantity = amount(body.amount);
            return await execute(await kernel.prepareWithdraw(from, asset, quantity, native.destination(from)),
              `${from} received the exact authorized native ${asset} payout`, { owner: from, asset, amount: quantity }, requestId);
          }
          case 'recover': {
            const notes = kernel.recover(from).filter(note => !note.spent);
            const balances = Object.fromEntries(assets.map(a => [a, notes.filter(note => note.asset === a).reduce((sum, note) => sum + note.amount, 0)]));
            add({ type: 'recover', status: 'accepted', summary: `${from}: scanned encrypted records and recovered ${notes.length} unspent notes`, recovery: { noteCount: notes.length, balances } });
            return { noteCount: notes.length, balances };
          }
          case 'replay': {
            if (store) throw new Error('Replay testing is disabled for persistent engines.');
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
            if (store) throw new Error('Tamper testing is disabled for persistent engines.');
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
            if (store) throw new Error('Rebase testing is disabled for persistent engines.');
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
      })();
      activeAction = running;
      try {
        const result = await running;
        if (requestId && requests[requestId]?.status !== 'done') {
          requests[requestId] = { bodyHash, status: 'done', result };
          persist();
        }
        return result;
      } catch (error) {
        if (pendingCompletion?.phase === 'submitted') recoveryError = error instanceof Error ? error.message : String(error);
        if (requestId && !pendingCompletion && !recoveryError) { delete requests[requestId]; persist(); }
        throw error;
      } finally { activeAction = undefined; busy = false; }
    },
  };
}
