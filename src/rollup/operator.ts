import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Transaction,type CSVMultisigTapscript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {ROLLUP_DOMAIN,RollupRejection} from '../../packages/protocol/src/rollup/constants.ts';
import {assetFieldOfId,destinationFieldOf,statementOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupState,type BatchSlot} from '../../packages/protocol/src/rollup/state.ts';
import {openStockJournal,type StockReleasePin} from '../stock/journal.ts';
import {stockSignedWeights,verifyStockCustomerSignatures,type StockNativeReceipt,type StockWireRequest} from '../stock/transport.ts';
import {selectRollupBatch,type RollupSpend} from './batcher.ts';
import {buildRollupBatchTx,rollupPoolTree,rollupWitness,type RollupCoin,type RollupLeaves} from './covenant.ts';
import {verifyRollupProof,type RollupProver} from './prover.ts';

export interface RollupPoolCoin {txid:string;vout:number;value:number;sourceTxHex:string}
export interface RollupArchive {version:1;head:RollupPoolCoin;reserves:Record<string,RollupPoolCoin&{amount:string}>;batches:number}
interface RecordSlot {root:string;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[]}
/** One accepted batch as published for data availability. */
export interface RollupRecord {kind:'spend';slots:RecordSlot[]}
interface RollupPlan {version:1;request:StockWireRequest;record:RollupRecord;firstDeposit:number;asset?:string;reserveAmount?:string}
export interface RollupTransport {
 submit(request:StockWireRequest,firstDeposit:number):Promise<StockNativeReceipt>;
 lookup(request:StockWireRequest):Promise<StockNativeReceipt|undefined>;
 verify(request:StockWireRequest,receipt:StockNativeReceipt):void;
 unspent(coin:{txid:string;vout:number}):Promise<boolean>;
 /** Unspent and expiring after now + floorMs: a batch's outputs inherit its earliest input expiry. */
 fresh?(coin:{txid:string;vout:number},floorMs:number):Promise<boolean>;
}
export interface RollupOperatorOptions {
 directory:string;
 pin:StockReleasePin;
 genesis:RollupArchive;
 leaves:RollupLeaves;
 token:string;
 serverKey:Uint8Array;
 emulatorKey:Uint8Array;
 exitDelay:{type:'seconds'|'blocks';value:number};
 checkpoint:CSVMultisigTapscript.Type;
 clientKey:unknown;
 hash:Hash;
 prover:RollupProver;
 transport:RollupTransport;
 signDeposits(request:StockWireRequest,spends:RollupSpend[]):Promise<StockWireRequest|undefined>;
 depositFloorMs?:number;
 weightLimit?:number;
 now?:()=>number;
}
export type RollupTick={txid:string;batch:number}|{blocked:string}|undefined;

const le32=(value:bigint)=>Uint8Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
const slotOf=(s:RecordSlot):BatchSlot=>({root:BigInt(s.root),nullifiers:s.nullifiers.map(BigInt),commitments:[BigInt(s.commitments[0]),BigInt(s.commitments[1])],ctDigest:BigInt(s.ctDigest),groupId:BigInt(s.groupId),groupSize:s.groupSize});
const recordOf=(spends:readonly RollupSpend[]):RollupRecord=>({kind:'spend',slots:spends.map(({slot,publics})=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publics.map(String)}))});

/** Carrier and funding rules a unit (one spend, or a complete group) must meet before it may enter a batch. */
function checkUnit(unit:readonly RollupSpend[]):void {
 unit.forEach((s,i)=>{
  if(s.publics[3]===0n||s.publics[2]===0n)return;
  const carrier=unit[i+1];
  if(!carrier||carrier.publics[3]!==0n||carrier.publics[2]===0n||hex.encode(carrier.program!)!==hex.encode(s.program!))throw new Error('An asset payout must be followed by its BTC carrier to the same program.');
 });
 const sats=unit.reduce((sum,s)=>sum+BigInt(s.coin?.value??0),0n),btc=unit.reduce((sum,s)=>sum+(s.publics[3]===0n?s.publics[1]:0n),0n);
 const units=unit.reduce((sum,s)=>sum+(s.coin?.assetAmount??0n),0n),assets=unit.reduce((sum,s)=>sum+(s.publics[3]!==0n?s.publics[1]:0n),0n);
 if(sats!==btc||units!==assets)throw new Error('Deposit coins must carry exactly the deposited sats and asset.');
}

export async function openRollupOperator(o:RollupOperatorOptions){
 const now=o.now??Date.now,pool=rollupPoolTree(o.serverKey,o.emulatorKey,o.leaves,o.exitDelay),serverKeyHex=hex.encode(o.serverKey);
 const bodies=join(o.directory,'batches');mkdirSync(bodies,{recursive:true});
 const bodyPath=(n:number)=>join(bodies,`${n}.json`);
 const state=RollupState.genesis(o.hash);
 const poolCoin=(c:RollupPoolCoin,leaf:Uint8Array):RollupCoin=>({txid:c.txid,vout:c.vout,value:c.value,sourceTx:hex.decode(c.sourceTxHex),tapTree:pool.tree.encode(),leaf:pool.tree.findLeaf(hex.encode(leaf))});
 const headOf=(plan:RollupPlan)=>{const input=Transaction.fromPSBT(base64.decode(plan.request.checkpoints[0]!)).getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};};
 const journal=await openStockJournal<RollupArchive,RollupPlan,StockNativeReceipt>(join(o.directory,'journal'),o.pin,o.genesis,{
  validateArchive:archive=>{if(archive.version!==1||Transaction.fromRaw(hex.decode(archive.head.sourceTxHex),{allowUnknownOutputs:true}).id!==archive.head.txid)throw new Error('Invalid rollup archive head.');},
  validatePlan:(plan,archive)=>{const head=headOf(plan);if(plan.version!==1||head.txid!==archive.head.txid||head.vout!==archive.head.vout)throw new Error('Rollup plan spends a different head.');},
  verifyReceipt:(plan,receipt)=>o.transport.verify(plan.request,receipt),
  transmit:plan=>o.transport.submit(plan.request,plan.firstDeposit),
  lookup:plan=>o.transport.lookup(plan.request),
  abandoned:async plan=>!await o.transport.lookup(plan.request)&&await o.transport.unspent(headOf(plan)),
  apply:(archive,plan,receipt)=>{
   writeFileSync(bodyPath(archive.batches),JSON.stringify(plan.record));
   if(state.batchCount===archive.batches)state.apply(plan.record.kind,plan.record.slots.map(slotOf));
   const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),coin=(vout:number)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))});
   const reserves=plan.asset?{...archive.reserves,[plan.asset]:{...coin(1),amount:plan.reserveAmount!}}:archive.reserves;
   return {...archive,head:coin(0),reserves,batches:archive.batches+1};
  },
 });
 for(let n=0;n<journal.status().archive.batches;n++){const body=JSON.parse(readFileSync(bodyPath(n),'utf8')) as RollupRecord;state.apply(body.kind,body.slots.map(slotOf));}
 let pending:RollupSpend[]=[],padding:RollupSpend[]=[],inflight:RollupSpend[]=[],inflightPadding:RollupSpend[]=[],busy=false,coinCap:number|undefined;
 const spent=(nf:bigint)=>state.nullifiers.has(nf)||[...pending,...inflight].some(s=>s.slot.nullifiers.includes(nf));

 const submit=async(spend:Omit<RollupSpend,'receivedAt'>)=>{
  const [pub,deposit,withdraw,assetField,destination]=spend.publics;
  if([...pending,...inflight].some(s=>s.id===spend.id))throw new Error('Duplicate rollup spend id.');
  if(spend.slot.nullifiers.some(spent))throw new RollupRejection('double-spend','The note is already spent or pending.');
  if(state.windowIndex(spend.slot.root)<0)throw new RollupRejection('stale-root','The spend proves against a root outside the window.');
  if(statementOf(o.hash,{domain:ROLLUP_DOMAIN,...spend.slot})!==pub)throw new Error('The spend statement does not match its opening.');
  if((withdraw>0n)!==!!spend.program||(spend.program?destinationFieldOf(spend.program):0n)!==destination)throw new Error('The withdrawal destination does not match its P2TR program.');
  if((assetField!==0n)!==!!spend.asset||(spend.asset?assetFieldOfId(spend.asset):0n)!==assetField)throw new Error('The boundary asset does not match its Arkade asset id.');
  if(spend.coin&&deposit===0n)throw new Error('A deposit coin needs a deposit leg.');
  if(!await verifyRollupProof(o.clientKey,spend.publics,spend.proof))throw new Error('Invalid client proof.');
  const admitted={...spend,receivedAt:now()},{groupId,groupSize}=spend.slot;
  const unit=groupId===0n?[admitted]:[...pending.filter(s=>s.slot.groupId===groupId),admitted];
  if(unit.length===Math.max(groupSize,1))checkUnit(unit);
  pending.push(admitted);
 };

 const run=async():Promise<RollupTick>=>{
  const fresh=(s:RollupSpend)=>state.windowIndex(s.slot.root)>=0;
  pending=pending.filter(fresh);padding=padding.filter(fresh);
  for(const s of pending.filter(s=>s.coin))if(o.transport.fresh&&!await o.transport.fresh(s.coin!,o.depositFloorMs??72*3600_000))pending=pending.filter(p=>p!==s&&(s.slot.groupId===0n||p.slot.groupId!==s.slot.groupId));
  let taken:RollupSpend[]=[];
  const selection=selectRollupBatch(pending,now(),count=>{if(padding.length<count)throw new Error('padding');taken=padding.splice(0,count);return taken;},coinCap);
  if(!selection)return undefined;
  const archive=journal.status().archive,reserveCoin=selection.asset?archive.reserves[selection.asset]:undefined;
  if(selection.asset&&!reserveCoin)throw new Error(`No reserve for asset ${selection.asset}.`);
  const clients=selection.spends.filter(s=>!taken.includes(s)),deposits=selection.spends.filter(s=>s.coin);
  pending=pending.filter(s=>!clients.includes(s));inflight=clients;inflightPadding=taken;
  let submitted=false,applied=false;
  try{
   const result=state.apply('spend',selection.spends.map(s=>s.slot));applied=true;
   const proof=await o.prover.prove(result.witness,result.publicSignals);
   const witness=rollupWitness(proof,selection.spends.map(s=>({proof:s.proof,publics:s.publics})));
   const reserve=reserveCoin?{...poolCoin(reserveCoin,pool.reserve),amount:BigInt(reserveCoin.amount)}:undefined;
   const built=buildRollupBatchTx({head:poolCoin(archive.head,pool.batch),...(reserve?{reserve}:{}),deposits:deposits.map(s=>s.coin!),legs:selection.legs,token:o.token,...(selection.asset?{asset:selection.asset}:{}),
    leaves:o.leaves,witness,newPacket:Uint8Array.from([...le32(state.commitment()),...le32(result.daRoot)]),checkpoint:o.checkpoint});
   const firstDeposit=reserve?2:1;
   let request={arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
   if(deposits.length){
    const signed=await o.signDeposits(request,deposits);
    if(!signed){inflight=inflight.filter(s=>!s.coin);throw new Error('A depositor did not sign; the batch is rebuilt without its deposits.');}
    verifyStockCustomerSignatures(signed,serverKeyHex,firstDeposit);request=signed;
   }
   const weights=stockSignedWeights(request,true),limit=o.weightLimit??40_000;
   if(weights.ark>limit||weights.checkpoints.some(w=>w>limit)){
    coinCap=Math.max(0,deposits.length-1);
    throw new Error(`The batch weighs ${weights.ark} WU, over the ${limit} WU weight limit; the next one takes fewer deposits.`);
   }
   const nx=selection.legs.reduce((sum,leg)=>sum+(leg.asset?leg.deposit-leg.withdraw:0n),0n);
   const plan:RollupPlan={version:1,request,record:recordOf(selection.spends),firstDeposit,...(reserve?{asset:selection.asset!,reserveAmount:String(reserve.amount+nx)}:{})};
   submitted=true;
   const outcome=await journal.submit('batch-'+archive.batches,plan);
   inflight=[];inflightPadding=[];coinCap=undefined;
   return {txid:outcome.receipt.txid,batch:archive.batches};
  }catch(error){
   if(submitted&&journal.status().pending)return {blocked:String((error as Error).message)};
   if(applied)state.undoLast();
   padding.unshift(...inflightPadding);pending.unshift(...inflight);inflight=[];inflightPadding=[];
   throw error;
  }
 };

 return {
  state,submit,
  addPadding:(spends:RollupSpend[])=>{padding.push(...spends);},
  pending:()=>pending.length,
  status:()=>journal.status(),
  /** Adopts the head and reserves a renewal round moved; their state packet is unchanged. */
  relocate:(moved:Pick<RollupArchive,'head'|'reserves'>)=>journal.updateArchive(archive=>({...archive,head:moved.head,reserves:moved.reserves})),
  /** Runs at most one batch: reconciles an unresolved submission first, then closes a due batch. */
  tick:async():Promise<RollupTick>=>{
   if(busy)return undefined;busy=true;
   try{
    if(journal.status().pending){
     const r=await journal.reconcile() as {resolved:boolean;abandoned?:boolean};
     if(!r.resolved)return {blocked:'A submitted batch has no known outcome yet.'};
     if(r.abandoned&&state.batchCount>journal.status().archive.batches){state.undoLast();pending.unshift(...inflight);padding.unshift(...inflightPadding);}
     inflight=[];inflightPadding=[];
    }
    try{return await run();}catch(error){if((error as Error).message==='padding')return {blocked:'Not enough padding spends.'};throw error;}
   }finally{busy=false;}
  },
  close:()=>journal.close(),
 };
}
export type RollupOperator=Awaited<ReturnType<typeof openRollupOperator>>;
