import {base64,hex} from '@scure/base';
import {CSVMultisigTapscript,MultisigTapscript,RestEmulatorProvider,RestIndexerProvider,Transaction,matchServerCheckpoints,verifyTapscriptSignatures} from '@arkade-os/sdk';
import {TaprootControlBlock} from '@scure/btc-signer/psbt.js';
import {tapLeafHash} from '@scure/btc-signer/payment.js';
import {assertStockWeightBudget,type StockNetworkInfo} from './network.ts';
import type {StockBuiltSpend} from './sdk.ts';
import {decodeStockIndexerTransaction} from './indexer.ts';

export interface StockWireRequest {arkTx:string;checkpoints:string[]}
export interface StockSignedResponse {signedArkTx:string;signedCheckpointTxs:string[]}
export interface StockNativeReceipt extends StockSignedResponse {
 txid:string;
 checkpointTxids:string[];
 weights:{ark:number;checkpoints:number[]};
 network:'mutinynet';
 finality:'operator-preconfirmed';
}
function same(left:Uint8Array|undefined,right:Uint8Array|undefined){return !!left&&!!right&&hex.encode(left)===hex.encode(right);}
function signers(script:Uint8Array):Uint8Array[]{
 if(CSVMultisigTapscript.isScriptValid(script)===true)return CSVMultisigTapscript.decode(script).params.pubkeys;
 try{const decoded=MultisigTapscript.decode(script);if(same(MultisigTapscript.encode(decoded.params).script,script))return decoded.params.pubkeys;}catch{}
 throw new Error('Unsupported stock spend closure; only plain platform multisig and its CSV checkpoint are permitted.');
}
function finalized(tx:Transaction,estimate=false):Transaction {
 const result=Transaction.fromPSBT(tx.toPSBT());
 for(let vin=0;vin<result.inputsLength;vin++){
  const input=result.getInput(vin),leaves=input.tapLeafScript;if(!leaves||leaves.length!==1)throw new Error('Stock spend must select exactly one immutable leaf.');
  const leaf=leaves[0],script=leaf[1].subarray(0,-1),keys=signers(script),leafHash=tapLeafHash(script,leaf[1].at(-1)!);
  const signatures=keys.slice().reverse().map(pubKey=>{
   const signature=input.tapScriptSig?.find(([key])=>same(key.pubKey,pubKey)&&same(key.leafHash,leafHash))?.[1];
   if(signature&&signature.length!==64)throw new Error('Stock transaction requires SIGHASH_DEFAULT signatures.');
   if(!signature&&!estimate)throw new Error('Incomplete stock native signature set.');
   return signature??new Uint8Array(64);
  });
  result.updateInput(vin,{finalScriptWitness:[...signatures,script,TaprootControlBlock.encode(leaf[0])]});
 }
 return result;
}
const weight=(tx:Transaction)=>tx.toBytes(true,true).length+3*tx.toBytes(false,false).length;
export function stockSignedWeights(request:StockWireRequest,estimate=false):{ark:number;checkpoints:number[]}{
 return {ark:weight(finalized(Transaction.fromPSBT(base64.decode(request.arkTx)),estimate)),checkpoints:request.checkpoints.map(encoded=>weight(finalized(Transaction.fromPSBT(base64.decode(encoded)),estimate)))};
}
export function verifyStockCustomerSignatures(request:StockWireRequest,serverKey:string):void {
 const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),checkpoints=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
 if(checkpoints.length!==ark.inputsLength)throw new Error('Stock input/checkpoint count mismatch.');
 for(let vin=1;vin<ark.inputsLength;vin++)for(const [tx,input] of [[ark,vin],[checkpoints[vin],0]] as const){
  const leaf=tx.getInput(input).tapLeafScript?.[0];if(!leaf)throw new Error('Customer funding has no immutable spend leaf.');
  const keys=signers(leaf[1].subarray(0,-1));
  if(keys.length!==2||!keys.some(key=>hex.encode(key)===serverKey))throw new Error('Customer funding must use its owner and the pinned Arkade signer.');
  const customer=keys.filter(key=>hex.encode(key)!==serverKey).map(key=>hex.encode(key));
  verifyTapscriptSignatures(tx,input,customer,undefined,undefined,tapLeafHash(leaf[1].subarray(0,-1),leaf[1].at(-1)!));
 }
}
function complete(actual:Transaction,expected:Transaction,serverKey:string):Transaction {
 if(actual.id!==expected.id||!same(actual.unsignedTx,expected.unsignedTx))throw new Error('Stock signer changed the exact submitted transaction.');
 for(let vin=0;vin<expected.inputsLength;vin++){
  const original=expected.getInput(vin),returned=actual.getInput(vin),leaf=original.tapLeafScript?.[0],returnedLeaf=returned.tapLeafScript?.[0];
  if(!leaf||!returnedLeaf||!same(leaf[1],returnedLeaf[1])||!same(TaprootControlBlock.encode(leaf[0]),TaprootControlBlock.encode(returnedLeaf[0]))||original.witnessUtxo?.amount!==returned.witnessUtxo?.amount||!same(original.witnessUtxo?.script,returned.witnessUtxo?.script))throw new Error('Stock signer changed authenticated input or policy metadata.');
  const script=leaf[1].subarray(0,-1),keys=signers(script);
  if(!keys.some(key=>hex.encode(key)===serverKey))throw new Error('Stock spend does not require the pinned Arkade signer.');
  verifyTapscriptSignatures(actual,vin,keys.map(key=>hex.encode(key)),undefined,undefined,tapLeafHash(script,leaf[1].at(-1)!));
 }
 return finalized(actual);
}
export function verifyStockResponse(request:StockWireRequest,response:StockSignedResponse,network:StockNetworkInfo):StockNativeReceipt {
 const expected=Transaction.fromPSBT(base64.decode(request.arkTx)),actual=Transaction.fromPSBT(base64.decode(response.signedArkTx));
 const checkpoints=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
 const signed=complete(actual,expected,network.serverKey);
 const matched=matchServerCheckpoints(response.signedCheckpointTxs,checkpoints,'stock emulator');
 const completed=matched.map(({server,local})=>complete(server,local,network.serverKey));
 const weights={ark:weight(signed),checkpoints:completed.map(weight)};assertStockWeightBudget(network,weights);
 return {txid:signed.id,checkpointTxids:completed.map(tx=>tx.id),weights,signedArkTx:base64.encode(signed.toPSBT()),signedCheckpointTxs:completed.map(tx=>base64.encode(tx.toPSBT())),network:'mutinynet',finality:'operator-preconfirmed'};
}
function restoreIndexed(raw:Transaction,expected:Transaction):Transaction {
 if(raw.id!==expected.id||!same(raw.unsignedTx,expected.unsignedTx))throw new Error('Indexer returned different stock transaction facts.');
 if(raw.inputsLength!==expected.inputsLength||raw.outputsLength!==expected.outputsLength)throw new Error('Indexer returned different stock transaction shape.');
 const result=Transaction.fromPSBT(expected.toPSBT());
 for(let vin=0;vin<result.inputsLength;vin++){
  const original=result.getInput(vin),received=raw.getInput(vin),leaf=original.tapLeafScript?.[0],receivedLeaves=received.tapLeafScript;
  if(!leaf||!receivedLeaves||receivedLeaves.length!==1)throw new Error('Indexer lacks authenticated stock spend leaf metadata.');
  const receivedLeaf=receivedLeaves[0];
  if(!same(leaf[1],receivedLeaf[1])||!same(TaprootControlBlock.encode(leaf[0]),TaprootControlBlock.encode(receivedLeaf[0]))||original.witnessUtxo?.amount!==received.witnessUtxo?.amount||!same(original.witnessUtxo?.script,received.witnessUtxo?.script)||!same(original.txid,received.txid)||original.index!==received.index)throw new Error('Indexer returned different authenticated stock input metadata.');
  const script=leaf[1].subarray(0,-1),keys=signers(script),leafHash=tapLeafHash(script,leaf[1].at(-1)!);
  const witness=received.finalScriptWitness;
  let signatures:Uint8Array[];
  if(witness){
   if(witness.length!==keys.length+2||!same(witness.at(-2),script)||!same(witness.at(-1),TaprootControlBlock.encode(leaf[0])))throw new Error('Indexer returned a different stock policy or signature stack.');
   signatures=keys.map((_,index)=>witness[keys.length-index-1]);
  }else{
   const entries=received.tapScriptSig??[];
   if(entries.length!==keys.length)throw new Error('Indexer lacks the complete stock signer set.');
   const seen=new Set<string>();
   for(const [key] of entries){
    const encoded=hex.encode(key.pubKey);
    if(!keys.some(expectedKey=>same(expectedKey,key.pubKey))||!same(key.leafHash,leafHash)||seen.has(encoded))throw new Error('Indexer returned unexpected stock signature metadata.');
    seen.add(encoded);
   }
   signatures=keys.map(pubKey=>{
    const signature=entries.find(([key])=>same(key.pubKey,pubKey)&&same(key.leafHash,leafHash))?.[1];
    if(!signature||signature.length!==64)throw new Error('Indexer lacks a complete stock signer signature map.');
    return signature;
   });
  }
  result.updateInput(vin,{tapScriptSig:keys.map((pubKey,index)=>[{pubKey,leafHash},signatures[index]])});
 }
 return result;
}
export function createStockMutinynetTransport(network:StockNetworkInfo,providers:{emulator?:Pick<RestEmulatorProvider,'submitTx'>;indexer?:Pick<RestIndexerProvider,'getVirtualTxs'|'getVtxos'>}={}){
 const emulator=providers.emulator??new RestEmulatorProvider(network.emulatorUrl),indexer=providers.indexer??new RestIndexerProvider(network.indexerUrl??network.arkUrl);
 const lookup=async(request:StockWireRequest):Promise<StockNativeReceipt|undefined>=>{
  const expected=Transaction.fromPSBT(base64.decode(request.arkTx)),checkpoints=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
  const raw=(await indexer.getVirtualTxs([expected.id,...checkpoints.map(tx=>tx.id)])).txs.map(decodeStockIndexerTransaction);
  const ark=raw.find(tx=>tx.id===expected.id);if(!ark||checkpoints.some(tx=>!raw.some(found=>found.id===tx.id)))return;
  const inputs=checkpoints.map(tx=>({txid:hex.encode(tx.getInput(0).txid!),vout:tx.getInput(0).index!}));
  const inputCoins=(await indexer.getVtxos({outpoints:inputs})).vtxos;
  if(inputs.some((input,index)=>!inputCoins.some(coin=>coin.txid===input.txid&&coin.vout===input.vout&&coin.isSpent&&coin.spentBy===checkpoints[index].id&&coin.arkTxId===expected.id)))return;
  const outputs=Array.from({length:expected.outputsLength},(_,vout)=>({txid:expected.id,vout})).filter(({vout})=>expected.getOutput(vout).amount!>0n);
  const outputCoins=(await indexer.getVtxos({outpoints:outputs})).vtxos;
  if(outputs.some(({vout})=>!outputCoins.some(coin=>coin.txid===expected.id&&coin.vout===vout&&coin.value===Number(expected.getOutput(vout).amount!)&&coin.script===hex.encode(expected.getOutput(vout).script!))))return;
  return verifyStockResponse(request,{signedArkTx:base64.encode(restoreIndexed(ark,expected).toPSBT()),signedCheckpointTxs:checkpoints.map(tx=>base64.encode(restoreIndexed(raw.find(found=>found.id===tx.id)!,tx).toPSBT()))},network);
 };
 return {lookup,submit:async(request:StockWireRequest)=>{
  assertStockWeightBudget(network,stockSignedWeights(request,true));
  verifyStockCustomerSignatures(request,network.serverKey);
  return verifyStockResponse(request,await emulator.submitTx(request.arkTx,request.checkpoints),network);
 },request:(spend:StockBuiltSpend):StockWireRequest=>({arkTx:spend.arkTxPsbt,checkpoints:spend.checkpointPsbts})};
}
