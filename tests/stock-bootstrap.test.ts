import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CSVMultisigTapscript, MultisigTapscript, SingleKey, Transaction, VtxoScript } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import { buildPoseidon } from 'circomlibjs';
import { stockProofDescriptor } from '../packages/protocol/src/stock-native.ts';
import { createStockBootstrap, type StockBootstrapServices, type StockProfileWeightEvidence } from '../src/stock/bootstrap.ts';
import { offlineNativeFixture } from '../src/sdk/adapter.ts';
import { loadStockProfile, type StockProgramManifest } from '../src/stock/sdk.ts';
import { stockJournalFingerprint } from '../src/stock/journal.ts';
import type { StockArtifactManifest } from '../packages/protocol/src/stock-proof-node.ts';

const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const owner=SingleKey.fromPrivateKey(new Uint8Array(32).fill(9));
const server=SingleKey.fromPrivateKey(new Uint8Array(32).fill(8));
const emulator=SingleKey.fromPrivateKey(new Uint8Array(32).fill(7));
const verifier={protocol:'groth16',curve:'bn128',nPublic:1,vk_alpha_1:['1','2','1'],vk_beta_2:[['3','4'],['5','6'],['1','0']],vk_gamma_2:[['7','8'],['9','10'],['1','0']],vk_delta_2:[['11','12'],['13','14'],['1','0']],IC:[['15','16','1'],['17','18','1']]} as const;
const names=['prepare','abort','transfer','deposit','withdraw','withdraw-funded','seal'] as const;
const programBytes=Object.fromEntries(names.map((name,index)=>[name,hex.encode(Uint8Array.of(0x51+index))])) as Record<typeof names[number],string>;
const programManifest=():StockProgramManifest=>{
 const field=(n:unknown)=>{let value=BigInt(String(n));const bytes=new Uint8Array(32);for(let i=0;i<32;i++){bytes[i]=Number(value&255n);value>>=8n;}return bytes;};
 const g1=(p:readonly string[])=>new Uint8Array([...field(p[0]),...field(p[1])]);
 const g2=(p:readonly (readonly string[])[])=>{const mod=BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');const neg=(value:string)=>field(BigInt(value)===0n?0n:mod-BigInt(value));return new Uint8Array([...field(p[0]![1]),...field(p[0]![0]),...neg(p[1]![1]),...neg(p[1]![0])]);};
 const ic=new Uint8Array([...g1(verifier.IC[0]),...g1(verifier.IC[1])]),fixed=new Uint8Array([...g2(verifier.vk_delta_2),...g2(verifier.vk_gamma_2),...g1(verifier.vk_alpha_1),...g2(verifier.vk_beta_2)]);
 const pairs=Object.entries(programBytes).sort(([a],[b])=>a.localeCompare(b));
 return {version:1,profile:'shielded-stock-btc-v1',domain:'20260930001',publicInputs:1,icPacketHex:hex.encode(ic),fixedKeyPacketHex:hex.encode(fixed),icHashHex:sha(ic),fixedKeyHashHex:sha(fixed),combinedKeyHashHex:sha(new Uint8Array([...ic,...fixed])),programsHashHex:sha(new TextEncoder().encode(JSON.stringify(pairs))),programs:programBytes};
};

async function fixture(options:{throwSubmit?:boolean;throwFinalize?:boolean;publishFailure?:boolean;mutateResponse?:boolean;acceptedLookup?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'shielded-stock-bootstrap-')),releaseRoot=join(root,'release'),artifacts=join(root,'artifacts');mkdirSync(artifacts);
 const artifactFiles={'stock-combined_js/stock-combined.wasm':join(artifacts,'wasm'),'stock-combined.zkey':join(artifacts,'zkey'),'stock-combined.vkey.json':join(artifacts,'vkey'),'stock-combined.manifest.json':join(artifacts,'manifest')};
 const artifactData={'stock-combined.wasm':Buffer.from('public artifact 0'),'stock-combined.zkey':Buffer.from('public artifact 1'),'stock-combined.vkey.json':Buffer.from('public artifact 2')};
 writeFileSync(artifactFiles['stock-combined_js/stock-combined.wasm']!,artifactData['stock-combined.wasm']);if(!options.publishFailure)writeFileSync(artifactFiles['stock-combined.zkey']!,artifactData['stock-combined.zkey']);writeFileSync(artifactFiles['stock-combined.vkey.json']!,artifactData['stock-combined.vkey.json']);
 const programs=programManifest(),descriptor=stockProofDescriptor(verifier),net={network:'mutinynet' as const,arkUrl:'https://mutinynet.arkade.sh',emulatorUrl:'https://emulator.mutinynet.arkade.sh',serverKey:hex.encode(await server.xOnlyPublicKey()),emulatorKey:hex.encode(await emulator.xOnlyPublicKey()),operatorMaxWeight:4000,weightLimit:4000,dust:330,exitDelay:{type:'seconds' as const,value:2048},emulatorVersion:'fixture',nativeAdmission:'unverified' as const};
 const profile=loadStockProfile(programs,verifier,descriptor.profileId,{serverKey:net.serverKey,emulatorKey:net.emulatorKey,exitDelay:net.exitDelay},programs.programsHashHex);
 const proving={version:1,profile:descriptor,artifacts:Object.fromEntries(Object.entries(artifactData).map(([name,data])=>[name,{size:data.byteLength,sha256:sha(data)}])),setup:{phase1:'fixture',phase1Blake2b512:'4'.repeat(128),phase2:'development-only'}} as StockArtifactManifest;writeFileSync(artifactFiles['stock-combined.manifest.json']!,JSON.stringify(proving,null,2)+'\n');
 const checkpointTapscript='51',pin={version:1 as const,network:'mutinynet' as const,networkInfo:net,descriptorProfileId:descriptor.profileId,programsHash:programs.programsHashHex,artifactsHash:stockJournalFingerprint(proving),checkpointHash:sha(hex.decode(checkpointTapscript)),serverKey:net.serverKey,emulatorKey:net.emulatorKey,policyVersion:1 as const,developmentOnly:true};
 const evidenceNames=['prepare','transfer','deposit','withdraw','withdraw-funded','seal','exit-prepare','exit-withdraw','exit-withdraw-funded'] as const;
 const paths=Object.fromEntries(evidenceNames.map(name=>{const isExit=name.startsWith('exit-');return [name,{kind:isExit?'bitcoin-onchain-exit':'arkade-offchain',executed:true,backend:isExit?'pinned-emulator.SubmitOnchainTx':'pinned-emulator.SubmitTx',evidenceHash:sha('qualified:'+name),txWU:1000,checkpointWU:isExit?[]:[1000]}]})) as StockProfileWeightEvidence['paths'];
 const weightEvidence={version:1,network:'mutinynet',qualification:'local-native-service-all-nine',fundedMutinynet:false,nativeAdmission:'unverified',descriptorProfileId:descriptor.profileId,programsHash:programs.programsHashHex,artifactsHash:stockJournalFingerprint(proving),serverKey:net.serverKey,emulatorKey:net.emulatorKey,checkpointHash:sha(hex.decode(checkpointTapscript)),exitDelay:net.exitDelay,targetWeightLimit:net.weightLimit,poolTapTreeHash:sha(profile.tapTree),signatureModel:'64-byte-default-sighash',paths} as StockProfileWeightEvidence;
 const sourceTree=new VtxoScript([MultisigTapscript.encode({pubkeys:[await owner.xOnlyPublicKey(),await server.xOnlyPublicKey()]}).script]);
 const funding=offlineNativeFixture([{script:sourceTree.pkScript,amount:10000n}]);
 const input={txid:funding.id,vout:0,value:10000,sourceTxHex:hex.encode(funding.toBytes()),tapTreeHex:hex.encode(sourceTree.encode()),leafHex:hex.encode(sourceTree.scripts[0]!)};
 const db:{value:unknown}={value:undefined};const store={load:<T>()=>db.value===undefined?undefined:structuredClone(db.value as T),save:(value:unknown)=>{db.value=structuredClone(value);}};
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
 const backend={id:'groth16-bn254' as const,version:1 as const,describe:stockProofDescriptor,prove:async()=>{throw new Error('not needed for empty genesis');},verify:async()=>true};
 const counters={submit:0,lookup:0,finalize:0,indexed:0,publish:0};let accepted: any;let isIndexed=false,currentInput:typeof input|undefined=input;
 const weightOk:StockProfileWeightEvidence=weightEvidence;
 const services:StockBootstrapServices={store,pin,proving,checkpointTapscript,weightEvidence:weightOk,profile,programs,backend,identity:owner,ownerKey:hex.encode(await owner.xOnlyPublicKey()),input:async(point)=>point===`${input.txid}:0`?currentInput:undefined,changeScript:sourceTree.pkScript,checkpoint:CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[await server.xOnlyPublicKey()]}),hash,releaseRoot,artifactFiles,
  submit:async(request)=>{counters.submit++;const journal=store.load<any>();assert.equal(journal.stage,'submit-started');assert.equal(journal.approvedReleaseFingerprint,services.expectedReleaseFingerprint);const original=Transaction.fromPSBT(base64.decode(request.arkTx));let arkUnsigned=original;if(options.mutateResponse){arkUnsigned=Transaction.fromRaw(original.unsignedTx);arkUnsigned.updateInput(0,{witnessUtxo:original.getInput(0).witnessUtxo,tapLeafScript:original.getInput(0).tapLeafScript});arkUnsigned.updateOutput(0,{amount:329n});}const ark=await server.sign(arkUnsigned,[0]);const cps=await Promise.all(request.checkpoints.map(async(encoded)=>server.sign(Transaction.fromPSBT(base64.decode(encoded)),[0])));accepted={arkTxid:original.id,finalArkTx:base64.encode(ark.toPSBT()),signedCheckpointTxs:cps.map(tx=>base64.encode(tx.toPSBT()))};if(options.throwSubmit)throw new Error('submit outcome unknown');return accepted;},
  lookup:async()=>{counters.lookup++;return options.acceptedLookup?accepted:undefined;},
  finalize:async()=>{counters.finalize++;const saved=store.load<any>();assert.equal(saved.stage,'finalize-started');assert.ok(saved.receipt);if(options.throwFinalize)throw new Error('finalize outcome unknown');isIndexed=true;},
  indexed:async()=>{counters.indexed++;return isIndexed;}};
 return {services,counters,input,store,accepted:()=>accepted,makeEngine:()=>createStockBootstrap(services),setIndexed:()=>{isIndexed=true;},setInput:(value:typeof input|undefined)=>{currentInput=value;},root,artifactFiles,cleanup:()=>rmSync(root,{recursive:true,force:true}),setIndexedState:(value:boolean)=>{isIndexed=value;}};
}

test('bootstrap journals the exact coin before Submit and verified signed receipt before Finalize',async()=>{
 const f=await fixture(),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);assert.equal(engine.status().phase,'planned');assert.equal(plan.poolValue,330);assert.equal(f.counters.submit,0);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;
 try{const result=await engine.apply(plan.outpoint);assert.equal(f.counters.submit,1);assert.equal(f.counters.finalize,1);assert.equal(result.phase,'indexed');assert.equal(engine.status().phase,'indexed');const deployment=JSON.parse(readFileSync(join((result as any).releaseDirectory,'deployment.json'),'utf8'));assert.deepEqual(Object.keys(deployment).sort(),['checkpointTapscript','genesis','pin','programs','proving','version'].sort());}finally{f.cleanup();}
});

test('bootstrap rejects incomplete, wrongly bound, or over-cap local qualification before Submit',async()=>{
 for(const mutate of [
  (e:StockProfileWeightEvidence)=>{delete (e.paths as any)['exit-withdraw-funded'];},
  (e:StockProfileWeightEvidence)=>{e.artifactsHash='f'.repeat(64);},
  (e:StockProfileWeightEvidence)=>{e.paths['exit-withdraw'].checkpointWU=[1];},
  (e:StockProfileWeightEvidence)=>{e.paths.deposit.txWU=4001;},
  (e:StockProfileWeightEvidence)=>{e.paths.withdraw.backend='pinned-emulator.SubmitOnchainTx';},
  (e:StockProfileWeightEvidence)=>{e.nativeAdmission='accepted' as any;},
 ]){
  const f=await fixture(),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;mutate(f.services.weightEvidence!);
  try{await assert.rejects(engine.apply(plan.outpoint),/qualification|all-nine|native-service|immutable stock covenant|CSV exit|4000 WU/i);assert.equal(f.counters.submit,0,'invalid local evidence reached the operator');}
  finally{f.cleanup();}
 }
});

test('unknown submit is reconciled read-only and never resubmitted or switched to another coin',async()=>{
 const f=await fixture({throwSubmit:true}),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;try{await assert.rejects(engine.apply(plan.outpoint),/submit outcome unknown/);assert.equal(engine.status().phase,'unknown-submit');
 await assert.rejects(engine.apply('f'.repeat(64)+':0'),/exact journaled customer outpoint/);await assert.rejects(engine.apply(plan.outpoint),/outcome is unresolved/);assert.equal(f.counters.submit,1);}finally{f.cleanup();}
});

test('lost Submit can recover only its accepted response by exact identity, then explicit apply finalizes without resubmission',async()=>{
 const f=await fixture({throwSubmit:true,acceptedLookup:true}),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;try{
  await assert.rejects(engine.apply(plan.outpoint),/submit outcome unknown/);const restarted=await f.makeEngine();assert.equal(restarted.status().phase,'unknown-submit');const recovered=await restarted.reconcile();assert.equal(recovered.phase,'response-verified');assert.equal(f.counters.lookup,1);assert.equal(f.counters.finalize,0);assert.equal(f.counters.submit,1);
  const finalized=await restarted.apply(plan.outpoint);assert.equal(finalized.phase,'indexed');assert.equal(f.counters.submit,1);assert.equal(f.counters.finalize,1);
 }finally{f.cleanup();}
});

test('apply rejects a changed live coin and missing independent release approval before Submit',async()=>{
 const f=await fixture(),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);try{
  await assert.rejects(engine.apply(plan.outpoint),/independently approved immutable release fingerprint/);assert.equal(f.counters.submit,0);
  f.services.expectedReleaseFingerprint=plan.releaseFingerprint;f.setInput(undefined);await assert.rejects(engine.apply(plan.outpoint),/exact journaled customer coin is no longer identical/);assert.equal(f.counters.submit,0);
 }finally{f.cleanup();}
});

test('tampered operator body is rejected and cannot reach Finalize',async()=>{
 const f=await fixture({mutateResponse:true}),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;try{await assert.rejects(engine.apply(plan.outpoint),/operator changed the exact submitted transaction body/);assert.equal(engine.status().phase,'unknown-submit');assert.equal(f.counters.finalize,0);}finally{f.cleanup();}
});

test('partial immutable release publication resumes by verifying existing bytes without overwriting',async()=>{
 const f=await fixture({publishFailure:true}),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;try{
  await assert.rejects(engine.apply(plan.outpoint),/publishing is incomplete/);assert.equal(engine.status().phase,'indexed');assert.equal(f.counters.submit,1);assert.equal(f.counters.finalize,1);
  const fingerprint=stockJournalFingerprint({version:1,network:'mutinynet',descriptorProfileId:f.services.pin.descriptorProfileId,programsHash:f.services.pin.programsHash,artifactsHash:f.services.pin.artifactsHash,checkpointHash:f.services.pin.checkpointHash,genesisTxid:plan.txid,serverKey:f.services.pin.serverKey,emulatorKey:f.services.pin.emulatorKey}),wasmPath=join(f.services.releaseRoot,fingerprint,'stock-combined_js','stock-combined.wasm'),before=readFileSync(wasmPath);
  writeFileSync(f.artifactFiles['stock-combined.zkey']!,'public artifact 1');const result=await engine.reconcile();assert.equal(result.phase,'indexed');assert.equal(f.counters.submit,1);assert.deepEqual(readFileSync(wasmPath),before);assert.ok(readFileSync(join(f.services.releaseRoot,fingerprint,'deployment.json'),'utf8').includes('"genesis"'));
 }finally{f.cleanup();}
});

test('changed proving artifact bytes cannot be published after acceptance',async()=>{
 const f=await fixture(),engine=await f.makeEngine(),plan=await engine.plan(`${f.input.txid}:0`);f.services.expectedReleaseFingerprint=plan.releaseFingerprint;try{
  writeFileSync(f.artifactFiles['stock-combined.zkey']!,'changed artifact');await assert.rejects(engine.apply(plan.outpoint),/publishing is incomplete/);
  assert.equal(engine.status().phase,'indexed');assert.equal(f.counters.submit,1);assert.equal(f.counters.finalize,1);
  writeFileSync(f.artifactFiles['stock-combined.zkey']!,'public artifact 1');const resumed=await engine.reconcile();assert.equal(resumed.phase,'indexed');assert.equal(f.counters.submit,1);assert.equal(f.counters.finalize,1);
 }finally{f.cleanup();}
});
