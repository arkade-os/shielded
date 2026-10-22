import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Transaction,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {ARCHIVE_DEPTH,EPOCH_NULLIFIERS,ROLLUP_DOMAIN,ROLLUP_FIELD,RollupRejection,type EpochBatchKind} from '../../packages/protocol/src/rollup/constants.ts';
import {anchorOf,EpochState,type EpochSlot} from '../../packages/protocol/src/rollup/epoch.ts';
import {assetFieldOfId,destinationFieldOf,groupIdOf,statementOf} from '../../packages/protocol/src/rollup/notes.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../../packages/protocol/src/rollup/wallet.ts';
import {openStockJournal} from '../stock/journal.ts';
import {stockCustomerSigned,stockSignedWeights,verifyStockCustomerSignatures,type StockNativeReceipt,type StockWireRequest} from '../stock/transport.ts';
import {BATCH_WAIT_MS,JOIN_BATCH_WAIT_MS,selectRollupBatch,type RollupSelection,type RollupSpend} from './batcher.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupWitness,type RollupCoin,type RollupEpochLeaves} from './covenant.ts';
import {readEpochBatchTx,spentCoins} from './external.ts';
import {ROLLUP_GROUP_WAIT_MS,ROLLUP_QUICK_REFUSAL_MS,ROLLUP_RESEND_GRACE_MS,type RollupArchive,type RollupDepositFacts,type RollupOperatorOptions,type RollupPoolCoin,type RollupTick} from './operator.ts';
import {verifyRollupProof,type RollupProver} from './prover.ts';
import {headCommitment} from './snapshot.ts';

/** A spend with `origin` set is a recovery of a note from that archived epoch. */
export interface RollupEpochSpend extends Omit<RollupSpend,'slot'> {slot:EpochSlot;origin?:number}
export interface EpochRecordSlot {anchor:string;rCur?:{epoch:number;root:string};origin?:number;nullifiers:string[];commitments:[string,string];ctDigest:string;groupId:string;groupSize:number;publics:string[];ciphertext?:string}
/** One accepted batch as published; the block root is always kept, so a replay never needs an archived nullifier set. */
export interface RollupEpochRecord {kind:EpochBatchKind;slots:EpochRecordSlot[];noteBlockRoot:string;txid?:string;at?:number}
interface RollupEpochPlan {version:1;request:StockWireRequest;record:RollupEpochRecord;firstDeposit:number;asset?:string;reserveAmount?:string}
export interface RollupEpochOperatorOptions extends Omit<RollupOperatorOptions,'leaves'|'clientKey'|'prover'|'signDeposits'|'snapshotEvery'> {
 epochLen:number;
 leaves:RollupEpochLeaves;
 clientKey:Record<EpochBatchKind,unknown>;
 prover:Record<EpochBatchKind,RollupProver>;
 signDeposits(request:StockWireRequest,spends:RollupEpochSpend[]):Promise<StockWireRequest|undefined>;
}

const KINDS=['spend','join','recover'] as const;
const le32=(value:bigint)=>Uint8Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
const inField=(value:unknown)=>typeof value==='bigint'&&value>=0n&&value<ROLLUP_FIELD;
const slotOf=(s:Omit<EpochRecordSlot,'publics'>):EpochSlot=>({anchor:BigInt(s.anchor),...(s.rCur?{rCur:{epoch:s.rCur.epoch,root:BigInt(s.rCur.root)}}:{}),...(s.origin!==undefined?{origin:s.origin}:{}),
 nullifiers:s.nullifiers.map(BigInt),commitments:[BigInt(s.commitments[0]),BigInt(s.commitments[1])],ctDigest:BigInt(s.ctDigest),groupId:BigInt(s.groupId),groupSize:s.groupSize});
const recordOf=(kind:EpochBatchKind,spends:readonly RollupEpochSpend[],noteBlockRoot:bigint):RollupEpochRecord=>({kind,slots:spends.map(({slot,publics,ciphertext})=>({anchor:String(slot.anchor),
 ...(slot.rCur?{rCur:{epoch:slot.rCur.epoch,root:String(slot.rCur.root)}}:{}),...(slot.origin!==undefined?{origin:slot.origin}:{}),nullifiers:slot.nullifiers.map(String),commitments:[String(slot.commitments[0]),String(slot.commitments[1])],
 ctDigest:String(slot.ctDigest),groupId:String(slot.groupId),groupSize:slot.groupSize,publics:publics.map(String),...(ciphertext?{ciphertext:hex.encode(ciphertext)}:{})})),noteBlockRoot:String(noteBlockRoot)});

const sameTx=(left:string,right:string)=>{const [a,b]=[left,right].map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));return a.id===b.id&&hex.encode(a.unsignedTx)===hex.encode(b.unsignedTx);};
const sameRequest=(actual:StockWireRequest,expected:StockWireRequest)=>
 actual.checkpoints.length===expected.checkpoints.length&&sameTx(actual.arkTx,expected.arkTx)&&expected.checkpoints.every((encoded,i)=>sameTx(actual.checkpoints[i]!,encoded));

function checkUnit(unit:readonly RollupEpochSpend[]):void {
 unit.forEach((s,i)=>{
  if(s.publics[5]===0n||s.publics[4]===0n)return;
  const carrier=unit[i+1];
  if(!carrier||carrier.publics[5]!==0n||carrier.publics[4]===0n||hex.encode(carrier.program!)!==hex.encode(s.program!))throw new Error('An asset payout must be followed by its BTC carrier to the same program.');
 });
 const sats=unit.reduce((sum,s)=>sum+BigInt(s.coin?.value??0),0n),btc=unit.reduce((sum,s)=>sum+(s.publics[5]===0n?s.publics[3]:0n),0n);
 const units=unit.reduce((sum,s)=>sum+(s.coin?.assetAmount??0n),0n),assets=unit.reduce((sum,s)=>sum+(s.publics[5]!==0n?s.publics[3]:0n),0n);
 if(sats!==btc||units!==assets)throw new Error('Deposit coins must carry exactly the deposited sats and asset.');
}

export async function openRollupEpochOperator(o:RollupEpochOperatorOptions){
 const now=o.now??Date.now,verify=o.verify??verifyRollupProof,pool=rollupEpochPoolTree(o.serverKey,o.emulatorKey,o.leaves,o.exitDelay),serverKeyHex=hex.encode(o.serverKey);
 const bodies=join(o.directory,'batches');mkdirSync(bodies,{recursive:true});
 const kept=join(o.directory,'abandoned');mkdirSync(kept,{recursive:true});
 const bodyPath=(n:number)=>join(bodies,`${n}.json`);
 const state=EpochState.genesis(o.hash,o.epochLen,false);
 const applyRecord=(r:RollupEpochRecord)=>state.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));
 const poolCoin=(c:RollupPoolCoin,leaf:Uint8Array):RollupCoin=>({txid:c.txid,vout:c.vout,value:c.value,sourceTx:hex.decode(c.sourceTxHex),tapTree:pool.tree.encode(),leaf:pool.tree.findLeaf(hex.encode(leaf))});
 const headOf=(plan:RollupEpochPlan)=>{const input=Transaction.fromPSBT(base64.decode(plan.request.checkpoints[0]!)).getInput(0);return {txid:hex.encode(input.txid!),vout:input.index!};};
 const keptPath=(plan:RollupEpochPlan)=>join(kept,`${Transaction.fromPSBT(base64.decode(plan.request.arkTx)).id}.json`);
 let sent:{at:number;failed:boolean;tries:number;graceMs:number}|undefined;
 const journal=await openStockJournal<RollupArchive,RollupEpochPlan,StockNativeReceipt>(join(o.directory,'journal'),o.pin,o.genesis,{
  validateArchive:archive=>{if(archive.version!==1||Transaction.fromRaw(hex.decode(archive.head.sourceTxHex),{allowUnknownOutputs:true}).id!==archive.head.txid)throw new Error('Invalid rollup archive head.');},
  validatePlan:(plan,archive)=>{const head=headOf(plan);if(plan.version!==1||head.txid!==archive.head.txid||head.vout!==archive.head.vout)throw new Error('Rollup plan spends a different head.');},
  verifyReceipt:(plan,receipt)=>o.transport.verify(plan.request,receipt),
  transmit:async plan=>{
   const attempt={at:now(),failed:true,tries:(sent?.tries??0)+1,graceMs:ROLLUP_RESEND_GRACE_MS};sent=attempt;
   try{
    const receipt=await o.transport.lookup(plan.request)??await o.transport.submit(plan.request,plan.firstDeposit);
    sent=undefined;return receipt;
   }catch(error){if((error as {refused?:boolean}).refused&&now()-attempt.at<ROLLUP_QUICK_REFUSAL_MS)Object.assign(attempt,{at:now(),graceMs:ROLLUP_QUICK_REFUSAL_MS});throw error;}
  },
  lookup:plan=>o.transport.lookup(plan.request),
  abandoned:async plan=>{
   if(!sent?.failed||sent.tries<2||now()-sent.at<sent.graceMs)return false;
   if(await o.transport.lookup(plan.request)||!await o.transport.unspent(headOf(plan)))return false;
   writeFileSync(keptPath(plan),JSON.stringify(plan));return true;
  },
  apply:(archive,plan,receipt)=>{
   writeFileSync(bodyPath(archive.batches),JSON.stringify({...plan.record,txid:receipt.txid,at:now()}));
   if(state.batchCount===archive.batches)applyRecord(plan.record);
   const tx=Transaction.fromPSBT(base64.decode(receipt.signedArkTx)),coin=(vout:number)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))});
   const reserves=plan.asset?{...archive.reserves,[plan.asset]:{...coin(1),amount:plan.reserveAmount!}}:archive.reserves;
   return {...archive,head:coin(0),reserves,batches:archive.batches+1};
  },
 });
 const atOpen=journal.status().archive,committed=headCommitment(atOpen.head.sourceTxHex);
 if(committed===undefined)console.warn(`[rollup] The pool head ${atOpen.head.txid} carries no readable state packet; the state is replayed from genesis and cannot be checked against it.`);
 try{
  for(let n=0;n<atOpen.batches;n++)applyRecord(JSON.parse(readFileSync(bodyPath(n),'utf8')) as RollupEpochRecord);
  if(committed!==undefined&&state.commitment()!==committed)throw new Error(`Replaying ${atOpen.batches} batches gives commitment ${state.commitment()}, but the pool head commits to ${committed}; a batch record is wrong, so the pool does not open.`);
 }catch(error){journal.close();throw error;}
 const pending:Record<EpochBatchKind,RollupEpochSpend[]>={spend:[],join:[],recover:[]},padding:Record<EpochBatchKind,RollupEpochSpend[]>={spend:[],join:[],recover:[]};
 let inflight:RollupEpochSpend[]=[],inflightPadding:RollupEpochSpend[]=[],inflightKind:EpochBatchKind='spend',busy=false,coinCap:number|undefined;
 // An index into KINDS: after a batch of one kind the next kind leads, so none can starve.
 let lead=0;
 const queued=(q:Record<EpochBatchKind,RollupEpochSpend[]>)=>[...q.spend,...q.join,...q.recover];
 const proven=new WeakSet<RollupEpochSpend>(),checked=new WeakSet<RollupEpochSpend>();
 const selectable=(s:RollupEpochSpend)=>proven.has(s)&&checked.has(s);
 const kindOf=(s:{slot:EpochSlot;origin?:number}):EpochBatchKind=>{
  const kind=s.origin!==undefined?'recover':s.slot.nullifiers.length===2?'join':'spend';
  if(s.slot.nullifiers.length!==EPOCH_NULLIFIERS[kind]||s.slot.origin!==s.origin)throw new RollupRejection('slot-shape','A slot spends one note (a spend or a recovery) or two (a join), and only a recovery names an origin, on its spend and its slot alike.');
  return kind;
 };
 // The batch that rotates archives the epoch before last, and a recovery may ride that very batch.
 const archived=(origin:number)=>state.archive.has(origin)||(state.rotatesNext()&&origin===state.epoch-1);
 // After a rotation the previous epoch's set is the current one, so only the current set is checked across it.
 const spent=(nf:bigint,kind:EpochBatchKind)=>(kind==='recover'?state.recovered.has(nf):state.nullifiers.has(nf)||(!state.rotatesNext()&&state.prevNf.has(nf)))
  ||[...queued(pending),...inflight,...queued(padding)].some(s=>s.slot.nullifiers.includes(nf));
 const unitsOf=(list:readonly RollupEpochSpend[],pick:(s:RollupEpochSpend)=>boolean)=>{
  const ids=new Set(list.filter(s=>pick(s)&&s.slot.groupId!==0n).map(s=>s.slot.groupId));
  return new Set(list.filter(s=>pick(s)||ids.has(s.slot.groupId)));
 };
 const depositFacts=(s:RollupEpochSpend):RollupDepositFacts=>({txid:s.coin!.txid,vout:s.coin!.vout,value:s.coin!.value,
  script:hex.encode(VtxoScript.decode(s.coin!.tapTree).pkScript),assets:s.coin!.assetAmount?[{assetId:s.asset!,amount:s.coin!.assetAmount}]:[]});
 // selectRollupBatch reads only a slot's groupId and groupSize, which both slot shapes carry.
 const select=(list:RollupEpochSpend[],pad:(count:number)=>RollupEpochSpend[],maxCoins:number|undefined,waitMs:number)=>
  selectRollupBatch(list as unknown as RollupSpend[],now(),pad as unknown as (count:number)=>RollupSpend[],maxCoins,waitMs) as (Omit<RollupSelection,'spends'>&{spends:RollupEpochSpend[]})|undefined;

 /** The only gate: a spend the batch, the builder or the network would reject must never reserve a nullifier. */
 const submit=async(spend:Omit<RollupEpochSpend,'receivedAt'>)=>{
  const [pub,,,deposit,withdraw,assetField,destination]=spend.publics;
  const {anchor,rCur,nullifiers,commitments,ctDigest,groupId,groupSize}=spend.slot;
  if([...queued(pending),...inflight].some(s=>s.id===spend.id))throw new Error('Duplicate rollup spend id.');
  const kind=kindOf(spend);
  if(kind==='join'){
   if(deposit||withdraw||assetField||spend.coin||spend.asset||spend.program)throw new RollupRejection('slot-shape','A join carries no deposit, withdrawal, coin or asset.');
   if(groupId!==0n||groupSize!==0)throw new RollupRejection('group-invalid','A join is never part of a group.');
   if(nullifiers[0]===nullifiers[1])throw new RollupRejection('double-spend','A join spends two different notes.');
  }
  if(kind==='recover'){
   if(deposit||withdraw||assetField||destination||spend.coin||spend.asset||spend.program)throw new RollupRejection('slot-shape','A recovery carries no deposit, withdrawal, coin or asset: it only becomes a fresh note.');
   if(groupId!==0n||groupSize!==0)throw new RollupRejection('group-invalid','A recovery is never part of a group.');
   if(!archived(spend.origin!))throw new RollupRejection('recover-unarchived',`Epoch ${spend.origin} is not archived; a note of a live epoch takes the fast path.`);
  }else if(!rCur)throw new RollupRejection('window-tag','A fast-path slot must name the window leaf it anchors on.');
  if(nullifiers.some(nf=>!inField(nf)||nf===0n))throw new RollupRejection('nullifier-range','The nullifier is zero or outside the field.');
  if(commitments.length!==2||![...commitments,anchor,ctDigest,groupId].every(inField)||(rCur&&(!Number.isSafeInteger(rCur.epoch)||!inField(rCur.root))))throw new RollupRejection('slot-shape','A slot has two field-element commitments, and its anchor and window root are field elements.');
  if(![0,2,3].includes(groupSize)||(groupId===0n)!==(groupSize===0))throw new RollupRejection('group-invalid','A group has two or three members and a nonzero id.');
  const siblings=pending.spend.filter(s=>groupId!==0n&&s.slot.groupId===groupId);
  if(groupId!==0n&&(siblings.length>=groupSize||siblings.some(s=>s.slot.groupSize!==groupSize)))throw new RollupRejection('group-invalid','The group is already complete or disagrees on its size.');
  if(nullifiers.some(nf=>spent(nf,kind)))throw new RollupRejection('double-spend','The note is already spent or pending.');
  if(kind==='recover'){
   const origin=spend.origin!,nf=nullifiers[0]!,riding=!state.archive.has(origin);
   // The rotating batch archives epoch-1 from live state: its final root is prevNoteRoot, its frozen sets prevNf and nullifiers.
   if(riding&&(state.prevNf.has(nf)||state.nullifiers.has(nf)))throw new RollupRejection('double-spend','The note was already spent in its own epoch or the next.');
   const noteFinal=riding?state.prevNoteRoot:state.archive.witness(origin,nf).archived.noteFinal;
   if(anchor!==anchorOf(o.hash,noteFinal,noteFinal))throw new RollupRejection('stale-anchor','The recovery does not open against the final note root of its origin epoch.');
  }else{
   const epoch=state.epoch+(state.rotatesNext()?1:0);
   if((rCur!.epoch!==epoch&&rCur!.epoch!==epoch-1)||state.windowIndex(rCur!)<0)throw new RollupRejection('window-tag','The spend anchors on a root that is not a window leaf of a live epoch.');
   if(anchor!==anchorOf(o.hash,state.nextAnchorRoot(),rCur!.root))throw new RollupRejection('stale-anchor','The spend opens against another previous-epoch root than the next batch does; prove it again.');
  }
  if(statementOf(o.hash,{domain:ROLLUP_DOMAIN,...spend.slot,root:anchor})!==pub)throw new Error('The spend statement does not match its opening.');
  if((withdraw>0n)!==!!spend.program||(spend.program?destinationFieldOf(spend.program):0n)!==destination)throw new Error('The withdrawal destination does not match its P2TR program.');
  if(withdraw>0n&&assetField===0n&&withdraw<BigInt(o.dustSats??330))throw new Error(`A withdrawal pays at least the ${o.dustSats??330}-sat dust limit.`);
  if((assetField!==0n)!==!!spend.asset||(spend.asset?assetFieldOfId(spend.asset):0n)!==assetField)throw new Error('The boundary asset does not match its Arkade asset id.');
  if(spend.coin&&deposit===0n)throw new Error('A deposit coin needs a deposit leg.');
  if(spend.ciphertext&&(spend.ciphertext.length!==ROLLUP_RECORD_BYTES||ctDigestOf(spend.ciphertext)!==ctDigest))throw new Error('The note record does not match the slot digest.');
  if(spend.asset&&!journal.status().archive.reserves[spend.asset])throw new Error(`No reserve for asset ${spend.asset}.`);
  const admitted={...spend,receivedAt:now()};
  pending[kind].push(admitted);
  try{
   if(!await verify(o.clientKey[kind],spend.publics,spend.proof))throw new Error('Invalid client proof.');
   proven.add(admitted);
   const unit=groupId===0n?[admitted]:pending.spend.filter(s=>s.slot.groupId===groupId);
   if(unit.length!==Math.max(groupSize,1))return;
   checkUnit(unit);
   if(groupId!==0n&&groupIdOf(o.hash,unit.map(s=>s.slot.nullifiers[0]!))!==groupId)throw new RollupRejection('group-invalid','The group id does not commit to its members.');
   for(const s of unit)checked.add(s);
  }catch(error){pending[kind]=pending[kind].filter(s=>s!==admitted);throw error;}
 };

 const dropped=(list:Iterable<RollupEpochSpend>,reason:string)=>{const ids=[...list].map(s=>s.id);if(ids.length)o.onDrop?.(ids,reason);};
 const run=async(kind:EpochBatchKind):Promise<RollupTick>=>{
  if(state.archive.count()>=2**ARCHIVE_DEPTH)throw new RollupRejection('archive-full','The epoch archive is full, so no batch of any kind can be proved again.');
  const live=(s:RollupEpochSpend)=>kind==='recover'?archived(s.origin!)&&!s.slot.nullifiers.some(nf=>state.recovered.has(nf))
   :s.slot.anchor===anchorOf(o.hash,state.nextAnchorRoot(),s.slot.rCur!.root)&&state.windowIndex(s.slot.rCur!)>=0&&!s.slot.nullifiers.some(nf=>state.nullifiers.has(nf));
  dropped([...pending[kind],...padding[kind]].filter(s=>!live(s)),kind==='recover'?'Its note is already recovered, or its epoch is no longer archived.'
   :'An epoch rotation made its anchor stale, its root left the 64-batch window, or its note is already spent; prove it again.');
  pending[kind]=pending[kind].filter(live);padding[kind]=padding[kind].filter(live);
  if(kind==='spend'){
   const stranded=pending.spend.filter(s=>s.slot.groupId!==0n&&now()-s.receivedAt>ROLLUP_GROUP_WAIT_MS&&pending.spend.filter(p=>p.slot.groupId===s.slot.groupId).length<s.slot.groupSize);
   dropped(stranded,'The rest of its group never arrived.');pending.spend=pending.spend.filter(s=>!stranded.includes(s));
   const floorMs=o.depositFloorMs??72*3600_000;
   for(const s of pending.spend.filter(s=>s.coin))if(o.transport.fresh&&!await o.transport.fresh(depositFacts(s),floorMs)){
    const drop=unitsOf(pending.spend,p=>p===s);pending.spend=pending.spend.filter(p=>!drop.has(p));
    dropped(drop,`The deposit coin is spent, changed, or expires within ${Math.round(floorMs/3600_000)} hours.`);
   }
  }
  let taken:RollupEpochSpend[]=[];
  const pad=(count:number)=>{if(padding[kind].length<count)throw new Error('padding');taken=padding[kind].splice(0,count);return taken;};
  const ready=pending[kind].filter(selectable);
  // A recover batch is one slot wide: it takes no padding and waits for no company.
  const selection=kind==='recover'?select(ready.slice(0,1),()=>[],undefined,0)
   :select(ready,pad,kind==='spend'?coinCap:undefined,kind==='join'?o.joinWaitMs??JOIN_BATCH_WAIT_MS:o.batchWaitMs??BATCH_WAIT_MS);
  if(!selection)return undefined;
  const taker=await o.transport.spentBy?.(journal.status().archive.head);
  if(taker){padding[kind].unshift(...taken);return {blocked:`The pool head was spent by ${taker}, a batch this operator did not build. Post that batch's record to /api/rollup/external to continue.`};}
  const clients=selection.spends.filter(s=>!taken.includes(s)),deposits=selection.spends.filter(s=>s.coin);
  pending[kind]=pending[kind].filter(s=>!clients.includes(s));inflight=clients;inflightPadding=taken;inflightKind=kind;
  const archive=journal.status().archive,reserveCoin=selection.asset?archive.reserves[selection.asset]:undefined;
  let submitted=false,applied=false,evict=false;
  const gate=<T>(build:()=>T):T=>{try{return build();}catch(error){evict=true;throw error;}};
  const started=now(),oldest=Math.min(...clients.map(s=>s.receivedAt));
  try{
   if(selection.asset&&!reserveCoin)gate(()=>{throw new Error(`No reserve for asset ${selection.asset}.`);});
   const result=gate(()=>state.apply(kind,selection.spends.map(s=>s.slot)));applied=true;
   const proof=await o.prover[kind].prove(result.witness,result.publicSignals),proved=now();
   const witness=rollupWitness(proof,selection.spends.map(s=>({proof:s.proof,publics:s.publics})));
   const reserve=reserveCoin?{...poolCoin(reserveCoin,pool.reserve),amount:BigInt(reserveCoin.amount)}:undefined;
   const built=gate(()=>buildRollupBatchTx({kind,head:poolCoin(archive.head,kind==='recover'?pool.batchRecover:kind==='join'?pool.batchJoin:pool.batch),...(reserve?{reserve}:{}),deposits:deposits.map(s=>s.coin!),legs:selection.legs,token:o.token,...(selection.asset?{asset:selection.asset}:{}),
    leaves:o.leaves,witness,newPacket:Uint8Array.from([...le32(state.commitment()),...le32(result.daRoot),...le32(result.blockRoot)]),checkpoint:o.checkpoint}));
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
   const plan:RollupEpochPlan={version:1,request,record:recordOf(kind,selection.spends,result.blockRoot),firstDeposit,...(reserve?{asset:selection.asset!,reserveAmount:String(reserve.amount+nx)}:{})};
   submitted=true;
   const outcome=await journal.submit('batch-'+archive.batches,plan);
   inflight=[];inflightPadding=[];if(kind==='spend')coinCap=undefined;
   return {txid:outcome.receipt.txid,batch:archive.batches,timings:{waitedMs:started-oldest,proveMs:proved-started,publishMs:now()-proved}};
  }catch(error){
   if(submitted&&journal.status().pending)return {blocked:String((error as Error).message)};
   if(applied)state.undoLast();
   padding[kind].unshift(...inflightPadding);if(!evict)pending[kind].unshift(...inflight);else dropped(inflight,'The batch builder refused it: '+(error as Error).message);
   inflight=[];inflightPadding=[];
   throw error;
  }
 };

 const adopt=async():Promise<RollupTick>=>{
  for(const name of readdirSync(kept)){
   const plan=JSON.parse(readFileSync(join(kept,name),'utf8')) as RollupEpochPlan,archive=journal.status().archive,head=headOf(plan);
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
  addPadding:(spends:RollupEpochSpend[])=>{for(const s of spends){const kind=kindOf(s);if(kind==='recover'||!s.slot.rCur)throw new Error('Padding is a spend or join slot that names its window leaf.');padding[kind].push(s);}},
  pending:()=>queued(pending).length,
  pendingIds:()=>[...queued(pending),...inflight].map(s=>s.id),
  padding:(kind?:EpochBatchKind)=>kind?padding[kind].length:queued(padding).length,
  status:()=>journal.status(),
  /** Follows a batch another prover got accepted from this pool's head; the caller has checked the network accepted `tx`. */
  follow:async(external:{tx:Transaction;checkpoints:Transaction[];slots?:(Omit<EpochRecordSlot,'publics'>&{publics?:string[]})[];at:number;reserveAmount?:string}):Promise<{batch:number;txid:string}>=>{
   if(busy)throw new Error('The operator is busy; try again.');busy=true;
   try{
    const {tx,slots}=external,facts=readEpochBatchTx(tx,o.leaves),[head,second]=spentCoins(tx,external.checkpoints);
    let archive=journal.status().archive;
    if(head!.txid!==archive.head.txid||head!.vout!==archive.head.vout)throw new Error(`Transaction ${tx.id} spends ${head!.txid}:${head!.vout}, not this pool's head.`);
    if(slots){
     const m=EPOCH_NULLIFIERS[facts.kind];
     if(slots.length!==facts.publics.length)throw new Error('The record has the wrong number of slots.');
     if(slots.some(s=>s.nullifiers.length!==m))throw new Error(`Every slot of a ${facts.kind} batch spends ${m===2?'two notes':'one note'}.`);
     slots.forEach((s,i)=>{
      if(statementOf(o.hash,{domain:ROLLUP_DOMAIN,...slotOf(s),root:BigInt(s.anchor)})!==facts.publics[i]![0])throw new Error(`Slot ${i} does not match the statement the transaction carries.`);
      if(s.ciphertext&&ctDigestOf(hex.decode(s.ciphertext))!==BigInt(s.ctDigest))throw new Error(`Slot ${i}'s note record does not match its digest.`);
     });
    }
    if(journal.status().pending){
     journal.discard();sent=undefined;
     if(state.batchCount>archive.batches)state.undoLast();
     padding[inflightKind].unshift(...inflightPadding);pending[inflightKind].unshift(...inflight);inflight=[];inflightPadding=[];
    }
    const replica=state.clone();
    if(slots){
     const replay=replica.apply(facts.kind,slots.map(slotOf));
     if(replica.commitment()!==facts.commitment||replay.daRoot!==facts.daRoot)throw new Error('The record does not match the state the transaction committed to.');
    }else if(replica.applyFromChain(facts.kind,facts.nullifiers,facts.noteBlockRoot)!==facts.commitment)throw new Error('The transaction does not reconstruct a consistent state.');
    const reserveAsset=second&&Object.entries(archive.reserves).find(([,c])=>c.txid===second.txid&&c.vout===second.vout)?.[0];
    if(reserveAsset&&external.reserveAmount===undefined)throw new Error('Following a batch that moves a reserve needs the reserve\'s new amount.');
    const record:RollupEpochRecord={kind:facts.kind,slots:slots
     ?slots.map((s,i)=>({...s,publics:facts.publics[i]!.map(String)}))
     :facts.nullifiers.map((nf,i)=>({anchor:'0',nullifiers:nf.map(String),commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:0,publics:facts.publics[i]!.map(String)})),noteBlockRoot:String(facts.noteBlockRoot),txid:tx.id,at:external.at};
    writeFileSync(bodyPath(archive.batches),JSON.stringify(record));
    state.applyFromChain(facts.kind,facts.nullifiers,facts.noteBlockRoot);
    const coin=(vout:number)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTxHex:hex.encode(tx.toBytes(true,true))});
    archive=await journal.updateArchive(a=>({...a,head:coin(0),reserves:reserveAsset?{...a.reserves,[reserveAsset]:{...coin(1),amount:external.reserveAmount!}}:a.reserves,batches:a.batches+1}));
    return {batch:archive.batches-1,txid:tx.id};
   }finally{busy=false;}
  },
  relocate:(moved:Pick<RollupArchive,'head'|'reserves'>)=>journal.updateArchive(archive=>({...archive,head:moved.head,reserves:moved.reserves})),
  /** Runs at most one batch: resolves an unresolved submission first, then closes a due batch. */
  tick:async():Promise<RollupTick>=>{
   if(busy)return undefined;busy=true;
   try{
    if(journal.status().pending){
     const batch=journal.status().archive.batches;
     let r=await journal.reconcile() as {resolved:boolean;abandoned?:boolean;receipt?:StockNativeReceipt};
     if(!r.resolved){
      if(sent&&now()-sent.at<sent.graceMs)return {blocked:'A submitted batch has no known outcome yet.'};
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
     inflight=[];inflightPadding=[];sent=undefined;
     if(r.receipt)return {txid:r.receipt.txid,batch};
    }
    const adopted=await adopt();if(adopted)return adopted;
    let short:EpochBatchKind|undefined;
    for(let i=0;i<KINDS.length;i++){
     const kind=KINDS[(lead+i)%KINDS.length]!;
     try{const ran=await run(kind);if(ran){if('txid' in ran)lead=(lead+i+1)%KINDS.length;return ran;}}catch(error){if((error as Error).message!=='padding')throw error;short??=kind;}
    }
    return short?{blocked:`Not enough padding ${short==='join'?'joins':'spends'}.`}:undefined;
   }finally{busy=false;}
  },
  close:()=>journal.close(),
 };
}
export type RollupEpochOperator=Awaited<ReturnType<typeof openRollupEpochOperator>>;
