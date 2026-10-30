import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs,{cpSync,existsSync,readFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {mock,test} from 'node:test';
import {hex} from '@scure/base';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState,type EpochAnchorRef,type EpochSlot} from '../packages/protocol/src/rollup/epoch.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {rotatesAt} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {openRollupEpochOperator,type RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupEpochPin,type RollupService,type RollupStatus} from '../src/rollup/service.ts';
import type {EncodedEpochSpend} from '../src/rollup/spend-store.ts';
import {epochHarness} from './fixtures/epoch.ts';
import {badProof,bakedPool,checkpoint,emulatorKey,epochRecord,exitDelay,hash,keySet,listen,offline,pendingOnDisk,proof,ready,scratch,serverKey,token,until} from './fixtures/epoch-service.ts';

const {deposit,dummyInput}=epochHarness(hash);
type Spend=Omit<RollupEpochSpend,'receivedAt'>;
type Pool=NonNullable<RollupStatus['pool']>;
const ONE='An epoch slot names exactly one of rCur, for a fast-path spend, and origin, for a recovery.',ROOT='An epoch slot names its anchor, not a root.',MALFORMED='Malformed epoch slot.';
const WHOLE='A recovery names its origin epoch as a whole number.',EXTERNAL="Expected a txid, and its batch record's slots unless it is followed chain-only.";

/** A wallet's spend anchored on (rPrev, rCur.root), with a real note record; a recovery names its origin in place of rCur. */
const spendOf=(rPrev:bigint,rCur:EpochAnchorRef,origin?:number):Spend=>{
 const ciphertext=randomBytes(ROLLUP_RECORD_BYTES),{slot,publicSignals}=deposit({nextAnchorRoot:()=>rPrev} as unknown as EpochState,0n,{ctDigest:ctDigestOf(ciphertext)},rCur),{rCur:_,...bare}=slot;
 return {id:randomBytes(16).toString('hex'),...(origin===undefined?{slot}:{slot:{...bare,origin},origin}),publics:publicSignals as unknown as Spend['publics'],proof,ciphertext};
};
const walletSpend=(pool:Pool)=>spendOf(BigInt(rotatesAt(pool.batches,pool.epochLen!)?pool.root:pool.prevNoteRoot!),{epoch:pool.epoch!,root:BigInt(pool.root)});
/** The body a Plan 5 wallet posts: decimal strings, slot.anchor, and exactly one of rCur and origin. */
const wire=(s:Spend):EncodedEpochSpend&{ciphertext:string}=>({id:s.id,slot:{anchor:String(s.slot.anchor),...(s.origin===undefined?{rCur:{epoch:s.slot.rCur!.epoch,root:String(s.slot.rCur!.root)}}:{origin:s.origin}),
 nullifiers:s.slot.nullifiers.map(String),commitments:[String(s.slot.commitments[0]),String(s.slot.commitments[1])],ctDigest:String(s.slot.ctDigest),groupId:String(s.slot.groupId),groupSize:s.slot.groupSize},
 publics:s.publics.map(String),proof:s.proof,ciphertext:hex.encode(s.ciphertext!)});
const recorded=(body:ReturnType<typeof wire>)=>({...body.slot,publics:body.publics,ciphertext:body.ciphertext});
const post=(request:Awaited<ReturnType<typeof listen>>,path:string,body:unknown)=>request(`/api/rollup${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const answer=async(response:Promise<Response>)=>{const r=await response;return [r.status,await r.json()];};
const batchesOf=(service:RollupService,from:number,limit:number)=>service.batches(from,limit).batches as unknown as RollupEpochRecord[];
const accepted=(pool:Pool)=>({batches:pool.batches,root:pool.root,prevNoteRoot:pool.prevNoteRoot,epoch:pool.epoch});

// Batch 128 rotates and archives epoch 0, so a recovery of epoch 0 rides it, or follows it once it has landed.
const openRiding=async()=>{const {net,service}=await bakedPool({epochLen:64,batches:128,record:epochRecord(64)});return {net,service,request:await listen(service),r0:BigInt(service.status().pool!.prevNoteRoot!)};};
let riding:ReturnType<typeof openRiding>|undefined;
const ridingPool=()=>riding??=openRiding();

test('an epoch pool admits a fast-path spend posted with anchor and rCur',async()=>{
 const {net,service,request}=await ridingPool(),body=wire(walletSpend(service.status().pool!));
 assert.deepEqual(await answer(post(request,'/spends',body)),[202,{id:body.id,status:'pending'}]);
 await until('the spend lands',()=>service.spend(body.id)?.status==='included',net);
 const [record]=batchesOf(service,service.spend(body.id)!.batch!,1);
 assert.deepEqual([record!.kind,record!.slots.find(s=>s.nullifiers[0]===body.slot.nullifiers[0])],['spend',recorded(body)]);
});

test('an epoch pool admits a recovery posted with origin and no rCur',async()=>{
 const {net,service,request,r0}=await ridingPool(),body=wire(spendOf(r0,{epoch:0,root:r0},0)),{batches,erCount}=service.status().pool!;
 assert.deepEqual([batches,erCount],[129,2],'the spend above landed rotating batch 128, so epoch 0 is archived rather than riding');
 assert.deepEqual(await answer(post(request,'/spends',body)),[202,{id:body.id,status:'pending'}]);
 await until('the recovery lands',()=>service.spend(body.id)?.status==='included',net);
 const [record]=batchesOf(service,service.spend(body.id)!.batch!,1);
 assert.deepEqual([record!.kind,record!.slots],['recover',[recorded(body)]]);
});

test('a body with both rCur and origin, with neither, or with slot.root is a named 400',async()=>{
 const {service,request}=await ridingPool(),good=wire(walletSpend(service.status().pool!)),{rCur,...bare}=good.slot;
 const refused:[string,unknown,string][]=[['both',{...good.slot,origin:0},ONE],['neither',bare,ONE],['a root',{...good.slot,root:good.slot.anchor},ROOT],
  ['a fractional origin',{...bare,origin:0.5},WHOLE],['a negative origin',{...bare,origin:-1},WHOLE],['an origin in quotes',{...bare,origin:'0'},WHOLE],
  ['a window leaf without its root',{...good.slot,rCur:{epoch:rCur!.epoch}},'Expected a decimal field element.'],['no slot',undefined,MALFORMED]];
 for(const [label,slot,error] of refused)assert.deepEqual(await answer(post(request,'/spends',{...good,slot})),[400,{error}],label);
});

/** A third-party prover and two followers at one baked state; the prover lands a spend, a join, and a recover batch riding the rotation at 128. */
const openThirdParty=async()=>{
 const prover=scratch('rollup-epoch-prover-');let copy='';
 const {net,directory,service:withSlots}=await bakedPool({epochLen:64,batches:126,record:epochRecord(64),prepare:({directory})=>{
  copy=scratch('rollup-epoch-chain-only-');cpSync(directory,copy,{recursive:true});cpSync(join(directory,'operator','batches'),join(prover,'batches'),{recursive:true});
 }});
 const chainOnly=await ready(net,copy,join(copy,'keys')),genesis=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8'));
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json')),stub={prove:async()=>proof};
 const x=await openRollupEpochOperator({directory:prover,epochLen:64,genesis:genesis.archive,leaves,token,serverKey:hex.decode(serverKey),emulatorKey:hex.decode(emulatorKey),exitDelay,checkpoint,hash,
  pin:rollupEpochPin({leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:genesis.txid,serverKey,emulatorKey}),
  clientKey:{spend:{},join:{},recover:{}},prover:{spend:stub,join:stub,recover:stub},transport:net.transport,signDeposits:async()=>undefined,verify:async()=>true,batchWaitMs:0,joinWaitMs:0});
 const views:ReturnType<typeof accepted>[]=[],lift=(w:{slot:EpochSlot;publicSignals:bigint[]}):Spend=>({id:randomBytes(8).toString('hex'),slot:w.slot,publics:w.publicSignals as unknown as Spend['publics'],proof});
 const land=async(client:Spend,pad?:()=>Spend)=>{
  await x.submit(client);
  if(pad)x.addPadding(Array.from({length:BATCH_SLOTS-1},()=>({...pad(),receivedAt:Infinity})));
  assert.ok('txid' in (await x.tick())!);
  const s=x.status();views.push({batches:s.archive.batches,root:String(s.acceptedRoot),prevNoteRoot:String(s.acceptedPrevNoteRoot),epoch:s.acceptedEpoch});
 };
 const fast=()=>lift(deposit(x.state,0n)),pair=()=>lift(deposit(x.state,0n,{inputs:[dummyInput(),dummyInput()]}));
 await land(spendOf(x.state.nextAnchorRoot(),{epoch:x.state.epoch,root:x.state.latestRoot()}),fast);
 await land(pair(),pair);
 // Admitted with rCur beside origin, as the harness's recovery() builds it; the record must name origin alone.
 const both=spendOf(x.state.prevNoteRoot,{epoch:0,root:x.state.prevNoteRoot},0);
 await land({...both,slot:{...both.slot,rCur:{epoch:0,root:x.state.prevNoteRoot}}});
 x.close();
 return {withSlots,chainOnly,views,records:views.map((_,i)=>JSON.parse(readFileSync(join(prover,'batches',`${126+i}.json`),'utf8')) as RollupEpochRecord),
  requests:{withSlots:await listen(withSlots),chainOnly:await listen(chainOnly)}};
};
let thirdParty:ReturnType<typeof openThirdParty>|undefined;
const thirdPartyPools=()=>thirdParty??=openThirdParty();

test('/external refuses a batch the indexer does not show spending the pool head',async()=>{
 const {withSlots,records:[,second],requests}=await thirdPartyPools(),batches=withSlots.status().pool!.batches;
 assert.deepEqual(await answer(post(requests.withSlots,'/external',{txid:second!.txid})),[400,{error:"That transaction has not spent this pool's head."}],'the batch before it spent the head');
 assert.equal(withSlots.status().pool!.batches,batches);
});

test('/external follows a third-party epoch batch from its slots, for all three kinds',async()=>{
 const {withSlots,views,records,requests}=await thirdPartyPools();
 assert.deepEqual(records.map(r=>r.kind),['spend','join','recover']);
 for(const [i,record] of records.entries()){
  const slots=record.slots.map(({publics:_,...slot})=>slot);
  assert.deepEqual(await answer(post(requests.withSlots,'/external',{txid:record.txid,slots})),[200,{batch:126+i,txid:record.txid}],record.kind);
  assert.deepEqual(accepted(withSlots.status().pool!),views[i],record.kind);
  assert.deepEqual({...batchesOf(withSlots,126+i,1)[0],at:0},{...record,at:0},`the ${record.kind} record is the prover's`);
 }
});

test('a recover record the pool wrote round-trips through the /external parser',async()=>{
 const {records:[,,recover]}=await thirdPartyPools(),slots=recover!.slots.map(({publics:_,...slot})=>slot);
 const echo=await listen({ready:()=>true,external:async(_txid:string,parsed:unknown)=>parsed} as unknown as RollupService);
 assert.deepEqual(await answer(post(echo,'/external',{txid:recover!.txid,slots})),[200,slots]);
});

test('/external with no slots follows the same batch chain-only',async()=>{
 const {chainOnly,views,records,requests}=await thirdPartyPools();
 for(const [i,{txid}] of records.entries()){
  assert.deepEqual(await answer(post(requests.chainOnly,'/external',{txid})),[200,{batch:126+i,txid}]);
  assert.deepEqual(accepted(chainOnly.status().pool!),views[i],'the accepted root and prevNoteRoot move on this path too');
 }
 assert.ok(batchesOf(chainOnly,126,3).every(r=>r.slots.every(s=>s.commitments.every(c=>c==='0'))),'with no record there is no opening to keep');
});

test('/external refuses an empty slots list, where only an omitted one follows chain-only',async()=>{
 const echo=await listen({ready:()=>true,external:async(_txid:string,parsed:unknown)=>parsed} as unknown as RollupService);
 assert.deepEqual(await answer(post(echo,'/external',{txid:'ab'.repeat(32),slots:[]})),[400,{error:EXTERNAL}]);
});

test('/external on an epoch pool answers a named 400, never a raw TypeError message',async()=>{
 const {withSlots,records:[record],requests}=await thirdPartyPools(),txid=record!.txid,batches=withSlots.status().pool!.batches;
 const slots=record!.slots.map(({publics:_,...slot})=>slot),[slot]=slots;
 const refused:[string,unknown,string][]=[
  ['a classic record, with roots and no anchors',{txid,slots:slots.map(({anchor,rCur:_,...s})=>({...s,root:anchor}))},ROOT],
  ['slots that are not a list',{txid,slots:{}},EXTERNAL],['eleven slots',{txid,slots:Array(11).fill(slot)},EXTERNAL],['no txid',{slots},EXTERNAL],
  ['a slot that is not an object',{txid,slots:[null]},MALFORMED],['a slot that spends three notes',{txid,slots:[{...slot,nullifiers:['1','2','3']}]},MALFORMED],
  ['a slot with both rCur and origin',{txid,slots:[{...slot,origin:0}]},ONE],['a note record of the wrong size',{txid,slots:[{...slot,ciphertext:'00'}]},'Expected lowercase hex of the right length.']];
 for(const [label,body,error] of refused)assert.deepEqual(await answer(post(requests.withSlots,'/external',body)),[400,{error}],label);
 assert.equal(withSlots.status().pool!.batches,batches,'none of them was followed');
});

test('an epoch spend survives a restart and is re-admitted',async()=>{
 const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-epoch-readmit-');
 // Nine pads at 2 s each: the spend is still waiting for its batch when the service stops.
 net.delay(2000);
 const first=await ready(net,directory,keys,'64'),body=wire(walletSpend(first.status().pool!));
 assert.deepEqual(await answer(post(await listen(first),'/spends',body)),[202,{id:body.id,status:'pending'}]);
 assert.deepEqual([first.status().pool!.batches,first.spend(body.id)],[0,{status:'pending'}]);
 first.close();net.delay(0);
 const service=await ready(net,directory,keys);
 assert.deepEqual(service.spend(body.id),{status:'pending'},'re-admitted, not dropped');
 await until('the re-admitted spend lands',()=>service.spend(body.id)?.status==='included',net);
 assert.deepEqual(batchesOf(service,0,1)[0]!.slots.find(s=>s.nullifiers[0]===body.slot.nullifiers[0]),recorded(body));
});

test('a stored epoch spend whose anchor died in a rotation is dropped with a reason, not re-admitted',async()=>{
 const {net,directory,service:first}=await bakedPool({epochLen:64,batches:63,record:epochRecord(64)});
 const [landed,died]=[0,1].map(()=>walletSpend(first.status().pool!)) as [Spend,Spend];
 await first.submit(landed);
 await until('the batch that ends epoch 0 lands',()=>first.status().pool!.batches===64,net);
 first.close();
 pendingOnDisk(directory,landed,died);
 const service=await ready(net,directory,join(directory,'keys')),{status,reason}=service.spend(died.id)!;
 assert.deepEqual([service.spend(landed.id),status,service.status().pool!.pending],[{status:'included'},'dropped',0]);
 assert.match(reason!,/^It could not be re-admitted after the pool restarted: The spend opens against another previous-epoch root/);
});

test('an unproven recovery loads no archive file',async()=>{
 const record=epochRecord(64),replica=EpochState.genesis(hash,64,false);
 for(let n=0;n<129;n++){const r=record(n);replica.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));}
 const {net,directory,service:first}=await bakedPool({epochLen:64,batches:129,record,committed:replica.commitment()});
 await until('the snapshot is written',()=>existsSync(join(directory,'operator','snapshot.bin')),net);
 first.close();
 // Reopened from the snapshot, epoch 0's frozen set is on disk only.
 const service=await ready(net,directory,join(directory,'keys')),request=await listen(service),r0=replica.archive.record(0)!.noteFinal,body=wire(spendOf(r0,{epoch:0,root:r0},0));
 const reads=mock.method(fs,'readFileSync'),loaded=()=>reads.mock.calls.filter(c=>String(c.arguments[0]).startsWith(join(directory,'operator','nullifiers'))).length;
 syncBuiltinESMExports();
 try{
  assert.deepEqual([...await answer(post(request,'/spends',{...body,proof:badProof})),loaded()],[400,{error:'Invalid client proof.'},0]);
  assert.deepEqual([...await answer(post(request,'/spends',body)),loaded()],[202,{id:body.id,status:'pending'},1],'once proven, it loads the one file it needs');
 }finally{reads.mock.restore();syncBuiltinESMExports();}
});
