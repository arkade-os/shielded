import test from 'node:test';
import assert from 'node:assert/strict';
import {base64,hex} from '@scure/base';
import {buildOffchainTx,CSVMultisigTapscript,MultisigTapscript,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {verifyStockGenesisResponse} from '../src/stock/bootstrap.ts';
import {restoreStockBootstrapIndexed} from '../src/stock/bootstrap-adapter.ts';

test('bootstrap adapter refuses an indexer transaction whose signed body differs from the journaled request',()=>{
 const submitted=offlineNativeFixture([{script:Uint8Array.of(0x51),amount:1000n}]);
 const altered=offlineNativeFixture([{script:Uint8Array.of(0x51),amount:999n}]);
 assert.throws(()=>restoreStockBootstrapIndexed(base64.encode(submitted.toPSBT()),altered),/different transaction body/);
});

test('bootstrap adapter restores indexer signatures and leaves cryptographic verification to the exact-request verifier',async()=>{
 const server=SingleKey.fromPrivateKey(new Uint8Array(32).fill(21)),owner=SingleKey.fromPrivateKey(new Uint8Array(32).fill(22)),serverKey=await server.xOnlyPublicKey(),ownerKey=await owner.xOnlyPublicKey();
 const leaf=MultisigTapscript.encode({pubkeys:[serverKey,ownerKey]}).script,tree=new VtxoScript([leaf]),parent=offlineNativeFixture([{script:tree.pkScript,amount:1000n}]);
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[serverKey],timelock:{type:'seconds',value:2048n}});
 const assembled=buildOffchainTx([{txid:parent.id,vout:0,value:1000,tapTree:tree.encode(),tapLeafScript:tree.findLeaf(hex.encode(leaf))}],[{script:tree.pkScript,amount:1000n}],checkpoint);
 const request={arkTx:base64.encode(assembled.arkTx.toPSBT()),checkpoints:assembled.checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
 const sign=async(tx:Transaction)=>owner.sign(await server.sign(tx));
 const rawArk=await sign(Transaction.fromPSBT(base64.decode(request.arkTx))),rawCheckpoints=await Promise.all(request.checkpoints.map(async encoded=>sign(Transaction.fromPSBT(base64.decode(encoded)))));
 const restored={arkTxid:rawArk.id,finalArkTx:restoreStockBootstrapIndexed(request.arkTx,rawArk),signedCheckpointTxs:rawCheckpoints.map((tx,index)=>restoreStockBootstrapIndexed(request.checkpoints[index]!,tx))};
 const network={network:'mutinynet' as const,arkUrl:'https://ark.example',emulatorUrl:'https://emulator.example',serverKey:hex.encode(serverKey),emulatorKey:'33'.repeat(32),operatorMaxWeight:4000,weightLimit:4000,dust:330,exitDelay:{type:'seconds' as const,value:2048},emulatorVersion:'adapter-test',nativeAdmission:'unverified' as const};
 const receipt=verifyStockGenesisResponse(request,restored,network,hex.encode(ownerKey));
 assert.equal(receipt.txid,Transaction.fromPSBT(base64.decode(request.arkTx)).id);
 const tampered=Transaction.fromPSBT(base64.decode(restored.finalArkTx)),signatures=tampered.getInput(0).tapScriptSig!;
 (tampered as any).inputs[0].tapScriptSig=signatures.map(([key,sig],index)=>[key,index===0?new Uint8Array(64):sig]);
 assert.throws(()=>verifyStockGenesisResponse(request,{...restored,finalArkTx:base64.encode(tampered.toPSBT())},network,hex.encode(ownerKey)));
});
