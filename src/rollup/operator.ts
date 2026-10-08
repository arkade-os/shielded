import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Transaction,VtxoScript,type CSVMultisigTapscript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {ROLLUP_DOMAIN,ROLLUP_FIELD,RollupRejection} from '../../packages/protocol/src/rollup/constants.ts';
import {assetFieldOfId,destinationFieldOf,groupIdOf,statementOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupState,type BatchSlot} from '../../packages/protocol/src/rollup/state.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../../packages/protocol/src/rollup/wallet.ts';
import {openStockJournal,type StockReleasePin} from '../stock/journal.ts';
import {stockCustomerSigned,stockSignedWeights,verifyStockCustomerSignatures,type StockNativeReceipt,type StockWireRequest} from '../stock/transport.ts';
import {selectRollupBatch,type RollupSpend} from './batcher.ts';
import {buildRollupBatchTx,rollupPoolTree,rollupWitness,type RollupCoin,type RollupLeaves} from './covenant.ts';
import {verifyRollupProof,type RollupProver} from './prover.ts';

export interface RollupPoolCoin {txid:string;vout:number;value:number;sourceTxHex:string}
export interface RollupArchive {version:1;head:RollupPoolCoin;reserves:Record<string,RollupPoolCoin&{amount:string}>;batches:number}
interface RecordSlot {root:string;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[];ciphertext?:string}
/** One accepted batch as published for data availability. */
export interface RollupRecord {kind:'spend';slots:RecordSlot[]}
interface RollupPlan {version:1;request:StockWireRequest;record:RollupRecord;firstDeposit:number;asset?:string;reserveAmount?:string}
/** What a deposit coin must still be when the batch is signed, as the client claims it. */
export interface RollupDepositFacts {txid:string;vout:number;value:number;script:string;assets:{assetId:string;amount:bigint}[]}
export interface RollupTransport {
 submit(request:StockWireRequest,firstDeposit:number):Promise<StockNativeReceipt>;
 lookup(request:StockWireRequest):Promise<StockNativeReceipt|undefined>;
 verify(request:StockWireRequest,receipt:StockNativeReceipt):void;
 unspent(coin:{txid:string;vout:number}):Promise<boolean>;
 /** Unspent, exactly these facts, and expiring after now + floorMs: a batch's outputs inherit its earliest input expiry. */
 fresh?(coin:RollupDepositFacts,floorMs:number):Promise<boolean>;
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
 /** The network's dust limit; arkd refuses a batch whose BTC payout is below it. */
 dustSats?:number;
 /** Told which admitted spends left without a batch, and why, so their owners can rebuild them. */
 onDrop?(ids:string[],reason:string):void;
 weightLimit?:number;
 now?:()=>number;
}
export type RollupTick={txid:string;batch:number}|{blocked:string}|undefined;

/** How long an unresolved submission is left alone between exact re-sends, and before it may be abandoned. */
export const ROLLUP_RESEND_GRACE_MS=120_000;
/** How long the first member of a group waits for the rest before the group is dropped. */
export const ROLLUP_GROUP_WAIT_MS=120_000;
const le32=(value:bigint)=>Uint8Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
const slotOf=(s:RecordSlot):BatchSlot=>({root:BigInt(s.root),nullifiers:s.nullifiers.map(BigInt),commitments:[BigInt(s.commitments[0]),BigInt(s.commitments[1])],ctDigest:BigInt(s.ctDigest),groupId:BigInt(s.groupId),groupSize:s.groupSize});
const recordOf=(spends:readonly RollupSpend[]):RollupRecord=>({kind:'spend',slots:spends.map(({slot,publics,ciphertext})=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publics.map(String),...(ciphertext?{ciphertext:hex.encode(ciphertext)}:{})}))});

const sameTx=(left:string,right:string)=>{const [a,b]=[left,right].map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));return a.id===b.id&&hex.encode(a.unsignedTx)===hex.encode(b.unsignedTx);};
/** Signatures alone say nothing about which coins they cover, so the signed batch must be the built one, byte for byte. */
const sameRequest=(actual:StockWireRequest,expected:StockWireRequest)=>
 actual.checkpoints.length===expected.checkpoints.length&&sameTx(actual.arkTx,expected.arkTx)&&expected.checkpoints.every((encoded,i)=>sameTx(actual.checkpoints[i]!,encoded));

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
 const kept=join(o.directory,'abandoned');mkdirSync(kept,{recursive:true});
 const bodyPath=(n:number)=>join(bodies,`${n}.json`);
 const state=RollupState.genesis(o.hash);
 const poolCoin=(c:RollupPoolCoin,leaf:Uint8Array):RollupCoin=>({txid:c.txid,vout:c.vout,value:c.value,sourceTx:hex.decode(c.sourceTxHex),tapTree:pool.tree.encode(),leaf:pool.tree.findLeaf(hex.encode(leaf))});
 const headOf=(plan:RollupPlan)=>{const input=Transaction.fromPSBT(base64.decode(plan.request.checkpoints[0]!)).getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};};
 const keptPath=(plan:RollupPlan)=>join(kept,`${Transaction.fromPSBT(base64.decode(plan.request.arkTx)).id}.json`);
 /** The last transmission of the journaled plan; `tries` counts the sends of the exact bytes the journal holds. */
 let sent:{at:number;failed:boolean;tries:number}|undefined;
 const journal=await openStockJournal<RollupArchive,RollupPlan,StockNativeReceipt>(join(o.directory,'journal'),o.pin,o.genesis,{
  validateArchive:archive=>{if(archive.version!==1||Transaction.fromRaw(hex.decode(archive.head.sourceTxHex),{allowUnknownOutputs:true}).id!==archive.head.txid)throw new Error('Invalid rollup archive head.');},
  validatePlan:(plan,archive)=>{const head=headOf(plan);if(plan.version!==1||head.txid!==archive.head.txid||head.vout!==archive.head.vout)throw new Error('Rollup plan spends a different head.');},
  verifyReceipt:(plan,receipt)=>o.transport.verify(plan.request,receipt),
  transmit:async plan=>{
   sent={at:now(),failed:true,tries:(sent?.tries??0)+1};
   const receipt=await o.transport.lookup(plan.request)??await o.transport.submit(plan.request,plan.firstDeposit);
   sent=undefined;return receipt;
  },
  lookup:plan=>o.transport.lookup(plan.request),
  // Only "not accepted yet" is observable, so the plan is also kept on disk in case it lands after this.
  abandoned:async plan=>{
   if(!sent?.failed||sent.tries<2||now()-sent.at<ROLLUP_RESEND_GRACE_MS)return false;
   if(await o.transport.lookup(plan.request)||!await o.transport.unspent(headOf(plan)))return false;
   writeFileSync(keptPath(plan),JSON.stringify(plan));return true;
  },
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
 const spent=(nf:bigint)=>state.nullifiers.has(nf)||[...pending,...inflight,...padding].some(s=>s.slot.nullifiers.includes(nf));
 /** Every spend of every unit (a lone spend, or a whole group) the predicate picks out. */
 const unitsOf=(list:readonly RollupSpend[],pick:(s:RollupSpend)=>boolean)=>{
  const ids=new Set(list.filter(s=>pick(s)&&s.slot.groupId!==0n).map(s=>s.slot.groupId));
  return new Set(list.filter(s=>pick(s)||ids.has(s.slot.groupId)));
 };
 const depositFacts=(s:RollupSpend):RollupDepositFacts=>({txid:s.coin!.txid,vout:s.coin!.vout,value:s.coin!.value,
  script:hex.encode(VtxoScript.decode(s.coin!.tapTree).pkScript),assets:s.coin!.assetAmount?[{assetId:s.asset!,amount:s.coin!.assetAmount}]:[]});

 /** The only gate: a spend the batch, the builder or the network would reject must never reserve a nullifier. */
 const submit=async(spend:Omit<RollupSpend,'receivedAt'>)=>{
  const [pub,deposit,withdraw,assetField,destination]=spend.publics;
  const {root,nullifiers,commitments,ctDigest,groupId,groupSize}=spend.slot;
  if([...pending,...inflight].some(s=>s.id===spend.id))throw new Error('Duplicate rollup spend id.');
  if(nullifiers.length!==1)throw new RollupRejection('slot-shape','A spend slot spends exactly one note.');
  if(nullifiers.some(nf=>nf<=0n||nf>=ROLLUP_FIELD))throw new RollupRejection('nullifier-range','The nullifier is zero or outside the field.');
  if(commitments.length!==2||[...commitments,root,ctDigest,groupId].some(v=>v<0n||v>=ROLLUP_FIELD))throw new RollupRejection('slot-shape','A slot has two field-element commitments.');
  if(![0,2,3].includes(groupSize)||(groupId===0n)!==(groupSize===0))throw new RollupRejection('group-invalid','A group has two or three members and a nonzero id.');
  const siblings=pending.filter(s=>groupId!==0n&&s.slot.groupId===groupId);
  if(groupId!==0n&&(siblings.length>=groupSize||siblings.some(s=>s.slot.groupSize!==groupSize)))throw new RollupRejection('group-invalid','The group is already complete or disagrees on its size.');
  if(nullifiers.some(spent))throw new RollupRejection('double-spend','The note is already spent or pending.');
  if(state.windowIndex(root)<0)throw new RollupRejection('stale-root','The spend proves against a root outside the window.');
  if(statementOf(o.hash,{domain:ROLLUP_DOMAIN,...spend.slot})!==pub)throw new Error('The spend statement does not match its opening.');
  if((withdraw>0n)!==!!spend.program||(spend.program?destinationFieldOf(spend.program):0n)!==destination)throw new Error('The withdrawal destination does not match its P2TR program.');
  if(withdraw>0n&&assetField===0n&&withdraw<BigInt(o.dustSats??330))throw new Error(`A withdrawal pays at least the ${o.dustSats??330}-sat dust limit.`);
  if((assetField!==0n)!==!!spend.asset||(spend.asset?assetFieldOfId(spend.asset):0n)!==assetField)throw new Error('The boundary asset does not match its Arkade asset id.');
  if(spend.coin&&deposit===0n)throw new Error('A deposit coin needs a deposit leg.');
  if(spend.ciphertext&&(spend.ciphertext.length!==ROLLUP_RECORD_BYTES||ctDigestOf(spend.ciphertext)!==ctDigest))throw new Error('The note record does not match the slot digest.');
  if(spend.asset&&!journal.status().archive.reserves[spend.asset])throw new Error(`No reserve for asset ${spend.asset}.`);
  const admitted={...spend,receivedAt:now()};
  pending.push(admitted);
  try{
   if(!await verifyRollupProof(o.clientKey,spend.publics,spend.proof))throw new Error('Invalid client proof.');
   const unit=groupId===0n?[admitted]:pending.filter(s=>s.slot.groupId===groupId);
   if(unit.length!==Math.max(groupSize,1))return;
   checkUnit(unit);
   if(groupId!==0n&&groupIdOf(o.hash,unit.map(s=>s.slot.nullifiers[0]!))!==groupId)throw new RollupRejection('group-invalid','The group id does not commit to its members.');
  }catch(error){pending=pending.filter(s=>s!==admitted);throw error;}
 };

 const dropped=(list:Iterable<RollupSpend>,reason:string)=>{const ids=[...list].map(s=>s.id);if(ids.length)o.onDrop?.(ids,reason);};
 const run=async():Promise<RollupTick>=>{
  const live=(s:RollupSpend)=>state.windowIndex(s.slot.root)>=0&&!s.slot.nullifiers.some(nf=>state.nullifiers.has(nf));
  dropped(pending.filter(s=>!live(s)),'Its root left the 64-batch window or its note is already spent.');
  pending=pending.filter(live);padding=padding.filter(live);
  // An incomplete group never batches, so without a deadline its members would hold their notes indefinitely.
  const stranded=pending.filter(s=>s.slot.groupId!==0n&&now()-s.receivedAt>ROLLUP_GROUP_WAIT_MS&&pending.filter(p=>p.slot.groupId===s.slot.groupId).length<s.slot.groupSize);
  dropped(stranded,'The rest of its group never arrived.');pending=pending.filter(s=>!stranded.includes(s));
  const floorMs=o.depositFloorMs??72*3600_000;
  for(const s of pending.filter(s=>s.coin))if(o.transport.fresh&&!await o.transport.fresh(depositFacts(s),floorMs)){
   const drop=unitsOf(pending,p=>p===s);pending=pending.filter(p=>!drop.has(p));
   dropped(drop,`The deposit coin is spent, changed, or expires within ${Math.round(floorMs/3600_000)} hours.`);
  }
  let taken:RollupSpend[]=[];
  const selection=selectRollupBatch(pending,now(),count=>{if(padding.length<count)throw new Error('padding');taken=padding.splice(0,count);return taken;},coinCap);
  if(!selection)return undefined;
  const clients=selection.spends.filter(s=>!taken.includes(s)),deposits=selection.spends.filter(s=>s.coin);
  pending=pending.filter(s=>!clients.includes(s));inflight=clients;inflightPadding=taken;
  const archive=journal.status().archive,reserveCoin=selection.asset?archive.reserves[selection.asset]:undefined;
  let submitted=false,applied=false,evict=false;
  // Admission gates everything below, so a rejection here is a gap: evict the selection rather than loop on it.
  const gate=<T>(build:()=>T):T=>{try{return build();}catch(error){evict=true;throw error;}};
  try{
   if(selection.asset&&!reserveCoin)gate(()=>{throw new Error(`No reserve for asset ${selection.asset}.`);});
   const result=gate(()=>state.apply('spend',selection.spends.map(s=>s.slot)));applied=true;
   const proof=await o.prover.prove(result.witness,result.publicSignals);
   const witness=rollupWitness(proof,selection.spends.map(s=>({proof:s.proof,publics:s.publics})));
   const reserve=reserveCoin?{...poolCoin(reserveCoin,pool.reserve),amount:BigInt(reserveCoin.amount)}:undefined;
   const built=gate(()=>buildRollupBatchTx({head:poolCoin(archive.head,pool.batch),...(reserve?{reserve}:{}),deposits:deposits.map(s=>s.coin!),legs:selection.legs,token:o.token,...(selection.asset?{asset:selection.asset}:{}),
    leaves:o.leaves,witness,newPacket:Uint8Array.from([...le32(state.commitment()),...le32(result.daRoot)]),checkpoint:o.checkpoint}));
   const firstDeposit=reserve?2:1;
   let request={arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))};
   if(deposits.length){
    const signed=await o.signDeposits(request,deposits);
    const tampered=!!signed&&!sameRequest(signed,request);
    const refused=signed&&!tampered?deposits.filter((s,i)=>!stockCustomerSigned(signed,serverKeyHex,firstDeposit+i)):deposits;
    if(refused.length){
     const drop=unitsOf(inflight,s=>refused.includes(s));
     inflight=inflight.filter(s=>!drop.has(s));
     const reason=tampered?'The signed batch is not the batch the operator built; its deposits are dropped.':'A depositor did not sign; the batch is rebuilt without their deposits.';
     dropped(drop,reason);throw new Error(reason);
    }
    verifyStockCustomerSignatures(signed!,serverKeyHex,firstDeposit);request=signed!;
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
   padding.unshift(...inflightPadding);if(!evict)pending.unshift(...inflight);else dropped(inflight,'The batch builder refused it: '+(error as Error).message);
   inflight=[];inflightPadding=[];
   throw error;
  }
 };

 /** Records an abandoned batch the network accepted after all, while the head it spends is still ours. */
 const adopt=async():Promise<RollupTick>=>{
  for(const name of readdirSync(kept)){
   const plan=JSON.parse(readFileSync(join(kept,name),'utf8')) as RollupPlan,archive=journal.status().archive,head=headOf(plan);
   if(head.txid!==archive.head.txid||head.vout!==archive.head.vout){rmSync(join(kept,name));continue;}
   if(!await o.transport.lookup(plan.request))continue;
   const outcome=await journal.submit('batch-'+archive.batches,plan);
   rmSync(join(kept,name));
   return {txid:outcome.receipt.txid,batch:archive.batches};
  }
  return undefined;
 };

 return {
  state,submit,
  addPadding:(spends:RollupSpend[])=>{padding.push(...spends);},
  pending:()=>pending.length,
  pendingIds:()=>[...pending,...inflight].map(s=>s.id),
  padding:()=>padding.length,
  status:()=>journal.status(),
  /** Adopts the head and reserves a renewal round moved; their state packet is unchanged. */
  relocate:(moved:Pick<RollupArchive,'head'|'reserves'>)=>journal.updateArchive(archive=>({...archive,head:moved.head,reserves:moved.reserves})),
  /** Runs at most one batch: resolves an unresolved submission first, then closes a due batch. */
  tick:async():Promise<RollupTick>=>{
   if(busy)return undefined;busy=true;
   try{
    if(journal.status().pending){
     const batch=journal.status().archive.batches;
     let r=await journal.reconcile() as {resolved:boolean;abandoned?:boolean;receipt?:StockNativeReceipt};
     if(!r.resolved){
      if(sent&&now()-sent.at<ROLLUP_RESEND_GRACE_MS)return {blocked:'A submitted batch has no known outcome yet.'};
      try{r={resolved:true,...await journal.retransmit()};}catch(error){return {blocked:String((error as Error).message)};}
     }
     if(r.abandoned){
      if(state.batchCount>journal.status().archive.batches)state.undoLast();
      const refused=unitsOf(inflight,s=>!!s.coin);
      dropped(refused,'The network kept refusing the batch with this deposit.');
      padding.unshift(...inflightPadding);pending.unshift(...inflight.filter(s=>!refused.has(s)));
      inflight=[];inflightPadding=[];sent=undefined;
      return {blocked:'A submitted batch was abandoned; its plan is kept in case it lands.'};
     }
     inflight=[];inflightPadding=[];
     if(r.receipt)return {txid:r.receipt.txid,batch};
    }
    const adopted=await adopt();if(adopted)return adopted;
    try{return await run();}catch(error){if((error as Error).message==='padding')return {blocked:'Not enough padding spends.'};throw error;}
   }finally{busy=false;}
  },
  close:()=>journal.close(),
 };
}
export type RollupOperator=Awaited<ReturnType<typeof openRollupOperator>>;
