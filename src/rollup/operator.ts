import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Transaction,VtxoScript,type CSVMultisigTapscript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {ROLLUP_DOMAIN,ROLLUP_FIELD,RollupRejection,type BatchKind} from '../../packages/protocol/src/rollup/constants.ts';
import {assetFieldOfId,destinationFieldOf,groupIdOf,statementOf,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {RollupState,type BatchSlot} from '../../packages/protocol/src/rollup/state.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../../packages/protocol/src/rollup/wallet.ts';
import {openStockJournal,type StockReleasePin} from '../stock/journal.ts';
import {stockCustomerSigned,stockSignedWeights,verifyStockCustomerSignatures,type StockNativeReceipt,type StockWireRequest} from '../stock/transport.ts';
import {BATCH_WAIT_MS,JOIN_BATCH_WAIT_MS,selectRollupBatch,type RollupSpend} from './batcher.ts';
import {buildRollupBatchTx,rollupPoolTree,rollupWitness,type RollupCoin,type RollupLeaves} from './covenant.ts';
import {readBatchTx,spentCoins} from './external.ts';
import {verifyRollupProof,type RollupProver} from './prover.ts';

export interface RollupPoolCoin {txid:string;vout:number;value:number;sourceTxHex:string}
export interface RollupArchive {version:1;head:RollupPoolCoin;reserves:Record<string,RollupPoolCoin&{amount:string}>;batches:number}
interface RecordSlot {root:string;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[];ciphertext?:string}
/** One accepted batch as published for data availability. */
export interface RollupRecord {kind:BatchKind;slots:RecordSlot[];txid?:string;at?:number}
interface RollupPlan {version:1;request:StockWireRequest;record:RollupRecord;firstDeposit:number;asset?:string;reserveAmount?:string}
/** What a deposit coin must still be when the batch is signed, as the client claims it. */
export interface RollupDepositFacts {txid:string;vout:number;value:number;script:string;assets:{assetId:string;amount:bigint}[]}
export interface RollupTransport {
 submit(request:StockWireRequest,firstDeposit:number):Promise<StockNativeReceipt>;
 lookup(request:StockWireRequest):Promise<StockNativeReceipt|undefined>;
 verify(request:StockWireRequest,receipt:StockNativeReceipt):void;
 unspent(coin:{txid:string;vout:number}):Promise<boolean>;
 /** The transaction that spent a coin, when the network shows it spent. */
 spentBy?(coin:{txid:string;vout:number}):Promise<string|undefined>;
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
 clientKey:Record<BatchKind,unknown>;
 hash:Hash;
 prover:Record<BatchKind,RollupProver>;
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
const recordOf=(kind:BatchKind,spends:readonly RollupSpend[]):RollupRecord=>({kind,slots:spends.map(({slot,publics,ciphertext})=>({root:String(slot.root),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publics.map(String),...(ciphertext?{ciphertext:hex.encode(ciphertext)}:{})}))});

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
   writeFileSync(bodyPath(archive.batches),JSON.stringify({...plan.record,txid:receipt.txid,at:now()}));
   if(state.batchCount===archive.batches)state.apply(plan.record.kind,plan.record.slots.map(slotOf));
   const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),coin=(vout:number)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))});
   const reserves=plan.asset?{...archive.reserves,[plan.asset]:{...coin(1),amount:plan.reserveAmount!}}:archive.reserves;
   return {...archive,head:coin(0),reserves,batches:archive.batches+1};
  },
 });
 for(let n=0;n<journal.status().archive.batches;n++){const body=JSON.parse(readFileSync(bodyPath(n),'utf8')) as RollupRecord;state.apply(body.kind,body.slots.map(slotOf));}
 // One batch is in flight at a time (the journal holds one plan), so a single in-flight pair carries its kind.
 const pending:Record<BatchKind,RollupSpend[]>={spend:[],join:[]},padding:Record<BatchKind,RollupSpend[]>={spend:[],join:[]};
 let inflight:RollupSpend[]=[],inflightPadding:RollupSpend[]=[],inflightKind:BatchKind='spend',busy=false,coinCap:number|undefined;
 const queued=(q:Record<BatchKind,RollupSpend[]>)=>[...q.spend,...q.join];
 const kindOf=(s:{slot:BatchSlot}):BatchKind=>{
  const n=s.slot.nullifiers.length;
  if(n!==1&&n!==2)throw new RollupRejection('slot-shape','A slot spends one note (a spend) or two (a join).');
  return n===1?'spend':'join';
 };
 const spent=(nf:bigint)=>state.nullifiers.has(nf)||[...queued(pending),...inflight,...queued(padding)].some(s=>s.slot.nullifiers.includes(nf));
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
  if([...queued(pending),...inflight].some(s=>s.id===spend.id))throw new Error('Duplicate rollup spend id.');
  const kind=kindOf(spend);
  if(kind==='join'){
   if(deposit||withdraw||assetField||spend.coin||spend.asset||spend.program)throw new RollupRejection('slot-shape','A join carries no deposit, withdrawal, coin or asset.');
   if(groupId!==0n||groupSize!==0)throw new RollupRejection('group-invalid','A join is never part of a group.');
   if(nullifiers[0]===nullifiers[1])throw new RollupRejection('double-spend','A join spends two different notes.');
  }
  if(nullifiers.some(nf=>nf<=0n||nf>=ROLLUP_FIELD))throw new RollupRejection('nullifier-range','The nullifier is zero or outside the field.');
  if(commitments.length!==2||[...commitments,root,ctDigest,groupId].some(v=>v<0n||v>=ROLLUP_FIELD))throw new RollupRejection('slot-shape','A slot has two field-element commitments.');
  if(![0,2,3].includes(groupSize)||(groupId===0n)!==(groupSize===0))throw new RollupRejection('group-invalid','A group has two or three members and a nonzero id.');
  const siblings=pending.spend.filter(s=>groupId!==0n&&s.slot.groupId===groupId);
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
  pending[kind].push(admitted);
  try{
   if(!await verifyRollupProof(o.clientKey[kind],spend.publics,spend.proof))throw new Error('Invalid client proof.');
   const unit=groupId===0n?[admitted]:pending.spend.filter(s=>s.slot.groupId===groupId);
   if(unit.length!==Math.max(groupSize,1))return;
   checkUnit(unit);
   if(groupId!==0n&&groupIdOf(o.hash,unit.map(s=>s.slot.nullifiers[0]!))!==groupId)throw new RollupRejection('group-invalid','The group id does not commit to its members.');
  }catch(error){pending[kind]=pending[kind].filter(s=>s!==admitted);throw error;}
 };

 const dropped=(list:Iterable<RollupSpend>,reason:string)=>{const ids=[...list].map(s=>s.id);if(ids.length)o.onDrop?.(ids,reason);};
 const run=async(kind:BatchKind):Promise<RollupTick>=>{
  const live=(s:RollupSpend)=>state.windowIndex(s.slot.root)>=0&&!s.slot.nullifiers.some(nf=>state.nullifiers.has(nf));
  dropped(pending[kind].filter(s=>!live(s)),'Its root left the 64-batch window or its note is already spent.');
  pending[kind]=pending[kind].filter(live);padding[kind]=padding[kind].filter(live);
  // An incomplete group never batches, so without a deadline its members would hold their notes indefinitely.
  if(kind==='spend'){
   const stranded=pending.spend.filter(s=>s.slot.groupId!==0n&&now()-s.receivedAt>ROLLUP_GROUP_WAIT_MS&&pending.spend.filter(p=>p.slot.groupId===s.slot.groupId).length<s.slot.groupSize);
   dropped(stranded,'The rest of its group never arrived.');pending.spend=pending.spend.filter(s=>!stranded.includes(s));
   const floorMs=o.depositFloorMs??72*3600_000;
   for(const s of pending.spend.filter(s=>s.coin))if(o.transport.fresh&&!await o.transport.fresh(depositFacts(s),floorMs)){
    const drop=unitsOf(pending.spend,p=>p===s);pending.spend=pending.spend.filter(p=>!drop.has(p));
    dropped(drop,`The deposit coin is spent, changed, or expires within ${Math.round(floorMs/3600_000)} hours.`);
   }
  }
  let taken:RollupSpend[]=[];
  const pad=(count:number)=>{if(padding[kind].length<count)throw new Error('padding');taken=padding[kind].splice(0,count);return taken;};
  const selection=selectRollupBatch(pending[kind],now(),pad,kind==='spend'?coinCap:undefined,kind==='join'?JOIN_BATCH_WAIT_MS:BATCH_WAIT_MS);
  if(!selection)return undefined;
  // run() only builds with nothing in flight, so a spent head means another prover moved it.
  const taker=await o.transport.spentBy?.(journal.status().archive.head);
  if(taker){padding[kind].unshift(...taken);return {blocked:`The pool head was spent by ${taker}, a batch this operator did not build. Post that batch's record to /api/rollup/external to continue.`};}
  const clients=selection.spends.filter(s=>!taken.includes(s)),deposits=selection.spends.filter(s=>s.coin);
  pending[kind]=pending[kind].filter(s=>!clients.includes(s));inflight=clients;inflightPadding=taken;inflightKind=kind;
  const archive=journal.status().archive,reserveCoin=selection.asset?archive.reserves[selection.asset]:undefined;
  let submitted=false,applied=false,evict=false;
  // Admission gates everything below, so a rejection here is a gap: evict the selection rather than loop on it.
  const gate=<T>(build:()=>T):T=>{try{return build();}catch(error){evict=true;throw error;}};
  try{
   if(selection.asset&&!reserveCoin)gate(()=>{throw new Error(`No reserve for asset ${selection.asset}.`);});
   const result=gate(()=>state.apply(kind,selection.spends.map(s=>s.slot)));applied=true;
   const proof=await o.prover[kind].prove(result.witness,result.publicSignals);
   const witness=rollupWitness(proof,selection.spends.map(s=>({proof:s.proof,publics:s.publics})));
   const reserve=reserveCoin?{...poolCoin(reserveCoin,pool.reserve),amount:BigInt(reserveCoin.amount)}:undefined;
   const built=gate(()=>buildRollupBatchTx({kind,head:poolCoin(archive.head,kind==='join'?pool.batchJoin:pool.batch),...(reserve?{reserve}:{}),deposits:deposits.map(s=>s.coin!),legs:selection.legs,token:o.token,...(selection.asset?{asset:selection.asset}:{}),
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
    if(kind==='spend')coinCap=Math.max(0,deposits.length-1);
    throw new Error(`The batch weighs ${weights.ark} WU, over the ${limit} WU weight limit; the next one takes fewer deposits.`);
   }
   const nx=selection.legs.reduce((sum,leg)=>sum+(leg.asset?leg.deposit-leg.withdraw:0n),0n);
   const plan:RollupPlan={version:1,request,record:recordOf(kind,selection.spends),firstDeposit,...(reserve?{asset:selection.asset!,reserveAmount:String(reserve.amount+nx)}:{})};
   submitted=true;
   const outcome=await journal.submit('batch-'+archive.batches,plan);
   inflight=[];inflightPadding=[];if(kind==='spend')coinCap=undefined;
   return {txid:outcome.receipt.txid,batch:archive.batches};
  }catch(error){
   if(submitted&&journal.status().pending)return {blocked:String((error as Error).message)};
   if(applied)state.undoLast();
   padding[kind].unshift(...inflightPadding);if(!evict)pending[kind].unshift(...inflight);else dropped(inflight,'The batch builder refused it: '+(error as Error).message);
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
  /** Padding goes to the queue its slot shape belongs to: one nullifier pads spend batches, two pad join batches. */
  addPadding:(spends:RollupSpend[])=>{for(const s of spends)padding[kindOf(s)].push(s);},
  pending:()=>queued(pending).length,
  pendingIds:()=>[...queued(pending),...inflight].map(s=>s.id),
  padding:(kind?:BatchKind)=>kind?padding[kind].length:queued(padding).length,
  status:()=>journal.status(),
  txidOf:(batch:number)=>journal.receipt('batch-'+batch)?.txid,
  /**
   * Follows a batch another prover got accepted from this pool's head; the caller has checked the network accepted `tx`.
   * Every record slot must reproduce the statement the transaction carries and the replay must reach its state packet,
   * so a record that misstates any note is refused.
   */
  follow:async(external:{tx:Transaction;checkpoints:Transaction[];slots:(Omit<RecordSlot,'publics'>&{publics?:string[]})[];at:number;reserveAmount?:string}):Promise<{batch:number;txid:string}>=>{
   if(busy)throw new Error('The operator is busy; try again.');busy=true;
   try{
    const {tx,slots}=external,facts=readBatchTx(tx,o.leaves),[head,second]=spentCoins(tx,external.checkpoints);
    let archive=journal.status().archive;
    if(head!.txid!==archive.head.txid||head!.vout!==archive.head.vout)throw new Error(`Transaction ${tx.id} spends ${head!.txid}:${head!.vout}, not this pool's head.`);
    if(slots.length!==facts.publics.length)throw new Error('The record has the wrong number of slots.');
    if(slots.some(s=>s.nullifiers.length!==(facts.kind==='join'?2:1)))throw new Error(`Every slot of a ${facts.kind} batch spends ${facts.kind==='join'?'two notes':'one note'}.`);
    slots.forEach((s,i)=>{
     if(statementOf(o.hash,{domain:ROLLUP_DOMAIN,...slotOf({...s,publics:[]})})!==facts.publics[i]![0])throw new Error(`Slot ${i} does not match the statement the transaction carries.`);
     if(s.ciphertext&&ctDigestOf(hex.decode(s.ciphertext))!==BigInt(s.ctDigest))throw new Error(`Slot ${i}'s note record does not match its digest.`);
    });
    // Our own unaccepted batch spent the same head, so it can never land now.
    if(journal.status().pending){
     journal.discard();sent=undefined;
     if(state.batchCount>archive.batches)state.undoLast();
     padding[inflightKind].unshift(...inflightPadding);pending[inflightKind].unshift(...inflight);inflight=[];inflightPadding=[];
    }
    const replica=state.clone(),replay=replica.apply(facts.kind,slots.map(s=>slotOf({...s,publics:[]})));
    if(replica.commitment()!==facts.commitment||replay.daRoot!==facts.daRoot)throw new Error('The record does not match the state the transaction committed to.');
    const reserveAsset=second&&Object.entries(archive.reserves).find(([,c])=>c.txid===second.txid&&c.vout===second.vout)?.[0];
    if(reserveAsset&&external.reserveAmount===undefined)throw new Error('Following a batch that moves a reserve needs the reserve\'s new amount.');
    const record:RollupRecord={kind:facts.kind,slots:slots.map((s,i)=>({...s,publics:facts.publics[i]!.map(String)})),txid:tx.id,at:external.at};
    writeFileSync(bodyPath(archive.batches),JSON.stringify(record));
    state.apply(facts.kind,slots.map(s=>slotOf({...s,publics:[]})));
    const coin=(vout:number)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))});
    archive=await journal.updateArchive(a=>({...a,head:coin(0),reserves:reserveAsset?{...a.reserves,[reserveAsset]:{...coin(1),amount:external.reserveAmount!}}:a.reserves,batches:a.batches+1}));
    return {batch:archive.batches-1,txid:tx.id};
   }finally{busy=false;}
  },
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
      padding[inflightKind].unshift(...inflightPadding);pending[inflightKind].unshift(...inflight.filter(s=>!refused.has(s)));
      inflight=[];inflightPadding=[];sent=undefined;
      return {blocked:'A submitted batch was abandoned; its plan is kept in case it lands.'};
     }
     inflight=[];inflightPadding=[];
     if(r.receipt)return {txid:r.receipt.txid,batch};
    }
    const adopted=await adopt();if(adopted)return adopted;
    let short:BatchKind|undefined;
    for(const kind of ['spend','join'] as const){
     try{const ran=await run(kind);if(ran)return ran;}catch(error){if((error as Error).message!=='padding')throw error;short??=kind;}
    }
    return short?{blocked:`Not enough padding ${short==='join'?'joins':'spends'}.`}:undefined;
   }finally{busy=false;}
  },
  close:()=>journal.close(),
 };
}
export type RollupOperator=Awaited<ReturnType<typeof openRollupOperator>>;
