import {EmulatorPacket,Extension,type Transaction} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {hex} from '@scure/base';
import {BATCH_SLOTS,type BatchKind} from '../../packages/protocol/src/rollup/constants.ts';
import {ROLLUP_STATE_PACKET,type RollupLeaves} from './covenant.ts';

const same=(a:Uint8Array,b:Uint8Array)=>hex.encode(a)===hex.encode(b);
function scriptNum(item:Uint8Array):bigint {
 if(item.length&&item[item.length-1]!&0x80)throw new Error('A batch witness number is negative.');
 return item.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);
}
const le=(item:Uint8Array)=>item.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);

/** What an accepted batch transaction itself proves: each slot's public inputs and the new state packet. */
export function readBatchTx(tx:Transaction,leaves:RollupLeaves){
 const ext=Extension.fromTx(tx),packet=ext.getPacketByType(EmulatorPacket.PACKET_TYPE),state=ext.getPacketByType(ROLLUP_STATE_PACKET)?.serialize();
 const entry=packet?EmulatorPacket.fromBytes(packet.serialize()).entries.find(e=>e.vin===0):undefined;
 const kind:BatchKind|undefined=!entry?.witness?undefined:same(entry.script,leaves.batch)?'spend':same(entry.script,leaves.batchJoin)?'join':undefined;
 if(!kind)throw new Error('The transaction does not spend the pool head through a batch leaf.');
 if(!state||state.length!==96)throw new Error('The transaction carries no rollup state packet.');
 const items=RawWitness.decode(entry!.witness!);
 if(items.length!==8+BATCH_SLOTS*15)throw new Error('The batch witness has the wrong shape.');
 // Per slot after the 8 proof items: pub, nf0, nf1, deposit, withdraw, boundaryAsset, destination. Slots run last to first.
 const parsed=Array.from({length:BATCH_SLOTS},(_,i)=>{const at=8+(BATCH_SLOTS-1-i)*15+8,p=items.slice(at,at+7);
  return {publics:[scriptNum(p[0]!),scriptNum(p[3]!),scriptNum(p[4]!),le(p[5]!),le(p[6]!)],nullifiers:kind==='join'?[scriptNum(p[1]!),scriptNum(p[2]!)]:[scriptNum(p[1]!)]};});
 return {kind,publics:parsed.map(s=>s.publics),nullifiers:parsed.map(s=>s.nullifiers),commitment:le(state.subarray(0,32)),daRoot:le(state.subarray(32,64)),noteBlockRoot:le(state.subarray(64))};
}

/** The coin each checkpoint spends; an Arkade transaction's input i spends checkpoint i, which spends the coin itself. */
export function spentCoins(tx:Transaction,checkpoints:readonly Transaction[]){
 if(checkpoints.length!==tx.inputsLength)throw new Error('Every input needs its checkpoint transaction.');
 return checkpoints.map((checkpoint,vin)=>{
  if(hex.encode(tx.getInput(vin).txid!)!==checkpoint.id)throw new Error(`Checkpoint ${vin} is not the one the transaction spends.`);
  const input=checkpoint.getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};
 });
}
