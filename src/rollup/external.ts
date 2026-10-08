import {EmulatorPacket,Extension,type Transaction} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {hex} from '@scure/base';
import {BATCH_SLOTS} from '../../packages/protocol/src/rollup/constants.ts';
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
 if(!entry?.witness||!same(entry.script,leaves.batch))throw new Error('The transaction does not spend the pool head through its batch leaf.');
 if(!state||state.length!==64)throw new Error('The transaction carries no rollup state packet.');
 const items=RawWitness.decode(entry.witness);
 if(items.length!==8+BATCH_SLOTS*13)throw new Error('The batch witness has the wrong shape.');
 // rollupWitness writes the batch proof, then each slot's proof and public inputs from the last slot to the first.
 const publics=Array.from({length:BATCH_SLOTS},(_,i)=>{const at=8+(BATCH_SLOTS-1-i)*13+8,p=items.slice(at,at+5);return [scriptNum(p[0]!),scriptNum(p[1]!),scriptNum(p[2]!),le(p[3]!),le(p[4]!)];});
 return {publics,commitment:le(state.subarray(0,32)),daRoot:le(state.subarray(32))};
}

/** The coin each checkpoint spends; an Arkade transaction's input i spends checkpoint i, which spends the coin itself. */
export function spentCoins(tx:Transaction,checkpoints:readonly Transaction[]){
 if(checkpoints.length!==tx.inputsLength)throw new Error('Every input needs its checkpoint transaction.');
 return checkpoints.map((checkpoint,vin)=>{
  if(hex.encode(tx.getInput(vin).txid!)!==checkpoint.id)throw new Error(`Checkpoint ${vin} is not the one the transaction spends.`);
  const input=checkpoint.getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};
 });
}
