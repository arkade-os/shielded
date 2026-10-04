import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
// @ts-ignore circomlibjs has no declarations.
import {buildBabyjub,buildPoseidon} from 'circomlibjs';
import {createGroth16ProofBackend,proofStatement} from '../packages/protocol/src/proofs.ts';
import {createClientProtocol} from '../packages/protocol/src/index.ts';
import {createBrowserClient} from '../packages/protocol/src/browser.ts';
import {DOMAIN,Kernel,type ProtocolEnvironment} from '../packages/protocol/src/core.ts';
import type {Groth16Proof} from '../packages/protocol/src/types.ts';

const proof:Groth16Proof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1'],protocol:'groth16',curve:'bn128'};
const signals=Array.from({length:25},(_,i)=>String(i));

test('Groth16 backend pins relation, verifier, profile and ordered public statement',async()=>{
 let proved=0,verified=0;
 const key={protocol:'groth16',curve:'bn128',nPublic:25,alpha:'fixture'};
 const backend=createGroth16ProofBackend({prove:async()=>{proved++;return {proof,publicSignals:signals};},verify:async(received,publicSignals,receivedProof)=>{verified++;return received===key&&publicSignals.every((value,index)=>value===signals[index])&&receivedProof===proof;}});
 const output=await backend.prove('intent',{},key,'20260930001');
 assert.equal(output.statement.descriptor.backendId,'groth16-bn254');
 assert.equal(output.statement.descriptor.circuitId,'shielded.intent.v1');
 assert.equal(output.statement.descriptor.publicSignalCount,25);
 assert.equal(output.statement.publicSignals[4],'4');
 assert.equal(await backend.verify(output.statement,output.proof,key,'20260930001'),true);
 assert.equal(proved,1);assert.equal(verified,1);
 const reordered={...output.statement,publicSignals:signals.slice().reverse()};
 assert.equal(await backend.verify(reordered,output.proof,key,'20260930001'),false);
 assert.equal(verified,1);
 const reboundOrder=proofStatement(output.statement.descriptor,signals.slice().reverse());
 assert.equal(await backend.verify(reboundOrder,output.proof,key,'20260930001'),false);
 assert.equal(await backend.verify({...output.statement,descriptor:{...output.statement.descriptor,circuitId:'shielded.transition.v1'}},output.proof,key,'20260930001'),false);
 assert.throws(()=>proofStatement(output.statement.descriptor,signals.slice(1)));
 assert.equal(await backend.verify(output.statement,output.proof,{...key,alpha:'other'},'20260930001'),false);
 assert.equal(await backend.verify(output.statement,output.proof,key,'other-domain'),false);
 assert.equal(verified,2);
});

test('Groth16 backend rejects unsupported backend proof shape and noncanonical signals',async()=>{
 const backend=createGroth16ProofBackend({prove:async()=>({proof,publicSignals:signals}),verify:async()=>true});
 const output=await backend.prove('intent',{}, {},'domain');
 assert.equal(await backend.verify({...output.statement,descriptor:{...output.statement.descriptor,backendId:'risc0-groth16'}},proof,{},'domain'),false);
 assert.equal(await backend.verify(output.statement,{...proof,curve:'bls12-381'}, {},'domain'),false);
 assert.equal(await backend.verify({...output.statement,publicSignals:['01',...signals.slice(1)]},proof,{},'domain'),false);
 await assert.rejects(async()=>{
  const bad=createGroth16ProofBackend({prove:async()=>({proof,publicSignals:['01',...signals.slice(1)]}),verify:async()=>true});
  await bad.prove('intent',{}, {},'domain');
 });
});

test('Kernel accepts an injected local Groth16 engine through its pinned backend seam',async()=>{
 const calls:string[]=[];
 const vkeys={intent:{protocol:'groth16',circuit:'intent'},transition:{protocol:'groth16',circuit:'transition'}};
 const proofs=createGroth16ProofBackend({prove:async(circuit,witness)=>{calls.push(circuit);const publicSignals=witness.data as string[];return {proof:{...proof,pi_a:[publicSignals.at(-1)!,proof.pi_a[1],proof.pi_a[2]]},publicSignals};},verify:async(_key,publicSignals,received)=>received.pi_a[0]===publicSignals.at(-1)});
 const env:ProtocolEnvironment={randomBytes,vkeys,proofs};
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);
 const kernel=new Kernel(poseidon,baby,env,'client','alice',{spend:'17',view:'19'});
 const prepared=await kernel.prepareShield('alice','BTC',100);
 assert.deepEqual(calls,['intent','transition']);
 assert.equal(prepared.intentSignals[0],String(DOMAIN));
 assert.equal(await kernel.verify(prepared),true);
 const changed=structuredClone(prepared);changed.intentSignals[24]='0';
 assert.equal(await kernel.verify(changed),false);
});

test('Node and browser protocol factories select an injected proof backend',async()=>{
 const called:string[]=[];
 const backend=()=>createGroth16ProofBackend({prove:async(circuit,witness)=>{called.push(circuit);return {proof,publicSignals:witness.data as string[]};},verify:async()=>true});
 const node=await createClientProtocol({owner:'alice',keys:{spend:'37',view:'41'},proofBackend:backend()});
 await node.prepareShield('alice','BTC',10);
 assert.deepEqual(called,['intent','transition']);
 called.length=0;
 const browser=await createBrowserClient({owner:'alice',keys:{spend:'43',view:'47'},proofBackend:backend()});
 await browser.prepareShield('alice','BTC',10);
 assert.deepEqual(called,['intent','transition']);
});
