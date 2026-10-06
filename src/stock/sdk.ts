import { sha256 } from '@noble/hashes/sha2.js';
import { arkade, buildOffchainTx, CSVMultisigTapscript, EmulatorPacket, Extension, MultisigTapscript, PrevArkTxField, setArkPsbtField, Transaction, UnknownPacket, VtxoScript } from '@arkade-os/sdk';
import type { Identity, TapLeafScript } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import type { StockNativeBinding, StockOperation, StockSettlementProof } from '../../packages/protocol/src/stock-native.ts';
import { encodeStockNativeBinding, stockStateCommitment } from '../../packages/protocol/src/stock-native.ts';
import { validateStockProofEnvelope } from '../../packages/protocol/src/stock-proof.ts';
import { stockProofDescriptor } from '../../packages/protocol/src/stock-native.ts';
import type { StockNetworkInfo } from './network.ts';
import type { ProtocolState } from '../../packages/protocol/src/types.ts';

export const STOCK_LEAVES = ['prepare','abort','transfer','deposit','withdraw','withdraw-funded','seal'] as const;
export type StockLeaf = typeof STOCK_LEAVES[number];
export const STOCK_EXIT_LEAVES = ['exit-prepare','exit-withdraw','exit-withdraw-funded'] as const;
export type StockExitLeaf = typeof STOCK_EXIT_LEAVES[number];
export type StockSpendLeaf = Exclude<StockLeaf,'abort'>|StockExitLeaf;
export interface StockProgramManifest {
 version: 1;
 profile: 'shielded-stock-btc-v1';
 domain: '20260930001';
 publicInputs: 1;
 icPacketHex: string;
 fixedKeyPacketHex: string;
 icHashHex: string;
 fixedKeyHashHex: string;
 combinedKeyHashHex: string;
 programsHashHex: string;
 programs: Record<StockLeaf,string>;
}
export interface StockProfile extends StockProgramManifest {
 verifierKey: unknown;
 descriptorProfileId: string;
 serverKey: string;
 emulatorKey: string;
 vtxo: VtxoScript;
 tapTree: Uint8Array;
 scripts: Record<StockLeaf,Uint8Array>;
 closures: Record<StockLeaf,Uint8Array>;
 exitTapscripts: Record<StockExitLeaf,Uint8Array>;
 exitClosures: Record<StockExitLeaf,Uint8Array>;
 exitClosure: Uint8Array;
 exitTapscript: Uint8Array;
}
export interface StockVtxoInput {
 txid: string;
 vout: number;
 value: number;
 sourceTx: Uint8Array;
 tapTree: Uint8Array;
 tapLeafScript: TapLeafScript;
 emulatorScript?: Uint8Array;
 emulatorWitness?: readonly Uint8Array[];
}
export interface StockSpendRequest {
 profile: StockProfile;
 operation: 'prepare'|'abort'|StockOperation|'withdraw-funded';
 pool: Omit<StockVtxoInput,'tapTree'|'tapLeafScript'|'emulatorScript'|'emulatorWitness'>;
 oldState: ProtocolState;
 newState: ProtocolState;
 externalFunding?: StockVtxoInput;
 externalProgram?: string;
 payoutBTC?: bigint|number|string;
 checkpoint: CSVMultisigTapscript.Type;
 hash: (values:bigint[])=>bigint;
 weightLimit?: number;
}
export interface StockDraft {
 operation: StockSpendRequest['operation'];
 checkpointTxid: string;
 checkpointVout: 0;
 nativeBinding?: StockNativeBinding;
 arkTxPsbt: string;
 checkpointPsbts: string[];
}
export interface StockBuiltSpend {
 operation: StockSpendRequest['operation'];
 arkTx: Transaction;
 checkpoints: Transaction[];
 checkpointOutpoint: {txid:string;vout:0};
 arkTxPsbt: string;
 checkpointPsbts: string[];
 weightLimit: number;
 inputCount: number;
 outputCount: number;
}

function fail(message:string):never{throw new Error(`Invalid stock SDK transaction: ${message}`);}
const sha=(bytes:Uint8Array)=>hex.encode(sha256(bytes));
const fromHex=(value:string,label:string)=>{if(typeof value!=='string'||value.length%2||!/^(?:[0-9a-f]{2})+$/.test(value))fail(`${label} must be lowercase hex.`);return hex.decode(value);};
const packet=(type:number,data:Uint8Array)=>({type:()=>type,serialize:()=>data});
function le(value:bigint|number|string,length:number,label:string):Uint8Array {
 let n:bigint;try{n=BigInt(value);}catch{return fail(`${label} must be an integer.`);}
 if(n<0n||n>=1n<<BigInt(length*8))fail(`${label} is outside uint${length*8}.`);
 const out=new Uint8Array(length);for(let i=0;i<length;i++){out[i]=Number(n&255n);n>>=8n;}return out;
}
function concat(...items:Uint8Array[]){const out=new Uint8Array(items.reduce((n,item)=>n+item.length,0));let i=0;for(const item of items){out.set(item,i);i+=item.length;}return out;}
const FIELD=BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');
function fieldBytes(value:unknown,label:string):Uint8Array {
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))fail(`${label} is not a canonical coordinate.`);
 let n=BigInt(value);if(n>=FIELD)fail(`${label} is outside BN254 Fq.`);
 const out=new Uint8Array(32);for(let i=0;i<32;i++){out[i]=Number(n&255n);n>>=8n;}return out;
}
function deriveKeyPackets(vk:unknown){
 if(!vk||typeof vk!=='object')fail('a pinned Groth16 verifier key is required.');
 const key=vk as Record<string,unknown>,g1=(value:unknown,label:string)=>{
  if(!Array.isArray(value)||value.length!==3||value[2]!=='1')fail(`${label} must be affine G1.`);
  return concat(fieldBytes(value[0],label),fieldBytes(value[1],label));
 },g2=(value:unknown,label:string)=>{
  if(!Array.isArray(value)||value.length!==3||!Array.isArray(value[0])||value[0].length!==2||!Array.isArray(value[1])||value[1].length!==2||JSON.stringify(value[2])!==JSON.stringify(['1','0']))fail(`${label} must be affine G2.`);
  const x0=BigInt(String(value[0][0])),x1=BigInt(String(value[0][1])),y0=BigInt(String(value[1][0])),y1=BigInt(String(value[1][1]));
  if([x0,x1,y0,y1].some(n=>n<0n||n>=FIELD))fail(`${label} is outside BN254 Fq.`);
  const neg=(n:bigint)=>n===0n?0n:FIELD-n;
  return concat(fieldBytes(String(x1),label),fieldBytes(String(x0),label),fieldBytes(String(neg(y1)),label),fieldBytes(String(neg(y0)),label));
 };
 if(key.protocol!=='groth16'||key.curve!=='bn128'||key.nPublic!==1||!Array.isArray(key.IC)||key.IC.length!==2)fail('verifier key must be one-public-input Groth16 BN254.');
 const ic=concat(...key.IC.map((point,index)=>g1(point,`IC[${index}]`)));
 const fixed=concat(g2(key.vk_delta_2,'delta'),g2(key.vk_gamma_2,'gamma'),g1(key.vk_alpha_1,'alpha'),g2(key.vk_beta_2,'beta'));
 return {ic,fixed};
}
function programHash(programs:Record<StockLeaf,string>):string{
 const pairs=[...STOCK_LEAVES].sort().map(name=>[name,programs[name]]);
 return sha(new TextEncoder().encode(JSON.stringify(pairs)));
}
function p2tr(program:string){const witness=fromHex(program,'external Taproot program');if(witness.length!==32)fail('withdrawal program must be exactly 32 bytes.');return concat(Uint8Array.of(0x51,0x20),witness);}
function scriptNumber(text:string):Uint8Array {
 if(!/^(0|[1-9][0-9]*)$/.test(text))fail('Groth16 coordinates must be canonical decimals.');
 let n=BigInt(text);if(n===0n)return new Uint8Array();const bytes:number[]=[];while(n>0n){bytes.push(Number(n&255n));n>>=8n;}if(bytes.at(-1)!&0x80)bytes.push(0);return Uint8Array.from(bytes);
}
function proofWitness(proof:StockSettlementProof):Uint8Array[] {
 const {pi_a:a,pi_b:b,pi_c:c}=proof.proof;
 return [a[0],a[1],b[0][1],b[0][0],b[1][1],b[1][0],c[0],c[1]].map(scriptNumber);
}
function modeOf(operation:StockSpendRequest['operation']):StockOperation|undefined{return operation==='prepare'||operation==='abort'?undefined:operation==='withdraw-funded'?'withdraw':operation;}
function inputData(input:StockVtxoInput){
 if(!Number.isSafeInteger(input.value)||input.value<0||!Number.isInteger(input.vout)||input.vout<0||!/^[0-9a-f]{64}$/.test(input.txid)||!input.sourceTx.length)fail('a native input with its original transaction is required.');
 const tree=VtxoScript.decode(input.tapTree),previous=Transaction.fromRaw(input.sourceTx),output=previous.getOutput(input.vout);
 if(previous.id!==input.txid||!output||output.amount!==BigInt(input.value)||hex.encode(output.script??new Uint8Array())!==hex.encode(tree.pkScript))fail('input outpoint, value, or Taproot policy does not match its authenticated previous transaction.');
 return tree;
}
export function loadStockProfile(manifest:StockProgramManifest,verifierKey:unknown,descriptorProfileId:string,network:Pick<StockNetworkInfo,'serverKey'|'emulatorKey'|'exitDelay'>,expectedProgramsHash:string):StockProfile {
 if(!manifest||manifest.version!==1||manifest.profile!=='shielded-stock-btc-v1'||manifest.domain!=='20260930001'||manifest.publicInputs!==1)fail('unsupported verifier profile.');
 const descriptor=stockProofDescriptor(verifierKey);
 if(descriptor.profileId!==descriptorProfileId)fail('verifier descriptor does not match the loaded Groth16 key.');
 if(!network||!/^[0-9a-f]{64}$/.test(network.serverKey)||!/^[0-9a-f]{64}$/.test(network.emulatorKey)||network.serverKey===network.emulatorKey)fail('expected Mutinynet signer keys are required.');
 if(!/^[0-9a-f]{64}$/.test(expectedProgramsHash)||manifest.programsHashHex!==expectedProgramsHash||programHash(manifest.programs)!==expectedProgramsHash)fail('native policy programs do not match the trusted release pin.');
 const ic=fromHex(manifest.icPacketHex,'IC packet'),fixed=fromHex(manifest.fixedKeyPacketHex,'fixed-key packet');
 if(ic.length!==128||fixed.length!==448||sha(ic)!==manifest.icHashHex||sha(fixed)!==manifest.fixedKeyHashHex)fail('verifier key packet size or pin mismatch.');
 const derived=deriveKeyPackets(verifierKey),combined=sha(concat(derived.ic,derived.fixed));
 if(hex.encode(derived.ic)!==hex.encode(ic)||hex.encode(derived.fixed)!==hex.encode(fixed)||combined!==manifest.combinedKeyHashHex)fail('native verifier packets are not derived from the pinned verifier key.');
 const scripts=Object.fromEntries(STOCK_LEAVES.map(name=>[name,fromHex(manifest.programs?.[name]??'',''+name+' script')])) as Record<StockLeaf,Uint8Array>;
 if(new Set(Object.values(scripts).map(hex.encode)).size!==STOCK_LEAVES.length)fail('every policy phase must have a distinct immutable leaf.');
 const closures=Object.fromEntries(STOCK_LEAVES.map(name=>[name,MultisigTapscript.encode({pubkeys:[hex.decode(network.serverKey),arkade.computeArkadeScriptPublicKey(hex.decode(network.emulatorKey),scripts[name])]}).script])) as Record<StockLeaf,Uint8Array>;
 const exitTapscripts:Record<StockExitLeaf,Uint8Array>={
  'exit-prepare':CSVMultisigTapscript.encode({timelock:{type:network.exitDelay.type,value:BigInt(network.exitDelay.value)},pubkeys:[arkade.computeArkadeScriptPublicKey(hex.decode(network.emulatorKey),scripts.prepare)]}).script,
  'exit-withdraw':CSVMultisigTapscript.encode({timelock:{type:network.exitDelay.type,value:BigInt(network.exitDelay.value)},pubkeys:[arkade.computeArkadeScriptPublicKey(hex.decode(network.emulatorKey),scripts.withdraw)]}).script,
  'exit-withdraw-funded':CSVMultisigTapscript.encode({timelock:{type:network.exitDelay.type,value:BigInt(network.exitDelay.value)},pubkeys:[arkade.computeArkadeScriptPublicKey(hex.decode(network.emulatorKey),scripts['withdraw-funded'])]}).script,
 };
 const exitClosures=exitTapscripts,exitTapscript=exitTapscripts['exit-withdraw'],exitClosure=exitTapscript,sorted=[...STOCK_LEAVES.filter(name=>name!=='abort'),...STOCK_EXIT_LEAVES].sort() as StockSpendLeaf[],vtxo=new VtxoScript(sorted.map(name=>name in exitClosures?exitClosures[name as StockExitLeaf]:closures[name as Exclude<StockLeaf,'abort'>]));
 if(!vtxo.pkScript||!vtxo.encode())fail('could not assemble Arkade-compatible stock Taproot tree.');
 return {...structuredClone(manifest),verifierKey:structuredClone(verifierKey),descriptorProfileId,serverKey:network.serverKey,emulatorKey:network.emulatorKey,vtxo,tapTree:vtxo.encode(),scripts,closures,exitTapscripts,exitClosures,exitClosure,exitTapscript};
}
function poolInput(request:StockSpendRequest,operation=request.operation):StockVtxoInput {
 if(operation==='abort')fail('the fresh stock profile has no abort covenant leaf; reconcile the exact prepare outcome instead.');
 const script=request.profile.scripts[operation];
 const closure=request.profile.closures[operation];
 return {...request.pool,tapTree:request.profile.tapTree,tapLeafScript:request.profile.vtxo.findLeaf(hex.encode(closure)),emulatorScript:script};
}
function outputsAndInputs(request:StockSpendRequest){
 const mode=modeOf(request.operation),pool=poolInput(request),inputs:StockVtxoInput[]=[pool],outputs:{script:Uint8Array;amount:bigint}[]=[];
 const poolTree=inputData(pool);
 if(hex.encode(poolTree.pkScript)!==hex.encode(request.profile.vtxo.pkScript))fail('pool input is not locked to this immutable stock profile.');
 const oldCommit=stockStateCommitment(request.hash,request.oldState),newCommit=stockStateCommitment(request.hash,request.newState),sameState=oldCommit===newCommit;
 if((request.operation==='prepare'||request.operation==='abort')&&!sameState)fail('prepare and abort must preserve the state commitment.');
 if(request.oldState.reserves.DEMO!==0||request.newState.reserves.DEMO!==0)fail('the first stock profile supports BTC only.');
 const poolValue=BigInt(pool.value),continuation=330n+BigInt(request.newState.reserves.BTC);
 if(mode==='deposit'){
  if(!request.externalFunding)fail('deposit requires a customer-owned Ark VTXO input.');
  inputData(request.externalFunding);inputs.push(request.externalFunding);
  const oldReserve=BigInt(request.oldState.reserves.BTC),newReserve=BigInt(request.newState.reserves.BTC),funding=BigInt(request.externalFunding.value);
  if(poolValue!==330n+oldReserve||newReserve-oldReserve!==funding)fail('deposit input must be credited in full to the proved BTC reserve.');
  outputs.push({script:request.profile.vtxo.pkScript,amount:continuation});
 }else if(mode==='withdraw'){
  const payout=BigInt(request.payoutBTC??0),oldReserve=BigInt(request.oldState.reserves.BTC),newReserve=BigInt(request.newState.reserves.BTC);
  const funding=request.operation==='withdraw-funded'?request.externalFunding:undefined;
  if(request.operation==='withdraw-funded'&&!funding)fail('dust withdrawal requires a customer-owned Ark VTXO funding input.');
  if(funding){inputData(funding);inputs.push(funding);}
  if(poolValue!==330n+oldReserve||payout<=0n||oldReserve-newReserve+BigInt(funding?.value??0)!==payout||!request.externalProgram)fail('withdrawal amount, payout program, external funding, and reserve change must agree.');
  outputs.push({script:p2tr(request.externalProgram),amount:payout},{script:request.profile.vtxo.pkScript,amount:continuation});
 }else{
  if(request.externalFunding||request.payoutBTC||request.externalProgram)fail(`${request.operation} cannot add external inputs or payouts.`);
  if(poolValue!==330n+BigInt(request.oldState.reserves.BTC)||BigInt(request.oldState.reserves.BTC)!==BigInt(request.newState.reserves.BTC))fail(`${request.operation} must preserve pool backing.`);
  outputs.push({script:request.profile.vtxo.pkScript,amount:continuation});
 }
 return {mode,pool,inputs,outputs,oldCommit,newCommit,continuation};
}
function extensionFor(request:StockSpendRequest,proof?:StockSettlementProof){
 const {mode,inputs,oldCommit,newCommit}=outputsAndInputs(request);
 if(proof){
  if(!mode||proof.operation!==mode)fail('proof operation does not match the transaction leaf.');
  validateStockProofEnvelope(proof,request.profile.verifierKey);
  if(proof.descriptorProfileId!==request.profile.descriptorProfileId)fail('proof verifier profile does not match the loaded stock scripts.');
 }
 const proofItems=proof?proofWitness(proof):[];
 const entries=[{vin:0,script:inputs[0].emulatorScript!,witness:RawWitness.encode(proofItems)}];
 for(const [vin,input] of inputs.entries())if(vin>0&&input.emulatorScript)entries.push({vin,script:input.emulatorScript,witness:RawWitness.encode([...(input.emulatorWitness??[])])});
 const packets: import('@arkade-os/sdk').ExtensionPacket[]=[EmulatorPacket.create(entries)];
 if(request.operation==='prepare')packets.push(new UnknownPacket(0x85,fromHex(request.profile.icPacketHex,'IC packet')),new UnknownPacket(0x86,fromHex(request.profile.fixedKeyPacketHex,'fixed-key packet')));
 packets.push(new UnknownPacket(0x87,le(request.operation==='prepare'||request.operation==='abort'?oldCommit:newCommit,32,'state commitment')));
 packets.push(new UnknownPacket(0x88,Uint8Array.of(request.operation==='prepare'?18:17)));
 return Extension.create(packets);
}
function build(request:StockSpendRequest,proof?:StockSettlementProof){
 const model=outputsAndInputs(request),extension=extensionFor(request,proof);
 const sdkInputs=model.inputs.map(input=>({txid:input.txid,vout:input.vout,value:input.value,tapTree:input.tapTree,tapLeafScript:input.tapLeafScript}));
 const assembled=buildOffchainTx(sdkInputs,[...model.outputs,extension.txOut()],request.checkpoint);
 if(assembled.checkpoints.length!==model.inputs.length)fail('SDK checkpoint count does not match native input count.');
 for(const [vin,input] of model.inputs.entries())setArkPsbtField(assembled.arkTx,vin,PrevArkTxField,input.sourceTx);
 return {...model,arkTx:assembled.arkTx,checkpoints:assembled.checkpoints};
}
function checkpointBinding(request:StockSpendRequest,checkpoint:Transaction):StockNativeBinding {
 const model=outputsAndInputs(request),mode=modeOf(request.operation);if(!mode)fail('prepare and abort have no Groth16 statement.');
 const txidLE=hex.encode(Uint8Array.from(hex.decode(checkpoint.id)).reverse());
 return {mode,checkpointTxidLE:txidLE,checkpointVout:0,oldState:request.oldState,newState:request.newState,poolInputBTC:String(request.pool.value),continuationBTC:model.continuation.toString(),
  ...(request.externalFunding?{externalFundingBTC:String(request.externalFunding.value)}:{}),...(mode==='withdraw'?{payoutOrChangeBTC:String(request.payoutBTC),externalProgram:request.externalProgram}:{})};
}
export function planStockSpend(request:StockSpendRequest):StockDraft {
 if(request.operation==='prepare'||request.operation==='abort')fail('prepare and abort are complete transactions and do not need a proof draft.');
 const built=build(request),checkpoint=built.checkpoints[0],binding=checkpointBinding(request,checkpoint);
 return {operation:request.operation,checkpointTxid:checkpoint.id,checkpointVout:0,nativeBinding:binding,arkTxPsbt:base64.encode(built.arkTx.toPSBT()),checkpointPsbts:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
}
export function buildStockSpend(request:StockSpendRequest,proof?:StockSettlementProof,expectedDraft?:StockDraft):StockBuiltSpend {
 if(request.operation!=='prepare'&&request.operation!=='abort'&&!proof)fail('a client proof is required for stock state transitions.');
 if((request.operation==='prepare'||request.operation==='abort')&&proof)fail('prepare and abort do not carry a Groth16 proof.');
 const built=build(request,proof),checkpoint=built.checkpoints[0],binding=modeOf(request.operation)?checkpointBinding(request,checkpoint):undefined;
 if(expectedDraft&&(expectedDraft.operation!==request.operation||expectedDraft.checkpointTxid!==checkpoint.id||expectedDraft.checkpointVout!==0))fail('proof draft was built for a different checkpoint transaction.');
 if(proof&&binding){const expected=encodeStockNativeBinding(binding,request.hash);if(proof.nativeBinding!==hex.encode(expected))fail('proof is bound to different native transaction facts.');if(expectedDraft?.nativeBinding&&hex.encode(encodeStockNativeBinding(expectedDraft.nativeBinding,request.hash))!==hex.encode(expected))fail('prepared proof draft changed before finalization.');}
 const configured=request.weightLimit??4_000;if(!Number.isSafeInteger(configured)||configured<1)fail('invalid operator weight limit.');
 return {operation:request.operation,arkTx:built.arkTx,checkpoints:built.checkpoints,checkpointOutpoint:{txid:checkpoint.id,vout:0},arkTxPsbt:base64.encode(built.arkTx.toPSBT()),checkpointPsbts:built.checkpoints.map(tx=>base64.encode(tx.toPSBT())),weightLimit:Math.min(configured,4_000),inputCount:built.inputs.length,outputCount:built.arkTx.outputsLength};
}
export function stockVmRequest(spend:StockBuiltSpend){return {arkTx:spend.arkTxPsbt,checkpoints:spend.checkpointPsbts};}
export function stockProofWitnessOrder(proof:StockSettlementProof){return proofWitness(proof);}
export async function signCustomerDeposit(spend:StockBuiltSpend,identity:Identity):Promise<StockBuiltSpend>{
 if(spend.operation!=='deposit'||spend.arkTx.inputsLength!==2||spend.checkpoints.length!==2)fail('customer signature is only valid for the two-input deposit path.');
 const arkTx=await identity.sign(spend.arkTx,[1]),checkpoints=spend.checkpoints.slice();checkpoints[1]=await identity.sign(checkpoints[1],[0]);
 return {...spend,arkTx,checkpoints,arkTxPsbt:base64.encode(arkTx.toPSBT()),checkpointPsbts:checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
}
export async function signCustomerFunding(spend:StockBuiltSpend,identity:Identity):Promise<StockBuiltSpend>{
 if((spend.operation!=='deposit'&&spend.operation!=='withdraw-funded')||spend.arkTx.inputsLength!==2||spend.checkpoints.length!==2)fail('customer signature requires the exact two-input stock funding path.');
 return signCustomerDeposit({...spend,operation:'deposit'},identity).then(signed=>({...signed,operation:spend.operation}));
}
