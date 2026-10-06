import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { buildBabyjub, buildPoseidon } from 'circomlibjs';
import { Kernel, DOMAIN, type ProtocolEnvironment } from '../packages/protocol/src/core.ts';
import { IndexedNullifiers } from '../packages/protocol/src/indexed-nullifiers.ts';
import { createGroth16ProofBackend } from '../packages/protocol/src/proofs.ts';
import { encodeStockNativeBinding, stockProofDescriptor, stockStatementScalar } from '../packages/protocol/src/stock-native.ts';

const build = join(process.cwd(), 'circuits', 'stock', 'build', process.env.STOCK_COMPILED_DIR ?? 'compiled');
const wasmPath = join(build, 'stock-combined_js', 'stock-combined.wasm');
const wcalcPath = join(build, 'stock-combined_js', 'witness_calculator.js');
const r1csPath = join(build, 'stock-combined.r1cs');
const proof = { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' };
const stockKey = { protocol:'groth16', curve:'bn128', nPublic:1, vk_alpha_1:['1','2','1'], vk_beta_2:[['1','2'],['3','4'],['1','0']], vk_gamma_2:[['1','2'],['3','4'],['1','0']], vk_delta_2:[['1','2'],['3','4'],['1','0']], IC:[['1','2','1'],['3','4','1']] };
const require = createRequire(import.meta.url);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function main() {
 const [poseidon, baby] = await Promise.all([buildPoseidon(), buildBabyjub()]);
 const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));
 let captured: Record<string, any> | undefined;
 const proofs = createGroth16ProofBackend({ prove: async (_circuit, witness) => ({ proof, publicSignals: witness.data as string[] }), verify: async () => true });
 const stockProof = {
  id:'groth16-bn254' as const, version:1 as const,
  describe:(key: unknown, domain: string) => stockProofDescriptor(key, domain),
  prove: async (witness: Record<string, any>) => {
   captured = clone(witness);
   return { proof, publicSignals:[stockStatementScalar(Uint8Array.from(witness.native as number[])).toString()] };
  },
  verify: async () => true,
 };
 const env: ProtocolEnvironment = { randomBytes, vkeys:{}, proofs, stockProof, stockVerifierKey:stockKey, stockOnly:true };
 const client: any = new Kernel(poseidon, baby, env, 'client', 'alice', { spend:'17', view:'19' });
 const calculate = require(wcalcPath);
 const calculator = await calculate(new Uint8Array(await readFile(wasmPath)));
 let checks = 0;
 async function check(label: string, witness: Record<string, any>) {
  witness.nfPredecessor = witness.nfPredecessor.map(String);
  const bytes = await calculator.calculateWTNSBin(witness, 0);
  const path = join(build, `stock-${label}.wtns`);
  await writeFile(path, bytes);
  assert.equal(await snarkjs.wtns.check(r1csPath, path), true);
  const exported = await snarkjs.wtns.exportJson(path) as string[];
  assert.equal(BigInt(exported[1]), stockStatementScalar(Uint8Array.from(witness.native)));
  checks++;
  console.log(`WASM witness satisfies stock R1CS: ${label}`);
 }
 async function reject(label: string, witness: Record<string, any>) {
  try {
   const bytes = await calculator.calculateWTNSBin(witness, 0);
   const path = join(build, `stock-invalid-${label}.wtns`);
   await writeFile(path, bytes);
   assert.notEqual(await snarkjs.wtns.check(r1csPath, path), true);
  } catch (error) {
   if (error instanceof assert.AssertionError) throw error;
  }
  console.log(`WASM witness rejects invalid stock relation: ${label}`);
 }
 async function provePrepared(prepared: any, binding: any, label: string) {
  const envelope = await client.proveStock(prepared, binding);
  assert.ok(captured);
  await check(label, captured!);
  return envelope;
 }
 const binding = (prepared: any, mode: 'deposit'|'transfer'|'seal'|'withdraw', destination?: string, funding=0n) => ({
  mode, checkpointTxidLE:'11'.repeat(32), checkpointVout:checks,
  oldState:prepared.oldState, newState:prepared.newState,
  poolInputBTC:330n + BigInt(prepared.oldState.reserves.BTC),
  continuationBTC:330n + BigInt(prepared.newState.reserves.BTC),
  ...(mode === 'deposit' ? { externalFundingBTC:BigInt(prepared.boundary.deposit.BTC) } : {}),
  ...(mode === 'withdraw' ? { externalFundingBTC:funding, payoutOrChangeBTC:BigInt(prepared.boundary.withdrawal.BTC)+funding, externalProgram:destination } : {}),
 });
 async function commit(prepared: any, envelope: any) { await client.commitStock(prepared, envelope, {accepted:true}); }

 const deposit = await client.prepareStockShield('alice', 'BTC', 100);
 const depositBinding = binding(deposit, 'deposit');
 await provePrepared(deposit, depositBinding, 'deposit');
 const invalidDeposit = clone(captured!); invalidDeposit.native[121]++;
 await reject('native-funding', invalidDeposit);
 const depositEnvelope = await client.proveStock(deposit, depositBinding);
 await commit(deposit, depositEnvelope);

 const seal = await client.prepareStockSeal();
 const sealBinding = binding(seal, 'seal');
 const sealEnvelope = await provePrepared(seal, sealBinding, 'seal');
 await commit(seal, sealEnvelope);

 const transfer = await client.prepareStockTransfer('alice', 'alice', 'BTC', 50);
 const transferBinding = binding(transfer, 'transfer');
 const transferEnvelope = await provePrepared(transfer, transferBinding, 'transfer');
 const invalidNullifier = clone(captured!); invalidNullifier.nfPredecessor[0] = '1';
 await reject('indexed-nullifier-order', invalidNullifier);
 await commit(transfer, transferEnvelope);

 const postTransferSeal = await client.prepareStockSeal();
 const postTransferSealEnvelope = await provePrepared(postTransferSeal, binding(postTransferSeal, 'seal'), 'seal-after-transfer');
 await commit(postTransferSeal, postTransferSealEnvelope);
 const destination = Array.from({length:32}, (_, i) => i.toString(16).padStart(2, '0')).join('');
 const fundedWithdrawal = await client.prepareStockWithdraw('alice', 'BTC', 1, destination);
 const fundedBinding = binding(fundedWithdrawal, 'withdraw', destination, 1n);
 const fundedEnvelope = await provePrepared(fundedWithdrawal, fundedBinding, 'funded-dust-withdraw');
 assert.equal(captured!.native[121], 1);
 const invalidDestination = clone(captured!); invalidDestination.native[137] ^= 1;
 await reject('withdraw-destination-binding', invalidDestination);
 await commit(fundedWithdrawal, fundedEnvelope);

 for (let i = 0; i < 125; i++) {
  const prepared = await client.prepareStockShield('alice', 'BTC', 1);
  const envelope = await client.proveStock(prepared, binding(prepared, 'deposit'));
  await commit(prepared, envelope);
 }
 assert.equal(client.snapshot().state.noteCount, 256);
 const fullSeal = await client.prepareStockSeal();
 const fullSealEnvelope = await provePrepared(fullSeal, binding(fullSeal, 'seal'), 'seal-at-capacity');
 await commit(fullSeal, fullSealEnvelope);
 const duplicateSeal = clone(captured!);
 const oldState = client.snapshot().state;
 const nextHistory = client.historyTree.clone();
 nextHistory.set(oldState.historyCount, hash([DOMAIN, BigInt(oldState.noteRoot)]));
 const newState = { ...clone(oldState), historyRoot:nextHistory.root().toString(), historyCount:oldState.historyCount + 1, revision:oldState.revision + 1 };
 const transitionData = Array(30).fill('0');
 transitionData[0] = DOMAIN.toString(); transitionData[19] = '1';
 transitionData[20] = oldState.noteRoot; transitionData[21] = newState.noteRoot;
 transitionData[22] = oldState.spentRoot; transitionData[23] = newState.spentRoot;
 transitionData[24] = oldState.historyRoot; transitionData[25] = newState.historyRoot;
 transitionData[26] = String(oldState.noteCount); transitionData[27] = String(newState.noteCount);
 transitionData[28] = String(oldState.historyCount); transitionData[29] = String(newState.historyCount);
 const nullifierState = new IndexedNullifiers(hash, client.publicCheckpoint().stockNullifiers);
 const nf = nullifierState.noopWitness();
 duplicateSeal.transitionData = transitionData; duplicateSeal.historyPath = client.historyTree.path(0);
 duplicateSeal.historyIndex = oldState.historyCount; duplicateSeal.sealPath = client.historyTree.path(oldState.historyCount);
 duplicateSeal.nfCount = nf.nfCount; duplicateSeal.nfPredecessorIndex = nf.nfPredecessorIndex;
 duplicateSeal.nfPredecessor = nf.nfPredecessor.map(String); duplicateSeal.nfPredecessorPath = nf.nfPredecessorPath; duplicateSeal.nfAppendPath = nf.nfAppendPath;
 duplicateSeal.lastSealedRoot = oldState.noteRoot; duplicateSeal.lastSealPath = client.historyTree.path(oldState.historyCount - 1);
 duplicateSeal.oldState = [oldState.noteRoot,oldState.spentRoot,oldState.historyRoot,String(oldState.noteCount),String(oldState.historyCount),String(oldState.revision),String(oldState.reserves.BTC),String(oldState.reserves.DEMO)];
 duplicateSeal.newState = [newState.noteRoot,newState.spentRoot,newState.historyRoot,String(newState.noteCount),String(newState.historyCount),String(newState.revision),String(newState.reserves.BTC),String(newState.reserves.DEMO)];
 duplicateSeal.native = Array.from(encodeStockNativeBinding({ mode:'seal', checkpointTxidLE:'33'.repeat(32), checkpointVout:checks, oldState, newState, poolInputBTC:330n + BigInt(oldState.reserves.BTC), continuationBTC:330n + BigInt(newState.reserves.BTC) }, (values)=>hash(values)));
 await reject('duplicate-seal-root', duplicateSeal);

 const fullExitNote = client.recover('alice').find((note: any) => !note.spent && note.spendable);
 assert.ok(fullExitNote);
 const withdrawal = await client.prepareStockWithdraw('alice', 'BTC', fullExitNote.amount, destination);
 const withdrawalEnvelope = await provePrepared(withdrawal, binding(withdrawal, 'withdraw', destination), 'full-withdraw-at-capacity');
 assert.equal(withdrawal.oldState.noteCount, 256);
 assert.equal(withdrawal.newState.noteCount, 256);
 const modeConfused = clone(captured!); modeConfused.native[4] = 0;
 await reject('withdraw-mode-confusion', modeConfused);
 await commit(withdrawal, withdrawalEnvelope);
 assert.equal(checks, 7);
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });