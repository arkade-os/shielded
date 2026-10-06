import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { arkade, CSVMultisigTapscript, EmulatorPacket, Extension, MultisigTapscript, SingleKey, Transaction, VtxoScript } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { STOCK_FIELD, encodeStockNativeBinding, stockProofDescriptor, stockStatementScalar } from '../packages/protocol/src/stock-native.ts';
import type { ProtocolState } from '../packages/protocol/src/types.ts';
import { buildStockSpend, loadStockProfile, planStockSpend, signCustomerFunding, stockVmRequest, type StockProgramManifest, type StockProfile, type StockVtxoInput } from '../src/stock/sdk.ts';
import { offlineNativeFixture } from '../src/sdk/adapter.ts';
import { walletIntentLeafScriptHex } from '../src/stock/ark-wallet.ts';

const key={protocol:'groth16',curve:'bn128',nPublic:1,vk_alpha_1:['1','2','1'],vk_beta_2:[['3','4'],['5','6'],['1','0']],vk_gamma_2:[['7','8'],['9','10'],['1','0']],vk_delta_2:[['11','12'],['13','14'],['1','0']],IC:[['15','16','1'],['17','18','1']]};
const h=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const field=(value:unknown)=>{let n=BigInt(String(value));const out=new Uint8Array(32);for(let i=0;i<32;i++){out[i]=Number(n&255n);n>>=8n;}return out;};
function keyPackets(){
 const g1=(p:unknown[])=>new Uint8Array([...field(p[0]),...field(p[1])]);
 const g2=(p:unknown[][])=>{const mod=BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583'),neg=(x:unknown)=>field(String(BigInt(String(x))===0n?0n:mod-BigInt(String(x))));return new Uint8Array([...field(p[0][1]),...field(p[0][0]),...neg(p[1][1]),...neg(p[1][0])]);};
 const ic=new Uint8Array([...g1(key.IC[0]),...g1(key.IC[1])]),fixed=new Uint8Array([...g2(key.vk_delta_2),...g2(key.vk_gamma_2),...g1(key.vk_alpha_1),...g2(key.vk_beta_2)]);
 return {ic,fixed};
}
const programs=Object.fromEntries(['prepare','abort','transfer','deposit','withdraw','withdraw-funded','seal'].map((name,i)=>[name,hex.encode(Uint8Array.of(0x51+i))])) as Record<'prepare'|'abort'|'transfer'|'deposit'|'withdraw'|'withdraw-funded'|'seal',string>;
function manifest():StockProgramManifest{
 const {ic,fixed}=keyPackets(),pairs=Object.entries(programs).sort(([a],[b])=>a.localeCompare(b));
 return {version:1,profile:'shielded-stock-btc-v1',domain:'20260930001',publicInputs:1,icPacketHex:hex.encode(ic),fixedKeyPacketHex:hex.encode(fixed),icHashHex:h(ic),fixedKeyHashHex:h(fixed),combinedKeyHashHex:h(new Uint8Array([...ic,...fixed])),programsHashHex:h(new TextEncoder().encode(JSON.stringify(pairs))),programs};
}
const server=SingleKey.fromPrivateKey(new Uint8Array(32).fill(1)),emulator=SingleKey.fromPrivateKey(new Uint8Array(32).fill(2));
const hash=(values:bigint[])=>values.reduce((acc,value)=>(acc*257n+value)%STOCK_FIELD,1n);
const state=(reserve:number,revision:number):ProtocolState=>({noteRoot:'1',spentRoot:'2',historyRoot:'3',noteCount:2,historyCount:1,revision,reserves:{BTC:reserve,DEMO:0}});
async function profile():Promise<StockProfile>{
 const network={serverKey:hex.encode(await server.xOnlyPublicKey()),emulatorKey:hex.encode(await emulator.xOnlyPublicKey()),exitDelay:{type:'seconds' as const,value:2048}},data=manifest();
 return loadStockProfile(data,key,stockProofDescriptor(key).profileId,network,data.programsHashHex);
}
function vtxoInput(tree:VtxoScript,value:number):StockVtxoInput{
 const funding=offlineNativeFixture([{script:tree.pkScript,amount:BigInt(value)}]);
 return {txid:funding.id,vout:0,value,sourceTx:funding.toBytes(),tapTree:tree.encode(),tapLeafScript:tree.findLeaf(hex.encode(tree.scripts[0]))};
}
function makeProof(nativeBinding:string,operation:'transfer'|'deposit'|'withdraw'|'seal',descriptorProfileId:string){
 const scalar=stockStatementScalar(Uint8Array.from(hex.decode(nativeBinding))).toString();
 return {version:1 as const,profile:'shielded-stock-btc-v1' as const,descriptorProfileId,operation,nativeBinding,statement:scalar,publicSignals:[scalar] as [string],proof:{protocol:'groth16' as const,curve:'bn128' as const,pi_a:['1','2','1'] as [string,string,string],pi_b:[['1','2'],['3','4'],['1','0']] as [[string,string],[string,string],[string,string]],pi_c:['5','6','1'] as [string,string,string]}};
}

test('stock profile wraps VM programs in the Arkade emulator/server two-key closure',async()=>{
 const p=await profile();assert.equal(p.vtxo.scripts.length,9);
 const expectedLeaves={deposit:p.closures.deposit,'exit-prepare':p.exitClosures['exit-prepare'],'exit-withdraw':p.exitClosures['exit-withdraw'],'exit-withdraw-funded':p.exitClosures['exit-withdraw-funded'],prepare:p.closures.prepare,seal:p.closures.seal,transfer:p.closures.transfer,withdraw:p.closures.withdraw,'withdraw-funded':p.closures['withdraw-funded']};
 assert.deepEqual(p.vtxo.scripts.map(hex.encode),Object.keys(expectedLeaves).sort().map(name=>hex.encode(expectedLeaves[name as keyof typeof expectedLeaves])));
 for(const name of ['prepare','abort','transfer','deposit','withdraw','withdraw-funded','seal'] as const){
  const tweaked=arkade.computeArkadeScriptPublicKey(hex.decode(p.emulatorKey),p.scripts[name]);
  assert.deepEqual(p.closures[name],MultisigTapscript.encode({pubkeys:[hex.decode(p.serverKey),tweaked]}).script);
  assert.notDeepEqual(tweaked,arkade.computeArkadeScriptPublicKey(hex.decode(p.emulatorKey),arkade.arkadeScriptHash(p.scripts[name])),'the SDK accepts raw VM script bytes and hashes them internally');
  if(name==='abort')assert.throws(()=>p.vtxo.findLeaf(hex.encode(p.closures[name])),/not found/);else assert.ok(p.vtxo.findLeaf(hex.encode(p.closures[name])));
  assert.notDeepEqual(p.closures[name],p.scripts[name]);
 }
 for(const [name,program] of [['exit-prepare','prepare'],['exit-withdraw','withdraw'],['exit-withdraw-funded','withdraw-funded']] as const){
  assert.ok(p.vtxo.findLeaf(hex.encode(p.exitClosures[name])));
  assert.deepEqual(p.exitTapscripts[name],CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[arkade.computeArkadeScriptPublicKey(hex.decode(p.emulatorKey),p.scripts[program])]}).script);
 }
 assert.deepEqual(p.exitTapscript,p.exitTapscripts['exit-withdraw']);
 assert.throws(()=>{const q:any={profile:p,operation:'abort'};buildStockSpend(q);},/no abort covenant leaf/);
});

test('Arkade script tweak matches the Go reference vector for a real stock prepare leaf',()=>{
 const script=hex.decode('d4519dd5539d51cf009d52cf009d00c900cf8800ca6b00d16b6c6c9d8802870000f5698201209d028700f4698201209d8802880000f569011188028800f469011288028500f469820280009d76c47c75028600f4697dc6207994b0ca969b69a417e3332f06f1f130ed9c663904a3338153f22d52469bc3b688750000f591697500f491697551');
 const emulatorKey=hex.decode('f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a');
 assert.equal(hex.encode(arkade.arkadeScriptHash(script)),'90ef90c5acc824981a031070c8774adb4b0fdf5094c0a296a44a630646f24c10');
 assert.equal(hex.encode(arkade.computeArkadeScriptPublicKey(emulatorKey,script)),'ba0a28b5c8918320fcd2f5d9d8ce7cc421997da5ff7b875cd683f38e39ab42d2');
 assert.notEqual(hex.encode(arkade.computeArkadeScriptPublicKey(emulatorKey,arkade.arkadeScriptHash(script))),'ba0a28b5c8918320fcd2f5d9d8ce7cc421997da5ff7b875cd683f38e39ab42d2');
});

test('Arkade wallet intent leaf serialization strips the trailing Taproot leaf version',async()=>{
 const serverKey=await server.xOnlyPublicKey(),script=MultisigTapscript.encode({pubkeys:[serverKey,await emulator.xOnlyPublicKey()]}).script,tree=new VtxoScript([script,CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[serverKey]}).script]),leaf=tree.findLeaf(hex.encode(script));
 assert.equal(leaf[1].at(-1),0xc0);
 assert.equal(walletIntentLeafScriptHex(leaf),hex.encode(script));
 assert.equal(tree.findLeaf(walletIntentLeafScriptHex(leaf)),leaf);
 assert.throws(()=>walletIntentLeafScriptHex([new Uint8Array(),new Uint8Array()]));
});

test('profile loading rejects arbitrary verifier packets, descriptors, and unpinned VM leaves',async()=>{
 const p=manifest(),id=stockProofDescriptor(key).profileId,network={serverKey:hex.encode(await server.xOnlyPublicKey()),emulatorKey:hex.encode(await emulator.xOnlyPublicKey()),exitDelay:{type:'seconds' as const,value:2048}};
 assert.throws(()=>loadStockProfile(p,key,'0'.repeat(64),network,p.programsHashHex),/descriptor does not match/);
 assert.throws(()=>loadStockProfile({...p,programsHashHex:'0'.repeat(64)},key,id,network,p.programsHashHex),/trusted release pin/);
 const changed={...p,fixedKeyPacketHex:'00'.repeat(448)},raw=hex.decode(changed.fixedKeyPacketHex);changed.fixedKeyHashHex=h(raw);changed.combinedKeyHashHex=h(new Uint8Array([...hex.decode(changed.icPacketHex),...raw]));
 assert.throws(()=>loadStockProfile(changed,key,id,network,p.programsHashHex),/not derived from the pinned verifier/);
 assert.throws(()=>loadStockProfile(p,key,id,{...network,serverKey:'11'.repeat(32)},p.programsHashHex),/signer keys|wrong pubkey/);
});

test('transfer binds proof to the exact native checkpoint and omits a customer emulator entry',async()=>{
 const p=await profile(),oldState=state(1_000,1),newState=state(1_000,2),pool=vtxoInput(p.vtxo,1_330),draft=planStockSpend({profile:p,operation:'transfer',pool,oldState,newState,checkpoint:CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}),hash});
 const bindingBytes=encodeStockNativeBinding(draft.nativeBinding!,hash),proof=makeProof(hex.encode(bindingBytes),'transfer',p.descriptorProfileId);
 const result=buildStockSpend({profile:p,operation:'transfer',pool,oldState,newState,checkpoint:CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}),hash},proof,draft);
 const extension=Extension.fromTx(result.arkTx),packet=extension.getEmulatorPacket();assert(packet);assert.equal(packet.entries.length,1);assert.equal(packet.entries[0].vin,0);assert.equal(hex.encode(packet.entries[0].script),hex.encode(p.scripts.transfer));
 assert.equal(extension.getPacketByType(0x89),null);assert.equal(result.checkpointOutpoint.txid,draft.checkpointTxid);
 assert.throws(()=>buildStockSpend({profile:p,operation:'transfer',pool,oldState,newState,checkpoint:CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}),hash},makeProof('00'.repeat(201),'transfer',p.descriptorProfileId),draft),/does not match its native binding/);
});

test('two-input deposit does not demand an emulator signature from the customer Ark VTXO',async()=>{
 const p=await profile(),oldState=state(1_000,1),newState=state(1_200,2),pool=vtxoInput(p.vtxo,1_330),customerTree=new VtxoScript([CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}).script]),externalFunding=vtxoInput(customerTree,200),request={profile:p,operation:'deposit' as const,pool,oldState,newState,externalFunding,checkpoint:CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}),hash};
 const draft=planStockSpend(request),proof=makeProof(hex.encode(encodeStockNativeBinding(draft.nativeBinding!,hash)),'deposit',p.descriptorProfileId),built=buildStockSpend(request,proof,draft),packet=Extension.fromTx(built.arkTx).getEmulatorPacket();
 assert.equal(built.arkTx.inputsLength,2);assert.equal(packet?.entries.length,1);assert.equal(packet?.entries[0].vin,0);
});

test('fixture-only funded withdrawal binds exact coin and adds customer signing witness below dust',async()=>{
 const p=await profile(),oldState=state(1_000,1),newState=state(999,2),pool=vtxoInput(p.vtxo,1_330),customer=SingleKey.fromPrivateKey(new Uint8Array(32).fill(3)),customerLeaf=MultisigTapscript.encode({pubkeys:[await server.xOnlyPublicKey(),await customer.xOnlyPublicKey()]}).script,customerTree=new VtxoScript([customerLeaf]),externalFunding=vtxoInput(customerTree,330),request={profile:p,operation:'withdraw-funded' as const,pool,oldState,newState,externalFunding,payoutBTC:331,externalProgram:'ab'.repeat(32),checkpoint:CSVMultisigTapscript.encode({timelock:{type:'blocks',value:144n},pubkeys:[hex.decode(p.serverKey)]}),hash};
 const draft=planStockSpend(request);assert.equal(draft.nativeBinding?.externalFundingBTC,'330');assert.equal(draft.nativeBinding?.payoutOrChangeBTC,'331');
 const proof=makeProof(hex.encode(encodeStockNativeBinding(draft.nativeBinding!,hash)),'withdraw',p.descriptorProfileId),spend=buildStockSpend(request,proof,draft),signed=await signCustomerFunding(spend,customer);
 assert.equal(signed.operation,'withdraw-funded');assert.equal(signed.arkTx.inputsLength,2);assert.equal(signed.checkpoints.length,2);
 const wire=stockVmRequest(signed);assert.equal(typeof wire.arkTx,'string');assert.equal(wire.checkpoints.length,2,'fixture should serialize its signed native request; this test does not measure production proof weight.');
});
