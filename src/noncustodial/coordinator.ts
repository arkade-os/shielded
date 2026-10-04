import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {secp256k1,schnorr} from '@noble/curves/secp256k1.js';
import {createPublicProtocol} from '../../packages/protocol/src/index.ts';
import {protocolProfileFingerprint} from '../../packages/protocol/src/core.ts';
import {isValidOwner,LEGACY_OWNERS,type Owner,type PublicRecipient,type PublicProtocolCheckpoint,type PreparedSettlement,type ClientProtocolKernel} from '../../packages/protocol/src/types.ts';
import {verifyParticipantRegistration,type ParticipantAuthorization,type RegistrationNetwork,type RegistrationPayload} from '../../packages/protocol/src/registration.ts';
import {createSdkRuntime,type NativeCheckpoint,type NativeReceipt,type NativeSubmission,type SdkRuntime} from '../sdk/runtime.ts';
import {EngineStore} from '../storage.ts';
export interface Participant {recipient:PublicRecipient;nativePublicKey:string;authorization?:ParticipantAuthorization}
interface Saved {version:1;participants:Partial<Record<Owner,Participant>>;protocol?:PublicProtocolCheckpoint;native?:NativeCheckpoint;accepted:Record<string,{fingerprint:string;receipt:NativeReceipt}>;journal?:{stage:'submitted'|'accepted';prepared:PreparedSettlement;submission:NativeSubmission;receipt?:NativeReceipt}}
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function createPublicCoordinator(directory:string,options:{network?:RegistrationNetwork;allowLegacyLocalIds?:boolean}={}){
 const network=options.network??'local-emulator';
 const allowLegacyLocalIds=options.allowLegacyLocalIds??network==='local-emulator';
 const build=resolve(dirname(fileURLToPath(import.meta.url)),'../../circuits/build');
 const vkeys=Object.fromEntries(await Promise.all(['intent','transition'].map(async name=>[name,JSON.parse(await readFile(join(build,`${name}.vkey.json`),'utf8'))])));
 const registrationProfile=protocolProfileFingerprint(vkeys);
 const store=EngineStore.open(directory);let saved:Saved=store.load<Saved>()??{version:1,participants:{},accepted:{}};
 if(saved.version!==1){store.close();throw new Error('Unsupported public coordinator checkpoint');}
 let protocol:ClientProtocolKernel|undefined,native:SdkRuntime|undefined,busy=false,blocked='';
 const registryFile=join(directory,'registry.json');
 const persist=()=>store.save(saved);
 const recipientsFor=(participants:Partial<Record<Owner,Participant>>)=>Object.fromEntries(Object.entries(participants).map(([owner,value])=>[owner,value!.recipient])) as Record<Owner,PublicRecipient>;
 const nativeOptions=(participants:Partial<Record<Owner,Participant>>,candidate:ClientProtocolKernel,checkpoint?:NativeCheckpoint)=>({
  verificationKeys:candidate.verificationKeys(),initialState:checkpoint?.state??candidate.snapshot().state,
  registry:{file:registryFile,recipientPublicKeys:Object.fromEntries(Object.entries(participants).map(([owner,value])=>[owner,value!.nativePublicKey]))},checkpoint,
  onSubmission:async(prepared:PreparedSettlement,submission:NativeSubmission)=>{saved={...saved,protocol:protocol!.publicCheckpoint(),native:native!.exportState(),journal:{stage:'submitted',prepared,submission}};persist();},
  onCheckpoint:async(value:NativeCheckpoint)=>{const receipt=value.receipts.at(-1);if(!saved.journal||!receipt||receipt.id!==saved.journal.prepared.id)throw new Error('Unmatched acceptance journal');saved={...saved,native:value,journal:{...saved.journal,stage:'accepted',receipt}};persist();}
 });
 const makeRuntime=async(participants:Partial<Record<Owner,Participant>>,candidate:ClientProtocolKernel,checkpoint?:NativeCheckpoint)=>createSdkRuntime(nativeOptions(participants,candidate,checkpoint));
 const initialize=async()=>{
  const startupKeys=new Set<string>();for(const [owner,value] of Object.entries(saved.participants)){const legacy=allowLegacyLocalIds&&LEGACY_OWNERS.includes(owner as typeof LEGACY_OWNERS[number])&&!value!.authorization;if((!legacy&&(owner!==value!.nativePublicKey||!verifyParticipantRegistration({owner,recipient:value!.recipient,nativePublicKey:value!.nativePublicKey,authorization:value!.authorization!},network,registrationProfile)))||!/^[0-9a-f]{64}$/.test(value!.nativePublicKey)||startupKeys.has(value!.nativePublicKey))throw new Error('Saved participant registration is invalid');startupKeys.add(value!.nativePublicKey);}
  if(Object.keys(saved.participants).length<2)return;
  const candidate=await createPublicProtocol({recipients:recipientsFor(saved.participants),checkpoint:saved.protocol});
  const candidateNative=await makeRuntime(saved.participants,candidate,saved.native);protocol=candidate;native=candidateNative;
  if(saved.journal?.stage==='accepted'){
   const journal=saved.journal;if(!journal.receipt)throw new Error('Missing accepted receipt');const restored=await protocol.restorePrepared(journal.prepared);await protocol.commit(restored,journal.receipt);saved.accepted[restored.id]={fingerprint:fingerprint(journal.prepared),receipt:journal.receipt};saved.protocol=protocol.publicCheckpoint();saved.native=native.exportState();delete saved.journal;persist();
  }else if(saved.journal){blocked='A submitted signing outcome is unresolved. Read-only reconciliation is required before any new settlement.';}
  else{saved.protocol=protocol.publicCheckpoint();saved.native=native.exportState();persist();}
 };
 try{await initialize();}catch(error){await native?.close();store.close();throw error;}
 const profile=()=>({version:1,profile:protocol?.publicCheckpoint().profile??registrationProfile,capacity:{treeDepth:8,noteCapacity:256,remainingNoteRecords:256-(protocol?.snapshot().state.noteCount??0),maximumNonSealOperations:128},phase:protocol&&native?'ready':'registration',participants:structuredClone(saved.participants),registration:{scheme:'schnorr-xonly-v1',network,profile:registrationProfile,minimumParticipants:2},proofSystem:'groth16-bn254',setup:'single-party-development-only',network,funding:'synthetic treasury fixture',custody:'client keys',verifier:'independent registered Arkade VM',ready:!!protocol&&!!native&&!blocked,blockedReason:blocked,destinations:native?Object.fromEntries(Object.keys(saved.participants).map(owner=>[owner,native!.destination(owner)])):undefined,verificationKeys:protocol?.verificationKeys(),limitations:['Requires the registry extension on the operator emulator','Development ceremony; no real-value deployment','Single serial lane and depth-8 demonstration trees','No independent note-holder exit from pooled BTC']});
 const archive=()=>{if(!protocol||!native)throw new Error('Register at least two public participants first');return {archive:protocol.publicCheckpoint(),native:native!.snapshot(),profile:profile()};};
 const submit=async(input:PreparedSettlement)=>{
  if(busy)throw new Error('Another settlement is in flight');if(blocked)throw new Error(blocked);if(!protocol||!native)throw new Error('Coordinator is not initialized');
  const fp=fingerprint(input),known=saved.accepted[input.id];if(known){if(known.fingerprint!==fp)throw new Error('Settlement ID reused with a different payload');return {receipt:structuredClone(known.receipt),...archive(),replay:true};}
  let accepted=false;busy=true;try{const prepared=await protocol.restorePrepared(input);const receipt=await native.settle(prepared);accepted=true;await protocol.commit(prepared,receipt);saved={...saved,protocol:protocol.publicCheckpoint(),native:native.exportState(),accepted:{...saved.accepted,[prepared.id]:{fingerprint:fp,receipt}}};delete saved.journal;persist();return {receipt,...archive(),replay:false};}catch(error){if(accepted||saved.journal)blocked='A settlement is journaled. Reconcile or restart before proceeding; unknown outcomes are never resubmitted.';throw error;}finally{busy=false;}
 };
 return {profile,archive,submit,register:async(owner:Owner,participant:Participant)=>{
  if(busy||blocked||saved.journal)throw new Error(blocked||'Participant registration cannot run during a settlement');
  if(!isValidOwner(owner)||!participant)throw new Error('Invalid public participant identity');
  const legacy=allowLegacyLocalIds&&LEGACY_OWNERS.includes(owner as typeof LEGACY_OWNERS[number])&&!participant.authorization;
  if(!legacy&&owner!==participant.nativePublicKey)throw new Error('Public participant ID must equal its native public key');
  if(saved.participants[owner]){if(fingerprint(saved.participants[owner])!==fingerprint(participant))throw new Error('Participant already registered');return profile();}
  if(!/^[0-9a-f]{64}$/.test(participant.nativePublicKey))throw new Error('Invalid native public key');secp256k1.Point.fromHex('02'+participant.nativePublicKey);
  if(Object.values(saved.participants).some(existing=>existing?.nativePublicKey===participant.nativePublicKey))throw new Error('Native participant key is already registered');
  const signed:RegistrationPayload={owner,recipient:participant.recipient,nativePublicKey:participant.nativePublicKey,authorization:participant.authorization!};
  if(!legacy&&!verifyParticipantRegistration(signed,network,registrationProfile))throw new Error('Participant registration signature is invalid');
  if(participant.authorization&&participant.authorization.network!==network)throw new Error('Participant registration network mismatch');
  busy=true;let candidateNative:SdkRuntime|undefined;try{
   const candidateParticipants={...saved.participants,[owner]:structuredClone(participant)};const descriptors=recipientsFor(candidateParticipants);
   const candidateProtocol=await createPublicProtocol({recipients:descriptors,checkpoint:saved.protocol});
   if(Object.keys(candidateParticipants).length<2){const next={...saved,participants:candidateParticipants};store.save(next);saved=next;return profile();}
   const registryBefore=native?await readFile(registryFile):undefined;
   candidateNative=await makeRuntime(candidateParticipants,candidateProtocol,saved.native);
   if(registryBefore){const registryAfter=await readFile(registryFile);if(!registryBefore.equals(registryAfter))throw new Error('Participant append changed the native registry program set');}
   const before=native?.exportState(),after=candidateNative.exportState();
   if(before){for(const field of ['network','domain','state','serverKey','emulatorKey','checkpointScript','identities','issuanceRaw','genesisRaw','heads','funding'] as const)if(JSON.stringify(before[field])!==JSON.stringify(after[field]))throw new Error(`Participant append changed native ${field}`);
    const priorPrograms=native!.compiledArtifacts(),nextPrograms=candidateNative.compiledArtifacts();for(const key of ['gate','lane','btcVault','tokenVault'])if(JSON.stringify(priorPrograms[key])!==JSON.stringify(nextPrograms[key]))throw new Error(`Participant append changed native ${key} verifier program`);
   }
   const next={...saved,participants:candidateParticipants,protocol:candidateProtocol.publicCheckpoint(),native:after};
   store.save(next);const previous=native;saved=next;protocol=candidateProtocol;native=candidateNative;candidateNative=undefined;await previous?.close();return profile();
  }finally{await candidateNative?.close();busy=false;}
 },seal:async()=>{if(!protocol||blocked||busy)throw new Error(blocked||'Coordinator unavailable');busy=true;let prepared;try{prepared=await protocol.prepareSeal();}finally{busy=false;}return submit(prepared);},close:async()=>{await native?.close();store.close();}};
}
export type PublicCoordinator=Awaited<ReturnType<typeof createPublicCoordinator>>;
