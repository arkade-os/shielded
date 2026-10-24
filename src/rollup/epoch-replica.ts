import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {CSVMultisigTapscript,Transaction} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {hex} from '@scure/base';
import {randomField} from '../../packages/protocol/src/rollup/account.ts';
import {EpochState,type EpochSlot} from '../../packages/protocol/src/rollup/epoch.ts';
import {epochBatchInput,epochPaddingTransfer} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import type {Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {rollupRecipientOf} from '../../packages/protocol/src/rollup/wallet.ts';
import {buildRollupBatchTx,rollupWitness,type RollupCoin,type RollupEpochLeaves,type rollupEpochPoolTree,type SnarkProof} from './covenant.ts';
import {epochNfArchivePath,readEpochNfArchive} from './epoch-archive-file.ts';
import {recordSlotOf,type RollupEpochRecord} from './epoch-operator.ts';
import {readEpochBatchTx} from './external.ts';
import type {RollupProver} from './prover.ts';

const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));

/** A replayed EpochState with its archive files loaded and checked, from a mirror directory 4b Task 6 filled. */
export async function openEpochReplica(o:{dir:string;hash:Hash;epochLen:number;leaves:RollupEpochLeaves}){
 const state=EpochState.genesis(o.hash,o.epochLen,false),records:RollupEpochRecord[]=[];
 let bound:bigint|undefined;
 // Chain facts only, as the operator replays: apply would also judge slot fields the head does not commit to, so one bad record would stop every fallback.
 const replay=(r:RollupEpochRecord)=>{state.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));records.push(r);};
 const batches=join(o.dir,'batches'),count=readdirSync(batches).filter(name=>/^(0|[1-9]\d*)\.json$/.test(name)).length;
 for(let n=0;n<count;n++)replay(JSON.parse(readFileSync(join(batches,`${n}.json`),'utf8')) as RollupEpochRecord);
 return {state,records,
  /** Checks an archived origin's two mirrored files against the ER record of the chain-bound replay; that replay rebuilt both sets, so a missing file only skips its check. */
  preload(origin:number):void{
   if(bound===undefined||state.commitment()!==bound)throw new Error('The replica is not bound to the pool head; catch it up from the chain before trusting an archive.');
   const record=state.archive.record(origin);
   if(record)for(const [epoch,root] of [[origin,record.nfFinal],[origin+1,record.nfNextFinal]] as const){
    const path=epochNfArchivePath(join(o.dir,'nullifiers'),epoch);
    if(existsSync(path))state.archive.load(epoch,readEpochNfArchive(path,o.hash,{epoch,root}));
   }
  },
  /** Applies the head's ancestry after `fromTxid` from chain until the replica holds `target`, and binds it there. */
  async catchUpFromChain(fromTxid:string,target:bigint,next:(head:{txid:string;vout:number})=>Promise<Transaction|undefined>):Promise<number>{
   let outpoint={txid:fromTxid,vout:0},applied=0;
   while(state.commitment()!==target){
    const tx=await next(outpoint);
    if(!tx)throw new Error(`The chain stops at ${outpoint.txid}:${outpoint.vout} before the head's state; the mirrored records do not replay to it.`);
    const facts=readEpochBatchTx(tx,o.leaves);
    replay({kind:facts.kind,slots:facts.nullifiers.map((nf,i)=>({anchor:'0',nullifiers:nf.map(String),commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:0,publics:facts.publics[i]!.map(String)})),noteBlockRoot:String(facts.noteBlockRoot),txid:tx.id});
    outpoint={txid:tx.id,vout:0};applied++;
   }
   bound=target;
   return applied;
  },
  /** A padding spend opening against the anchor the next batch accepts. */
  pad:()=>epochPaddingTransfer(o.hash,{rPrev:state.nextAnchorRoot(),rCur:{epoch:state.epoch,root:state.latestRoot()},self:rollupRecipientOf(o.hash,randomField(),randomField(),x25519.utils.randomSecretKey()),width:1}),
 };
}
export type EpochReplica=Awaited<ReturnType<typeof openEpochReplica>>;

export interface EpochFallbackSpend {built:{slot:EpochSlot;witness:{publicSignals:bigint[]};ciphertext:Uint8Array};proof:SnarkProof}
/** The next batch from proved spends: applied to a copy of the replica, proved, and built to spend the head through its kind's leaf. */
export async function buildEpochFallbackBatch(replica:EpochReplica,o:{kind:'spend'|'recover';spends:EpochFallbackSpend[];program?:Uint8Array;prover:RollupProver;head:Omit<RollupCoin,'tapTree'|'leaf'>;pool:ReturnType<typeof rollupEpochPoolTree>;leaves:RollupEpochLeaves;token:string;checkpoint:CSVMultisigTapscript.Type}){
 const next=replica.state.clone(),result=next.apply(o.kind,o.spends.map(s=>s.built.slot)),{tree}=o.pool;
 const proof=await o.prover.prove(epochBatchInput(result.witness),result.publicSignals);
 const built=buildRollupBatchTx({kind:o.kind,head:{...o.head,tapTree:tree.encode(),leaf:tree.findLeaf(hex.encode(o.kind==='recover'?o.pool.batchRecover:o.pool.batch))},deposits:[],token:o.token,leaves:o.leaves,checkpoint:o.checkpoint,
  legs:o.spends.map(({built:{witness:{publicSignals:p}}},i)=>({deposit:p[3]!,withdraw:p[4]!,asset:p[5]!==0n,...(i===0&&o.program?{program:o.program}:{})})),
  witness:rollupWitness(proof,o.spends.map(s=>({proof:s.proof,publics:s.built.witness.publicSignals}))),newPacket:Uint8Array.from([...le32(next.commitment()),...le32(result.daRoot),...le32(result.blockRoot)])});
 const record:RollupEpochRecord={kind:o.kind,noteBlockRoot:String(result.blockRoot),slots:o.spends.map(({built:{slot,witness,ciphertext}})=>({...recordSlotOf(slot),publics:witness.publicSignals.map(String),ciphertext:hex.encode(ciphertext)}))};
 return {...built,record};
}
