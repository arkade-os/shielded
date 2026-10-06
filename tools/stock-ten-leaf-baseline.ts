import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {base64,hex} from '@scure/base';
import {CSVMultisigTapscript,MultisigTapscript,SingleKey,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import {createClientProtocol,createPublicProtocol} from '../packages/protocol/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {signParticipantRegistration} from '../packages/protocol/src/registration.ts';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../packages/protocol/src/stock-proof-node.ts';
import {stockStateCommitment,type StockSettlementProof} from '../packages/protocol/src/stock-native.ts';
import type {StockPreparedSettlement} from '../packages/protocol/src/types.ts';
import {createStockCoordinator,type StockPublicArchive,type StockPublicFunding} from '../src/stock/coordinator.ts';
import {stockJournalFingerprint} from '../src/stock/journal.ts';
import {loadStockProfile,buildStockSpend,stockVmRequest,STOCK_LEAVES,STOCK_EXIT_LEAVES,type StockExitLeaf,type StockLeaf,type StockProgramManifest} from '../src/stock/sdk.ts';
import {stockSignedWeights,verifyStockResponse,type StockNativeReceipt,type StockWireRequest} from '../src/stock/transport.ts';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {executeVmBinary} from '../src/sdk/runtime.ts';
import {EngineStore} from '../src/storage.ts';

const root=process.cwd(),artifacts=resolve(process.env.SHIELDED_STOCK_ARTIFACTS??'circuits/stock/build/compiled');
const manifest=JSON.parse(await readFile(join(artifacts,'stock-combined.manifest.json'),'utf8')) as StockArtifactManifest;
const loaded=await loadStockProofArtifacts(artifacts,manifest),binary=resolve(root,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm');
const programs=JSON.parse(execFileSync(binary,['--stock-build',join(artifacts,'stock-combined.vkey.json')],{encoding:'utf8',windowsHide:true})) as StockProgramManifest;
const server=SingleKey.fromHex('01'.repeat(32)),emulator=SingleKey.fromHex('02'.repeat(32));
const network={network:'mutinynet' as const,arkUrl:'synthetic-native-service',emulatorUrl:'synthetic-native-service',serverKey:hex.encode(await server.xOnlyPublicKey()),emulatorKey:hex.encode(await emulator.xOnlyPublicKey()),operatorMaxWeight:4000,weightLimit:4000,dust:330,exitDelay:{type:'seconds' as const,value:2048},emulatorVersion:'local-stock-Service.SubmitTx',nativeAdmission:'unverified' as const};
const baseProfile=loadStockProfile(programs,loaded.verifierKey,loaded.descriptor.profileId,network,programs.programsHashHex);
const tenLeafNames=[...STOCK_LEAVES,...STOCK_EXIT_LEAVES].sort(),tenLeafScripts=tenLeafNames.map(name=>name in baseProfile.exitClosures?baseProfile.exitClosures[name as StockExitLeaf]:baseProfile.closures[name as StockLeaf]);
if(tenLeafNames.length!==10||tenLeafScripts.some(script=>!script)||new Set(tenLeafScripts.map(hex.encode)).size!==10)throw new Error('The baseline must contain ten distinct sorted stock policy leaves.');
const tenLeafTree=new VtxoScript(tenLeafScripts),profile={...baseProfile,vtxo:tenLeafTree,tapTree:tenLeafTree.encode()};
const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
const publicKernel=await createPublicProtocol({recipients:{},stockOnly:true,stockProofBackend:loaded.backend,stockVerifierKey:loaded.verifierKey});
const protocol=publicKernel.publicCheckpoint(),state=stockStateCommitment(hash,protocol.state),stateBytes=new Uint8Array(32);let value=state;for(let i=0;i<32;i++){stateBytes[i]=Number(value&255n);value>>=8n;}
const genesis=offlineNativeFixture([{script:profile.vtxo.pkScript,amount:330n}],[new UnknownPacket(0x87,stateBytes),new UnknownPacket(0x88,Uint8Array.of(17))]);
const initial:StockPublicArchive={version:1,protocol,participants:{},head:{txid:genesis.id,vout:0,value:330,sourceTxHex:hex.encode(genesis.toBytes())},phase:17,history:[]};
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[await server.xOnlyPublicKey()],timelock:{type:'seconds',value:2048n}}),checkpointTapscript=hex.encode(checkpoint.script);
const pin={version:1 as const,network:'local-stock' as const,descriptorProfileId:profile.descriptorProfileId,programsHash:profile.programsHashHex,artifactsHash:stockJournalFingerprint(manifest),checkpointHash:createHash('sha256').update(checkpoint.script).digest('hex'),genesisTxid:genesis.id,serverKey:network.serverKey,emulatorKey:network.emulatorKey};
const directory=await mkdtemp(join(tmpdir(),'shielded-stock-ten-leaf-baseline-'));
const accepted=new Map<string,StockNativeReceipt>();let transmissions=0,dropResponse=false;
const transport={submit:async(request:StockWireRequest)=>{
 transmissions++;const response=await executeVmBinary(binary,request);assert.equal(response.ok,true,response.error);
 const signedArkTx=base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(response.arkTx!)))).toPSBT());
 const signedCheckpointTxs=await Promise.all(response.checkpoints!.map(async encoded=>base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(encoded)))).toPSBT())));
 const selected=Transaction.fromPSBT(base64.decode(request.arkTx)).getInput(0).tapLeafScript?.[0]?.[1].subarray(0,-1),leaf=[...STOCK_LEAVES].find(name=>hex.encode(profile.closures[name])===hex.encode(selected??new Uint8Array()))??[...STOCK_EXIT_LEAVES].find(name=>hex.encode(profile.exitClosures[name])===hex.encode(selected??new Uint8Array()))??'unknown',weights=stockSignedWeights({arkTx:signedArkTx,checkpoints:signedCheckpointTxs});
 console.log(`TEN-LEAF ${leaf}: Ark ${weights.ark} WU; checkpoints ${weights.checkpoints.join(',')} WU`);
 const receipt=verifyStockResponse(request,{signedArkTx,signedCheckpointTxs},network);accepted.set(receipt.txid,receipt);
 if(dropResponse){dropResponse=false;throw new Error('Injected lost native response after actual Service execution.');}return receipt;
},lookup:async(request:StockWireRequest)=>accepted.get(Transaction.fromPSBT(base64.decode(request.arkTx)).id)};
const options={directory,pin,profile,network,checkpointTapscript,initialArchive:initial,backend:loaded.backend,hash,transport};
let coordinator=await createStockCoordinator(options),coinCounter=1;
async function restoreTenLeafArchive(archive:StockPublicArchive,label:string){
 const directory=join(options.directory,label),store=EngineStore.open(directory);store.save({version:1,pin,archive,accepted:{}});store.close();
 const restored=await createStockCoordinator({...options,directory});try{return restored.archive();}finally{restored.close();}
}
function assertHistoryDescends(archive:StockPublicArchive){
 let cursor=initial.head;
 for(const entry of archive.history){
  const checkpointTx=Transaction.fromPSBT(base64.decode(entry.request.checkpoints[0]!)),input=checkpointTx.getInput(0),poolTx=Transaction.fromPSBT(base64.decode(entry.receipt.signedArkTx)),vout=entry.operation==='withdraw'||entry.operation==='withdraw-funded'?1:0,output=poolTx.getOutput(vout);
  assert.ok(input.txid&&hex.encode(input.txid)===cursor.txid&&input.index===cursor.vout,'Every archived checkpoint must consume the previously trusted pool head.');
  assert.equal(poolTx.id,entry.receipt.txid);assert.ok(output?.script&&hex.encode(output.script)===hex.encode(profile.vtxo.pkScript),'Every pool successor must keep the exact ten-leaf native policy.');
  cursor={txid:poolTx.id,vout,value:Number(output.amount),sourceTxHex:hex.encode(poolTx.toBytes(true,true))};
 }
 assert.deepEqual(cursor,archive.head,'The ten-leaf native receipt history must reach its exact final head.');
}
async function party(label:string){
 const master=createHash('sha256').update('stock-lifecycle-public-fixture:'+label).digest(),material=deriveWalletKeyMaterial(master,'mutinynet'),identity=SingleKey.fromHex(material.nativeSecret),owner=hex.encode(await identity.xOnlyPublicKey());
 const client=await createClientProtocol({owner,keys:material.keys,stockOnly:true,stockProofBackend:loaded.backend,stockVerifierKey:loaded.verifierKey});
 const registration=signParticipantRegistration({network:'mutinynet',profile:coordinator.registrationProfile,secretKey:material.nativeSecret,recipient:client.publicDescriptor()});
 const forfeit=MultisigTapscript.encode({pubkeys:[await identity.xOnlyPublicKey(),await server.xOnlyPublicKey()]}).script;
 const exit=CSVMultisigTapscript.encode({pubkeys:[await identity.xOnlyPublicKey()],timelock:{type:'seconds',value:2048n}}).script,tree=new VtxoScript([forfeit,exit]);
 await coordinator.register(registration);return {label,master,material,identity,owner,client,registration,tree,forfeit};
}
const parties:Awaited<ReturnType<typeof party>>[]=[];
const sync=()=>{const archive=coordinator.archive();for(const party of parties){party.client.setRecipients(archive.protocol.recipients);party.client.restorePublicCheckpoint(archive.protocol);}return archive;};
function funding(party:typeof parties[number],value:number):StockPublicFunding {
 const parent=offlineNativeFixture([{script:party.tree.pkScript,amount:BigInt(value)}],[],{txid:createHash('sha256').update('stock-exact-funding:'+coinCounter++).digest('hex'),vout:0});
 return {txid:parent.id,vout:0,value,sourceTxHex:hex.encode(parent.toBytes()),tapTreeHex:hex.encode(party.tree.encode()),leafHex:hex.encode(party.forfeit)};
}
function payoutFunding(party:typeof parties[number],receipt:StockNativeReceipt,value:number):StockPublicFunding {
 const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),output=tx.getOutput(0);
 if(output.amount!==BigInt(value)||hex.encode(output.script??new Uint8Array())!==hex.encode(party.tree.pkScript))throw new Error('The native Service withdrawal did not create the exact customer funding VTXO.');
 return {txid:tx.id,vout:0,value,sourceTxHex:hex.encode(tx.toBytes(true,true)),tapTreeHex:hex.encode(party.tree.encode()),leafHex:hex.encode(party.forfeit)};
}
let first:{prepared:StockPreparedSettlement;proof:StockSettlementProof;externalFunding:StockPublicFunding;signed:StockWireRequest}|undefined;
async function nativePlan(party:typeof parties[number],prepared:StockPreparedSettlement,externalFunding?:StockPublicFunding){
 await coordinator.prepare();const archive=coordinator.archive(),externalProgram=prepared.operation==='withdraw'?hex.encode(party.tree.pkScript.subarray(2)):undefined;
 const draft=coordinator.draft(prepared,externalFunding,externalProgram),proof=await party.client.proveStock(prepared,draft.nativeBinding!);
 const request={profile,operation:prepared.operation==='shield'?'deposit' as const:prepared.operation==='withdraw'&&externalFunding?'withdraw-funded' as const:prepared.operation,pool:{...archive.head,sourceTx:hex.decode(archive.head.sourceTxHex)},oldState:prepared.oldState,newState:prepared.newState,checkpoint,hash,weightLimit:4000,...(externalFunding?{externalFunding:{...externalFunding,sourceTx:hex.decode(externalFunding.sourceTxHex),tapTree:hex.decode(externalFunding.tapTreeHex),tapLeafScript:party.tree.findLeaf(externalFunding.leafHex)}}:{}),...(externalProgram?{externalProgram,payoutBTC:prepared.boundary.withdrawal.BTC+(externalFunding?.value??0)}:{})};
 const buildSigned=async(mutate?:(tx:Transaction)=>void)=>{
  const spend=buildStockSpend(request,proof,draft);mutate?.(spend.arkTx);
  if(externalFunding){spend.arkTx=await party.identity.sign(spend.arkTx,[1]);spend.checkpoints[1]=await party.identity.sign(spend.checkpoints[1],[0]);}
  spend.arkTxPsbt=base64.encode(spend.arkTx.toPSBT());spend.checkpointPsbts=spend.checkpoints.map(tx=>base64.encode(tx.toPSBT()));
  return stockVmRequest(spend);
 };
 return {proof,signed:await buildSigned(),buildSigned};
}
async function apply(party:typeof parties[number],prepared:StockPreparedSettlement,externalFunding?:StockPublicFunding){
 const {proof,signed,buildSigned}=await nativePlan(party,prepared,externalFunding);
 const changed=await buildSigned(tx=>tx.updateOutput(0,{amount:tx.getOutput(0).amount!+1n}));
 assert.notEqual(hex.encode(Transaction.fromPSBT(base64.decode(changed.arkTx)).unsignedTx),hex.encode(Transaction.fromPSBT(base64.decode(signed.arkTx)).unsignedTx),'Mutation fixture did not change the signed native transaction.');
 const changedResponse=await executeVmBinary(binary,changed);assert.equal(changedResponse.ok,false,'Stock VM accepted a proof for different native amounts.');
 if(prepared.operation==='withdraw'){
  const alternate=parties.find(candidate=>candidate.owner!==party.owner);if(!alternate)throw new Error('Destination mutation needs a second valid Taproot program.');
  const redirected=await buildSigned(tx=>tx.updateOutput(0,{script:alternate.tree.pkScript.slice()}));
  assert.notEqual(hex.encode(Transaction.fromPSBT(base64.decode(redirected.arkTx)).unsignedTx),hex.encode(Transaction.fromPSBT(base64.decode(signed.arkTx)).unsignedTx),'Destination fixture did not change the signed native transaction.');
  const redirectedResponse=await executeVmBinary(binary,redirected);assert.equal(redirectedResponse.ok,false,'Stock VM accepted a withdrawal proof for another destination.');
 }
 const result=await coordinator.submit(prepared,proof,externalFunding,signed);sync();
 if(externalFunding&&!first)first={prepared,proof,externalFunding,signed};
 console.log('Actual combined Groth16 + stock native Service '+prepared.operation+': '+result.receipt.weights.ark+' WU');return result;
}
try{
 const alice=await party('alice'),bob=await party('bob');parties.push(alice,bob);sync();
 await apply(alice,await alice.client.prepareStockShield(alice.owner,'BTC',1330),funding(alice,1330));
 await assert.rejects(alice.client.prepareStockTransfer(alice.owner,bob.owner,'BTC',630),/sealed/i);
 await coordinator.seal();sync();
 const carol=await party('carol');parties.push(carol);sync();
 const concurrentPrepared=await alice.client.prepareStockTransfer(alice.owner,carol.owner,'BTC',200),concurrent=await nativePlan(alice,concurrentPrepared);
 await apply(alice,await alice.client.prepareStockTransfer(alice.owner,bob.owner,'BTC',630));
 const beforeStale=transmissions;await assert.rejects(coordinator.submit(concurrentPrepared,concurrent.proof,undefined,concurrent.signed));assert.equal(transmissions,beforeStale,'A stale parallel proof reached native submission.');
 await coordinator.seal();sync();
 const bob330=await apply(bob,await bob.client.prepareStockWithdraw(bob.owner,'BTC',330,hex.encode(bob.tree.pkScript.subarray(2))));
 await coordinator.seal();sync();
 const bob330Funding=payoutFunding(bob,bob330.receipt,330);
 const bobDust=await apply(bob,await bob.client.prepareStockWithdraw(bob.owner,'BTC',1,hex.encode(bob.tree.pkScript.subarray(2))),bob330Funding);
 await coordinator.seal();sync();
 await apply(alice,await alice.client.prepareStockTransfer(alice.owner,carol.owner,'BTC',200));
 await coordinator.seal();sync();
 await apply(carol,await carol.client.prepareStockWithdraw(carol.owner,'BTC',200,hex.encode(carol.tree.pkScript.subarray(2))),funding(carol,330));
 const before=sync();assertHistoryDescends(before);
 const recovery=await createClientProtocol({owner:bob.owner,keys:deriveWalletKeyMaterial(bob.master,'mutinynet').keys,stockOnly:true,stockProofBackend:loaded.backend,stockVerifierKey:loaded.verifierKey});
 recovery.setRecipients(before.protocol.recipients);recovery.restorePublicCheckpoint(before.protocol);
 assert.deepEqual(recovery.snapshot().wallets[bob.owner].balances,bob.client.snapshot().wallets[bob.owner].balances);
 const priorTransmissions=transmissions;assert.equal((await coordinator.submit(first!.prepared,first!.proof,first!.externalFunding,first!.signed)).replay,true);assert.equal(transmissions,priorTransmissions);
 dropResponse=true;await assert.rejects(coordinator.prepare(),/Injected lost/);assert.equal(coordinator.status().blocked,true);
 await assert.rejects(coordinator.prepare(),/unresolved|in flight|pending/i);
 coordinator.close();coordinator=await createStockCoordinator(options);const atRestart=transmissions;await coordinator.reconcile();assert.equal(transmissions,atRestart);assert.equal(coordinator.status().blocked,false);sync();
 assert.ok(profile.vtxo.findLeaf(hex.encode(profile.closures.abort)),'The ten-leaf native pool policy includes the abort leaf.');
 await assert.rejects(coordinator.abort(),/no abort closure/);
 await apply(alice,await alice.client.prepareStockWithdraw(alice.owner,'BTC',500,hex.encode(alice.tree.pkScript.subarray(2))));
 await apply(bob,await bob.client.prepareStockWithdraw(bob.owner,'BTC',299,hex.encode(bob.tree.pkScript.subarray(2))),payoutFunding(bob,bobDust.receipt,331));
 for(const party of parties)assert.equal(party.client.snapshot().wallets[party.owner].balances.BTC,0,`${party.label} private balance must be fully withdrawn.`);
 const finished=coordinator.archive();coordinator.close();coordinator=await createStockCoordinator(options);assert.deepEqual(coordinator.archive(),finished);
 assertHistoryDescends(finished);
 const nextAfterTrustedHead=finished.history[before.history.length];assert.ok(nextAfterTrustedHead,'Final history must extend beyond the independently saved pre-cashout trusted head.');
 const trustedInput=Transaction.fromPSBT(base64.decode(nextAfterTrustedHead.request.checkpoints[0]!)).getInput(0);assert.equal(hex.encode(trustedInput.txid!),before.head.txid);assert.equal(trustedInput.index,before.head.vout);
 assert.deepEqual(await restoreTenLeafArchive(finished,'ten-leaf-restore-valid'),finished,'A separate encrypted journal must restore the full ten-leaf proof and native history.');
 const corruptRoot=structuredClone(finished);corruptRoot.protocol.state.reserves.BTC++;
 await assert.rejects(restoreTenLeafArchive(corruptRoot,'ten-leaf-restore-corrupt-root'));
 const invalidProof=structuredClone(finished);invalidProof.history.find(entry=>entry.proof)!.proof!.proof.pi_a[0]='0';
 await assert.rejects(restoreTenLeafArchive(invalidProof,'ten-leaf-restore-corrupt-proof'));
 coordinator.close();const store=EngineStore.open(directory);try{const saved=JSON.stringify(store.load());for(const party of parties)for(const secret of [party.material.keys.spend,party.material.keys.view,party.material.nativeSecret])assert.equal(saved.includes(secret),false,'Operator archive contains a customer secret.');}finally{store.close();}
 const measurements=finished.history.map(entry=>({operation:entry.operation,ark:entry.receipt.weights.ark,checkpoints:entry.receipt.weights.checkpoints}));
 await writeFile(resolve(root,'validation/stock-ten-leaf-lifecycle.json'),JSON.stringify({evidence:'local synthetic stock native Service lifecycle; not public funded acceptance or deployment weight evidence',network:'local-stock',fundedMutinynet:false,policyLeafCount:10,policyLeafNames:tenLeafNames,abortLeafIncluded:true,nativeAbortExecuted:false,nativeCsvExitsExecuted:false,browserArchiveReplayExecuted:false,coordinatorAbortRoute:'not exposed by fresh-profile coordinator API',proofSystem:'actual combined Groth16 BN254 development setup',profile:loaded.descriptor,participants:3,clientKeys:true,operatorHasCustomerSecrets:false,stockServiceExecution:true,customerTwoLeafArkPolicy:true,budgetWu:4000,oneSatWithdrawalWithCustomerDustFunding:true,allCustomerPrivateBalancesEmpty:true,seedPlusAuthenticatedArchiveRecovery:true,seedArchiveRecoveryParticipants:['bob'],exactAcceptedReplay:true,unknownResponseRecoveredWithoutSubmission:true,sameDirectoryRestart:true,staleParallelProofRejectedBeforeSubmission:true,nativeAmountAndDestinationMutationsRejected:true,measurements,limitations:['Synthetic native prevouts, no public Arkd admission or Bitcoin settlement','This is local policy-weight evidence for the ten-leaf profile only, not public deployment weight evidence','Development circuit-specific phase2','A valid direct native transition can withhold its off-chain sidecar and freeze other users','No independent pooled Bitcoin exit if Arkade platform is unavailable']},null,2)+'\n');
 console.log('Ten-leaf local native Service lifecycle passed. This is not public Mutinynet acceptance or deployment weight evidence.');
}finally{coordinator.close();if(dirname(directory)!==resolve(tmpdir())||!basename(directory).startsWith('shielded-stock-ten-leaf-baseline-'))throw new Error('Refusing cleanup outside the exact stock temporary directory.');await rm(directory,{recursive:true,force:true});await (globalThis as any).curve_bn128?.terminate();}

process.exit(0);
