import {EmulatorPacket,Extension,type Transaction} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {hex} from '@scure/base';
import {BATCH_SLOTS,EPOCH_NULLIFIERS,EPOCH_SLOTS,type BatchKind,type EpochBatchKind} from '../../packages/protocol/src/rollup/constants.ts';
import {ROLLUP_STATE_PACKET,type RollupEpochLeaves,type RollupLeaves} from './covenant.ts';
import {decodeStockIndexerTransaction} from '../stock/indexer.ts';

const same=(a:Uint8Array,b:Uint8Array)=>hex.encode(a)===hex.encode(b);
function scriptNum(item:Uint8Array):bigint {
 if(item.length&&item[item.length-1]!&0x80)throw new Error('A batch witness number is negative.');
 return item.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);
}
const le=(item:Uint8Array)=>item.reduceRight((acc,byte)=>(acc<<8n)|BigInt(byte),0n);

function readBatchFacts<K extends string>(tx:Transaction,table:readonly {script:Uint8Array;kind:K;slots:number;nullifiers:number}[]){
 const ext=Extension.fromTx(tx),packet=ext.getPacketByType(EmulatorPacket.PACKET_TYPE),state=ext.getPacketByType(ROLLUP_STATE_PACKET)?.serialize();
 const entry=packet?EmulatorPacket.fromBytes(packet.serialize()).entries.find(e=>e.vin===0):undefined;
 const leaf=!entry?.witness?undefined:table.find(l=>same(entry.script,l.script));
 if(!leaf)throw new Error('The transaction does not spend the pool head through a batch leaf.');
 if(!state||state.length!==96)throw new Error('The transaction carries no rollup state packet.');
 const items=RawWitness.decode(entry!.witness!);
 if(items.length!==8+leaf.slots*15)throw new Error('The batch witness has the wrong shape.');
 // Per slot after the 8 proof items: pub, nf0, nf1, deposit, withdraw, boundaryAsset, destination. Slots run last to first.
 const parsed=Array.from({length:leaf.slots},(_,i)=>{const at=8+(leaf.slots-1-i)*15+8,p=items.slice(at,at+7);
  return {publics:[scriptNum(p[0]!),scriptNum(p[1]!),scriptNum(p[2]!),scriptNum(p[3]!),scriptNum(p[4]!),le(p[5]!),le(p[6]!)],nullifiers:[scriptNum(p[1]!),scriptNum(p[2]!)].slice(0,leaf.nullifiers)};});
 return {kind:leaf.kind,publics:parsed.map(s=>s.publics),nullifiers:parsed.map(s=>s.nullifiers),commitment:le(state.subarray(0,32)),daRoot:le(state.subarray(32,64)),noteBlockRoot:le(state.subarray(64))};
}

/** What an accepted batch transaction itself proves: each slot's public inputs and the new state packet. */
export function readBatchTx(tx:Transaction,leaves:RollupLeaves){
 return readBatchFacts<BatchKind>(tx,[{script:leaves.batch,kind:'spend',slots:BATCH_SLOTS,nullifiers:1},{script:leaves.batchJoin,kind:'join',slots:BATCH_SLOTS,nullifiers:2}]);
}
export function readEpochBatchTx(tx:Transaction,leaves:RollupEpochLeaves){
 const row=(script:Uint8Array,kind:EpochBatchKind)=>({script,kind,slots:EPOCH_SLOTS[kind],nullifiers:EPOCH_NULLIFIERS[kind]});
 return readBatchFacts(tx,[row(leaves.batch,'spend'),row(leaves.batchJoin,'join'),row(leaves.batchRecover,'recover')]);
}

export interface ChainOnlyBatch {kind:BatchKind;noteBlockRoot:string;slots:{root:string;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[]}[]}
/** A batch described by the transaction alone, with no openings: nullifiers, the block root, and the public inputs. */
export function chainOnlyBatch(facts:ReturnType<typeof readBatchTx>):ChainOnlyBatch{
 return {kind:facts.kind,noteBlockRoot:String(facts.noteBlockRoot),slots:facts.nullifiers.map((nf,i)=>({root:'0',nullifiers:nf.map(String),commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:0,publics:facts.publics[i]!.map(String)}))};
}

/**
 * Advances a full-replica account across batches whose records are missing, reading each from the chain. `nextBatchTx` returns
 * the transaction that spent a given head output (the next batch), or undefined once the head is unspent. Stops at `target`.
 */
export async function catchUpFromChain(account:{apply(batch:ChainOnlyBatch):Promise<unknown>;state:{commitment():bigint}},leaves:RollupLeaves,fromTxid:string,target:bigint,nextBatchTx:(head:{txid:string;vout:number})=>Promise<Transaction|undefined>):Promise<number>{
 let outpoint={txid:fromTxid,vout:0},applied=0;
 while(account.state.commitment()!==target){
  const tx=await nextBatchTx(outpoint);
  if(!tx)throw new Error(`The chain stops at ${outpoint.txid}:${outpoint.vout} before the head's state; mirror again or find the missing records.`);
  await account.apply(chainOnlyBatch(readBatchTx(tx,leaves)));
  outpoint={txid:tx.id,vout:0};applied++;
 }
 return applied;
}

/** The slice of a live indexer the chain walk needs: is a head spent, and by which batch transaction. */
export interface BatchIndexer {
 getVtxos(opts:{outpoints:{txid:string;vout:number}[]}):Promise<{vtxos:{isSpent?:boolean;arkTxId?:string}[]}>;
 getVirtualTxs(ids:string[]):Promise<{txs:string[]}>;
}
/** A `nextBatchTx` for `catchUpFromChain` backed by a live indexer: a head's `arkTxId` names the batch that spent it. */
export function indexerBatchWalker(indexer:BatchIndexer):(head:{txid:string;vout:number})=>Promise<Transaction|undefined>{
 return async head=>{
  const [v]=(await indexer.getVtxos({outpoints:[head]})).vtxos;
  if(!v?.isSpent||!v.arkTxId)return undefined;
  const id=v.arkTxId;
  return (await indexer.getVirtualTxs([id])).txs.map(decodeStockIndexerTransaction).find(t=>t.id===id);
 };
}

/** The coin each checkpoint spends; an Arkade transaction's input i spends checkpoint i, which spends the coin itself. */
export function spentCoins(tx:Transaction,checkpoints:readonly Transaction[]){
 if(checkpoints.length!==tx.inputsLength)throw new Error('Every input needs its checkpoint transaction.');
 return checkpoints.map((checkpoint,vin)=>{
  if(hex.encode(tx.getInput(vin).txid!)!==checkpoint.id)throw new Error(`Checkpoint ${vin} is not the one the transaction spends.`);
  const input=checkpoint.getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};
 });
}
