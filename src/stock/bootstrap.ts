import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,openSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {buildOffchainTx,CSVMultisigTapscript,Extension,getArkPsbtFields,MultisigTapscript,P2A,PrevArkTxField,setArkPsbtField,Transaction,UnknownPacket,VtxoScript,verifyTapscriptSignatures,type Identity} from '@arkade-os/sdk';
import {hex,base64} from '@scure/base';
import {tapLeafHash} from '@scure/btc-signer/payment.js';
import {TaprootControlBlock} from '@scure/btc-signer';
import type {StockNetworkInfo} from './network.ts';
import {assertStockWeightBudget} from './network.ts';
import {stockJournalFingerprint} from './journal.ts';
import type {StockProfile,StockProgramManifest} from './sdk.ts';
import type {StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import type {StockWireRequest} from './transport.ts';
import {stockSignedWeights} from './transport.ts';
import {stockStateCommitment} from '../../packages/protocol/src/stock-native.ts';
import {createPublicProtocol} from '../../packages/protocol/src/index.ts';
import type {StockProofBackend} from '../../packages/protocol/src/stock-native.ts';
import type {PublicProtocolCheckpoint} from '../../packages/protocol/src/types.ts';
import type {EngineStore} from '../storage.ts';

export interface StockBootstrapInput {txid:string;vout:number;value:number;sourceTxHex:string;tapTreeHex:string;leafHex:string}
export interface StockBootstrapPin {version:1;network:'mutinynet';networkInfo:StockNetworkInfo;descriptorProfileId:string;programsHash:string;artifactsHash:string;checkpointHash:string;serverKey:string;emulatorKey:string;policyVersion:1;developmentOnly:boolean}
export interface StockBootstrapPlan {outpoint:string;selectedInputFingerprint:string;txid:string;checkpointTxids:string[];request:StockWireRequest;poolScriptHex:string;poolValue:330;changeValue:number;changeScriptHex?:string;releaseFingerprint:string;initialArchive:StockBootstrapArchive}
export interface StockBootstrapArchive {version:1;protocol:PublicProtocolCheckpoint;participants:Record<string,unknown>;head:{txid:string;vout:0;value:330;sourceTxHex:string};phase:17;history:never[]}
export interface StockBootstrapResponse {arkTxid:string;finalArkTx:string;signedCheckpointTxs:string[]}
export interface StockBootstrapReceipt {txid:string;checkpointTxids:string[];response:StockBootstrapResponse;checkpointPsbts:string[];weights:{ark:number;checkpoints:number[]}}
export type StockQualificationPath='prepare'|'transfer'|'deposit'|'withdraw'|'withdraw-funded'|'seal'|'exit-prepare'|'exit-withdraw'|'exit-withdraw-funded';
export interface StockQualificationPathEvidence {kind:'arkade-offchain'|'bitcoin-onchain-exit';executed:true;backend:'pinned-emulator.SubmitTx'|'pinned-emulator.SubmitOnchainTx';evidenceHash:string;txWU:number;checkpointWU:number[]}
export interface StockProfileWeightEvidence {
 version:1;network:'mutinynet';qualification:'local-native-service-all-nine';fundedMutinynet:false;nativeAdmission:'unverified';
 descriptorProfileId:string;programsHash:string;artifactsHash:string;serverKey:string;emulatorKey:string;checkpointHash:string;
 exitDelay:{type:'blocks'|'seconds';value:number};targetWeightLimit:number;poolTapTreeHash:string;signatureModel:'64-byte-default-sighash';
 paths:Record<StockQualificationPath,StockQualificationPathEvidence>
}
type Stage='planned'|'submit-started'|'response-verified'|'finalize-started'|'unknown-submit'|'unknown-finalize'|'finalized'|'indexed';
interface Saved {version:1;pinHash:string;pin:StockBootstrapPin;stage:Stage;plan:StockBootstrapPlan;approvedReleaseFingerprint?:string;receipt?:StockBootstrapReceipt;error?:string}
export interface StockBootstrapServices {
 store:Pick<EngineStore,'load'|'save'>;
 pin:StockBootstrapPin;
 expectedReleaseFingerprint?:string;
 proving:StockArtifactManifest;
 checkpointTapscript:string;
 weightEvidence?:StockProfileWeightEvidence;
 profile:StockProfile;
 programs:StockProgramManifest;
 backend:StockProofBackend;
 identity:Identity;
 ownerKey:string;
 input(outpoint:string):Promise<StockBootstrapInput|undefined>;
 changeScript:Uint8Array;
 checkpoint:CSVMultisigTapscript.Type;
 hash(values:bigint[]):bigint;
 submit(request:StockWireRequest):Promise<StockBootstrapResponse>;
 lookup(request:StockWireRequest):Promise<StockBootstrapResponse|undefined>;
 finalize(txid:string,checkpoints:string[]):Promise<void>;
 indexed(plan:StockBootstrapPlan,receipt:StockBootstrapReceipt):Promise<boolean>;
 releaseRoot:string;
 artifactFiles:Record<string,string>;
}

const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const same=(a:Uint8Array|undefined,b:Uint8Array|undefined)=>!!a&&!!b&&Buffer.from(a).equals(Buffer.from(b));
function fail(message:string):never{throw new Error('Stock genesis bootstrap: '+message);}
function outpoint(value:string){if(!/^[0-9a-f]{64}:[0-9]+$/.test(value))fail('select exactly one canonical customer outpoint (txid:vout).');const [txid,vout]=value.split(':');if(!Number.isSafeInteger(Number(vout))||Number(vout)<0)fail('customer outpoint index is invalid.');return {txid:txid!,vout:Number(vout)};}
function validatePin(pin:StockBootstrapPin,profile:StockProfile){
 if(pin.version!==1||pin.network!=='mutinynet'||pin.networkInfo.network!=='mutinynet'||pin.policyVersion!==1)fail('unsupported network or genesis policy.');
 if(pin.networkInfo.arkUrl!=='https://mutinynet.arkade.sh'||pin.networkInfo.emulatorUrl!=='https://emulator.mutinynet.arkade.sh'||pin.networkInfo.nativeAdmission!=='unverified')fail('only the pinned public Mutinynet endpoints are permitted.');
 if(pin.networkInfo.weightLimit!==Math.min(pin.networkInfo.operatorMaxWeight,4000)||pin.networkInfo.weightLimit<1)fail('invalid operator weight preflight.');
 if(profile.descriptorProfileId!==pin.descriptorProfileId||profile.programsHashHex!==pin.programsHash||profile.serverKey!==pin.serverKey||profile.emulatorKey!==pin.emulatorKey)fail('release pins do not match the loaded stock verifier and covenant program.');
 for(const key of ['descriptorProfileId','programsHash','artifactsHash','checkpointHash','serverKey','emulatorKey'] as const)if(!/^[0-9a-f]{64}$/.test(pin[key]))fail('malformed immutable release pin.');
 if(pin.serverKey===pin.emulatorKey)fail('Arkade and emulator signer keys must be distinct.');
}
function planFingerprint(plan:StockBootstrapPlan){return stockJournalFingerprint(plan);}
function deploymentPin(pin:StockBootstrapPin,genesisTxid:string){return {version:1 as const,network:'mutinynet' as const,descriptorProfileId:pin.descriptorProfileId,programsHash:pin.programsHash,artifactsHash:pin.artifactsHash,checkpointHash:pin.checkpointHash,genesisTxid,serverKey:pin.serverKey,emulatorKey:pin.emulatorKey};}
export function stockBootstrapReleaseFingerprint(pin:StockBootstrapPin,genesisTxid:string){return stockJournalFingerprint(deploymentPin(pin,genesisTxid));}
function txFrom(value:string){try{return Transaction.fromPSBT(base64.decode(value));}catch{return fail('saved PSBT is malformed.');}}
function validatePlan(plan:StockBootstrapPlan,options:StockBootstrapServices){
 const point=outpoint(plan.outpoint),ark=txFrom(plan.request.arkTx),checkpoints=plan.request.checkpoints.map(txFrom),input=ark.getInput(0),cpInput=checkpoints[0]?.getInput(0);
 if(ark.inputsLength!==1||checkpoints.length!==1||ark.id!==plan.txid||plan.checkpointTxids.length!==1||checkpoints[0]!.id!==plan.checkpointTxids[0])fail('saved genesis does not contain one exact Ark transaction and checkpoint.');
 const checkpoint=checkpoints[0]!,checkpointOutput=checkpoint.getOutput(0);
 if(!cpInput||!cpInput.txid||hex.encode(cpInput.txid).toLowerCase()!==point.txid||cpInput.index!==point.vout||!cpInput.witnessUtxo)fail('saved genesis checkpoint does not spend the exact selected customer outpoint.');
 if(!input.txid||hex.encode(input.txid).toLowerCase()!==checkpoint.id||input.index!==0||!input.witnessUtxo||!checkpointOutput)fail('saved Ark transaction does not spend the exact generated checkpoint outpoint.');
 if(cpInput.witnessUtxo.amount!==BigInt(330+plan.changeValue)||input.witnessUtxo.amount!==checkpointOutput.amount||!same(input.witnessUtxo.script,checkpointOutput.script))fail('saved genesis Ark and checkpoint disagree on the authenticated source or checkpoint output.');
 const ownerLeaf=input.tapLeafScript?.[0],pool=ark.getOutput(0),extension=Extension.fromTx(ark),statePacket=extension.getPacketByType(0x87)?.serialize(),phasePacket=extension.getPacketByType(0x88)?.serialize(),state=plan.initialArchive.protocol.state,packetTypes=extension.getPackets().map(packet=>packet.type());
 if(!ownerLeaf||!pool||pool.amount!==330n||!same(pool.script,options.profile.vtxo.pkScript)||plan.poolScriptHex!==hex.encode(options.profile.vtxo.pkScript)||plan.poolValue!==330||plan.changeValue!==Number(input.witnessUtxo.amount-330n)||statePacket?.length!==32||phasePacket?.length!==1||phasePacket[0]!==17||packetTypes.join(',')!=='135,136'||!state||state.noteCount!==0||state.historyCount!==0||state.revision!==0||BigInt(state.reserves.BTC)!==0n||BigInt(state.reserves.DEMO)!==0n)fail('saved transaction is not an empty phase-17 stock genesis with a 330-sat pool head.');
 let commitment=BigInt(stockStateCommitment(options.hash,state));const expectedState=new Uint8Array(32);for(let i=0;i<32;i++){expectedState[i]=Number(commitment&255n);commitment>>=8n;}
 if(!same(statePacket,expectedState))fail('genesis extension does not commit to the canonical empty state.');
 const outputs=Array.from({length:ark.outputsLength},(_,index)=>ark.getOutput(index)),extensionOutput=outputs[plan.changeValue?2:1],anchorOutput=outputs.at(-1);if(!extensionOutput||extensionOutput.amount!==0n||!Extension.isExtension(extensionOutput.script!)||!anchorOutput||anchorOutput.amount!==0n||!same(anchorOutput.script,P2A.script))fail('genesis transaction must contain one canonical zero-value extension and the Ark P2A anchor.');
 const change=plan.changeValue?ark.getOutput(1):undefined;if(plan.changeValue>0&&(!change||change.amount!==BigInt(plan.changeValue)||hex.encode(change.script!)!==plan.changeScriptHex||change.amount<330n))fail('customer change does not preserve normal Arkade dust.');
 if(ark.outputsLength!==(plan.changeValue?4:3)||outputs.reduce((sum,output)=>sum+output.amount!,0n)!==input.witnessUtxo.amount)fail('genesis transaction does not conserve the selected VTXO value.');
 const keys=scriptKeys(ark,0);if(!keys.includes(options.ownerKey)||!keys.includes(options.pin.serverKey))fail('genesis funding input does not bind the customer and pinned Arkade signer.');
 const leafHash=tapLeafHash(ownerLeaf[1].subarray(0,-1),ownerLeaf[1].at(-1)!);try{verifyTapscriptSignatures(ark,0,[options.ownerKey],[],undefined,leafHash);verifyTapscriptSignatures(checkpoints[0]!,0,[options.ownerKey],[],undefined,tapLeafHash(checkpoints[0]!.getInput(0).tapLeafScript![0]![1].subarray(0,-1),checkpoints[0]!.getInput(0).tapLeafScript![0]![1].at(-1)!));}catch{return fail('saved genesis is missing valid customer signatures.');}
 const raw=Transaction.fromRaw(hex.decode(plan.initialArchive.head.sourceTxHex));if(raw.id!==ark.id||!same(raw.unsignedTx,ark.unsignedTx)||plan.initialArchive.head.txid!==ark.id||plan.initialArchive.head.vout!==0||plan.initialArchive.head.value!==330||plan.initialArchive.phase!==17||plan.initialArchive.history.length!==0||Object.keys(plan.initialArchive.participants).length!==0)fail('saved initial public archive does not match its exact empty genesis transaction.');
 assertStockWeightBudget(options.pin.networkInfo,stockSignedWeights(plan.request,true));
}
function scriptKeys(tx:Transaction,vin:number):string[]{const leaf=tx.getInput(vin).tapLeafScript?.[0];if(!leaf)fail('submitted input lacks a tapscript.');let keys:string[];try{keys=MultisigTapscript.decode(leaf[1].subarray(0,-1)).params.pubkeys.map(hex.encode);}catch{return fail('customer input is not a canonical Arkade multisig VTXO.');}if(keys.length!==2)return fail('customer VTXO must have its owner and Arkade signer.');return keys;}
function verifyBody(actual:Transaction,expected:Transaction){
 if(actual.id!==expected.id||!same(actual.unsignedTx,expected.unsignedTx)||actual.inputsLength!==expected.inputsLength||actual.outputsLength!==expected.outputsLength)fail('operator changed the exact submitted transaction body.');
 for(let vin=0;vin<expected.inputsLength;vin++){
  const a=actual.getInput(vin),e=expected.getInput(vin),aLeaves=a.tapLeafScript,eLeaves=e.tapLeafScript;
  if(a.index!==e.index||!same(a.txid,e.txid)||a.witnessUtxo?.amount!==e.witnessUtxo?.amount||!same(a.witnessUtxo?.script,e.witnessUtxo?.script)||!aLeaves||!eLeaves||aLeaves.length!==1||eLeaves.length!==1||!same(aLeaves[0]![1],eLeaves[0]![1])||!same(TaprootControlBlock.encode(aLeaves[0]![0]),TaprootControlBlock.encode(eLeaves[0]![0])))fail('operator changed authenticated input outpoint, value, script, or spend leaf.');
  const actualPrev=getArkPsbtFields(actual,vin,PrevArkTxField),expectedPrev=getArkPsbtFields(expected,vin,PrevArkTxField);if(actualPrev.length!==expectedPrev.length||actualPrev.some((bytes,index)=>!same(bytes,expectedPrev[index])))fail('operator changed the authenticated original Ark transaction metadata.');
  const expectedSigs=e.tapScriptSig??[],actualSigs=a.tapScriptSig??[],originalCount=actualSigs.length;
  for(const [key,sig] of expectedSigs){const prior=actualSigs.find(([other])=>same(other.pubKey,key.pubKey)&&same(other.leafHash,key.leafHash));if(prior&&!same(prior[1],sig))fail('operator response conflicts with a saved customer signature.');if(!prior)actualSigs.push([key,sig]);}
  if(actualSigs.length!==originalCount)actual.updateInput(vin,{tapScriptSig:actualSigs});
 }
}
function validateResponse(request:StockWireRequest,response:StockBootstrapResponse,network:StockNetworkInfo,ownerKey:string):StockBootstrapReceipt{
 const expected=txFrom(request.arkTx),returned=txFrom(response.finalArkTx);if(response.arkTxid!==expected.id)fail('operator response names another transaction.');verifyBody(returned,expected);
 const server=network.serverKey;
 for(let vin=0;vin<expected.inputsLength;vin++){
  const leaf=expected.getInput(vin).tapLeafScript![0]!,keys=scriptKeys(expected,vin),hash=leaf[1].subarray(0,-1);
  if(!keys.includes(server)||!keys.includes(ownerKey)||server===ownerKey)fail('customer leaf does not bind the pinned Arkade signer and funding owner.');
  const leafHash=tapLeafHash(hash,leaf[1].at(-1)!);
  const signatures=returned.getInput(vin).tapScriptSig??[];
  if(signatures.some(([,signature])=>signature.length!==64))fail('genesis uses an unsupported non-default Taproot signature hash type.');
  if(signatures.some(([key])=>!same(key.leafHash,leafHash)||!keys.includes(hex.encode(key.pubKey))))fail('operator returned signatures for a different leaf or signer.');
  try{verifyTapscriptSignatures(returned,vin,[server],[],undefined,leafHash);verifyTapscriptSignatures(returned,vin,keys,[],undefined,leafHash);}catch{return fail('operator response does not complete a valid owner-plus-Arkade spend.');}
 }
 const expectedCps=request.checkpoints.map(txFrom),returnedCps=response.signedCheckpointTxs.map(txFrom);
 if(returnedCps.length!==expectedCps.length)fail('operator response has a different checkpoint count.');
 const seen=new Set<string>();const checkpoints=expectedCps.map((local)=>{
  const matches=returnedCps.filter(tx=>tx.id===local.id);if(matches.length!==1||seen.has(local.id))return fail('operator response checkpoint identity differs from the exact request.');seen.add(local.id);
  const tx=matches[0]!;verifyBody(tx,local);const keys=scriptKeys(local,0),serverKey=network.serverKey;
  if(!keys.includes(serverKey)||!keys.includes(ownerKey))fail('checkpoint does not bind the pinned Arkade signer and funding owner.');
  const leaf=local.getInput(0).tapLeafScript![0]!,leafHash=tapLeafHash(leaf[1].subarray(0,-1),leaf[1].at(-1)!);
  if((tx.getInput(0).tapScriptSig??[]).some(([,signature])=>signature.length!==64))fail('checkpoint uses an unsupported non-default Taproot signature hash type.');
  try{verifyTapscriptSignatures(tx,0,[serverKey],[],undefined,leafHash);verifyTapscriptSignatures(tx,0,keys,[],undefined,leafHash);}catch{return fail('operator response checkpoint lacks both valid signatures.');}
  return base64.encode(tx.toPSBT());
 });
 const completed={arkTx:base64.encode(returned.toPSBT()),checkpoints},weights=stockSignedWeights(completed,false);assertStockWeightBudget(network,weights);
 return {txid:expected.id,checkpointTxids:expectedCps.map(tx=>tx.id),response:{...response,finalArkTx:completed.arkTx,signedCheckpointTxs:completed.checkpoints},checkpointPsbts:checkpoints,weights};
}

export async function buildStockGenesisPlan(args:{input:StockBootstrapInput;profile:StockProfile;ownerKey:string;identity:Identity;changeScript:Uint8Array;checkpoint:CSVMultisigTapscript.Type;network:StockNetworkInfo;hash(values:bigint[]):bigint;initialArchive:PublicProtocolCheckpoint}):Promise<StockBootstrapPlan>{
 const {txid,vout}=outpoint(`${args.input.txid}:${args.input.vout}`);if(args.input.value<330||!Number.isSafeInteger(args.input.value))fail('selected customer VTXO is below the pool carrier or has an invalid value.');
 const source=Transaction.fromRaw(hex.decode(args.input.sourceTxHex)),tree=VtxoScript.decode(hex.decode(args.input.tapTreeHex)),leaf=tree.findLeaf(args.input.leafHex),previous=source.getOutput(vout);
 if(source.id!==txid||!previous||previous.amount!==BigInt(args.input.value)||!same(previous.script,tree.pkScript)||args.input.value<330)fail('selected outpoint, source transaction, value, or wallet script is not authenticated.');
 const change=args.input.value-330;if(change>0&&change<330)fail('selected coin cannot fund both the 330-sat pool carrier and Arkade dust change.');
 const extension=Extension.create([new UnknownPacket(0x87,(()=>{let n=BigInt(stockStateCommitment(args.hash,args.initialArchive.state));const b=new Uint8Array(32);for(let i=0;i<32;i++){b[i]=Number(n&255n);n>>=8n;}return b;})()),new UnknownPacket(0x88,Uint8Array.of(17))]);
 const outputs:[{script:Uint8Array;amount:bigint},...{script:Uint8Array;amount:bigint}[]]=[{script:args.profile.vtxo.pkScript,amount:330n},...(change?[{script:args.changeScript,amount:BigInt(change)}]:[]),extension.txOut()];
 const built=buildOffchainTx([{txid,vout,value:args.input.value,tapTree:tree.encode(),tapLeafScript:leaf}],outputs,args.checkpoint);setArkPsbtField(built.arkTx,0,PrevArkTxField,source.toBytes(true,true));
 const ark=await args.identity.sign(built.arkTx,[0]),checkpoints=built.checkpoints.slice();if(checkpoints.length!==1)fail('genesis must produce one checkpoint per exact customer input.');checkpoints[0]=await args.identity.sign(checkpoints[0]!,[0]);
 const request={arkTx:base64.encode(ark.toPSBT()),checkpoints:checkpoints.map(tx=>base64.encode(tx.toPSBT()))},weights=stockSignedWeights(request,true);assertStockWeightBudget(args.network,weights);
 return {outpoint:`${txid}:${vout}`,selectedInputFingerprint:stockJournalFingerprint(args.input),txid:ark.id,checkpointTxids:checkpoints.map(tx=>tx.id),request,poolScriptHex:hex.encode(args.profile.vtxo.pkScript),poolValue:330,changeValue:change,...(change?{changeScriptHex:hex.encode(args.changeScript)}:{}),releaseFingerprint:'',initialArchive:{version:1,protocol:args.initialArchive,participants:{},head:{txid:ark.id,vout:0,value:330,sourceTxHex:hex.encode(ark.toBytes(true,true))},phase:17,history:[]}};
}

export function verifyStockGenesisResponse(request:StockWireRequest,response:StockBootstrapResponse,network:StockNetworkInfo,ownerKey:string):StockBootstrapReceipt{return validateResponse(request,response,network,ownerKey);}

export async function createStockBootstrap(options:StockBootstrapServices){
 validatePin(options.pin,options.profile);if(options.profile.programsHashHex!==options.programs.programsHashHex)fail('compiled program manifest changed.');
 if(options.pin.artifactsHash!==stockJournalFingerprint(options.proving)||sha(hex.decode(options.checkpointTapscript))!==options.pin.checkpointHash)fail('proof or checkpoint manifest does not match its immutable release pin.');
 const validateWeightEvidence=()=>{
  const evidence=options.weightEvidence;
  if(!evidence||evidence.version!==1||evidence.network!=='mutinynet'||evidence.qualification!=='local-native-service-all-nine'||evidence.fundedMutinynet!==false||evidence.nativeAdmission!=='unverified')fail('bootstrap requires local all-nine native-service qualification; funded Mutinynet admission remains unverified.');
  const expectedDelay=options.pin.networkInfo.exitDelay,poolTapTreeHash=sha(options.profile.tapTree);
  if(evidence.descriptorProfileId!==options.pin.descriptorProfileId||evidence.programsHash!==options.pin.programsHash||evidence.artifactsHash!==options.pin.artifactsHash||evidence.serverKey!==options.pin.serverKey||evidence.emulatorKey!==options.pin.emulatorKey||evidence.checkpointHash!==options.pin.checkpointHash||evidence.exitDelay.type!==expectedDelay.type||evidence.exitDelay.value!==expectedDelay.value||evidence.targetWeightLimit!==options.pin.networkInfo.weightLimit||evidence.poolTapTreeHash!==poolTapTreeHash||evidence.signatureModel!=='64-byte-default-sighash')fail('local qualification does not bind the exact verifier, artifacts, target keys, checkpoint, exit policy, pool tree, and signature model.');
  const required:StockQualificationPath[]=['prepare','transfer','deposit','withdraw','withdraw-funded','seal','exit-prepare','exit-withdraw','exit-withdraw-funded'];
  if(!evidence.paths||Object.keys(evidence.paths).length!==required.length||required.some(name=>!evidence.paths[name])||Object.keys(evidence.paths).some(name=>!required.includes(name as StockQualificationPath)))fail('qualification must execute every one of the nine immutable stock covenant paths.');
  for(const name of required){
   const path=evidence.paths[name],isExit=name.startsWith('exit-');
   if(path.kind!==(isExit?'bitcoin-onchain-exit':'arkade-offchain')||path.executed!==true||path.backend!==(isExit?'pinned-emulator.SubmitOnchainTx':'pinned-emulator.SubmitTx')||!/^[0-9a-f]{64}$/.test(path.evidenceHash)||!Number.isSafeInteger(path.txWU)||path.txWU<1||path.txWU>4000||!Array.isArray(path.checkpointWU)||path.checkpointWU.some(weight=>!Number.isSafeInteger(weight)||weight<1||weight>4000))fail(`invalid local native execution or 4000 WU weight evidence for ${name}.`);
   if(isExit){if(path.checkpointWU.length!==0)fail(`Bitcoin CSV exit ${name} must not claim Arkade checkpoints.`);}
   else if(path.checkpointWU.length===0||path.txWU>options.pin.networkInfo.weightLimit||path.checkpointWU.some(weight=>weight>options.pin.networkInfo.weightLimit))fail(`Arkade path ${name} must include checkpoint weights within min(operator limit, 4000 WU).`);
  }
 };
 const pinHash=stockJournalFingerprint(options.pin);let saved:Saved|undefined=options.store.load<Saved>();if(saved){
  if(saved.version!==1||saved.pinHash!==pinHash||stockJournalFingerprint(saved.pin)!==pinHash)fail('existing genesis journal belongs to a different release or network; refusing replacement.');
  const plan=saved.plan;if(!plan||!['planned','submit-started','response-verified','finalize-started','unknown-submit','unknown-finalize','finalized','indexed'].includes(saved.stage)||!/^([0-9a-f]{64}):(?:0|[1-9][0-9]*)$/.test(plan.outpoint)||!/^[0-9a-f]{64}$/.test(plan.selectedInputFingerprint))fail('persisted bootstrap journal is malformed.');validatePlan(plan,options);const releaseFingerprint=stockBootstrapReleaseFingerprint(saved.pin,plan.txid);if(plan.releaseFingerprint!==releaseFingerprint||(saved.approvedReleaseFingerprint!==undefined&&saved.approvedReleaseFingerprint!==releaseFingerprint))fail('saved release fingerprint does not match the exact genesis and immutable deployment.');
  if(['response-verified','finalize-started','unknown-finalize','finalized','indexed'].includes(saved.stage)!==!!saved.receipt)fail('persisted accepted response does not agree with the recovery phase.');
  if(saved.receipt){const verified=verifyStockGenesisResponse(plan.request,saved.receipt.response,options.pin.networkInfo,options.ownerKey);if(verified.txid!==saved.receipt.txid||verified.checkpointTxids.join(',')!==saved.receipt.checkpointTxids.join(',')||saved.receipt.checkpointPsbts.join(',')!==verified.checkpointPsbts.join(','))fail('persisted accepted response failed integrity verification.');}
 }
 let state=saved;const persist=(value:Saved)=>{options.store.save(value);state=value;};
 const status=()=>state?{phase:state.stage,outpoint:state.plan.outpoint,txid:state.plan.txid,blocked:['submit-started','unknown-submit','finalize-started','unknown-finalize'].includes(state.stage)}:{phase:'empty' as const,blocked:false};
 const plan=async(exact:string)=>{
  const point=outpoint(exact);if(state){if(state.plan.outpoint!==exact)fail('this journal is bound to another selected customer outpoint; it never falls through to another coin.');if(state.stage!=='planned')return structuredClone(state.plan);return structuredClone(state.plan);}
  const input=await options.input(exact);if(!input||input.txid!==point.txid||input.vout!==point.vout)fail('the exact selected coin is no longer available; no alternate outpoint will be selected.');
  const publicProtocol=await createPublicProtocol({recipients:{},stockOnly:true,stockProofBackend:options.backend,stockVerifierKey:options.profile.verifierKey});
  const archive=publicProtocol.publicCheckpoint();const candidate=await buildStockGenesisPlan({input,profile:options.profile,ownerKey:options.ownerKey,identity:options.identity,changeScript:options.changeScript,checkpoint:options.checkpoint,network:options.pin.networkInfo,hash:options.hash,initialArchive:archive});candidate.releaseFingerprint=stockBootstrapReleaseFingerprint(options.pin,candidate.txid);
  validatePlan(candidate,options);
  if(candidate.txid!==Transaction.fromPSBT(base64.decode(candidate.request.arkTx)).id)fail('genesis transaction id changed during construction.');
  const value:Saved={version:1,pinHash,pin:structuredClone(options.pin),stage:'planned',plan:candidate};persist(value);return structuredClone(candidate);
 };
 let busy=false;
 const reconcileInternal=async()=>{
  if(!state)return {resolved:true,phase:'empty' as const};
  if(state.stage==='unknown-submit'||state.stage==='submit-started'){
   const response=await options.lookup(state.plan.request);if(!response)return {resolved:false,phase:state.stage};
   const receipt=verifyStockGenesisResponse(state.plan.request,response,state.pin.networkInfo,options.ownerKey);persist({...state,stage:'response-verified',receipt,error:undefined});
  }else if(state.stage==='unknown-finalize'||state.stage==='finalize-started'){
   const indexed=await options.indexed(state.plan,state.receipt!);if(!indexed)return {resolved:false,phase:state.stage};persist({...state,stage:'indexed',error:undefined});
  }
  if(state.stage==='finalized'){
   if(!await options.indexed(state.plan,state.receipt!))return {resolved:false,phase:state.stage};
   persist({...state,stage:'indexed'});
  }
  if(state.stage==='indexed'){
   const releasePin=deploymentPin(state.pin,state.plan.txid),fingerprint=stockJournalFingerprint(releasePin),target=join(resolve(options.releaseRoot),fingerprint);
   mkdirSync(resolve(options.releaseRoot),{recursive:true});
   if(!existsSync(target))mkdirSync(target,{recursive:false});
   if(!lstatSync(target).isDirectory()||lstatSync(target).isSymbolicLink())fail('release fingerprint path is not a private directory.');
   try{
    const expectedFiles=['stock-combined.manifest.json','stock-combined.vkey.json','stock-combined.wasm','stock-combined.zkey'];if(Object.keys(options.artifactFiles).map(name=>name==='stock-combined_js/stock-combined.wasm'?'stock-combined.wasm':name).sort().join(',')!==expectedFiles.join(','))fail('release copy map does not match the complete pinned proving bundle.');
    for(const [name,source] of Object.entries(options.artifactFiles)){
     const parts=name.split(/[\\/]/);if(parts.some(part=>!/^[a-zA-Z0-9._-]+$/.test(part)||part==='.'||part==='..'))fail('artifact filename is unsafe.');
     const destination=join(target,...parts),sourceBytes=readFileSync(source),artifactName=name==='stock-combined_js/stock-combined.wasm'?'stock-combined.wasm':name;
     if(artifactName==='stock-combined.manifest.json'){let parsed:unknown;try{parsed=JSON.parse(sourceBytes.toString('utf8'));}catch{return fail('proving manifest source is malformed.');}if(stockJournalFingerprint(parsed)!==stockJournalFingerprint(options.proving))fail('proving manifest source differs from its immutable release pin.');}
     else{const pin=options.proving.artifacts[artifactName as keyof StockArtifactManifest['artifacts']];if(!pin||sourceBytes.byteLength!==pin.size||sha(sourceBytes)!==pin.sha256)fail('proving artifact source differs from its immutable size/hash pin: '+artifactName+'.');}
     let parent=target;for(const part of parts.slice(0,-1)){parent=join(parent,part);if(existsSync(parent)){const stat=lstatSync(parent);if(stat.isSymbolicLink()||!stat.isDirectory())fail('release artifact path contains a symlink or non-directory.');}else mkdirSync(parent);}
     if(existsSync(destination)){const stat=lstatSync(destination);if(stat.isSymbolicLink()||!stat.isFile()||sha(readFileSync(destination))!==sha(sourceBytes))fail('partial release artifact differs from its pinned source; refusing overwrite.');continue;}
     const fd=openSync(destination,'wx',0o644);try{writeFileSync(fd,sourceBytes);}finally{closeSync(fd);}
    }
    const release={version:1,pin:releasePin,programs:options.programs,proving:options.proving,checkpointTapscript:options.checkpointTapscript,genesis:state.plan.initialArchive},deploymentPath=join(target,'deployment.json'),expected=JSON.stringify(release,null,2)+'\n';
    if(existsSync(deploymentPath)){const stat=lstatSync(deploymentPath);if(stat.isSymbolicLink()||!stat.isFile()||readFileSync(deploymentPath,'utf8')!==expected)fail('release destination contains different immutable deployment data; refusing overwrite.');}
    else{const fd=openSync(deploymentPath,'wx',0o644);try{writeFileSync(fd,expected);}finally{closeSync(fd);}}
   }catch(error){throw new Error('Accepted stock genesis is indexed, but immutable release publishing is incomplete and must be resumed at the same fingerprint.',{cause:error});}
   persist({...state,stage:'indexed'});return {resolved:true,phase:'indexed',releaseDirectory:target,txid:state.plan.txid};
  }
  return {resolved:state.stage==='planned'||state.stage==='finalized',phase:state.stage};
 };
 const applyInternal=async(exact:string)=>{
  if(!state)await plan(exact);
  if(!state||state.plan.outpoint!==exact)fail('apply must use the exact journaled customer outpoint.');
  if(state.stage==='unknown-submit'||state.stage==='unknown-finalize'||state.stage==='submit-started'||state.stage==='finalize-started')fail('transaction outcome is unresolved; only read-only reconciliation of the same identities is allowed.');
  if(state.stage==='planned'){
   validateWeightEvidence();
   const expected=stockBootstrapReleaseFingerprint(state.pin,state.plan.txid),authorization=options.expectedReleaseFingerprint;
   if(!state.approvedReleaseFingerprint){if(typeof authorization!=='string'||!/^[0-9a-f]{64}$/.test(authorization)||authorization!==expected)fail('live apply requires the exact independently approved immutable release fingerprint.');persist({...state,approvedReleaseFingerprint:authorization});}
   else if(state.approvedReleaseFingerprint!==expected||(authorization!==undefined&&authorization!==state.approvedReleaseFingerprint))fail('saved release approval does not match this exact genesis and immutable deployment.');
   const current=await options.input(exact);if(!current||stockJournalFingerprint(current)!==state.plan.selectedInputFingerprint)fail('the exact journaled customer coin is no longer identical and spendable; no alternate outpoint will be used.');
   persist({...state,stage:'submit-started'});
   let response:StockBootstrapResponse;try{response=await options.submit(state.plan.request);}catch(error){persist({...state,stage:'unknown-submit',error:error instanceof Error?error.message:'unknown submit outcome'});throw error;}
   try{const receipt=verifyStockGenesisResponse(state.plan.request,response,state.pin.networkInfo,options.ownerKey);persist({...state,stage:'response-verified',receipt});}
   catch(error){persist({...state,stage:'unknown-submit',error:'unverified operator response'});throw error;}
  }
  if(state.stage==='response-verified'){
   persist({...state,stage:'finalize-started'});
   try{await options.finalize(state.receipt!.txid,state.receipt!.checkpointPsbts);persist({...state,stage:'finalized'});}
   catch(error){persist({...state,stage:'unknown-finalize',error:error instanceof Error?error.message:'unknown finalize outcome'});throw error;}
  }
  return reconcileInternal();
 };
 const planInternal=plan;
 return {status,plan:async(exact:string)=>{if(busy)fail('another stock bootstrap operation is already running.');busy=true;try{return await planInternal(exact);}finally{busy=false;}},apply:async(exact:string)=>{if(busy)fail('another stock bootstrap operation is already running.');busy=true;try{return await applyInternal(exact);}finally{busy=false;}},reconcile:async()=>{if(busy)fail('another stock bootstrap operation is already running.');busy=true;try{return await reconcileInternal();}finally{busy=false;}}};
}
