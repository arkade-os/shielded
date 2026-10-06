import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
// @ts-ignore circomlibjs has no declarations.
import { buildBabyjub, buildPoseidon } from 'circomlibjs';
import { encodeStockNativeBinding, stockBindingHex, stockProofDescriptor, stockStatementScalar, stockStateCommitment, STOCK_BINDING_BYTES, STOCK_FIELD } from '../packages/protocol/src/stock-native.ts';
import { DOMAIN, Kernel, type ProtocolEnvironment } from '../packages/protocol/src/core.ts';
import { createGroth16ProofBackend } from '../packages/protocol/src/proofs.ts';
import type { Groth16Proof, ProtocolState } from '../packages/protocol/src/types.ts';

const state: ProtocolState = { noteRoot: '1', spentRoot: '2', historyRoot: '3', noteCount: 2, historyCount: 1, revision: 2, reserves: { BTC: 50_000, DEMO: 0 } };
const hash = (values: bigint[]) => values.reduce((acc, value) => (acc * 257n + value) % STOCK_FIELD, 1n);
const binding = () => ({ mode: 'transfer' as const, checkpointTxidLE: '11'.repeat(32), checkpointVout: 7, oldState: state, newState: { ...state, revision: 3 }, poolInputBTC: 50_330n, continuationBTC: 50_330n });

test('stock native binding uses the canonical 201-byte layout and one LE-248 statement scalar', () => {
 const bytes = encodeStockNativeBinding(binding(), hash);
 assert.equal(bytes.length, STOCK_BINDING_BYTES);
 assert.equal(stockBindingHex(bytes).slice(0, 10), '5348010000');
 assert.equal(stockBindingHex(bytes).slice(10, 82), '11'.repeat(32) + '07000000');
 assert.equal(bytes[4], 0);
 const oldStateBytes = Array.from({ length: 32 }, (_, i) => Number((stockStateCommitment(hash, state) >> BigInt(8 * i)) & 255n));
 assert.deepEqual(Array.from(bytes.slice(41, 73)), oldStateBytes);
 const digest = createHash('sha256').update(bytes).digest();
 const expected = BigInt('0x' + Buffer.from(digest.subarray(0,31)).reverse().toString('hex'));
 assert.equal(stockStatementScalar(bytes), expected);
 assert.ok(stockStatementScalar(bytes) < STOCK_FIELD);
 const changed = encodeStockNativeBinding({ ...binding(), checkpointVout: 8 }, hash);
 assert.notEqual(stockStatementScalar(bytes), stockStatementScalar(changed));
});

test('stock state commitment binds all public tree, count, revision, and reserve openings', () => {
 const first = stockStateCommitment(hash, state);
 for (const changed of [
  { ...state, noteRoot: '4' }, { ...state, spentRoot: '4' }, { ...state, historyRoot: '4' },
  { ...state, noteCount: 3 }, { ...state, historyCount: 2 }, { ...state, revision: 3 },
  { ...state, reserves: { BTC: 50_001, DEMO: 0 } }, { ...state, reserves: { BTC: 50_000, DEMO: 1 } },
 ]) assert.notEqual(stockStateCommitment(hash, changed), first);
});

test('stock native binding rejects malformed or unsupported metadata before proving', () => {
 assert.throws(() => encodeStockNativeBinding({ ...binding(), checkpointTxidLE: 'AA'.repeat(32) }, hash), /lowercase hex/);
 assert.throws(() => encodeStockNativeBinding({ ...binding(), checkpointVout: -1 }, hash), /uint32/);
 assert.throws(() => encodeStockNativeBinding({ ...binding(), poolInputBTC: '01' }, hash), /canonical decimal/);
 assert.throws(() => encodeStockNativeBinding({ ...binding(), assetPacket: Uint8Array.of(1) }, hash), /cannot include an asset packet/);
 assert.throws(() => encodeStockNativeBinding({ ...binding(), externalProgram: 'ab' }, hash), /32 lowercase hex bytes/);
});

test('client proves the exact prepared native statement while private witnesses stay local and stale payloads fail closed', async () => {
 const proof: Groth16Proof = { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' };
 const vkeys = { intent: { protocol: 'groth16', circuit: 'intent' }, transition: { protocol: 'groth16', circuit: 'transition' } };
 let captured: Record<string, unknown> | undefined;
 const proofs = createGroth16ProofBackend({ prove: async (_circuit, witness) => ({ proof, publicSignals: witness.data as string[] }), verify: async () => true });
 const stockVerifierKey={protocol:'groth16',curve:'bn128',nPublic:1,vk_alpha_1:['1','2','1'],vk_beta_2:[['1','2'],['3','4'],['1','0']],vk_gamma_2:[['1','2'],['3','4'],['1','0']],vk_delta_2:[['1','2'],['3','4'],['1','0']],IC:[['1','2','1'],['3','4','1']]};
 const env: ProtocolEnvironment = { randomBytes, vkeys, proofs, stockVerifierKey, stockProof: { id:'groth16-bn254',version:1,describe:(key,domain)=>stockProofDescriptor(key,domain),verify:async(envelope,key)=>envelope.descriptorProfileId===stockProofDescriptor(key).profileId&&envelope.statement===stockStatementScalar(Uint8Array.from(Buffer.from(envelope.nativeBinding,'hex'))).toString(),prove: async witness => {
  captured = structuredClone(witness);
  const bytes = Uint8Array.from(witness.native as number[]);
  return { proof, publicSignals: [stockStatementScalar(bytes).toString()] };
 } } };
 const [poseidon,baby] = await Promise.all([buildPoseidon(),buildBabyjub()]);
 const client = new Kernel(poseidon,baby,env,'client','alice',{spend:'17',view:'19'});
 const prepared = await client.prepareShield('alice','BTC',100);
 const metadata = { mode: 'deposit' as const, checkpointTxidLE: '22'.repeat(32), checkpointVout: 0, oldState: prepared.oldState, newState: prepared.newState, poolInputBTC: 330n, continuationBTC: 430n, externalFundingBTC: 100n };
 const envelope = await client.proveStock(prepared,metadata);
 assert.equal(envelope.statement, stockStatementScalar(encodeStockNativeBinding(metadata,(values)=>BigInt(poseidon.F.toObject(poseidon(values))))).toString());
 assert.equal((captured?.spendSecret as string), '17');
 assert.equal((captured?.native as number[]).length, STOCK_BINDING_BYTES);
 assert.doesNotMatch(JSON.stringify(prepared), /spendSecret|recipientPreimage|ephemeral/);
 assert.doesNotMatch(JSON.stringify(client.publicCheckpoint()), /spendSecret|recipientPreimage|ephemeral/);
 assert.doesNotMatch(JSON.stringify(envelope), /spendSecret|recipientPreimage|ephemeral/);
 await assert.rejects(client.proveStock(prepared,{...metadata,externalFundingBTC:99n}),/exact customer funding/);
 const restored = await client.restorePrepared(JSON.parse(JSON.stringify(prepared)));
 await assert.rejects(client.proveStock(restored,metadata),/private intent witness is unavailable/);
 const seal = await client.prepareSeal();
 const sealEnvelope = await client.proveStock(seal,{mode:'seal',checkpointTxidLE:'33'.repeat(32),checkpointVout:1,oldState:seal.oldState,newState:seal.newState,poolInputBTC:330n,continuationBTC:330n});
 assert.equal(sealEnvelope.operation,'seal');
 assert.equal((captured?.intentData as string[]).length,25);
 assert.equal((captured?.spendSecret as string),'1');
 const stale=await client.prepareShield('alice','BTC',50);
 await client.commit(prepared,{accepted:true});
 const staleBinding={...metadata,checkpointTxidLE:'44'.repeat(32),oldState:stale.oldState,newState:stale.newState,poolInputBTC:330n,continuationBTC:380n,externalFundingBTC:50n};
 await assert.rejects(client.proveStock(stale,staleBinding),/Stale stock settlement/);
 const rebased=await client.rebase(stale);
 const rebasedBinding={...staleBinding,checkpointTxidLE:'55'.repeat(32),oldState:rebased.oldState,newState:rebased.newState,poolInputBTC:430n,continuationBTC:480n};
 const rebasedEnvelope=await client.proveStock(rebased,rebasedBinding);
 assert.notEqual(rebasedEnvelope.statement,envelope.statement);
 assert.equal(DOMAIN,20260930001n);
});

test('stock verifier profile rejects wrong public arity and malformed BN254 points', () => {
 const key={protocol:'groth16',curve:'bn128',nPublic:1,vk_alpha_1:['1','2','1'],vk_beta_2:[['1','2'],['3','4'],['1','0']],vk_gamma_2:[['1','2'],['3','4'],['1','0']],vk_delta_2:[['1','2'],['3','4'],['1','0']],IC:[['1','2','1'],['3','4','1']]};
 assert.equal(stockProofDescriptor(key).publicSignalCount,1);
 assert.throws(()=>stockProofDescriptor(key,'different-domain'),/domain is immutable/);
 assert.throws(()=>stockProofDescriptor({...key,nPublic:2}),/one-public-input/);
 assert.throws(()=>stockProofDescriptor({...key,curve:'bls12-381'}),/one-public-input/);
 assert.throws(()=>stockProofDescriptor({...key,IC:[key.IC[0]]}),/one-public-input/);
 assert.throws(()=>stockProofDescriptor({...key,vk_alpha_1:['1','2','0']}),/malformed Groth16 curve points/);
 assert.throws(()=>stockProofDescriptor({...key,vk_alpha_1:['1','2','999999999999999999999999999999999999999999999999999999999999999999999999']}),/malformed Groth16 curve points/);
});
