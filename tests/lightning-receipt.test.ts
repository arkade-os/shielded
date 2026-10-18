import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indexedDB} from 'fake-indexeddb';
import {ConditionWitness,Transaction,setArkPsbtField} from '@arkade-os/sdk';
import {InMemoryAssetSwapRepository,type CorridorSwapRecord,type LockupSpendIndexer} from '@arkade-os/swap';
import {base64,hex} from '@scure/base';
import {sha256} from '@noble/hashes/sha2.js';
import {LightningSwapRepository,repairLightningReceipt} from '../src/shielded/lightning-receipt.ts';

globalThis.indexedDB=indexedDB;
const preimage=new Uint8Array(32).fill(7),hash=hex.encode(sha256(preimage)),script='5120'+'aa'.repeat(32);
const record=()=>({id:'quote',family:'rfq',kind:'lightning_send',state:'refunded',lockupPkScript:script,lock:{hash},profile:{custom:'preserved'},updatedAt:1,custom:{nested:['preserved']}}) as unknown as CorridorSwapRecord;
const outpoint={txid:'ab'.repeat(32),vout:1};
function claim(){
 const tx=new Transaction({allowUnknownInputs:true,allowUnknownOutputs:true});tx.addInput({txid:outpoint.txid,index:outpoint.vout});tx.addOutput({script:hex.decode(script),amount:2113n});setArkPsbtField(tx,0,ConditionWitness,[preimage]);return tx;
}
function evidence(onRead=async()=>{}){
 const tx=claim();let reads=0;
 const indexer={getVtxos:async(input:{scripts:string[]})=>{assert.deepEqual(input.scripts,[script]);await onRead();reads++;return {vtxos:[{...outpoint,spentBy:tx.id,arkTxId:'cd'.repeat(32)}]};},getVirtualTxs:async(ids:string[])=>{assert.deepEqual(ids,[tx.id]);return {txs:[base64.encode(tx.toPSBT())]};}} as unknown as LockupSpendIndexer;
 return {indexer,reads:()=>reads};
}
test('verified claim receipt repair survives IndexedDB reopen and preserves unrelated fields',async()=>{
 const name=`receipt-${crypto.randomUUID()}`,repo=new LightningSwapRepository(name),original=record(),proof=evidence();await repo.saveSwapRecord(original);
 assert.equal(await repairLightningReceipt(repo,proof.indexer,original.id),true);
 await repo[Symbol.asyncDispose]();const reopened=new LightningSwapRepository(name),saved=await reopened.getSwapRecord(original.id);
 assert.deepEqual(saved,{...original,state:'settled',settlementPreimageHex:hex.encode(preimage),lockupSpendTxids:['cd'.repeat(32)],updatedAt:saved!.updatedAt});
 assert.equal(await repairLightningReceipt(reopened,proof.indexer,original.id),false);assert.equal(proof.reads(),1);await reopened[Symbol.asyncDispose]();
});
for(const change of ['metadata','refund','deleted'] as const)test(`receipt CAS preserves a concurrent ${change} write from another connection`,async()=>{
 const name=`receipt-${crypto.randomUUID()}`,repo=new LightningSwapRepository(name),other=new LightningSwapRepository(name),original=record();await repo.saveSwapRecord(original);
 const concurrent=change==='refund'?{...original,refundTxid:'ef'.repeat(32)}:{...original,custom:'new metadata'};
 const proof=evidence(async()=>{if(change==='deleted')await other.removeSwapRecord(original.id);else await other.saveSwapRecord(concurrent);});
 assert.equal(await repairLightningReceipt(repo,proof.indexer,original.id),false);
 assert.deepEqual(await repo.getSwapRecord(original.id),change==='deleted'?undefined:concurrent);
 await repo[Symbol.asyncDispose]();await other[Symbol.asyncDispose]();
});
test('known refunds, unsettled evidence and unsupported repositories never rewrite a receipt',async()=>{
 const name=`receipt-${crypto.randomUUID()}`,repo=new LightningSwapRepository(name),original=record(),proof=evidence();
 await repo.saveSwapRecord({...original,refundTxid:'ef'.repeat(32)});assert.equal(await repairLightningReceipt(repo,proof.indexer,original.id),false);assert.equal(proof.reads(),0);
 await repo.saveSwapRecord(original);
 const unknown={getVtxos:async()=>({vtxos:[]}),getVirtualTxs:async()=>{throw new Error('unneeded');}} as unknown as LockupSpendIndexer;
 assert.equal(await repairLightningReceipt(repo,unknown,original.id),false);assert.deepEqual(await repo.getSwapRecord(original.id),original);
 const unsupported=new InMemoryAssetSwapRepository();await unsupported.saveSwapRecord(original);
 assert.equal(await repairLightningReceipt(unsupported,proof.indexer,original.id),false);assert.equal(proof.reads(),0);
 await repo[Symbol.asyncDispose]();
});
