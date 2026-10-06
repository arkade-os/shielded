import {sha256} from '@noble/hashes/sha2.js';
import {base64,hex} from '@scure/base';
import {CSVMultisigTapscript,Extension,RestIndexerProvider,Transaction,VtxoScript} from '@arkade-os/sdk';
// @ts-ignore upstream library has no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore browser export is selected by Vite.
import * as snarkjs from 'snarkjs';
import {Kernel} from '../../packages/protocol/src/core.ts';
import {createStockGroth16ProofBackend} from '../../packages/protocol/src/stock-proof.ts';
import {stockStateCommitment} from '../../packages/protocol/src/stock-native.ts';
import {verifyParticipantRegistration} from '../../packages/protocol/src/registration.ts';
import type {ProtocolState,PublicProtocolCheckpoint} from '../../packages/protocol/src/types.ts';
import type {StockPublicArchive,StockHead} from './coordinator.ts';
import type {StockReleasePin} from './journal.ts';
import type {StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import {stockProofDescriptor} from '../../packages/protocol/src/stock-native.ts';
import {buildStockSpend,loadStockProfile,type StockProgramManifest,type StockSpendRequest} from './sdk.ts';
import {verifyStockResponse} from './transport.ts';
import {MUTINY_ARK_URL,MUTINY_EMULATOR_URL,preflightStockMutinynet,type StockNetworkInfo} from './network.ts';
import {decodeStockIndexerTransaction} from './indexer.ts';

export interface StockArchiveProfile {
 release:StockReleasePin;programs:StockProgramManifest;verifierKey:unknown;network:StockNetworkInfo;
 checkpointTapscript:string;genesis:StockPublicArchive;registration:{network:'mutinynet';profile:string};provingManifest:StockArtifactManifest;
}
export interface VerifiedStockHead {txid:string;vout:number;revision:number}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function canonical(value:any):string {
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 throw new Error('Archive contains noncanonical public data.');
}
const fingerprint=(value:unknown)=>hex.encode(sha256(new TextEncoder().encode(canonical(value))));
export const stockReleaseFingerprint=(value:StockReleasePin)=>fingerprint(value);
const withdrawal=(operation:string)=>operation==='withdraw'||operation==='withdraw-funded';

export async function replayStockArchive(profile:StockArchiveProfile,archive:StockPublicArchive,previous?:VerifiedStockHead):Promise<{checkpoint:PublicProtocolCheckpoint;head:VerifiedStockHead}> {
 const {release,network,genesis}=profile;
 if(release.version!==1||release.serverKey!==network.serverKey||release.emulatorKey!==network.emulatorKey||release.genesisTxid!==genesis.head.txid||fingerprint(release)!==profile.registration.profile||profile.registration.network!=='mutinynet')throw new Error('Archive deployment or registration identity changed.');
 if(hex.encode(sha256(hex.decode(profile.checkpointTapscript)))!==release.checkpointHash)throw new Error('Archive checkpoint policy changed.');
 if(fingerprint(profile.provingManifest)!==release.artifactsHash||!equal(profile.provingManifest.profile,stockProofDescriptor(profile.verifierKey)))throw new Error('Archive proving artifacts differ from the trusted release.');
 const policy=loadStockProfile(profile.programs,profile.verifierKey,release.descriptorProfileId,network,release.programsHash);
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);
 const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
 const backend=createStockGroth16ProofBackend({prove:async()=>{throw new Error('Archive verification cannot prove.');},verify:(vk,signals,proof)=>snarkjs.groth16.verify(vk,signals,proof)});
 const kernel=new Kernel(poseidon,baby,{randomBytes:length=>crypto.getRandomValues(new Uint8Array(length)),vkeys:{},stockOnly:true,stockProof:backend,stockVerifierKey:profile.verifierKey},'public',undefined,undefined,{});
 if(genesis.version!==1||genesis.phase!==17||genesis.history.length||Object.keys(genesis.participants).length||!equal(kernel.publicCheckpoint(),genesis.protocol))throw new Error('Archive genesis is not the pinned empty public state.');
 if(archive.version!==1||!Array.isArray(archive.history)||archive.history.length>3072||!archive.participants||!equal(Object.keys(archive.participants),Object.keys(archive.protocol.recipients)))throw new Error('Invalid bounded archive or participant directory.');
 for(const [owner,registration] of Object.entries(archive.participants))if(owner!==registration.owner||!equal(registration.recipient,archive.protocol.recipients[owner])||!verifyParticipantRegistration(registration,'mutinynet',profile.registration.profile))throw new Error('Archive recipient identity is not authenticated.');
 const stateHex=(state:ProtocolState)=>{let n=stockStateCommitment(hash,state);const bytes=new Uint8Array(32);for(let i=0;i<32;i++){bytes[i]=Number(n&255n);n>>=8n;}return hex.encode(bytes);};
 const verifyHead=(head:StockHead,phase:17|18)=>{
  if(!head||!Number.isSafeInteger(head.value)||head.value!==330+kernel.publicCheckpoint().state.reserves.BTC||!Number.isInteger(head.vout)||head.vout<0||!/^[0-9a-f]{64}$/.test(head.txid)||!/^(?:[0-9a-f]{2})+$/.test(head.sourceTxHex))throw new Error('Archive continuation identity or backing is invalid.');
  const tx=Transaction.fromRaw(hex.decode(head.sourceTxHex)),output=tx.getOutput(head.vout),extension=Extension.fromTx(tx);
  if(tx.id!==head.txid||!output||output.amount!==BigInt(head.value)||hex.encode(output.script!)!==hex.encode(policy.vtxo.pkScript)||extension.getPacketByType(0))throw new Error('Archive continuation changed its native backing or policy.');
  if(hex.encode(extension.getPacketByType(0x87)?.serialize()??new Uint8Array())!==stateHex(kernel.publicCheckpoint().state)||hex.encode(extension.getPacketByType(0x88)?.serialize()??new Uint8Array())!==hex.encode(Uint8Array.of(phase)))throw new Error('Archive continuation changed its state or phase.');
  for(const [type,expected] of [[0x85,policy.icPacketHex],[0x86,policy.fixedKeyPacketHex]] as const){const packet=extension.getPacketByType(type);if(phase===18?hex.encode(packet?.serialize()??new Uint8Array())!==expected:!!packet)throw new Error('Archive key publication is invalid.');}
 };
 let head=structuredClone(genesis.head),phase:17|18=17;
 verifyHead(head,phase);kernel.setRecipients(archive.protocol.recipients);
 let sawPrevious=!previous||previous.txid===head.txid&&previous.vout===head.vout&&previous.revision===0;
 const checkpoint=CSVMultisigTapscript.decode(hex.decode(profile.checkpointTapscript));
 for(const entry of archive.history){
  const auxiliary=entry.operation==='prepare'||entry.operation==='abort';
  if(phase!==(entry.operation==='prepare'?17:18)||auxiliary&&(entry.prepared||entry.proof||entry.externalFunding)||!auxiliary&&(!entry.prepared||!entry.proof))throw new Error('Archive transition has invalid proof or phase.');
  const expectedOperation=entry.prepared?.operation==='shield'?'deposit':entry.prepared?.operation==='withdraw'&&entry.externalFunding?'withdraw-funded':entry.prepared?.operation;
  if(!auxiliary&&expectedOperation!==entry.operation)throw new Error('Archive native operation differs from its proof.');
  const funding=entry.externalFunding;
  const request:StockSpendRequest={profile:policy,operation:entry.operation,pool:{...head,sourceTx:hex.decode(head.sourceTxHex)},oldState:kernel.publicCheckpoint().state,newState:entry.prepared?.newState??kernel.publicCheckpoint().state,checkpoint,hash,weightLimit:network.weightLimit,...(funding?{externalFunding:{...funding,sourceTx:hex.decode(funding.sourceTxHex),tapTree:hex.decode(funding.tapTreeHex),tapLeafScript:VtxoScript.decode(hex.decode(funding.tapTreeHex)).findLeaf(funding.leafHex)}}:{}),...(withdrawal(entry.operation)?{payoutBTC:entry.prepared!.boundary.withdrawal.BTC+(funding?.value??0),externalProgram:entry.proof!.nativeBinding.slice(274,338)}:{})};
  const rebuilt=buildStockSpend(request,entry.proof),expected={arkTx:rebuilt.arkTxPsbt,checkpoints:rebuilt.checkpointPsbts};
  const receipt=verifyStockResponse(expected,entry.receipt,network);
  if(!equal(receipt,entry.receipt))throw new Error('Archive receipt changed its authenticated signatures or weights.');
  const saved=[entry.request.arkTx,...entry.request.checkpoints],rebuiltPsbt=[expected.arkTx,...expected.checkpoints];
  if(saved.length!==rebuiltPsbt.length||saved.some((psbt,i)=>hex.encode(Transaction.fromPSBT(base64.decode(psbt)).unsignedTx)!==hex.encode(Transaction.fromPSBT(base64.decode(rebuiltPsbt[i])).unsignedTx)))throw new Error('Archive request changed the proved native transaction.');
  if(!auxiliary){const prepared=await kernel.restoreStockPrepared(entry.prepared!,entry.proof!);await kernel.commitStock(prepared,entry.proof!,receipt);}
  const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),vout=withdrawal(entry.operation)?1:0;
  head={txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))};phase=entry.operation==='prepare'?18:17;verifyHead(head,phase);
  if(previous&&previous.txid===head.txid&&previous.vout===head.vout&&previous.revision===kernel.publicCheckpoint().state.revision)sawPrevious=true;
 }
 const result=kernel.publicCheckpoint();
 if(!sawPrevious||previous&&result.state.revision<previous.revision)throw new Error('Operator archive rolled back or forked the last verified wallet head.');
 if(!equal(result,archive.protocol)||!equal(head,archive.head)||phase!==archive.phase)throw new Error('Operator archive differs from its verified proof and native history.');
 return {checkpoint:result,head:{txid:head.txid,vout:head.vout,revision:result.state.revision}};
}

export async function verifyStockArchive(profile:StockArchiveProfile,archive:StockPublicArchive,expectedReleaseFingerprint:string,previous?:VerifiedStockHead){
 if(!/^[0-9a-f]{64}$/.test(expectedReleaseFingerprint)||fingerprint(profile.release)!==expectedReleaseFingerprint)throw new Error('Server release differs from the independently trusted wallet release.');
 if(profile.release.network!=='mutinynet'||profile.network.arkUrl!==MUTINY_ARK_URL||profile.network.emulatorUrl!==MUTINY_EMULATOR_URL)throw new Error('Wallet requires the public Mutinynet operators.');
 const network=await preflightStockMutinynet({expected:{serverKey:profile.release.serverKey,emulatorKey:profile.release.emulatorKey}});
 if(!equal(network.exitDelay,profile.network.exitDelay)||profile.network.weightLimit!==network.weightLimit)throw new Error('Public operator policy changed.');
 const result=await replayStockArchive(profile,archive,previous),indexer=new RestIndexerProvider(MUTINY_ARK_URL);
 const coin=(await indexer.getVtxos({outpoints:[{txid:archive.head.txid,vout:archive.head.vout}]})).vtxos.find(v=>v.txid===archive.head.txid&&v.vout===archive.head.vout);
 const tx=(await indexer.getVirtualTxs([archive.head.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===archive.head.txid);
 const archived=Transaction.fromRaw(hex.decode(archive.head.sourceTxHex));
 if(!coin||coin.isSpent||coin.isSwept||coin.isUnrolled||coin.expiresAt&&coin.expiresAt.getTime()<=Date.now()||coin.value!==archive.head.value||coin.script!==hex.encode(archived.getOutput(archive.head.vout).script!)||!tx||hex.encode(tx.unsignedTx)!==hex.encode(archived.unsignedTx))throw new Error('Public indexer does not confirm the current unspent archive head. Reconcile before spending.');
 return result;
}
