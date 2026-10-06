import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {base64,hex} from '@scure/base';
import {RawWitness,TaprootControlBlock} from '@scure/btc-signer';
import {tapLeafHash} from '@scure/btc-signer/payment.js';
import {CSVMultisigTapscript,EmulatorPacket,Extension,MultisigTapscript,PrevoutTxField,RestArkProvider,SingleKey,Transaction,UnknownPacket,VtxoScript,setArkPsbtField,verifyTapscriptSignatures} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import {createClientProtocol,createPublicProtocol} from '../packages/protocol/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {signParticipantRegistration} from '../packages/protocol/src/registration.ts';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../packages/protocol/src/stock-proof-node.ts';
import {stockStateCommitment,type StockSettlementProof} from '../packages/protocol/src/stock-native.ts';
import type {StockPreparedSettlement} from '../packages/protocol/src/types.ts';
import {createStockCoordinator,type StockPublicArchive,type StockPublicFunding} from '../src/stock/coordinator.ts';
import {stockJournalFingerprint} from '../src/stock/journal.ts';
import {loadStockProfile,buildStockSpend,planStockSpend,stockVmRequest,stockProofWitnessOrder,type StockProgramManifest,type StockSpendRequest,type StockExitLeaf} from '../src/stock/sdk.ts';
import {verifyStockResponse,stockSignedWeights,type StockWireRequest} from '../src/stock/transport.ts';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {executeVmBinary} from '../src/sdk/runtime.ts';
import {preflightStockMutinynet,type StockNetworkInfo} from '../src/stock/network.ts';
import {loadStockInstallConfig} from '../src/stock/config.ts';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';
import type {StockProfileWeightEvidence,StockQualificationPath,StockQualificationPathEvidence} from '../src/stock/bootstrap.ts';

const root=process.cwd(),localOnly=process.argv.includes('--local-only'),installation=process.argv.includes('--installation'),installConfig=installation?loadStockInstallConfig():undefined,artifactDirectory=resolve(process.env.SHIELDED_STOCK_ARTIFACTS??'circuits/stock/build/compiled');
if(installation&&localOnly)throw new Error('Installation qualification cannot use synthetic local-only network metadata.');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const manifest=JSON.parse(await readFile(join(artifactDirectory,'stock-combined.manifest.json'),'utf8')) as StockArtifactManifest;
const loaded=await loadStockProofArtifacts(artifactDirectory,manifest),binary=resolve('bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm');
const programs=JSON.parse(execFileSync(binary,['--stock-build',join(artifactDirectory,'stock-combined.vkey.json')],{encoding:'utf8',windowsHide:true})) as StockProgramManifest;
const server=SingleKey.fromHex('01'.repeat(32)),emulator=SingleKey.fromHex('02'.repeat(32));
const network:StockNetworkInfo={network:'mutinynet',arkUrl:'synthetic-native-service',emulatorUrl:'synthetic-native-service',serverKey:hex.encode(await server.xOnlyPublicKey()),emulatorKey:hex.encode(await emulator.xOnlyPublicKey()),operatorMaxWeight:4000,weightLimit:4000,dust:330,exitDelay:{type:'seconds',value:2048},emulatorVersion:'local-pinned-Service',nativeAdmission:'unverified'};
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[await server.xOnlyPublicKey()],timelock:{type:'seconds',value:4096n}}),checkpointTapscript=hex.encode(checkpoint.script);
const targetNetwork=localOnly?network:await preflightStockMutinynet(installConfig?{arkUrl:installConfig.network.arkUrl,emulatorUrl:installConfig.network.emulatorUrl,indexerUrl:installConfig.network.indexerUrl}:{});
const targetInfo=localOnly?undefined:await new RestArkProvider(targetNetwork.arkUrl).getInfo();
const targetCheckpoint=targetInfo?validateStockCheckpoint(targetInfo.checkpointTapscript,targetInfo.forfeitPubkey):checkpoint;
const targetCheckpointTapscript=hex.encode(targetCheckpoint.script);
const profile=loadStockProfile(programs,loaded.verifierKey,loaded.descriptor.profileId,network,programs.programsHashHex),targetProfile=loadStockProfile(programs,loaded.verifierKey,loaded.descriptor.profileId,targetNetwork,programs.programsHashHex);
const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
const kernel=await createPublicProtocol({recipients:{},stockOnly:true,stockProofBackend:loaded.backend,stockVerifierKey:loaded.verifierKey}),protocol=kernel.publicCheckpoint();
let n=stockStateCommitment(hash,protocol.state);const stateBytes=new Uint8Array(32);for(let i=0;i<32;i++){stateBytes[i]=Number(n&255n);n>>=8n;}
const genesis=offlineNativeFixture([{script:profile.vtxo.pkScript,amount:330n}],[new UnknownPacket(0x87,stateBytes),new UnknownPacket(0x88,Uint8Array.of(17))]);
const initial:StockPublicArchive={version:1,protocol,participants:{},head:{txid:genesis.id,vout:0,value:330,sourceTxHex:hex.encode(genesis.toBytes())},phase:17,history:[]};
const pin={version:1 as const,network:'local-stock' as const,descriptorProfileId:profile.descriptorProfileId,programsHash:profile.programsHashHex,artifactsHash:stockJournalFingerprint(manifest),checkpointHash:sha(checkpoint.script),genesisTxid:genesis.id,serverKey:network.serverKey,emulatorKey:network.emulatorKey};
const directory=await mkdtemp(join(tmpdir(),'shielded-stock-qualification-'));
const paths={} as Record<StockQualificationPath,StockQualificationPathEvidence>;
const samples:Record<string,{localWU:number;targetWU:number;checkpointWU:number[]}>={};
const accepted=new Map<string,ReturnType<typeof verifyStockResponse>>();
const transport={submit:async(request:StockWireRequest)=>{
 const result=await executeVmBinary(binary,request);assert.equal(result.ok,true,result.error);
 const signedArkTx=base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(result.arkTx!)))).toPSBT());
 const signedCheckpointTxs=await Promise.all(result.checkpoints!.map(async value=>base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(value)))).toPSBT())));
 const receipt=verifyStockResponse(request,{signedArkTx,signedCheckpointTxs},network);accepted.set(receipt.txid,receipt);return receipt;
},lookup:async(request:StockWireRequest)=>accepted.get(Transaction.fromPSBT(base64.decode(request.arkTx)).id)};
const coordinator=await createStockCoordinator({directory,pin,profile,network,checkpointTapscript,initialArchive:initial,backend:loaded.backend,hash,transport});
let coinCounter=0;
async function party(label:string){
 const material=deriveWalletKeyMaterial(createHash('sha256').update('stock-profile-qualification:'+label).digest(),'mutinynet'),identity=SingleKey.fromHex(material.nativeSecret),owner=hex.encode(await identity.xOnlyPublicKey());
 const client=await createClientProtocol({owner,keys:material.keys,stockOnly:true,stockProofBackend:loaded.backend,stockVerifierKey:loaded.verifierKey});
 await coordinator.register(signParticipantRegistration({network:'mutinynet',profile:coordinator.registrationProfile,secretKey:material.nativeSecret,recipient:client.publicDescriptor()}));
 const forfeit=MultisigTapscript.encode({pubkeys:[await identity.xOnlyPublicKey(),await server.xOnlyPublicKey()]}).script,exit=CSVMultisigTapscript.encode({pubkeys:[await identity.xOnlyPublicKey()],timelock:{type:'seconds',value:2048n}}).script,tree=new VtxoScript([forfeit,exit]);
 const targetForfeit=MultisigTapscript.encode({pubkeys:[await identity.xOnlyPublicKey(),hex.decode(targetNetwork.serverKey)]}).script,targetTree=new VtxoScript([targetForfeit,exit]);
 return {identity,owner,client,tree,forfeit,exit,targetTree,targetForfeit};
}
const parties:Awaited<ReturnType<typeof party>>[]=[];
function sync(){const archive=coordinator.archive();for(const p of parties){p.client.setRecipients(archive.protocol.recipients);p.client.restorePublicCheckpoint(archive.protocol);}return archive;}
function funding(p:typeof parties[number],value:number):StockPublicFunding{
 const source=offlineNativeFixture([{script:p.tree.pkScript,amount:BigInt(value)}],[],{txid:sha('qualification-funding:'+ ++coinCounter),vout:0});
 return {txid:source.id,vout:0,value,sourceTxHex:hex.encode(source.toBytes()),tapTreeHex:hex.encode(p.tree.encode()),leafHex:hex.encode(p.forfeit)};
}
function project(request:StockWireRequest,operation:Exclude<StockQualificationPath,StockExitLeaf>,p?:typeof parties[number]){
 const originalArk=Transaction.fromPSBT(base64.decode(request.arkTx)),originalCps=request.checkpoints.map(value=>Transaction.fromPSBT(base64.decode(value)));
 const ark=new Transaction({version:originalArk.version,lockTime:originalArk.lockTime,allowUnknownOutputs:true}),cps:Transaction[]=[];
 for(let vin=0;vin<originalArk.inputsLength;vin++){
  const closure=vin===0?targetProfile.closures[operation]:p!.targetForfeit,tree=vin===0?targetProfile.vtxo:p!.targetTree,cpTree=new VtxoScript([targetCheckpoint.script,closure]);
  const a=originalArk.getInput(vin),c=originalCps[vin].getInput(0),cp=new Transaction({version:originalCps[vin].version,lockTime:originalCps[vin].lockTime,allowUnknownOutputs:true});
  ark.addInput({txid:a.txid!,index:a.index!,sequence:a.sequence!,witnessUtxo:{amount:a.witnessUtxo!.amount,script:cpTree.pkScript},tapLeafScript:[cpTree.findLeaf(hex.encode(closure))]});
  cp.addInput({txid:c.txid!,index:c.index!,sequence:c.sequence!,witnessUtxo:{amount:c.witnessUtxo!.amount,script:tree.pkScript},tapLeafScript:[tree.findLeaf(hex.encode(closure))]});
  for(let i=0;i<originalCps[vin].outputsLength;i++){const output=originalCps[vin].getOutput(i);cp.addOutput({amount:output.amount!,script:i===0?cpTree.pkScript:output.script!});}cps.push(cp);
 }
 for(let i=0;i<originalArk.outputsLength;i++){const output=originalArk.getOutput(i);let script=output.script!;if(hex.encode(script)===hex.encode(profile.vtxo.pkScript))script=targetProfile.vtxo.pkScript;else if(p&&hex.encode(script)===hex.encode(p.tree.pkScript))script=p.targetTree.pkScript;ark.addOutput({amount:output.amount!,script});}
 return stockSignedWeights({arkTx:base64.encode(ark.toPSBT()),checkpoints:cps.map(tx=>base64.encode(tx.toPSBT()))},true);
}
function record(operation:Exclude<StockQualificationPath,StockExitLeaf>,request:StockWireRequest,receipt:ReturnType<typeof verifyStockResponse>,p?:typeof parties[number]){
 const projected=project(request,operation,p);assert.ok(projected.ark<=targetNetwork.weightLimit&&projected.checkpoints.every(w=>w<=targetNetwork.weightLimit));
 paths[operation]={kind:'arkade-offchain',executed:true,backend:'pinned-emulator.SubmitTx',evidenceHash:sha(JSON.stringify({request,receipt,projected})),txWU:projected.ark,checkpointWU:projected.checkpoints};
 samples[operation]={localWU:receipt.weights.ark,targetWU:projected.ark,checkpointWU:projected.checkpoints};console.log('Qualified '+operation+': '+projected.ark+' WU');
}
async function prepare(){const prior=coordinator.archive().history.length;await coordinator.prepare();const entry=coordinator.archive().history[prior];record('prepare',entry.request,entry.receipt);sync();}
async function apply(p:typeof parties[number],prepared:StockPreparedSettlement,externalFunding?:StockPublicFunding){
 await prepare();const archive=coordinator.archive(),externalProgram=prepared.operation==='withdraw'?hex.encode(p.tree.pkScript.subarray(2)):undefined,draft=coordinator.draft(prepared,externalFunding,externalProgram),proof=await p.client.proveStock(prepared,draft.nativeBinding!);
 const operation=prepared.operation==='shield'?'deposit':prepared.operation==='withdraw'&&externalFunding?'withdraw-funded':prepared.operation;
 const request:StockSpendRequest={profile,operation,pool:{...archive.head,sourceTx:hex.decode(archive.head.sourceTxHex)},oldState:prepared.oldState,newState:prepared.newState,checkpoint,hash,weightLimit:4000,...(externalFunding?{externalFunding:{...externalFunding,sourceTx:hex.decode(externalFunding.sourceTxHex),tapTree:hex.decode(externalFunding.tapTreeHex),tapLeafScript:p.tree.findLeaf(externalFunding.leafHex)}}:{}),...(externalProgram?{externalProgram,payoutBTC:prepared.boundary.withdrawal.BTC+(externalFunding?.value??0)}:{})};
 const spend=buildStockSpend(request,proof,draft);if(externalFunding){spend.arkTx=await p.identity.sign(spend.arkTx,[1]);spend.checkpoints[1]=await p.identity.sign(spend.checkpoints[1],[0]);}
 spend.arkTxPsbt=base64.encode(spend.arkTx.toPSBT());spend.checkpointPsbts=spend.checkpoints.map(tx=>base64.encode(tx.toPSBT()));const wire=stockVmRequest(spend),result=await coordinator.submit(prepared,proof,externalFunding,wire);record(operation,wire,result.receipt,p);sync();
}
async function seal(){const before=coordinator.archive().history.length;await coordinator.seal();const entries=coordinator.archive().history.slice(before);for(const entry of entries){record(entry.operation as 'prepare'|'seal',entry.request,entry.receipt);}sync();}
function direct(template:Transaction,source:Transaction,sourceVout:number,leaf:StockExitLeaf,p?:typeof parties[number],external?:StockPublicFunding,proof?:StockSettlementProof){
 const tx=new Transaction({version:2,allowUnknownOutputs:true});const delay=0x400000+network.exitDelay.value/512;
 tx.addInput({txid:source.id,index:sourceVout,sequence:delay,witnessUtxo:{amount:source.getOutput(sourceVout).amount!,script:source.getOutput(sourceVout).script!},tapLeafScript:[profile.vtxo.findLeaf(hex.encode(profile.exitTapscripts[leaf]))]});setArkPsbtField(tx,0,PrevoutTxField,source.toBytes(true,true));
 if(external){const parent=Transaction.fromRaw(hex.decode(external.sourceTxHex));tx.addInput({txid:parent.id,index:external.vout,sequence:delay,witnessUtxo:{amount:parent.getOutput(external.vout).amount!,script:parent.getOutput(external.vout).script!},tapLeafScript:[p!.tree.findLeaf(hex.encode(p!.exit))]});setArkPsbtField(tx,1,PrevoutTxField,parent.toBytes(true,true));}
 for(let i=0;i<template.outputsLength;i++){const output=template.getOutput(i);if(Extension.isExtension(output.script!)){
  const packets=Extension.fromTx(template).getPackets().filter(packet=>packet.type()!==EmulatorPacket.PACKET_TYPE);
  const script=leaf==='exit-prepare'?profile.scripts.prepare:leaf==='exit-withdraw'?profile.scripts.withdraw:profile.scripts['withdraw-funded'];
  const ext=Extension.create([EmulatorPacket.create([{vin:0,script,witness:RawWitness.encode(proof?stockProofWitnessOrder(proof):[])}]),...packets]);tx.addOutput(ext.txOut());
 }else tx.addOutput(output);}
 return tx;
}
function exitWeight(tx:Transaction,target=false,p?:typeof parties[number],leaf?:StockExitLeaf){
 const result=Transaction.fromPSBT(tx.toPSBT());
 for(let vin=0;vin<result.inputsLength;vin++){
  const input=result.getInput(vin),selected=target?(vin===0?targetProfile.vtxo.findLeaf(hex.encode(targetProfile.exitTapscripts[leaf!])):p!.targetTree.findLeaf(hex.encode(p!.exit))):input.tapLeafScript![0],script=selected[1].subarray(0,-1),keys=CSVMultisigTapscript.decode(script).params.pubkeys,leafHash=tapLeafHash(script,selected[1].at(-1)!);
  const signatures=keys.slice().reverse().map(key=>{const value=input.tapScriptSig?.find(([entry])=>hex.encode(entry.pubKey)===hex.encode(key)&&hex.encode(entry.leafHash)===hex.encode(leafHash))?.[1];if(!target)assert.equal(value?.length,64);return target?new Uint8Array(64):value!;});
  result.updateInput(vin,{finalScriptWitness:[...signatures,script,TaprootControlBlock.encode(selected[0])]});
 }
 return result.toBytes(true,true).length+3*result.toBytes(false,false).length;
}
try{
 const alice=await party('alice'),bob=await party('bob');parties.push(alice,bob);sync();
 await apply(alice,await alice.client.prepareStockShield(alice.owner,'BTC',1500),funding(alice,1500));await seal();
 await apply(alice,await alice.client.prepareStockTransfer(alice.owner,bob.owner,'BTC',500));await seal();
 await apply(bob,await bob.client.prepareStockWithdraw(bob.owner,'BTC',330,hex.encode(bob.tree.pkScript.subarray(2))));await seal();
 await apply(bob,await bob.client.prepareStockWithdraw(bob.owner,'BTC',1,hex.encode(bob.tree.pkScript.subarray(2))),funding(bob,330));await seal();
 const archive=sync(),source=Transaction.fromRaw(hex.decode(archive.head.sourceTxHex));
 const base:StockSpendRequest={profile,operation:'prepare',pool:{...archive.head,sourceTx:hex.decode(archive.head.sourceTxHex)},oldState:archive.protocol.state,newState:archive.protocol.state,checkpoint,hash};
 const preparedTemplate=buildStockSpend(base).arkTx,exitPrepare=direct(preparedTemplate,source,archive.head.vout,'exit-prepare');
 const cases:{name:StockExitLeaf;psbt:string;party?:typeof alice}[]=[{name:'exit-prepare',psbt:base64.encode(exitPrepare.toPSBT())}];
 for(const funded of [false,true]){
  const prepared=await alice.client.prepareStockWithdraw(alice.owner,'BTC',funded?1:330,hex.encode(alice.tree.pkScript.subarray(2))),external=funded?funding(alice,330):undefined,operation=funded?'withdraw-funded' as const:'withdraw' as const;
  const request:StockSpendRequest={...base,operation,pool:{txid:exitPrepare.id,vout:0,value:Number(exitPrepare.getOutput(0).amount),sourceTx:exitPrepare.toBytes()},oldState:prepared.oldState,newState:prepared.newState,externalProgram:hex.encode(alice.tree.pkScript.subarray(2)),payoutBTC:prepared.boundary.withdrawal.BTC+(external?.value??0),...(external?{externalFunding:{...external,sourceTx:hex.decode(external.sourceTxHex),tapTree:hex.decode(external.tapTreeHex),tapLeafScript:alice.tree.findLeaf(external.leafHex)}}:{})};
  const draft=planStockSpend(request),binding={...draft.nativeBinding!,checkpointTxidLE:hex.encode(Uint8Array.from(hex.decode(exitPrepare.id)).reverse()),checkpointVout:0};
  const proof=await alice.client.proveStock(prepared,binding),template=Transaction.fromPSBT(base64.decode(draft.arkTxPsbt));
  let tx=direct(template,exitPrepare,0,funded?'exit-withdraw-funded':'exit-withdraw',alice,external,proof);if(external)tx=await alice.identity.sign(tx,[1]);
  cases.push({name:funded?'exit-withdraw-funded':'exit-withdraw',psbt:base64.encode(tx.toPSBT()),party:alice});
 }
 const input=join(directory,'onchain-cases.json');await writeFile(input,JSON.stringify({cases:cases.map(({name,psbt})=>({name,psbt}))}));
 const gateBinary=resolve(root,'bin',process.platform==='win32'?'stock-onchain-qualification.exe':'stock-onchain-qualification');
 const output=installation?execFileSync(gateBinary,['-test.run=^TestStockOnchainGateHarness$','-test.count=1','-test.v'],{cwd:root,env:{...process.env,SHIELDED_STOCK_ONCHAIN_GATE_INPUT:input},encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}):execFileSync('go',['test','-run','^TestStockOnchainGateHarness$','-count=1','-v'],{cwd:join(root,'tools/vm'),env:{...process.env,SHIELDED_STOCK_ONCHAIN_GATE_INPUT:input},encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
 const line=output.split(/\r?\n/).find(value=>value.startsWith('STOCK_ONCHAIN_GATE_RESULT='));assert.ok(line,'Pinned native Service returned no exit receipts');
 const result=JSON.parse(line.slice('STOCK_ONCHAIN_GATE_RESULT='.length));
 for(const item of cases){const receipt=result.cases.find((entry:any)=>entry.name===item.name);assert.equal(receipt?.ok,true);const signed=Transaction.fromPSBT(base64.decode(receipt.signedPsbt)),submitted=Transaction.fromPSBT(base64.decode(item.psbt));assert.equal(signed.id,submitted.id);assert.deepEqual(signed.unsignedTx,submitted.unsignedTx);
  for(let vin=0;vin<signed.inputsLength;vin++){const selected=signed.getInput(vin).tapLeafScript![0],original=submitted.getInput(vin);assert.deepEqual(selected,original.tapLeafScript![0]);assert.deepEqual(signed.getInput(vin).witnessUtxo,original.witnessUtxo);const script=selected[1].subarray(0,-1),keys=CSVMultisigTapscript.decode(script).params.pubkeys;verifyTapscriptSignatures(signed,vin,keys.map(hex.encode),[],undefined,tapLeafHash(script,selected[1].at(-1)!));}
  const localWU=exitWeight(signed),targetWU=exitWeight(signed,true,item.party,item.name);assert.ok(localWU<=4000&&targetWU<=4000);paths[item.name]={kind:'bitcoin-onchain-exit',executed:true,backend:'pinned-emulator.SubmitOnchainTx',evidenceHash:sha(JSON.stringify({submitted:item.psbt,signed:receipt.signedPsbt,targetWU})),txWU:targetWU,checkpointWU:[]};samples[item.name]={localWU,targetWU,checkpointWU:[]};console.log('Qualified '+item.name+': '+targetWU+' WU');
 }
 assert.equal(Object.keys(paths).length,9);
 const evidence:StockProfileWeightEvidence={version:1,network:'mutinynet',qualification:'local-native-service-all-nine',fundedMutinynet:false,nativeAdmission:'unverified',descriptorProfileId:targetProfile.descriptorProfileId,programsHash:targetProfile.programsHashHex,artifactsHash:stockJournalFingerprint(manifest),serverKey:targetNetwork.serverKey,emulatorKey:targetNetwork.emulatorKey,checkpointHash:sha(targetCheckpoint.script),exitDelay:targetNetwork.exitDelay,targetWeightLimit:targetNetwork.weightLimit,poolTapTreeHash:sha(targetProfile.tapTree),signatureModel:'64-byte-default-sighash',paths};
 const outputPath=resolve(installation?join(installConfig!.network.dataDirectory,'stock-profile-qualification.json'):localOnly?'validation/stock-profile-local.json':'validation/stock-profile-qualification.json'),content=JSON.stringify({...evidence,localOnly,measurements:samples,weightProjection:'Exact target-policy leaf/control-block lengths and 64-byte default-sighash signatures; actual locally executed proof witness bytes are retained. Target public signer signatures and target public admission are not claimed.',limitations:['Synthetic prevouts and deterministic public fixture signer keys; no network submission','CSV exit service execution does not demonstrate a confirmed matured Bitcoin exit','Development circuit-specific phase2']},null,2)+'\n';if(installation){await mkdir(installConfig!.network.dataDirectory,{recursive:true});const temporary=outputPath+'.tmp-'+process.pid;await writeFile(temporary,content,{flag:'wx',mode:0o600});try{await rename(temporary,outputPath);}catch(error){await rm(temporary,{force:true});throw error;}}else await writeFile(outputPath,content);console.log('All nine actual pinned native Service paths qualified; funded public admission remains unverified.');
}finally{coordinator.close();assert.ok(directory.startsWith(join(tmpdir(),'shielded-stock-qualification-')));await rm(directory,{recursive:true,force:true});await (globalThis as any).curve_bn128?.terminate();}
process.exit(0);
