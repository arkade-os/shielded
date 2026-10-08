import test from 'node:test';
import assert from 'node:assert/strict';
import {base64,hex} from '@scure/base';
import {buildOffchainTx,CSVMultisigTapscript,MultisigTapscript,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {offlineNativeFixture} from './fixtures/native.ts';
import {createStockMutinynetTransport,stockSignedWeights,verifyStockResponse,type StockWireRequest,type StockSignedResponse} from '../src/stock/transport.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';
const server=SingleKey.fromPrivateKey(new Uint8Array(32).fill(11)),customer=SingleKey.fromPrivateKey(new Uint8Array(32).fill(12));
async function fixture(){
 const serverKey=await server.xOnlyPublicKey(),customerKey=await customer.xOnlyPublicKey();
 const leaf=MultisigTapscript.encode({pubkeys:[serverKey,customerKey]}).script,tree=new VtxoScript([leaf]);
 const parent=offlineNativeFixture([{script:tree.pkScript,amount:1000n}]);
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[serverKey],timelock:{type:'blocks',value:144n}});
 const assembled=buildOffchainTx([{txid:parent.id,vout:0,value:1000,tapTree:tree.encode(),tapLeafScript:tree.findLeaf(hex.encode(leaf))}],[{script:tree.pkScript,amount:1000n}],checkpoint);
 const request:StockWireRequest={arkTx:base64.encode(assembled.arkTx.toPSBT()),checkpoints:assembled.checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
 const sign=async(encoded:string)=>base64.encode((await customer.sign(await server.sign(Transaction.fromPSBT(base64.decode(encoded))))).toPSBT());
 const response:StockSignedResponse={signedArkTx:await sign(request.arkTx),signedCheckpointTxs:await Promise.all(request.checkpoints.map(sign))};
 const network:StockNetworkInfo={network:'mutinynet',arkUrl:'https://mutinynet.arkade.sh',emulatorUrl:'https://emulator.mutinynet.arkade.sh',serverKey:hex.encode(serverKey),emulatorKey:hex.encode(customerKey),operatorMaxWeight:40000,weightLimit:4000,dust:330,exitDelay:{type:'seconds',value:2048},emulatorVersion:'unit-transport',nativeAdmission:'unverified'};
 return {request,response,network};
}
test('stock transport verifies real Schnorr signatures, immutable bodies, metadata, and every signed weight',async()=>{
 const {request,response,network}=await fixture(),receipt=verifyStockResponse(request,response,network);
 assert.equal(receipt.txid,Transaction.fromPSBT(base64.decode(request.arkTx)).id);
 assert.equal(receipt.network,'mutinynet');assert.equal(receipt.finality,'operator-preconfirmed');
 assert.deepEqual(stockSignedWeights(request,true),receipt.weights);
 assert.throws(()=>verifyStockResponse(request,response,{...network,weightLimit:receipt.weights.ark-1}),/exceeds/);
 const changed=Transaction.fromPSBT(base64.decode(request.arkTx));changed.updateOutput(0,{amount:999n});
 assert.throws(()=>verifyStockResponse(request,{...response,signedArkTx:base64.encode(changed.toPSBT())},network),/changed the exact/);
 const invalid=Transaction.fromPSBT(base64.decode(request.arkTx)),signature=Transaction.fromPSBT(base64.decode(response.signedArkTx)).getInput(0).tapScriptSig![0];
 invalid.updateInput(0,{tapScriptSig:[[signature[0],new Uint8Array(64)]]});
 assert.throws(()=>verifyStockResponse(request,{...response,signedArkTx:base64.encode(invalid.toPSBT())},network));
});
test('stock read-only reconciliation accepts an exact historical payout even when its recipient already spent it',async()=>{
 const {request,response,network}=await fixture(),receipt=verifyStockResponse(request,response,network);
 const ark=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),checkpoints=receipt.signedCheckpointTxs.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
 let submissions=0;
 const indexer={getVirtualTxs:async()=>({txs:[ark,...checkpoints].map(tx=>base64.encode(tx.toPSBT()))}),getVtxos:async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:outpoints.map(outpoint=>{
  if(outpoint.txid===ark.id){const output=ark.getOutput(outpoint.vout);return {...outpoint,value:Number(output.amount),script:hex.encode(output.script!),isSpent:true,spentBy:'later-recipient-spend'};}
  const cp=checkpoints.find(tx=>hex.encode(tx.getInput(0).txid!)===outpoint.txid&&tx.getInput(0).index===outpoint.vout)!;
  return {...outpoint,isSpent:true,spentBy:cp.id,arkTxId:ark.id};
 })})};
 const transport=createStockMutinynetTransport(network,{indexer:indexer as any,emulator:{submitTx:async()=>{submissions++;return response;}}});
 const accepted=await transport.lookup(request);assert.equal(accepted?.txid,receipt.txid);assert.equal(submissions,0);
 assert.equal((await transport.submit(request)).txid,receipt.txid);assert.equal(submissions,1);
});

test('stock read-only reconciliation restores complete signatures from a non-final PSBT',async()=>{
 const {request,response,network}=await fixture(),receipt=verifyStockResponse(request,response,network);
 const ark=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),checkpoints=receipt.signedCheckpointTxs.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
 const partial=(encoded:string,signed:Transaction)=>{
  const tx=Transaction.fromPSBT(base64.decode(encoded));
  for(let vin=0;vin<tx.inputsLength;vin++)tx.updateInput(vin,{tapScriptSig:signed.getInput(vin).tapScriptSig},true);
  return base64.encode(tx.toPSBT());
 };
 const partialTransactions=[partial(request.arkTx,ark),...checkpoints.map((tx,index)=>partial(request.checkpoints[index],tx))];
 const indexer={getVirtualTxs:async()=>({txs:partialTransactions}),getVtxos:async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:outpoints.map(outpoint=>{
  if(outpoint.txid===ark.id){const output=ark.getOutput(outpoint.vout);return {...outpoint,value:Number(output.amount),script:hex.encode(output.script!),isSpent:true,spentBy:'later-recipient-spend'};}
  const cp=checkpoints.find(tx=>hex.encode(tx.getInput(0).txid!)===outpoint.txid&&tx.getInput(0).index===outpoint.vout)!;
  return {...outpoint,isSpent:true,spentBy:cp.id,arkTxId:ark.id};
 })})};
 const transport=createStockMutinynetTransport(network,{indexer:indexer as any,emulator:{submitTx:async()=>{throw new Error('lookup must not submit');}}});
 const recovered=await transport.lookup(request);
 assert.equal(recovered?.txid,receipt.txid);
 assert.deepEqual(recovered?.weights,receipt.weights);
});

test('stock reconciliation rejects incomplete, invalid, or altered indexed signature evidence',async()=>{
 const {request,response,network}=await fixture(),receipt=verifyStockResponse(request,response,network);
 const ark=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),checkpoints=receipt.signedCheckpointTxs.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));
 const validPartial=(encoded:string,signed:Transaction)=>{
  const tx=Transaction.fromPSBT(base64.decode(encoded));
  for(let vin=0;vin<tx.inputsLength;vin++)tx.updateInput(vin,{tapScriptSig:signed.getInput(vin).tapScriptSig},true);
  return tx;
 };
 const all=[validPartial(request.arkTx,ark),...checkpoints.map((tx,index)=>validPartial(request.checkpoints[index],tx))];
 const getVtxos=async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:outpoints.map(outpoint=>{
  if(outpoint.txid===ark.id){const output=ark.getOutput(outpoint.vout);return {...outpoint,value:Number(output.amount),script:hex.encode(output.script!),isSpent:true,spentBy:'later-spend'};}
  const cp=checkpoints.find(tx=>hex.encode(tx.getInput(0).txid!)===outpoint.txid&&tx.getInput(0).index===outpoint.vout)!;
  return {...outpoint,isSpent:true,spentBy:cp.id,arkTxId:ark.id};
 })});
 const run=async(txs:Transaction[])=>createStockMutinynetTransport(network,{indexer:{getVirtualTxs:async()=>({txs:txs.map(tx=>base64.encode(tx.toPSBT()))}),getVtxos} as any}).lookup(request);
 const incomplete=all.map(tx=>Transaction.fromPSBT(tx.toPSBT()));
 incomplete[0]=await customer.sign(Transaction.fromPSBT(base64.decode(request.arkTx)));
 await assert.rejects(run(incomplete),/complete stock signer/);
 const invalid=all.map(tx=>Transaction.fromPSBT(tx.toPSBT()));
 const signatures=invalid[0].getInput(0).tapScriptSig!;
 (invalid[0] as any).inputs[0].tapScriptSig=signatures.map(([key,sig],index)=>[key,index===0?new Uint8Array(64):sig]);
 await assert.rejects(run(invalid));
 const altered=all.map(tx=>Transaction.fromPSBT(tx.toPSBT()));
 const witness=altered[0].getInput(0).witnessUtxo!;
 altered[0].updateInput(0,{witnessUtxo:{...witness,script:Uint8Array.of(0x51)}},true);
 await assert.rejects(run(altered),/authenticated stock input metadata/);
});
