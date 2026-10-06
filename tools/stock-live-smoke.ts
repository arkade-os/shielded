import {createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {base64,hex} from '@scure/base';
import {CSVMultisigTapscript,MultisigTapscript,RestArkProvider,RestIndexerProvider,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import {createClientProtocol} from '../packages/protocol/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {signParticipantRegistration,type RegistrationPayload} from '../packages/protocol/src/registration.ts';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../packages/protocol/src/stock-proof-node.ts';
import {stockJournalFingerprint} from '../src/stock/journal.ts';
import {stockReleaseFingerprint,verifyStockArchive,type StockArchiveProfile} from '../src/stock/archive-client.ts';
import type {StockPreparedSettlement,PublicProtocolCheckpoint} from '../packages/protocol/src/types.ts';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';
import type {StockSettlementProof} from '../packages/protocol/src/stock-native.ts';
import {loadStockProfile,buildStockSpend,stockVmRequest,type StockProgramManifest,type StockProfile,type StockDraft} from '../src/stock/sdk.ts';
import {EngineStore} from '../src/storage.ts';
import {openCustomerArkWallet,type CustomerVtxo} from '../src/stock/ark-wallet.ts';
import {preflightStockMutinynet,type StockNetworkInfo} from '../src/stock/network.ts';
import type {StockPublicArchive,StockPublicFunding,StockHistoryEntry} from '../src/stock/coordinator.ts';
import type {StockNativeReceipt,StockWireRequest} from '../src/stock/transport.ts';

type PartyName='alice'|'bob'|'carol';
type UnsealedProbeEvidence={status:'rejected-as-unsealed';head:string;fromOwner:string;toOwner:string;checkedAt:string};
type Party={name:PartyName;master:string;material:ReturnType<typeof deriveWalletKeyMaterial>;identity:SingleKey;owner:string;tree:VtxoScript;forfeit:Uint8Array;registration:RegistrationPayload;client:Awaited<ReturnType<typeof createClientProtocol>>};
type Pending={name:string;kind:'participant'|'prepare'|'settlement'|'verify-only';before:{head:string;vout:number;phase:17|18;historyLength:number;revision:number};prepared?:StockPreparedSettlement;proof?:StockSettlementProof;externalFunding?:StockPublicFunding;signed?:StockWireRequest;expectedTxids?:string[];registration?:RegistrationPayload;createdAt:string};
type Saved={version:1;purpose:'stock-live-smoke';network:'mutinynet';releaseFingerprint:string;softwareImageDigest:string;aliceOutpoint?:string;bobMaster:string;carolMaster:string;registrations?:Partial<Record<PartyName,RegistrationPayload>>;completed:Record<string,{txid?:string;checkpointTxids?:string[];weights?:{ark:number;checkpoints:number[]};acceptedAt:string}>;fundingCoins:Record<string,StockPublicFunding>;unsealedProbe?:UnsealedProbeEvidence;pending?:Pending;restart?:{verified:boolean;head:string;archiveHash:string;releaseFingerprint:string;softwareImageDigest:string;recoveryBalances?:Record<PartyName,number>;beforeContainer?:{id:string;startedAt:string;image:string;volume:string};afterContainer?:{id:string;startedAt:string;image:string;volume:string}};restartBoundaryReached:boolean;startedAt:string};
type ServerProfile=StockArchiveProfile & {version:number;programs:StockProgramManifest;phase:17|18;head:StockPublicArchive['head'];ready:boolean;participants:Record<string,RegistrationPayload>;capacity?:unknown};
const ROOT=process.cwd();
const STORE_DIR=resolve('.recovery/stock-live-smoke');
const FUNDING_DIR=resolve('.recovery/stock-funding-wallet');
const LEDGER_FILE=resolve('validation/stock-mutinynet-lifecycle.json');
let mutationsAllowed=false;
const equal=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:stockJournalFingerprint(a)===stockJournalFingerprint(b);
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const has=(name:string)=>process.argv.includes(name);
function fail(message:string):never{throw new Error(`Stock live smoke: ${message}`);}
function help(){console.log('Stock live Mutinynet acceptance runner\n  --prepare [--alice-outpoint txid:vout]   Read-only wallet and operator preflight\n  --run --release-fingerprint <sha256> --software-image-digest sha256:<64hex> --alice-outpoint txid:vout\n  --verify-only --release-fingerprint <sha256> --software-image-digest sha256:<64hex> --restart-evidence <json>\n  --allow-development-only                 Explicitly permit test-only phase-2 artifacts\n  --disconnect-step <named-step>          Lose one HTTP response; never resubmit it\n  --operator-url http://127.0.0.1:8792\nRestart evidence fields: version, releaseFingerprint, softwareImageDigest, archiveHead, archiveHash, beforeContainer, afterContainer.\nSecrets and pending requests stay in the encrypted .recovery/stock-live-smoke store.');}
function requiredFingerprint(){const value=arg('--release-fingerprint')??process.env.SHIELDED_STOCK_RELEASE_FINGERPRINT;if(!value||!/^[0-9a-f]{64}$/.test(value))fail('supply the independently trusted --release-fingerprint or SHIELDED_STOCK_RELEASE_FINGERPRINT.');return value;}
function operatorBase(){const value=arg('--operator-url')??'http://127.0.0.1:8792';let url:URL;try{url=new URL(value);}catch{return fail('operator URL is invalid.');}const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash)fail('operator URL must be loopback HTTP or HTTPS without credentials/query.');return url.toString().replace(/\/$/,'');}
function requiredFile(path:string,label:string){if(!existsSync(path))fail(`missing ${label}: ${path}`);return path;}
function loadLocal(){
 const artifacts=resolve(arg('--artifacts')??process.env.SHIELDED_STOCK_ARTIFACTS??'circuits/stock/build/compiled'),manifestPath=requiredFile(join(artifacts,'stock-combined.manifest.json'),'compiled local stock manifest'),manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as StockArtifactManifest;
 if(manifest.setup.phase2==='development-only'&&!has('--allow-development-only'))fail('development-only phase2 requires explicit --allow-development-only for this testnet run.');
 const loadedPromise=loadStockProofArtifacts(artifacts,manifest),binary=requiredFile(resolve(ROOT,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm'),'stock VM binary'),vkPath=requiredFile(join(artifacts,'stock-combined.vkey.json'),'local verifier key');
 const programs=JSON.parse(execFileSync(binary,['--stock-build',vkPath],{encoding:'utf8',windowsHide:true})) as StockProgramManifest;
 return {artifacts,manifest,loadedPromise,binary,programs};
}
async function getJson<T>(url:string):Promise<T>{const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30_000)});const data=await response.json().catch(()=>undefined) as any;if(!response.ok)fail(`read-only HTTP ${response.status} from ${new URL(url).pathname}: ${data?.error??'request failed'}`);return data as T;}
async function postJson<T>(base:string,path:string,body:unknown,name:string,disconnect=false):Promise<T>{
 if(!mutationsAllowed)fail(`mutation ${path} is disabled in this mode.`);
 const controller=new AbortController();let timer:NodeJS.Timeout|undefined;const request=fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
 if(disconnect)timer=setTimeout(()=>controller.abort(),75);
 try{const response=await request;const data=await response.json().catch(()=>undefined) as any;if(!response.ok)fail(`${name} rejected with HTTP ${response.status}: ${data?.error??'request failed'}`);return data as T;}
 catch(error){if(disconnect)throw new Error(`Response deliberately disconnected for ${name}; the exact request is journaled and will only be reconciled read-only on the next run.`,{cause:error});throw new Error(`Outcome unknown for ${name}; exact request remains journaled for read-only reconciliation.`,{cause:error});}
 finally{if(timer)clearTimeout(timer);}
}
function copyPublic<T>(value:T):T{return structuredClone(value);}
export function modeMutationPaths(mode:'prepare'|'run'|'verify-only'):string[]{return mode==='run'?['/api/participants/:owner','/api/prepare','/api/settlements']:[];}
export function selectExactFundingCoin(coins:readonly CustomerVtxo[],outpoint:string,minimumValue=330):CustomerVtxo{
 const matches=coins.filter(coin=>`${coin.funding.txid.toLowerCase()}:${coin.funding.vout}`===outpoint.toLowerCase());
 if(matches.length!==1||matches[0]!.funding.value<minimumValue)fail(`exact customer VTXO ${outpoint} is missing, ambiguous, or below ${minimumValue} sats; no fallback coin is allowed.`);
 return matches[0]!;
}
export function pendingSettlementMatches(pending:Pending,item:StockHistoryEntry|undefined):boolean{
 if(!item||pending.kind!=='settlement'||!pending.prepared||!pending.proof||!pending.signed)return false;
 try{
  const txids=[Transaction.fromPSBT(base64.decode(item.request.arkTx)).id,...item.request.checkpoints.map(value=>Transaction.fromPSBT(base64.decode(value)).id)];
  return equal(item.prepared,pending.prepared)&&equal(item.proof,pending.proof)&&equal(item.externalFunding,pending.externalFunding)&&equal(item.request,pending.signed)&&equal(txids,pending.expectedTxids);
 }catch{return false;}
}
export async function assertUnsealedTransferRejected(attempt:()=>Promise<unknown>):Promise<void>{
 try{await attempt();}catch(error){if(/sealed/i.test(error instanceof Error?error.message:String(error)))return;throw new Error('The client-local unsealed-spend check failed for an unexpected reason.',{cause:error});}
 fail('the client locally prepared a private transfer before the pool was sealed.');
}
function verifyLocalProfile(remote:ServerProfile,local:LocalProfile,fingerprint:string){
 const pin=remote.release;
 if(stockReleaseFingerprint(pin)!==fingerprint)fail('operator release does not match the external fingerprint.');
 if(pin.network!=='mutinynet'||pin.serverKey!==local.network.serverKey||pin.emulatorKey!==local.network.emulatorKey||pin.descriptorProfileId!==local.loaded.descriptor.profileId||pin.programsHash!==local.programs.programsHashHex||pin.artifactsHash!==stockJournalFingerprint(local.manifest)||pin.genesisTxid!==remote.genesis.head.txid)fail('operator profile differs from the independently loaded local release artifacts or live signer keys.');
 if(remote.registration.profile!==stockReleaseFingerprint(pin)||remote.registration.network!=='mutinynet'||!equal(remote.programs,local.programs)||!equal(remote.provingManifest,local.manifest)||!equal(remote.verifierKey,local.loaded.verifierKey))fail('operator scripts, verifier, or proving manifest differ from the local release.');
 if(remote.network.arkUrl!==local.network.arkUrl||remote.network.emulatorUrl!==local.network.emulatorUrl||remote.network.weightLimit!==local.network.weightLimit||remote.network.dust!==local.network.dust||!equal(remote.network.exitDelay,local.network.exitDelay))fail('operator network policy differs from the current public Mutinynet preflight.');
 return loadStockProfile(local.programs,local.loaded.verifierKey,pin.descriptorProfileId,local.network,local.programs.programsHashHex);
}
async function verifiedSnapshot(base:string,fingerprint:string,local:LocalProfile){
 const remote=await getJson<ServerProfile>(base+'/api/profile'),archiveResult=await getJson<{archive:StockPublicArchive}>(base+'/api/archive'),profile=verifyLocalProfile(remote,local,fingerprint),archive=archiveResult.archive;
 const verified=await verifyStockArchive({...remote,programs:local.programs,verifierKey:local.loaded.verifierKey,provingManifest:local.manifest,network:local.network},archive,fingerprint);
 if(verified.head.txid!==archive.head.txid||verified.head.vout!==archive.head.vout||verified.head.revision!==archive.protocol.state.revision)fail('public archive replay returned a different head.');
 return {remote,archive,profile,verified};
}
function loadFundingSecret(){
 if(!existsSync(join(FUNDING_DIR,'shielded.sqlite'))||!existsSync(join(FUNDING_DIR,'.key')))fail('the preserved encrypted stock funding wallet is missing; create it with stock-funding-wallet --prepare first.');
 const store=EngineStore.open(FUNDING_DIR);try{const saved=store.load<{version:number;purpose:string;network:string;masterSecret:string}>();if(saved?.version!==1||saved.purpose!=='new-stock-profile-test-funding'||saved.network!=='mutinynet'||!/^(?:[0-9a-f]{2}){32}$/.test(saved.masterSecret))fail('preserved funding wallet metadata is invalid.');return saved.masterSecret;}finally{store.close();}
}
function loadOrCreateStore(){
 mkdirSync(STORE_DIR,{recursive:true,mode:0o700});chmodSync(STORE_DIR,0o700);const store=EngineStore.open(STORE_DIR);let saved=store.load<Saved>();
 if(!saved){saved={version:1,purpose:'stock-live-smoke',network:'mutinynet',releaseFingerprint:requiredFingerprint(),softwareImageDigest:requiredImageDigest(),bobMaster:randomBytes(32).toString('hex'),carolMaster:randomBytes(32).toString('hex'),completed:{},fundingCoins:{},restartBoundaryReached:false,startedAt:new Date().toISOString()};store.save(saved);}
 if(saved.version!==1||saved.purpose!=='stock-live-smoke'||saved.network!=='mutinynet'||saved.releaseFingerprint!==requiredFingerprint()||saved.softwareImageDigest!==requiredImageDigest()||!/^(?:[0-9a-f]{2}){32}$/.test(saved.bobMaster)||!/^(?:[0-9a-f]{2}){32}$/.test(saved.carolMaster))fail('encrypted client journal belongs to a different profile, software image, or is malformed.');
 return {store,saved,save:(next:Saved)=>{store.save(next);saved=next;}};
}
function openExistingStore(){
 if(!existsSync(join(STORE_DIR,'shielded.sqlite'))||!existsSync(join(STORE_DIR,'.key')))fail('the encrypted live-smoke wallet journal does not exist; run --run once to initialize it.');
 const store=EngineStore.open(STORE_DIR);let saved=store.load<Saved>();if(!saved||saved.version!==1||saved.purpose!=='stock-live-smoke'||saved.network!=='mutinynet'||saved.releaseFingerprint!==requiredFingerprint()||saved.softwareImageDigest!==requiredImageDigest())fail('encrypted live-smoke journal has no matching deployment and software identity.');
 return {store,saved,save:(next:Saved)=>{store.save(next);saved=next;}};
}
async function initializeParty(name:PartyName,master:string,network:StockNetworkInfo,profile:StockProfile,backend:Awaited<ReturnType<typeof loadStockProofArtifacts>>['backend'],registrationProfile:string,vault:{saved:Saved;save:(next:Saved)=>void}):Promise<Party>{
 const material=deriveWalletKeyMaterial(master,'mutinynet'),identity=SingleKey.fromHex(material.nativeSecret),owner=hex.encode(await identity.xOnlyPublicKey()),server=hex.decode(network.serverKey),key=await identity.xOnlyPublicKey();
 const forfeit=MultisigTapscript.encode({pubkeys:[key,server]}).script,exit=CSVMultisigTapscript.encode({pubkeys:[key],timelock:{type:network.exitDelay.type,value:BigInt(network.exitDelay.value)}}).script,tree=new VtxoScript([forfeit,exit]);
 const wallet=await openCustomerArkWallet(identity,network);if(wallet.externalProgram!==hex.encode(tree.pkScript.subarray(2)))fail(`${name}'s payout tree does not match its normal Ark wallet policy.`);
 const client=await createClientProtocol({owner,keys:material.keys,stockOnly:true,stockProofBackend:backend,stockVerifierKey:profile.verifierKey});
 const recipient=client.publicDescriptor(),known=vault.saved.registrations?.[name];
 if(known&&(known.owner!==owner||!equal(known.recipient,recipient)||known.nativePublicKey!==owner))fail(`${name}'s encrypted registration does not match its recovery secret.`);
 const registration=known??signParticipantRegistration({network:'mutinynet',profile:registrationProfile,secretKey:material.nativeSecret,recipient});
 if(!known)vault.save({...vault.saved,registrations:{...vault.saved.registrations,[name]:registration}});
 return {name,master,material,identity,owner,tree,forfeit,registration,client};
}
async function prepareMode(){
 const network=await preflightStockMutinynet(),master=loadFundingSecret(),material=deriveWalletKeyMaterial(master,'mutinynet'),identity=SingleKey.fromHex(material.nativeSecret),wallet=await openCustomerArkWallet(identity,network),chosen=arg('--alice-outpoint');
 const coins=wallet.coins.map((coin:CustomerVtxo)=>({outpoint:`${coin.funding.txid}:${coin.funding.vout}`,value:coin.funding.value}));
 if(chosen&&!coins.some((coin:any)=>coin.outpoint===chosen))fail('requested Alice outpoint is not a currently spendable, assetless Mutinynet VTXO.');
 console.log(JSON.stringify({network:'mutinynet',operatorMaxWeight:network.operatorMaxWeight,weightLimit:network.weightLimit,emulatorVersion:network.emulatorVersion,aliceAddress:wallet.address,aliceVtxos:coins,selectedOutpoint:chosen??null,transactionsSubmitted:0,serviceMutation:false},null,2));
}
type LocalProfile={artifacts:string;manifest:StockArtifactManifest;loaded:Awaited<ReturnType<typeof loadStockProofArtifacts>>;binary:string;programs:StockProgramManifest;network:StockNetworkInfo;profile:StockProfile;checkpoint:CSVMultisigTapscript.Type;hash:(values:bigint[])=>bigint};
async function loadRuntime():Promise<LocalProfile>{
 const base=loadLocal(),loaded=await base.loadedPromise,network=await preflightStockMutinynet(),remoteInfo=await new RestArkProvider(network.arkUrl).getInfo();
 if(remoteInfo.network!=='mutinynet'||remoteInfo.checkpointTapscript==null)fail('public Arkade checkpoint policy is unavailable.');
 const profile=loadStockProfile(base.programs,loaded.verifierKey,loaded.descriptor.profileId,network,base.programs.programsHashHex),checkpoint=validateStockCheckpoint(remoteInfo.checkpointTapscript,remoteInfo.forfeitPubkey);
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
 return {...base,loaded,network,profile,checkpoint,hash};
}
async function reconcilePending(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},snapshot:Awaited<ReturnType<typeof verifiedSnapshot>>){
 const pending=vault.saved.pending;if(!pending)return false;
 if(pending.kind==='participant'){
  const match=Object.values(snapshot.remote.participants).find(value=>equal(value,pending.registration));if(!match)fail(`pending participant request ${pending.name} is unresolved; it will not be resubmitted.`);markDone(vault,pending.name);return true;
 }
 if(pending.kind==='prepare'){
  const item=snapshot.archive.history[pending.before.historyLength];if(snapshot.archive.phase!==18||!item||item.operation!=='prepare'||pending.before.phase!==17)fail(`pending native prepare ${pending.name} is unresolved; it will not be resubmitted.`);
  const checkpoint=Transaction.fromPSBT(base64.decode(item.request.checkpoints[0]!)),input=checkpoint.getInput(0);
  if(snapshot.archive.history.length!==pending.before.historyLength+1||snapshot.archive.head.txid===pending.before.head||hex.encode(input.txid!)!==pending.before.head||input.index!==pending.before.vout)fail(`pending native prepare ${pending.name} is unresolved; it will not be resubmitted.`);
  markDone(vault,pending.name,{txid:item.receipt.txid,checkpointTxids:item.receipt.checkpointTxids,weights:item.receipt.weights,acceptedAt:new Date().toISOString()});return true;
 }
 if(pending.kind==='settlement'){
  const item=snapshot.archive.history.find(entry=>entry.prepared?.id===pending.prepared?.id);
  if(!item||!pendingSettlementMatches(pending,item))fail(`pending settlement ${pending.name} is not present as the exact accepted request; it will not be resubmitted.`);
  markDone(vault,pending.name,{txid:item!.receipt.txid,checkpointTxids:item!.receipt.checkpointTxids,weights:item!.receipt.weights,acceptedAt:new Date().toISOString()});return true;
 }
 fail(`unsupported pending action ${pending.name}; refusing further mutations.`);
}
async function makeClient(party:Party,archive:StockPublicArchive,local:LocalProfile){
 const client=await createClientProtocol({owner:party.owner,keys:party.material.keys,recipients:archive.protocol.recipients,checkpoint:archive.protocol,stockOnly:true,stockProofBackend:local.loaded.backend,stockVerifierKey:local.loaded.verifierKey});
 party.client=client;return client;
}
function markPending(vault:{saved:Saved;save:(next:Saved)=>void},pending:Pending){vault.save({...vault.saved,pending});}
function pendingBase(name:string,kind:Pending['kind'],snapshot:Awaited<ReturnType<typeof verifiedSnapshot>>):Pending{return {name,kind,before:{head:snapshot.archive.head.txid,vout:snapshot.archive.head.vout,phase:snapshot.archive.phase,historyLength:snapshot.archive.history.length,revision:snapshot.archive.protocol.state.revision},createdAt:new Date().toISOString()};}
async function ensurePhase18(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},name:string,disconnect?:string){
 let snapshot=await verifiedSnapshot(base,fingerprint,local);
 if(vault.saved.pending){await reconcilePending(base,fingerprint,local,vault,snapshot);snapshot=await verifiedSnapshot(base,fingerprint,local);}
 if(snapshot.archive.phase===18)return snapshot;
 const step=`prepare:${name}`;if(vault.saved.completed[step])fail('archive returned to phase 17 after a previously accepted prepare; inspect the immutable history.');
 const pending=pendingBase(step,'prepare',snapshot);markPending(vault,pending);
 await postJson(base,'/api/prepare',{},step,disconnect===step);
 snapshot=await verifiedSnapshot(base,fingerprint,local);
 const item=snapshot.archive.history[pending.before.historyLength];if(!item||item.operation!=='prepare'||snapshot.archive.phase!==18||snapshot.archive.head.txid===pending.before.head)fail('operator did not record the exact native prepare transition.');
 markDone(vault,step,{txid:item.receipt.txid,checkpointTxids:item.receipt.checkpointTxids,weights:item.receipt.weights,acceptedAt:new Date().toISOString()});return snapshot;
}
function fundingInput(input:StockPublicFunding){return {...input,sourceTx:hex.decode(input.sourceTxHex),tapTree:hex.decode(input.tapTreeHex),tapLeafScript:VtxoScript.decode(hex.decode(input.tapTreeHex)).findLeaf(input.leafHex)};}
async function spend(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},name:string,party:Party,operation:'shield'|'transfer'|'withdraw'|'seal',amount:number,recipient?:string,externalFunding?:StockPublicFunding,disconnect?:string){
 if(vault.saved.completed[name]){const known=await verifiedSnapshot(base,fingerprint,local),txid=vault.saved.completed[name]!.txid,item=known.archive.history.find(entry=>entry.receipt.txid===txid);if(!item)fail(`completed settlement ${name} is absent from verified history.`);return item;}
 let snapshot=await verifiedSnapshot(base,fingerprint,local);
 if(vault.saved.pending){await reconcilePending(base,fingerprint,local,vault,snapshot);snapshot=await verifiedSnapshot(base,fingerprint,local);if(vault.saved.completed[name])return;}
 snapshot=await ensurePhase18(base,fingerprint,local,vault,name,disconnect);
 if(vault.saved.pending)fail(`unresolved pending action ${vault.saved.pending.name}; no later mutation is allowed.`);
 const client=await makeClient(party,snapshot.archive,local),externalProgram=operation==='withdraw'?hex.encode(party.tree.pkScript.subarray(2)):undefined;
 const prepared=operation==='shield'?await client.prepareStockShield(party.owner,'BTC',amount):operation==='transfer'?await client.prepareStockTransfer(party.owner,recipient!,'BTC',amount):operation==='withdraw'?await client.prepareStockWithdraw(party.owner,'BTC',amount,externalProgram!):await client.prepareStockSeal();
 const draft=await postJson<StockDraft>(base,'/api/draft',{prepared,...(externalFunding?{externalFunding}:{}),...(externalProgram?{externalProgram}:{})},`${name}:draft`);
 if(!draft.nativeBinding)fail(`operator draft for ${name} lacks the bound native statement.`);
 const proof=await client.proveStock(prepared,draft.nativeBinding);
 const nativeOperation=operation==='shield'?'deposit':operation==='withdraw'&&externalFunding?'withdraw-funded':operation;
 const request={profile:local.profile,operation:nativeOperation as any,pool:{...snapshot.archive.head,sourceTx:hex.decode(snapshot.archive.head.sourceTxHex)},oldState:prepared.oldState,newState:prepared.newState,checkpoint:local.checkpoint,hash:local.hash,weightLimit:local.network.weightLimit,...(externalFunding?{externalFunding:fundingInput(externalFunding)}:{}),...(externalProgram?{externalProgram,payoutBTC:prepared.boundary.withdrawal.BTC+(externalFunding?.value??0)}:{})};
 const built=buildStockSpend(request,proof,draft);if(externalFunding){const identity=party.identity;built.arkTx=await identity.sign(built.arkTx,[1]);built.checkpoints[1]=await identity.sign(built.checkpoints[1]!,[0]);built.arkTxPsbt=base64.encode(built.arkTx.toPSBT());built.checkpointPsbts=built.checkpoints.map(tx=>base64.encode(tx.toPSBT()));}
 const signed=stockVmRequest(built),txIds=[Transaction.fromPSBT(base64.decode(signed.arkTx)).id,...signed.checkpoints.map(value=>Transaction.fromPSBT(base64.decode(value)).id)],pending={...pendingBase(name,'settlement',snapshot),prepared:copyPublic(prepared),proof:copyPublic(proof),...(externalFunding?{externalFunding:copyPublic(externalFunding)}:{}),signed:copyPublic(signed),expectedTxids:txIds};
 markPending(vault,pending);
 const result=await postJson<{receipt:StockNativeReceipt;archive:StockPublicArchive}>(base,'/api/settlements',{prepared,proof,...(externalFunding?{externalFunding}:{}),signed},name,disconnect===name);
 const after=await verifiedSnapshot(base,fingerprint,local),accepted=after.archive.history.find(entry=>entry.prepared?.id===prepared.id);
 if(!accepted||!equal(accepted.prepared,prepared)||!equal(accepted.proof,proof)||!equal(accepted.externalFunding,externalFunding)||!equal(accepted.request,signed)||!equal(result.receipt,accepted.receipt))fail(`operator response for ${name} did not match the publicly verified exact history entry.`);
 markDone(vault,name,{txid:accepted.receipt.txid,checkpointTxids:accepted.receipt.checkpointTxids,weights:accepted.receipt.weights,acceptedAt:new Date().toISOString()});
 return accepted;
}
function markDone(vault:{saved:Saved;save:(next:Saved)=>void},name:string,result:Saved['completed'][string]={acceptedAt:new Date().toISOString()}){
 const completed={...vault.saved.completed,[name]:result},next={...vault.saved,completed};delete (next as any).pending;vault.save(next);
}
async function registerParty(base:string,name:string,party:Party,snapshot:Awaited<ReturnType<typeof verifiedSnapshot>>,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},disconnect?:string){
 const pending=vault.saved.pending;
 if(pending){if(pending.name!==name||pending.kind!=='participant')fail(`unresolved pending action ${pending.name}; no later mutation is allowed.`);if(snapshot.remote.participants[party.owner]&&equal(snapshot.remote.participants[party.owner],pending.registration)){markDone(vault,name);return;}fail(`participant registration ${name} is unresolved; it will not be resubmitted.`);}
 const existing=snapshot.remote.participants[party.owner];if(existing){if(!equal(existing,party.registration))fail(`${name} identity differs from the journaled client recovery key.`);return;}
 const next={...vault.saved,pending:{name,kind:'participant' as const,before:{head:snapshot.archive.head.txid,vout:snapshot.archive.head.vout,phase:snapshot.archive.phase,historyLength:snapshot.archive.history.length,revision:snapshot.archive.protocol.state.revision},registration:copyPublic(party.registration),createdAt:new Date().toISOString()}};vault.save(next);
 await postJson(base,`/api/participants/${party.owner}`,party.registration,name,disconnect===name);
 const after=await verifiedSnapshot(base,vault.saved.releaseFingerprint,local);if(!equal(after.remote.participants[party.owner],party.registration))fail('operator did not preserve the exact signed client registration.');markDone(vault,name);
}

function currentContainer(){
 const ids=execFileSync('docker',['ps','-q','--filter','publish=8792'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean);
 if(ids.length!==1)fail(`expected exactly one local stock service container publishing 8792; found ${ids.length}.`);
 const raw=execFileSync('docker',['inspect',ids[0]!],{encoding:'utf8',windowsHide:true}),item=JSON.parse(raw)[0],data=item?.Mounts?.find((mount:any)=>mount.Destination==='/data'),release=item?.Mounts?.find((mount:any)=>mount.Destination==='/release');
 if(!item?.State?.Running||!data||!release||release.RW!==false)fail('stock service must be running with its encrypted /data volume and read-only /release mount.');
 return {id:String(item.Id),startedAt:String(item.State.StartedAt),image:String(item.Image),volume:String(data.Name??data.Source)};
}
function assertNoPending(vault:{saved:Saved}){if(vault.saved.pending)fail(`unresolved pending request ${vault.saved.pending.name}; reconcile this exact request before any later step.`);}
async function exactPayoutCoin(name:string,party:Party,amount:number,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void}):Promise<StockPublicFunding>{
 const item=await verifiedSnapshot(operatorBase(),fingerprint,local),entry=item.archive.history.find(value=>value.receipt.txid===vault.saved.completed[name]?.txid);
 if(!entry)fail(`withdrawal ${name} is absent from the verified archive.`);
 const tx=Transaction.fromPSBT(base64.decode(entry.request.arkTx)),output=tx.getOutput(0);if(output.amount!==BigInt(amount)||!output.script)fail(`withdrawal ${name} does not pay the exact expected customer VTXO.`);
 const outpoint=`${tx.id}:0`,stored=vault.saved.fundingCoins[name];if(stored&&`${stored.txid}:${stored.vout}`!==outpoint)fail(`journaled payout identity for ${name} differs from its exact accepted transaction.`);
 let wallet=await openCustomerArkWallet(party.identity,local.network),coin:CustomerVtxo|undefined;
 for(let attempt=0;attempt<12;attempt++){
  coin=wallet.coins.find(candidate=>`${candidate.funding.txid}:${candidate.funding.vout}`===outpoint);
  if(coin)break;
  await new Promise(resolve=>setTimeout(resolve,5_000));
  wallet=await openCustomerArkWallet(party.identity,local.network);
 }
 if(!coin||coin.funding.value!==amount||hex.encode(output.script)!==hex.encode(party.tree.pkScript))fail(`exact payout VTXO ${outpoint} is not yet verified as spendable for ${party.name}; no other coin will be selected.`);
 const prior=vault.saved.fundingCoins[name];if(prior&&!equal(prior,coin.funding))fail(`exact payout coin ${name} changed since it was journaled.`);
 vault.save({...vault.saved,fundingCoins:{...vault.saved.fundingCoins,[name]:copyPublic(coin.funding)}});return coin.funding;
}
async function chooseAliceCoin(party:Party,network:StockNetworkInfo,vault:{saved:Saved;save:(next:Saved)=>void}):Promise<CustomerVtxo>{
 const explicit=arg('--alice-outpoint'),outpoint=vault.saved.aliceOutpoint??explicit;if(!outpoint)fail('run --prepare first, then pass its exact --alice-outpoint to --run.');
 if(explicit&&vault.saved.aliceOutpoint&&explicit!==vault.saved.aliceOutpoint)fail('the selected Alice funding VTXO differs from the encrypted journal; never switch to a later coin.');
 const wallet=await openCustomerArkWallet(party.identity,network),coin=selectExactFundingCoin(wallet.coins,outpoint,2_000);
 if(!vault.saved.aliceOutpoint)vault.save({...vault.saved,aliceOutpoint:outpoint});
 return coin;
}
function recoveredBalance(client:Party['client'],owner:string){const value=client.snapshot().wallets[owner]?.balances.BTC;if(!Number.isSafeInteger(value)||value<0)fail('recovered customer BTC balance is invalid.');return value;}
async function register(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},party:Party,name:string,disconnect?:string){
 const snapshot=await verifiedSnapshot(base,fingerprint,local);await registerParty(base,name,party,snapshot,local,vault,disconnect);
}
async function seal(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},party:Party,name:string,disconnect?:string){
 await spend(base,fingerprint,local,vault,name,party,'seal',0,undefined,undefined,disconnect);
}
async function runInitial(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},alice:Party,bob:Party,carol:Party,disconnect?:string){
 await register(base,fingerprint,local,vault,alice,'register:alice',disconnect);
 await register(base,fingerprint,local,vault,bob,'register:bob',disconnect);
 if(!vault.saved.completed['alice:deposit']){const selected=await chooseAliceCoin(alice,local.network,vault);await spend(base,fingerprint,local,vault,'alice:deposit',alice,'shield',selected.funding.value,undefined,selected.funding,disconnect);}
 else await spend(base,fingerprint,local,vault,'alice:deposit',alice,'shield',0);
 if(!vault.saved.completed['seal:alice-deposit']){
  const verified=await verifiedSnapshot(base,fingerprint,local),probe=vault.saved.unsealedProbe;
  if(!probe||probe.head!==verified.archive.head.txid||probe.fromOwner!==alice.owner||probe.toOwner!==bob.owner){
   const restored=await makeClient(alice,verified.archive,local);
   await assertUnsealedTransferRejected(()=>restored.prepareStockTransfer(alice.owner,bob.owner,'BTC',500));
   vault.save({...vault.saved,unsealedProbe:{status:'rejected-as-unsealed',head:verified.archive.head.txid,fromOwner:alice.owner,toOwner:bob.owner,checkedAt:new Date().toISOString()}});
  }
 }
 await seal(base,fingerprint,local,vault,alice,'seal:alice-deposit',disconnect);
 await spend(base,fingerprint,local,vault,'alice:transfer-bob-500',alice,'transfer',500,bob.owner,undefined,disconnect);
 await seal(base,fingerprint,local,vault,alice,'seal:bob-transfer',disconnect);
 await spend(base,fingerprint,local,vault,'bob:withdraw-330',bob,'withdraw',330,undefined,undefined,disconnect);
 await seal(base,fingerprint,local,vault,bob,'seal:bob-330',disconnect);
 if(!vault.saved.completed['bob:withdraw-1-funded-330']){const bob330=await exactPayoutCoin('bob:withdraw-330',bob,330,fingerprint,local,vault);await spend(base,fingerprint,local,vault,'bob:withdraw-1-funded-330',bob,'withdraw',1,undefined,bob330,disconnect);}
 else await spend(base,fingerprint,local,vault,'bob:withdraw-1-funded-330',bob,'withdraw',1);
 await seal(base,fingerprint,local,vault,bob,'seal:bob-1',disconnect);
 const bob331=await exactPayoutCoin('bob:withdraw-1-funded-330',bob,331,fingerprint,local,vault);
 await register(base,fingerprint,local,vault,carol,'register:carol',disconnect);
 await spend(base,fingerprint,local,vault,'alice:transfer-carol-500',alice,'transfer',500,carol.owner,undefined,disconnect);
 await seal(base,fingerprint,local,vault,alice,'seal:carol-transfer',disconnect);
 await spend(base,fingerprint,local,vault,'carol:withdraw-330',carol,'withdraw',330,undefined,undefined,disconnect);
 await seal(base,fingerprint,local,vault,carol,'seal:carol-330',disconnect);
 if(!vault.saved.completed['carol:withdraw-170-funded-330']){const carol330=await exactPayoutCoin('carol:withdraw-330',carol,330,fingerprint,local,vault);await spend(base,fingerprint,local,vault,'carol:withdraw-170-funded-330',carol,'withdraw',170,undefined,carol330,disconnect);}
 else await spend(base,fingerprint,local,vault,'carol:withdraw-170-funded-330',carol,'withdraw',170);
 const snapshot=await verifiedSnapshot(base,fingerprint,local);assertNoPending(vault);
 const recoveryBalances={alice:recoveredBalance(await makeClient(alice,snapshot.archive,local),alice.owner),bob:recoveredBalance(await makeClient(bob,snapshot.archive,local),bob.owner),carol:recoveredBalance(await makeClient(carol,snapshot.archive,local),carol.owner)};
 const depositEntry=snapshot.archive.history.find(entry=>entry.receipt.txid===vault.saved.completed['alice:deposit']?.txid),depositBtc=depositEntry?.prepared?.boundary.deposit.BTC;
 if(depositEntry?.prepared?.operation!=='shield'||!Number.isSafeInteger(depositBtc)||depositBtc!<1_000||recoveryBalances.bob!==169||recoveryBalances.carol!==0||recoveryBalances.alice!==depositBtc!-1_000)fail('restart boundary balances do not match the authenticated deposit and completed three-party scenario.');
 const archiveHash=stockJournalFingerprint(snapshot.archive),beforeContainer=currentContainer();
 const softwareImageDigest=requiredImageDigest();vault.save({...vault.saved,restartBoundaryReached:true,restart:{verified:false,head:snapshot.archive.head.txid,archiveHash,releaseFingerprint:fingerprint,softwareImageDigest,recoveryBalances,beforeContainer}});
 console.log(JSON.stringify({status:'restart-required',head:snapshot.archive.head.txid,archiveHead:`${snapshot.archive.head.txid}:${snapshot.archive.head.vout}`,archiveHash,beforeContainer,releaseFingerprint:fingerprint,softwareImageDigest:vault.saved.restart!.softwareImageDigest,transactionsSubmitted:Object.keys(vault.saved.completed).length,action:'Restart the same shielded-stock service with the same image, release mount, and encrypted /data volume; capture a sanitized restart receipt, then run --verify-only --restart-evidence <file>.'},null,2));
}
function requiredImageDigest(){const value=arg('--software-image-digest')??process.env.SHIELDED_STOCK_SOFTWARE_IMAGE_DIGEST;if(!value||!/^sha256:[0-9a-f]{64}$/.test(value))fail('supply the actual immutable Docker image digest with --software-image-digest or SHIELDED_STOCK_SOFTWARE_IMAGE_DIGEST.');return value;}
async function verifyRestart(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},imageDigest:string){
 if(!vault.saved.restartBoundaryReached||!vault.saved.restart)fail('--verify-only requires the saved post-Carol-cashout restart boundary.');assertNoPending(vault);
 const snapshot=await verifiedSnapshot(base,fingerprint,local),current=currentContainer(),before=vault.saved.restart.beforeContainer;
 if(snapshot.archive.head.txid!==vault.saved.restart.head||stockJournalFingerprint(snapshot.archive)!==vault.saved.restart.archiveHash||fingerprint!==vault.saved.restart.releaseFingerprint||imageDigest!==vault.saved.restart.softwareImageDigest||imageDigest!==vault.saved.softwareImageDigest)fail('the authenticated archive, head, release, or software image changed across the restart.');
 if(current.image!==imageDigest||!before||current.image!==before.image||current.volume!==before.volume||Date.parse(current.startedAt)<=Date.parse(before.startedAt))fail('restart proof requires the pinned same image and encrypted volume with a later container start time.');
 const evidencePath=arg('--restart-evidence');if(!evidencePath)fail('--verify-only also requires an externally captured --restart-evidence receipt; a GET-only archive comparison is insufficient proof of restart.');
 const evidence=JSON.parse(readFileSync(resolve(evidencePath),'utf8')) as any;
 if(evidence.version!==1||evidence.releaseFingerprint!==fingerprint||evidence.softwareImageDigest!==imageDigest||evidence.archiveHead!==`${snapshot.archive.head.txid}:${snapshot.archive.head.vout}`||evidence.archiveHash!==vault.saved.restart.archiveHash||!equal(evidence.beforeContainer,before)||!equal(evidence.afterContainer,current))fail('external restart receipt does not match the saved boundary, observed container, release, and archive.');
 const masters:{[K in PartyName]:string}={alice:loadFundingSecret(),bob:vault.saved.bobMaster,carol:vault.saved.carolMaster};
 const recovered:Record<string,number>={};
 for(const name of ['alice','bob','carol'] as const){const material=deriveWalletKeyMaterial(masters[name],'mutinynet'),owner=hex.encode(await SingleKey.fromHex(material.nativeSecret).xOnlyPublicKey()),client=await createClientProtocol({owner,keys:material.keys,recipients:snapshot.archive.protocol.recipients,checkpoint:snapshot.archive.protocol,stockOnly:true,stockProofBackend:local.loaded.backend,stockVerifierKey:local.loaded.verifierKey});recovered[name]=recoveredBalance(client,owner);}
 if(!vault.saved.restart.recoveryBalances||!equal(recovered,vault.saved.restart.recoveryBalances))fail('fresh client keys did not reconstruct the exact pre-restart Alice, Bob, and Carol balances.');
 if(!vault.saved.restart.verified)vault.save({...vault.saved,restart:{...vault.saved.restart,verified:true,afterContainer:current}});
 console.log(JSON.stringify({status:'archive-seed-recovery-and-restart-verified',head:snapshot.archive.head.txid,releaseFingerprint:fingerprint,softwareImageDigest:imageDigest,volume:current.volume,startedAt:current.startedAt,recoveredBalances:recovered,transactionsSubmitted:0},null,2));
}
async function runFinal(base:string,fingerprint:string,local:LocalProfile,vault:{saved:Saved;save:(next:Saved)=>void},alice:Party,bob:Party,carol:Party){
 if(!vault.saved.restart?.verified)fail('the saved same-volume restart has not been verified; --run is paused before final cashout.');
 let snapshot=await verifiedSnapshot(base,fingerprint,local);
 if(!vault.saved.completed['alice:cashout-final']){const aliceClient=await makeClient(alice,snapshot.archive,local),aliceBalance=recoveredBalance(aliceClient,alice.owner);if(aliceBalance<330)fail(`Alice has ${aliceBalance} sats, below the final native withdrawal minimum.`);await spend(base,fingerprint,local,vault,'alice:cashout-final',alice,'withdraw',aliceBalance,undefined,undefined);}
 if(!vault.saved.completed['bob:cashout-final-169']){const bobFunding=await exactPayoutCoin('bob:withdraw-1-funded-330',bob,331,fingerprint,local,vault);snapshot=await verifiedSnapshot(base,fingerprint,local);const bobClient=await makeClient(bob,snapshot.archive,local),bobBalance=recoveredBalance(bobClient,bob.owner);if(bobBalance!==169)fail(`Bob's final private balance was ${bobBalance}, expected the exact 169-sat remainder.`);await spend(base,fingerprint,local,vault,'bob:cashout-final-169',bob,'withdraw',bobBalance,undefined,bobFunding);}
 else await spend(base,fingerprint,local,vault,'bob:cashout-final-169',bob,'withdraw',169);
 snapshot=await verifiedSnapshot(base,fingerprint,local);assertNoPending(vault);
 if(snapshot.archive.head.value!==330||snapshot.archive.protocol.state.reserves.BTC!==0)fail('the completed pool does not contain only its 330-sat carrier.');
 for(const party of [alice,bob,carol]){const recovered=await makeClient(party,snapshot.archive,local);if(recoveredBalance(recovered,party.owner)!==0)fail(`${party.name} recovery did not reproduce its fully withdrawn zero balance.`);}
 const ledger={version:1,network:'mutinynet',status:'funded-acceptance-passed',readiness:'bounded operator-backed testnet acceptance; not public-for-everyone readiness',releaseFingerprint:fingerprint,softwareImageDigest:requiredImageDigest(),programsHash:local.programs.programsHashHex,artifactsHash:stockJournalFingerprint(local.manifest),descriptorProfileId:local.loaded.descriptor.profileId,genesisTxid:snapshot.remote.genesis.head.txid,finalHead:snapshot.archive.head,finalReserveBTC:snapshot.archive.protocol.state.reserves.BTC,finalCarrierSats:snapshot.archive.head.value,participants:Object.keys(snapshot.remote.participants).length,unsealedSpendProbe:vault.saved.unsealedProbe??{status:'not-executed-before-first-seal',reason:'the first seal was already accepted when this runner resumed; no probe result is inferred'},transactions:Object.fromEntries(Object.entries(vault.saved.completed).map(([name,value])=>[name,{txid:value.txid,checkpointTxids:value.checkpointTxids,weights:value.weights}])),restart:vault.saved.restart,completedAt:new Date().toISOString(),limitations:['Mutinynet operator-backed proof of concept only','Development phase-2 setup is test-only and must be replaced through a new genesis','Arkade public emulator admission is limited to the pinned stock opcode profile','No independent note-holder pool exit if the Arkade platform is unavailable','A valid direct native transition may withhold the off-chain proof sidecar needed by other clients, causing note recovery and pool availability loss until the sidecar is restored']};
 mkdirSync(resolve('validation'),{recursive:true});writeFileSync(LEDGER_FILE,JSON.stringify(ledger,null,2)+'\n',{encoding:'utf8',flag:'wx'});
 console.log(JSON.stringify({status:'funded-lifecycle-and-restart-verified',steps:Object.keys(vault.saved.completed).length,head:snapshot.archive.head.txid,carrierSats:330,transactionsSubmittedAfterRestart:true},null,2));
}
async function main(){
 if(has('--help')){help();return;}
 const modes=(['--prepare','--run','--verify-only'] as const).filter(has);if(modes.length!==1)fail('choose exactly one of --prepare, --run, or --verify-only.');
 if(modes[0]==='--prepare'){await prepareMode();return;}
 const mode=modes[0]==='--run'?'run':'verify-only',fingerprint=requiredFingerprint(),imageDigest=requiredImageDigest(),base=operatorBase(),local=await loadRuntime();
 const disconnect=arg('--disconnect-step'),steps=['register:alice','register:bob','register:carol','alice:deposit','seal:alice-deposit','alice:transfer-bob-500','seal:bob-transfer','bob:withdraw-330','seal:bob-330','bob:withdraw-1-funded-330','seal:bob-1','alice:transfer-carol-500','seal:carol-transfer','carol:withdraw-330','seal:carol-330','carol:withdraw-170-funded-330','alice:cashout-final','bob:cashout-final-169'];
 if(disconnect&&mode!=='run')fail('--disconnect-step is only valid with --run.');
 if(disconnect&&!steps.some(step=>disconnect===step||disconnect===`prepare:${step}`))fail(`unknown disconnect step ${disconnect}.`);
 if(currentContainer().image!==imageDigest)fail('the running stock service image differs from the externally pinned image digest.');
 mutationsAllowed=mode==='run'&&modeMutationPaths(mode).length>0;
 const vault=mode==='run'?loadOrCreateStore():openExistingStore();
 try{
  const snapshot=await verifiedSnapshot(base,fingerprint,local);
  if(mode==='verify-only'){await verifyRestart(base,fingerprint,local,vault,imageDigest);return;}
  if(vault.saved.pending)await reconcilePending(base,fingerprint,local,vault,snapshot);
  assertNoPending(vault);
  if(vault.saved.restartBoundaryReached&&!vault.saved.restart?.verified)fail('restart verification is required before any later mutation; run --verify-only.');
  const aliceMaster=loadFundingSecret();
  const alice=await initializeParty('alice',aliceMaster,local.network,local.profile,local.loaded.backend,snapshot.remote.registration.profile,vault);
  const bob=await initializeParty('bob',vault.saved.bobMaster,local.network,local.profile,local.loaded.backend,snapshot.remote.registration.profile,vault);
  const carol=await initializeParty('carol',vault.saved.carolMaster,local.network,local.profile,local.loaded.backend,snapshot.remote.registration.profile,vault);
  if(vault.saved.restartBoundaryReached)await runFinal(base,fingerprint,local,vault,alice,bob,carol);
  else await runInitial(base,fingerprint,local,vault,alice,bob,carol,disconnect);
 }finally{vault.store.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(async()=>{await (globalThis as any).curve_bn128?.terminate();process.exit(process.exitCode??0);});
}
