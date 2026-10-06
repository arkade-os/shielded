import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
// @ts-ignore circomlibjs has no declarations.
import { buildBabyjub, buildPoseidon } from 'circomlibjs';
import { Kernel, type ProtocolEnvironment } from '../packages/protocol/src/core.ts';
import { createStockGroth16ProofBackend } from '../packages/protocol/src/stock-proof.ts';
import { stockProofDescriptor, stockStatementScalar, type StockNativeBinding } from '../packages/protocol/src/stock-native.ts';
import type { Groth16Proof, PublicProtocolCheckpoint, StockPreparedSettlement, WalletKeys } from '../packages/protocol/src/types.ts';

const vk={protocol:'groth16',curve:'bn128',nPublic:1,vk_alpha_1:['1','2','1'],vk_beta_2:[['1','2'],['3','4'],['1','0']],vk_gamma_2:[['1','2'],['3','4'],['1','0']],vk_delta_2:[['1','2'],['3','4'],['1','0']],IC:[['1','2','1'],['3','4','1']]};
const proof:Groth16Proof={protocol:'groth16',curve:'bn128',pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['5','6','1']};
const keys:WalletKeys={spend:'17',view:'19'};
async function client(checkpoint?:PublicProtocolCheckpoint){
 let captured:Record<string,unknown>|undefined;
 const stockProof=createStockGroth16ProofBackend({prove:async witness=>{captured=structuredClone(witness);return {proof,publicSignals:[stockStatementScalar(Uint8Array.from(witness.native as number[])).toString()]}},verify:async()=>true});
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);
 const env:ProtocolEnvironment={randomBytes,vkeys:{},stockOnly:true,stockVerifierKey:vk,stockProof};
 const kernel=new Kernel(poseidon,baby,env,'client','alice',keys,undefined);
 if(checkpoint)kernel.restorePublicCheckpoint(checkpoint);
 return {kernel,captured:()=>captured,poseidon};
}
function binding(prepared:StockPreparedSettlement,mode:'deposit'|'transfer'|'withdraw'|'seal',values:{funding?:number;payout?:number;program?:string}={}):StockNativeBinding{
 return {mode,checkpointTxidLE:'42'.repeat(32),checkpointVout:0,oldState:prepared.oldState,newState:prepared.newState,poolInputBTC:330+prepared.oldState.reserves.BTC,continuationBTC:330+prepared.newState.reserves.BTC,...(mode==='deposit'?{externalFundingBTC:values.funding}:{}),...(mode==='withdraw'?{payoutOrChangeBTC:values.payout,externalProgram:values.program}:{})};
}

test('stock-only kernel plans and seals client notes without legacy intent or transition artifacts',async()=>{
 const {kernel,captured}=await client();
 await assert.rejects(kernel.prepareShield('alice','BTC',25),/Use prepareStockShield/);
 const deposit=await kernel.prepareStockShield('alice','BTC',100);assert.equal('intentProof' in deposit,false);assert.equal('transitionProof' in deposit,false);assert.equal(deposit.ciphertextRecords.length,2);
 const depositProof=await kernel.proveStock(deposit,binding(deposit,'deposit',{funding:100}));
 await kernel.commitStock(deposit,depositProof,{accepted:true});assert.equal(kernel.snapshot().state.reserves.BTC,100);assert.equal(kernel.snapshot().encryptedLog.length,2);
 const seal=await kernel.prepareStockSeal(),sealProof=await kernel.proveStock(seal,binding(seal,'seal'));
 assert.equal((captured()?.intentData as string[]).length,25);assert.equal((captured()?.spendSecret as string),'1');
 await kernel.commitStock(seal,sealProof,{accepted:true});assert.equal(kernel.snapshot().state.historyCount,1);
 await assert.rejects(kernel.prepareStockSeal(),/no new notes to anchor/);
});

test('indexed nullifier transition restores from public plan plus proof and allows full withdrawal without adding zero notes',async()=>{
 const first=await client(),deposit=await first.kernel.prepareStockShield('alice','BTC',100),depositProof=await first.kernel.proveStock(deposit,binding(deposit,'deposit',{funding:100}));
 await first.kernel.commitStock(deposit,depositProof,{accepted:true});const seal=await first.kernel.prepareStockSeal(),sealProof=await first.kernel.proveStock(seal,binding(seal,'seal'));await first.kernel.commitStock(seal,sealProof,{accepted:true});
 const withdraw=await first.kernel.prepareStockWithdraw('alice','BTC',100,'ab'.repeat(32));assert.equal(withdraw.newState.noteCount,withdraw.oldState.noteCount);
 const withdrawBinding=binding(withdraw,'withdraw',{payout:100,program:'ab'.repeat(32)}),withdrawProof=await first.kernel.proveStock(withdraw,withdrawBinding);
 const checkpoint=JSON.parse(JSON.stringify(first.kernel.publicCheckpoint())) as PublicProtocolCheckpoint;
 assert.equal(checkpoint.stockNullifiers?.leaves.length,1);
 const restored=await client(checkpoint),restoredPrepared=await restored.kernel.restoreStockPrepared(JSON.parse(JSON.stringify(withdraw)),JSON.parse(JSON.stringify(withdrawProof)));
 assert.equal(restored.kernel.recover('alice')[0].amount,100);
 await assert.rejects(restored.kernel.proveStock(restoredPrepared,withdrawBinding),/private intent witness is unavailable/);
 await restored.kernel.commitStock(restoredPrepared,withdrawProof,{accepted:true});
 assert.equal(restored.kernel.snapshot().state.revision,3);assert.equal(restored.kernel.snapshot().state.noteCount,2);assert.equal(restored.kernel.snapshot().state.reserves.BTC,0);
 assert.equal(restored.kernel.snapshot().nullifiers.length,1);
 const witness=first.captured() as Record<string,unknown>;assert.equal(witness.nfCount,1);assert.equal((witness.nfPredecessorPath as string[]).length,9);assert.equal((witness.nfAppendPath as string[]).length,9);
});

test('empty stock coordinator genesis accepts its first registered client descriptor',async()=>{
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]),stockProof=createStockGroth16ProofBackend({prove:async()=>({proof,publicSignals:['1']}),verify:async()=>true}),env:ProtocolEnvironment={randomBytes,vkeys:{},stockOnly:true,stockVerifierKey:vk,stockProof};
 const coordinator=new Kernel(poseidon,baby,env,'public',undefined,undefined,{}),genesis=JSON.parse(JSON.stringify(coordinator.publicCheckpoint())) as PublicProtocolCheckpoint;
 assert.deepEqual(genesis.recipients,{});
 const owner=await client();coordinator.setRecipients({alice:owner.kernel.publicDescriptor()});assert.equal(Object.keys(coordinator.publicCheckpoint().recipients).length,1);
 const restored=new Kernel(poseidon,baby,env,'public',undefined,undefined,{});restored.restorePublicCheckpoint(genesis);restored.setRecipients({alice:owner.kernel.publicDescriptor()});assert.equal(restored.publicCheckpoint().recipients.alice.owner,owner.kernel.publicDescriptor().owner);
});

test('concurrent stock intent rebases its public records and requires a fresh native proof',async()=>{
 const coordinator=await client(),staleClient=await client();
 const stale=await staleClient.kernel.prepareStockShield('alice','BTC',50);
 const accepted=await coordinator.kernel.prepareStockShield('alice','BTC',100),acceptedBinding=binding(accepted,'deposit',{funding:100});
 const acceptedProof=await coordinator.kernel.proveStock(accepted,acceptedBinding);
 await coordinator.kernel.commitStock(accepted,acceptedProof,{accepted:true});

 staleClient.kernel.restorePublicCheckpoint(JSON.parse(JSON.stringify(coordinator.kernel.publicCheckpoint())) as PublicProtocolCheckpoint);
 const rebased=await staleClient.kernel.rebaseStock(stale);
 assert.deepEqual(rebased.ciphertextRecords.map(({index,createdRevision})=>({index,createdRevision})),[
  {index:2,createdRevision:2},{index:3,createdRevision:2},
 ]);
 assert.equal(rebased.ciphertextRecords[0].commitment,stale.ciphertextRecords[0].commitment);
 assert.equal(rebased.oldState.noteCount,2);
 assert.equal(rebased.newState.noteCount,4);
 const rebasedBinding=binding(rebased,'deposit',{funding:50});
 rebasedBinding.checkpointTxidLE='43'.repeat(32);
 const rebasedProof=await staleClient.kernel.proveStock(rebased,rebasedBinding);
 assert.notEqual(rebasedProof.nativeBinding,acceptedProof.nativeBinding);
 await staleClient.kernel.commitStock(rebased,rebasedProof,{accepted:true});
 assert.deepEqual(staleClient.kernel.snapshot().encryptedLog.map(record=>record.index),[0,1,2,3]);
});

test('full withdrawal remains available after all 256 note slots are occupied',async()=>{
 const {kernel}=await client();
 for(let index=0;index<128;index++){
  const next=await kernel.prepareStockShield('alice','BTC',1),proof=await kernel.proveStock(next,binding(next,'deposit',{funding:1}));await kernel.commitStock(next,proof,{accepted:true});
 }
 const seal=await kernel.prepareStockSeal(),sealProof=await kernel.proveStock(seal,binding(seal,'seal'));await kernel.commitStock(seal,sealProof,{accepted:true});
 assert.equal(kernel.snapshot().state.noteCount,256);
 const exit=await kernel.prepareStockWithdraw('alice','BTC',1,'cd'.repeat(32));assert.equal(exit.newState.noteCount,256);assert.equal(exit.newState.reserves.BTC,127);
});
