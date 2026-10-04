import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {hex} from '@scure/base';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {createPublicProtocol} from '../../packages/protocol/src/index.ts';
import type {Owner,PublicRecipient,PublicProtocolCheckpoint,PreparedSettlement,ClientProtocolKernel} from '../../packages/protocol/src/types.ts';
import {createSdkRuntime,type NativeCheckpoint,type NativeReceipt,type NativeSubmission,type SdkRuntime} from '../sdk/runtime.ts';
import {EngineStore} from '../storage.ts';
export interface Participant {recipient:PublicRecipient;nativePublicKey:string}
interface Saved {version:1;participants:Partial<Record<Owner,Participant>>;protocol?:PublicProtocolCheckpoint;native?:NativeCheckpoint;accepted:Record<string,{fingerprint:string;receipt:NativeReceipt}>;journal?:{stage:'submitted'|'accepted';prepared:PreparedSettlement;submission:NativeSubmission;receipt?:NativeReceipt}}
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function createPublicCoordinator(directory:string){
 const store=EngineStore.open(directory);let saved:Saved=store.load<Saved>()??{version:1,participants:{},accepted:{}};
 if(saved.version!==1){store.close();throw new Error('Unsupported public coordinator checkpoint');}
 let protocol:ClientProtocolKernel|undefined,native:SdkRuntime|undefined,busy=false,blocked='';
 const registryFile=join(directory,'registry.json');
 const persist=()=>store.save(saved);
 const initialize=async()=>{
  if(!saved.participants.alice||!saved.participants.bob)return;
  const recipients={alice:saved.participants.alice.recipient,bob:saved.participants.bob.recipient};
  protocol=await createPublicProtocol({recipients,checkpoint:saved.protocol});
  const registry={file:registryFile,recipientPublicKeys:{alice:saved.participants.alice.nativePublicKey,bob:saved.participants.bob.nativePublicKey}};
  native=await createSdkRuntime({verificationKeys:protocol.verificationKeys(),initialState:saved.native?.state??protocol.snapshot().state,registry,checkpoint:saved.native,
   onSubmission:async(prepared,submission)=>{saved={...saved,protocol:protocol!.publicCheckpoint(),native:native!.exportState(),journal:{stage:'submitted',prepared,submission}};persist();},
   onCheckpoint:async(checkpoint)=>{const receipt=checkpoint.receipts.at(-1);if(!saved.journal||!receipt||receipt.id!==saved.journal.prepared.id)throw new Error('Unmatched acceptance journal');saved={...saved,native:checkpoint,journal:{...saved.journal,stage:'accepted',receipt}};persist();}});
  if(saved.journal?.stage==='accepted'){
   const journal=saved.journal;if(!journal.receipt)throw new Error('Missing accepted receipt');const restored=await protocol.restorePrepared(journal.prepared);await protocol.commit(restored,journal.receipt);saved.accepted[restored.id]={fingerprint:fingerprint(journal.prepared),receipt:journal.receipt};saved.protocol=protocol.publicCheckpoint();delete saved.journal;persist();
  }else if(saved.journal){blocked='A submitted signing outcome is unresolved. Read-only reconciliation is required before any new settlement.';}
  else{saved.protocol=protocol.publicCheckpoint();saved.native=native.exportState();persist();}
 };
 try{await initialize();}catch(error){await native?.close();store.close();throw error;}
 const profile=()=>({version:1,phase:protocol&&native?'ready':protocol?'initializing':'registration',participants:structuredClone(saved.participants),proofSystem:'groth16-bn254',setup:'single-party-development-only',network:'local-emulator',funding:'synthetic treasury fixture',custody:'client keys',verifier:'independent registered Arkade VM',ready:!!protocol&&!!native&&!blocked,blockedReason:blocked,destinations:native?{alice:native.destination('alice'),bob:native.destination('bob')}:undefined,verificationKeys:protocol?.verificationKeys(),limitations:['Requires the registry extension on the operator emulator','Development ceremony; no real-value deployment','Single serial lane and depth-8 demonstration trees','No independent note-holder exit from pooled BTC']});
 const archive=()=>{if(!protocol||!native)throw new Error('Register both public participants first');return {archive:protocol.publicCheckpoint(),native:native!.snapshot(),profile:profile()};};
 const submit=async(input:PreparedSettlement)=>{
  if(busy)throw new Error('Another settlement is in flight');if(blocked)throw new Error(blocked);if(!protocol||!native)throw new Error('Coordinator is not initialized');
  const fp=fingerprint(input),known=saved.accepted[input.id];if(known){if(known.fingerprint!==fp)throw new Error('Settlement ID reused with a different payload');return {receipt:structuredClone(known.receipt),...archive(),replay:true};}
  let started=false;busy=true;try{const prepared=await protocol.restorePrepared(input);started=true;const receipt=await native.settle(prepared);await protocol.commit(prepared,receipt);saved={...saved,protocol:protocol.publicCheckpoint(),native:native.exportState(),accepted:{...saved.accepted,[prepared.id]:{fingerprint:fp,receipt}}};delete saved.journal;persist();return {receipt,...archive(),replay:false};}catch(error){if(started||saved.journal)blocked='A settlement is journaled. Reconcile or restart before proceeding; unknown outcomes are never resubmitted.';throw error;}finally{busy=false;}
 };
 return {profile,archive,submit,register:async(owner:Owner,participant:Participant)=>{
  if(busy||protocol||saved.protocol||saved.journal)throw new Error('Participant registry is already frozen');if(owner!=='alice'&&owner!=='bob')throw new Error('Unknown participant');if(saved.participants[owner]){if(fingerprint(saved.participants[owner])!==fingerprint(participant))throw new Error('Participant already registered');return profile();}
  if(!/^[0-9a-f]{64}$/.test(participant.nativePublicKey))throw new Error('Invalid native public key');secp256k1.Point.fromHex('02'+participant.nativePublicKey);
  busy=true;try{await createPublicProtocol({recipients:{alice:participant.recipient,bob:participant.recipient}});
  const candidate={...saved.participants,[owner]:structuredClone(participant)};if(candidate.alice&&candidate.bob){const verifier=await createPublicProtocol({recipients:{alice:candidate.alice.recipient,bob:candidate.bob.recipient}});if(verifier.publicCheckpoint().recipients.alice.owner===verifier.publicCheckpoint().recipients.bob.owner)throw new Error('Participants must have distinct spend owners');}
  saved={...saved,participants:candidate};persist();await initialize();return profile();}finally{busy=false;}
 },seal:async()=>{if(!protocol||blocked||busy)throw new Error(blocked||'Coordinator unavailable');busy=true;let prepared;try{prepared=await protocol.prepareSeal();}finally{busy=false;}return submit(prepared);},close:async()=>{await native?.close();store.close();}};
}
export type PublicCoordinator=Awaited<ReturnType<typeof createPublicCoordinator>>;
