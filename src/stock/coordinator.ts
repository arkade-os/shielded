import {base64,hex} from '@scure/base';
import {createHash} from 'node:crypto';
import {CSVMultisigTapscript,Extension,MultisigTapscript,Transaction,VtxoScript} from '@arkade-os/sdk';
import {tapLeafHash} from '@scure/btc-signer/payment.js';
import type {CSVMultisigTapscript as CsvType} from '@arkade-os/sdk';
import {createPublicProtocol} from '../../packages/protocol/src/index.ts';
import type {ProtocolState,PublicProtocolCheckpoint,StockPreparedSettlement} from '../../packages/protocol/src/types.ts';
import {stockStateCommitment,type StockSettlementProof,type StockProofBackend} from '../../packages/protocol/src/stock-native.ts';
import {verifyParticipantRegistration,type RegistrationPayload} from '../../packages/protocol/src/registration.ts';
import {buildStockSpend,planStockSpend,type StockProfile,type StockSpendRequest,type StockVtxoInput} from './sdk.ts';
import {openStockJournal,stockJournalFingerprint,type StockReleasePin} from './journal.ts';
import {stockSignedWeights,verifyStockCustomerSignatures,verifyStockResponse,type StockNativeReceipt,type StockWireRequest} from './transport.ts';
import {assertStockWeightBudget,type StockNetworkInfo} from './network.ts';

export interface StockHead {txid:string;vout:number;value:number;sourceTxHex:string}
export interface StockHistoryEntry {operation:StockSpendRequest['operation'];request:StockWireRequest;receipt:StockNativeReceipt;prepared?:StockPreparedSettlement;proof?:StockSettlementProof;externalFunding?:StockPublicFunding}
export interface StockPublicArchive {version:1;protocol:PublicProtocolCheckpoint;participants:Record<string,RegistrationPayload>;head:StockHead;phase:17|18;history:StockHistoryEntry[]}
interface StockPlan {version:1;operation:StockSpendRequest['operation'];request:StockWireRequest;oldHead:StockHead;prepared?:StockPreparedSettlement;proof?:StockSettlementProof;externalFunding?:StockPublicFunding}
export interface StockPublicFunding {txid:string;vout:number;value:number;sourceTxHex:string;tapTreeHex:string;leafHex:string}
export interface StockCoordinatorOptions {
 directory:string;
 pin:StockReleasePin;
 profile:StockProfile;
 network:StockNetworkInfo;
 checkpointTapscript:string;
 initialArchive:StockPublicArchive;
 backend:StockProofBackend;
 hash:(values:bigint[])=>bigint;
 beforeSubmit?:(request:StockWireRequest)=>Promise<void>;
 transport:{submit(request:StockWireRequest):Promise<StockNativeReceipt>;lookup(request:StockWireRequest):Promise<StockNativeReceipt|undefined>};
}
function equal(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
const isWithdrawal=(operation:StockSpendRequest['operation'])=>operation==='withdraw'||operation==='withdraw-funded';
const nativeOperation=(prepared:StockPreparedSettlement,funding?:StockPublicFunding):StockSpendRequest['operation']=>prepared.operation==='shield'?'deposit':prepared.operation==='withdraw'&&funding?'withdraw-funded':prepared.operation;
function stateBytes(hash:StockCoordinatorOptions['hash'],state:ProtocolState){let value=stockStateCommitment(hash,state);const bytes=new Uint8Array(32);for(let i=0;i<32;i++){bytes[i]=Number(value&255n);value>>=8n;}return hex.encode(bytes);}
function publicHead(receipt:StockNativeReceipt,operation:StockSpendRequest['operation']):StockHead {
 const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),vout=isWithdrawal(operation)?1:0,output=tx.getOutput(vout);
 if(!output||!Number.isSafeInteger(Number(output.amount)))throw new Error('Stock acceptance has no bounded continuation output.');
 return {txid:tx.id,vout,value:Number(output.amount),sourceTxHex:hex.encode(tx.toBytes(true,true))};
}
function verifyHead(head:StockHead,phase:17|18,state:ProtocolState,options:StockCoordinatorOptions){
 if(!head||!Number.isSafeInteger(head.value)||head.value!==330+state.reserves.BTC||!Number.isInteger(head.vout)||head.vout<0||!/^[0-9a-f]{64}$/.test(head.txid)||!/^(?:[0-9a-f]{2})+$/.test(head.sourceTxHex))throw new Error('Invalid stock continuation identity or BTC backing.');
 const tx=Transaction.fromRaw(hex.decode(head.sourceTxHex)),output=tx.getOutput(head.vout),extension=Extension.fromTx(tx);
 if(tx.id!==head.txid||!output||output.amount!==BigInt(head.value)||hex.encode(output.script!)!==hex.encode(options.profile.vtxo.pkScript))throw new Error('Stock continuation does not match its authenticated native transaction and immutable policy.');
 if(hex.encode(extension.getPacketByType(0x87)?.serialize()??new Uint8Array())!==stateBytes(options.hash,state)||hex.encode(extension.getPacketByType(0x88)?.serialize()??new Uint8Array())!==hex.encode(Uint8Array.of(phase))||extension.getPacketByType(0))throw new Error('Stock continuation state, phase, or BTC-only profile changed.');
 for(const [type,expected] of [[0x85,options.profile.icPacketHex],[0x86,options.profile.fixedKeyPacketHex]] as const){const packet=extension.getPacketByType(type);if(phase===18?hex.encode(packet?.serialize()??new Uint8Array())!==expected:!!packet)throw new Error('Stock key publication phase is invalid.');}
}
function fundingInput(input:StockPublicFunding):StockVtxoInput {
 if(!input||!Number.isSafeInteger(input.value)||input.value<330||!/^(?:[0-9a-f]{2})+$/.test(input.sourceTxHex)||!/^(?:[0-9a-f]{2})+$/.test(input.tapTreeHex)||!/^(?:[0-9a-f]{2})+$/.test(input.leafHex))throw new Error('Invalid exact customer Ark VTXO funding.');
 return {txid:input.txid,vout:input.vout,value:input.value,sourceTx:hex.decode(input.sourceTxHex),tapTree:hex.decode(input.tapTreeHex),tapLeafScript:optionsTreeLeaf(input)};
}
const optionsTreeLeaf=(input:StockPublicFunding)=>VtxoScript.decode(hex.decode(input.tapTreeHex)).findLeaf(input.leafHex);
function mergeCustomerSignatures(expected:StockWireRequest,supplied:StockWireRequest|undefined,serverKey:string):StockWireRequest {
 if(!supplied)return expected;
 const merge=(encoded:string,actual:string,customerInputs:number[])=>{
  const tx=Transaction.fromPSBT(base64.decode(encoded)),received=Transaction.fromPSBT(base64.decode(actual));
  if(hex.encode(tx.unsignedTx)!==hex.encode(received.unsignedTx))throw new Error('Client changed the proved native transaction body.');
  for(let vin=0;vin<tx.inputsLength;vin++){
   const signatures=received.getInput(vin).tapScriptSig;if(!signatures?.length)continue;
   if(!customerInputs.includes(vin))throw new Error('Client supplied a signature for the platform-controlled pool input.');
   const leaf=tx.getInput(vin).tapLeafScript![0],script=leaf[1].subarray(0,-1),keys=CSVMultisigTapscript.isScriptValid(script)===true?CSVMultisigTapscript.decode(script).params.pubkeys:MultisigTapscript.decode(script).params.pubkeys;
   const customer=keys.filter(key=>hex.encode(key)!==serverKey),leafHash=hex.encode(tapLeafHash(script,leaf[1].at(-1)!));
   if(customer.length!==1||signatures.length!==1||hex.encode(signatures[0][0].pubKey)!==hex.encode(customer[0])||hex.encode(signatures[0][0].leafHash)!==leafHash||signatures[0][1].length!==64)throw new Error('Client funding signature does not match the exact customer leaf.');
   tx.updateInput(vin,{tapScriptSig:signatures});
  }
  return base64.encode(tx.toPSBT());
 };
 if(supplied.checkpoints.length!==expected.checkpoints.length)throw new Error('Client changed the native checkpoint set.');
 return {arkTx:merge(expected.arkTx,supplied.arkTx,Array.from({length:expected.checkpoints.length-1},(_,index)=>index+1)),checkpoints:expected.checkpoints.map((encoded,index)=>merge(encoded,supplied.checkpoints[index],index>0?[0]:[]))};
}
export async function createStockCoordinator(options:StockCoordinatorOptions){
 const {profile,network}=options;
 if(profile.descriptorProfileId!==options.pin.descriptorProfileId||profile.programsHashHex!==options.pin.programsHash||profile.serverKey!==network.serverKey||profile.emulatorKey!==network.emulatorKey||options.pin.serverKey!==network.serverKey||options.pin.emulatorKey!==network.emulatorKey||options.pin.genesisTxid!==options.initialArchive.head.txid||options.initialArchive.history.length||options.initialArchive.phase!==17||options.initialArchive.protocol.state.revision!==0)throw new Error('Stock deployment configuration does not match its fresh immutable genesis.');
 if(!options.backend.verify)throw new Error('Stock coordinator requires the actual pinned combined proof verifier.');
 if(options.pin.checkpointHash!==createHash('sha256').update(hex.decode(options.checkpointTapscript)).digest('hex'))throw new Error('Stock checkpoint policy changed; migration is required.');
 const registrationProfile=stockJournalFingerprint(options.pin);
 const genesisProtocol=await createPublicProtocol({recipients:options.initialArchive.protocol.recipients,stockOnly:true,stockProofBackend:options.backend,stockVerifierKey:profile.verifierKey});
 if(!equal(genesisProtocol.publicCheckpoint(),options.initialArchive.protocol))throw new Error('Stock genesis must use the exact empty note, history, and indexed-nullifier state.');
 const checkpoint=CSVMultisigTapscript.decode(hex.decode(options.checkpointTapscript)) as CsvType.Type;
 const makeProtocol=(archive:StockPublicArchive)=>createPublicProtocol({recipients:archive.protocol.recipients,checkpoint:archive.protocol,stockOnly:true,stockProofBackend:options.backend,stockVerifierKey:profile.verifierKey});
 const requestFor=(archive:StockPublicArchive,operation:StockSpendRequest['operation'],prepared?:StockPreparedSettlement,externalFunding?:StockPublicFunding):StockSpendRequest=>({profile,operation,pool:{txid:archive.head.txid,vout:archive.head.vout,value:archive.head.value,sourceTx:hex.decode(archive.head.sourceTxHex)},oldState:archive.protocol.state,newState:prepared?.newState??archive.protocol.state,checkpoint,hash:options.hash,weightLimit:network.weightLimit,...(externalFunding?{externalFunding:fundingInput(externalFunding)}:{}),...(isWithdrawal(operation)?{payoutBTC:prepared!.boundary.withdrawal.BTC+(externalFunding?.value??0),externalProgram:undefined}:{} )});
 const withdrawalProgram=(proof:StockSettlementProof)=>proof.nativeBinding.slice(137*2,169*2);
 const buildPlan=(archive:StockPublicArchive,operation:StockSpendRequest['operation'],prepared?:StockPreparedSettlement,proof?:StockSettlementProof,externalFunding?:StockPublicFunding,signed?:StockWireRequest):StockPlan=>{
  const request=requestFor(archive,operation,prepared,externalFunding);if(isWithdrawal(operation))request.externalProgram=withdrawalProgram(proof!);
  const spend=buildStockSpend(request,proof),wire=mergeCustomerSignatures({arkTx:spend.arkTxPsbt,checkpoints:spend.checkpointPsbts},signed,network.serverKey);
  return {version:1,operation,request:wire,oldHead:archive.head,...(prepared?{prepared}:{}),...(proof?{proof}:{}),...(externalFunding?{externalFunding}: {})};
 };
 const validatePlan=async(plan:StockPlan,archive:StockPublicArchive)=>{
  if(plan.version!==1||!equal(plan.oldHead,archive.head))throw new Error('Stock request spends a different continuation.');
  if(plan.operation==='abort')throw new Error('This stock profile has no abort closure; reconcile the pending request or submit a valid proved transition.');
  const auxiliary=plan.operation==='prepare';
  if(archive.phase!==(plan.operation==='prepare'?17:18))throw new Error('Stock request uses the wrong key-publication phase.');
  if(auxiliary&&(plan.prepared||plan.proof||plan.externalFunding))throw new Error('Stock preparation and abort must preserve the proved state.');
  if(!auxiliary){if(!plan.prepared||!plan.proof)throw new Error('Stock state transitions require a client combined proof.');const protocol=await makeProtocol(archive);await protocol.restoreStockPrepared(plan.prepared,plan.proof);}
  const rebuilt=buildPlan(archive,plan.operation,plan.prepared,plan.proof,plan.externalFunding,plan.request);
  if(!equal(rebuilt.request,plan.request))throw new Error('Stock journal transaction is not the exact reconstructed native spend.');
  verifyStockCustomerSignatures(plan.request,network.serverKey);assertStockWeightBudget(network,stockSignedWeights(plan.request,true));
 };
 let verifiedArchive:StockPublicArchive|undefined;
 const journal=await openStockJournal<StockPublicArchive,StockPlan,StockNativeReceipt>(options.directory,options.pin,options.initialArchive,{
  validateArchive:async archive=>{
   if(archive.version!==1||!Array.isArray(archive.history))throw new Error('Invalid stock public archive.');
   if(!archive.participants||!equal(Object.keys(archive.participants),Object.keys(archive.protocol.recipients)))throw new Error('Stock recipient directory lacks its signed native identities.');
   for(const [owner,registration] of Object.entries(archive.participants))if(owner!==registration.owner||!equal(registration.recipient,archive.protocol.recipients[owner])||!verifyParticipantRegistration(registration,'mutinynet',registrationProfile))throw new Error('Invalid stock participant registration signature.');
   const reuse=verifiedArchive&&archive.history.length>=verifiedArchive.history.length&&equal(archive.history.slice(0,verifiedArchive.history.length),verifiedArchive.history);
   let cursor=structuredClone(reuse?verifiedArchive!:options.initialArchive);
   const directoryKernel=await makeProtocol(cursor);directoryKernel.setRecipients(archive.protocol.recipients);cursor.protocol=directoryKernel.publicCheckpoint();
   await makeProtocol(cursor);verifyHead(cursor.head,cursor.phase,cursor.protocol.state,options);
   for(const entry of archive.history.slice(cursor.history.length)){
    await validatePlan({version:1,operation:entry.operation,request:entry.request,oldHead:cursor.head,...(entry.prepared?{prepared:entry.prepared}:{}),...(entry.proof?{proof:entry.proof}:{}),...(entry.externalFunding?{externalFunding:entry.externalFunding}:{})},cursor);
    const receipt=verifyStockResponse(entry.request,entry.receipt,network);
    if(!equal(receipt,entry.receipt))throw new Error('Archived stock receipt changed its authenticated facts.');
    const cps=entry.request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded))),input=cps[0]?.getInput(0);
    if(!input||hex.encode(input.txid!)!==cursor.head.txid||input.index!==cursor.head.vout)throw new Error('Stock archive is not descended from the pinned genesis.');
    if(entry.operation==='prepare'||entry.operation==='abort'){
     if(entry.prepared||entry.proof||cursor.phase!==(entry.operation==='prepare'?17:18))throw new Error('Invalid archived stock phase transition.');
    }else{
     if(cursor.phase!==18||!entry.prepared||!entry.proof)throw new Error('Archived stock transition lacks its proof or authenticated parent.');
     const kernel=await makeProtocol(cursor),prepared=await kernel.restoreStockPrepared(entry.prepared,entry.proof);await kernel.commitStock(prepared,entry.proof,receipt);cursor.protocol=kernel.publicCheckpoint();
    }
    cursor.phase=entry.operation==='prepare'?18:17;cursor.head=publicHead(receipt,entry.operation);verifyHead(cursor.head,cursor.phase,cursor.protocol.state,options);
   }
   if(!equal(cursor.protocol,archive.protocol)||!equal(cursor.head,archive.head)||cursor.phase!==archive.phase)throw new Error('Stock archive disagrees with its complete proof and native acceptance history.');
   verifiedArchive=structuredClone(archive);
  },
  validatePlan,
  verifyReceipt:(plan,receipt)=>{const verified=verifyStockResponse(plan.request,receipt,network);if(!equal(verified,receipt))throw new Error('Stock native acceptance receipt is inconsistent.');},
  transmit:plan=>options.transport.submit(plan.request),lookup:plan=>options.transport.lookup(plan.request),
  apply:async(archive,plan,receipt)=>{
   if(plan.prepared&&plan.proof){const kernel=await makeProtocol(archive),prepared=await kernel.restoreStockPrepared(plan.prepared,plan.proof);await kernel.commitStock(prepared,plan.proof,receipt);archive.protocol=kernel.publicCheckpoint();}
   archive.head=publicHead(receipt,plan.operation);archive.phase=plan.operation==='prepare'?18:17;archive.history.push({operation:plan.operation,request:plan.request,receipt,...(plan.prepared?{prepared:plan.prepared}:{}),...(plan.proof?{proof:plan.proof}:{}),...(plan.externalFunding?{externalFunding:plan.externalFunding}:{})});return archive;
  },
 });
 const submitPlan=async(id:string,plan:StockPlan)=>{await validatePlan(plan,journal.status().archive);await options.beforeSubmit?.(plan.request);return journal.submit(id,plan);};
 let sealing=false;
 return {
  registrationProfile,
  status:()=>journal.status(),archive:()=>journal.status().archive,genesis:()=>structuredClone(options.initialArchive),
  register:async(registration:RegistrationPayload)=>{
   if(!verifyParticipantRegistration(registration,'mutinynet',registrationProfile))throw new Error('Stock registration must be signed by its native owner for this exact deployment.');
   return journal.updateArchive(async archive=>{
    const known=Object.hasOwn(archive.participants,registration.owner)?archive.participants[registration.owner]:undefined;
    if(known){if(!equal(known,registration))throw new Error('Stock participant identity is immutable.');return archive;}
    const kernel=await makeProtocol(archive);kernel.setRecipients({...archive.protocol.recipients,[registration.owner]:registration.recipient});archive.protocol=kernel.publicCheckpoint();archive.participants[registration.owner]=structuredClone(registration);return archive;
   });
  },
  draft:(prepared:StockPreparedSettlement,externalFunding?:StockPublicFunding,externalProgram?:string)=>{
   const archive=journal.status().archive;if(journal.status().blocked||archive.phase!==18)throw new Error('Prepare the stock native key phase before generating the client proof.');
   if(!equal(prepared.oldState,archive.protocol.state))throw new Error('Client preparation is stale.');
   const operation=nativeOperation(prepared,externalFunding),request=requestFor(archive,operation,prepared,externalFunding);if(isWithdrawal(operation))request.externalProgram=externalProgram;
   return planStockSpend(request);
  },
  prepare:async()=>{const archive=journal.status().archive;if(archive.phase===18)return journal.status();await submitPlan('prepare:'+archive.head.txid,buildPlan(archive,'prepare'));return journal.status();},
  abort:async()=>{throw new Error('This stock profile has no abort closure; reconcile the pending request or submit a valid proved transition.');},
  seal:async()=>{
   if(sealing)throw new Error('A stock seal proof is already being generated.');sealing=true;try{
   let archive=journal.status().archive;
   const before=await makeProtocol(archive);await before.prepareStockSeal();
   if(archive.phase===17){await submitPlan('prepare:'+archive.head.txid,buildPlan(archive,'prepare'));archive=journal.status().archive;}
   const kernel=await makeProtocol(archive),prepared=await kernel.prepareStockSeal(),request=requestFor(archive,'seal',prepared),draft=planStockSpend(request),proof=await kernel.proveStock(prepared,draft.nativeBinding!);
   return await submitPlan(prepared.id,buildPlan(archive,'seal',prepared,proof));
   }finally{sealing=false;}
  },
  submit:async(prepared:StockPreparedSettlement,proof:StockSettlementProof,externalFunding?:StockPublicFunding,signed?:StockWireRequest)=>{
   const archive=journal.status().archive,operation=nativeOperation(prepared,externalFunding);
   const accepted=archive.history.find(entry=>entry.prepared?.id===prepared.id);
   if(accepted){
    if(!equal(accepted.prepared,prepared)||!equal(accepted.proof,proof))throw new Error('Accepted stock request identity was reused with a different statement.');
    if(externalFunding){const funding=Transaction.fromPSBT(base64.decode(accepted.request.checkpoints[1]??'')).getInput(0);if(hex.encode(funding.txid!)!==externalFunding.txid||funding.index!==externalFunding.vout||funding.witnessUtxo?.amount!==BigInt(externalFunding.value))throw new Error('Accepted stock retry selected a different customer funding coin.');}
    if(signed){mergeCustomerSignatures(accepted.request,signed,network.serverKey);}
    return {receipt:structuredClone(accepted.receipt),archive,replay:true};
   }
   return submitPlan(prepared.id,buildPlan(archive,operation,prepared,proof,externalFunding,signed));
  },
  reconcile:journal.reconcile,close:journal.close,
 };
}
export type StockCoordinator=Awaited<ReturnType<typeof createStockCoordinator>>;
