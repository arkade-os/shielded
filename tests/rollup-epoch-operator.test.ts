import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {asset,CSVMultisigTapscript,Extension,MultisigTapscript,scriptFromTapLeafScript,SingleKey,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {ARCHIVE_DEPTH,BATCH_SLOTS,ROLLUP_DOMAIN,ROLLUP_FIELD,RollupRejection,type RejectionCode} from '../packages/protocol/src/rollup/constants.ts';
import {anchorOf,EpochState,type EpochSlot} from '../packages/protocol/src/rollup/epoch.ts';
import {EPOCH_DERIVED_FIELDS,epochBatchInput} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {assetFieldOfId,destinationFieldOf,statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {openRollupEpochOperator,slotOf,type RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {headCommitment} from '../src/rollup/epoch-snapshot.ts';
import {readBatchTx,readEpochBatchTx} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import type {RollupTransport} from '../src/rollup/operator.ts';
import {rollupSpecOf} from '../src/rollup/service.ts';
import type {StockWireRequest} from '../src/stock/transport.ts';
import {epochHarness,rejection} from './fixtures/epoch.ts';
import {executeVmBinary,offlineNativeFixture} from './fixtures/native.ts';

const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const {deposit,dummyInput,noteFrom,recovery}=epochHarness(hash);
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-epoch-covenant-snarkjs.json','utf8')) as {clientKey:{vk_delta_2:unknown;IC:unknown[]};batchKey:{vk_delta_2:unknown;IC:unknown[]};oldPacket:string;newPacket:string;slots:{proof:SnarkProof;publicSignals:string[]}[];batch:{proof:SnarkProof}};
const token=asset.AssetId.create('cc'.repeat(32),0).toString(),x=asset.AssetId.create('dd'.repeat(32),0).toString();
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const le32=(value:bigint)=>Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
// Only the recover leaf carries the fixture's real keys; the others are shared-setup stand-ins, as tools/vm/rollup_leaves_test.go:109 builds them.
const leaves=await (async()=>{
 const {clientKey,batchKey}=fixture,dir=mkdtempSync(join(tmpdir(),'rollup-epoch-keys-'));
 const wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 const keys={'epoch-spend':clientKey,'epoch-join':{...clientKey,vk_delta_2:batchKey.vk_delta_2},'epoch-batch-spend':wide,'epoch-batch-join':wide,'epoch-batch-recover':batchKey};
 mkdirSync(join(dir,'keys'));
 for(const [name,key] of Object.entries(keys))writeFileSync(join(dir,'keys',`${name}.vkey.json`),JSON.stringify(key));
 writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf('epoch',token,'aa'.repeat(32))));
 try{return await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));}finally{rmSync(dir,{recursive:true,force:true});}
})();
const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
const exitDelay={type:'seconds' as const,value:2048},pool=rollupEpochPoolTree(server,emulator,leaves,exitDelay);
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
const wire=(built:ReturnType<typeof buildRollupBatchTx>):StockWireRequest=>({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))});
/** The fixture's real recover batch, built in TypeScript on a head that carries its old packet, spent through `leaf`. */
const fixtureRecover=(leaf:Uint8Array)=>{
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]),[slot]=fixture.slots;
 return buildRollupBatchTx({kind:'recover',head:{txid:parent.id,vout:0,value:100_330,sourceTx:parent.toBytes(),tapTree:pool.tree.encode(),leaf:pool.tree.findLeaf(hex.encode(leaf))},deposits:[],legs:[{deposit:0n,withdraw:0n,asset:false}],token,leaves,
  witness:rollupWitness(fixture.batch.proof,[{proof:slot!.proof,publics:slot!.publicSignals.map(BigInt)}]),newPacket:hex.decode(fixture.newPacket),checkpoint});
};

const proof:SnarkProof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1']};
type Spend=Omit<RollupEpochSpend,'receivedAt'>;
let ids=0;
const spendOf=(w:{slot:EpochSlot;publicSignals:bigint[]},extra:Partial<Spend>={}):Spend=>({id:`s${++ids}`,slot:w.slot,publics:w.publicSignals as unknown as Spend['publics'],proof,...extra});
const fastSpend=(s:EpochState)=>spendOf(deposit(s,0n));
const joinSpend=(s:EpochState)=>spendOf(deposit(s,0n,{inputs:[dummyInput(),dummyInput()]}));
const recoverSpend=(s:EpochState,origin:number,note:Parameters<typeof recovery>[2])=>spendOf(recovery(s,origin,note),{origin});
const reanchored=(s:Spend,anchor:bigint):Spend=>{const slot={...s.slot,anchor};return {...s,slot,publics:[statementOf(hash,{domain:ROLLUP_DOMAIN,...slot,root:anchor}),...s.publics.slice(1)] as unknown as Spend['publics']};};
const padsFor=(s:EpochState,kind:'spend'|'join',count:number)=>Array.from({length:count},()=>({...(kind==='join'?joinSpend(s):fastSpend(s)),receivedAt:Infinity}));

async function world(epochLen:number){
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-operator-')),landed:StockWireRequest[]=[];
 const depositor=SingleKey.fromHex('03'.repeat(32)),userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
 const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
 const packet=Uint8Array.from([...le32(EpochState.genesis(hash,epochLen).commitment()),...le32(0n),...le32(0n)]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:1000n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,packet)]);
 const coin=(vout:number):RollupCoin=>({txid:parent.id,vout,value:Number(parent.getOutput(vout).amount),sourceTx:parent.toBytes(),tapTree:userTree.encode(),leaf:userTree.findLeaf(hex.encode(userCollab))});
 // Stub proofs cannot pass the covenant, so this network takes whatever it is sent; the real recover leaf has its own test.
 const transport:RollupTransport={
  submit:async request=>{landed.push(request);return {txid:Transaction.fromPSBT(base64.decode(request.arkTx)).id,checkpointTxids:request.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:request.arkTx,signedCheckpointTxs:request.checkpoints,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};},
  lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,
 };
 const signDeposits=async(request:StockWireRequest,spends:RollupEpochSpend[])=>{
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-spends.length,signed=await depositor.sign(ark,spends.map((_,i)=>first+i));
  const checkpoints=await Promise.all(request.checkpoints.map(async(encoded,vin)=>vin<first?encoded:base64.encode((await depositor.sign(Transaction.fromPSBT(base64.decode(encoded)),[0])).toPSBT())));
  return {arkTx:base64.encode(signed.toPSBT()),checkpoints};
 };
 const stub={prove:async()=>proof};
 const options={directory:dir,epochLen,hash,leaves,token,serverKey:server,emulatorKey:emulator,exitDelay,checkpoint,transport,signDeposits,batchWaitMs:0,joinWaitMs:0,
  pin:{version:1 as const,network:'local-stock' as const,descriptorProfileId:sha('rollup-epoch-test'),programsHash:sha(leaves.batchRecover),artifactsHash:sha('stub'),checkpointHash:sha(checkpoint.script),genesisTxid:parent.id,serverKey:hex.encode(server),emulatorKey:hex.encode(emulator)},
  genesis:{version:1 as const,head:{txid:parent.id,vout:0,value:100_330,sourceTxHex:hex.encode(parent.toBytes())},reserves:{},batches:0},
  clientKey:{spend:{},join:{},recover:{}},prover:{spend:stub,join:stub,recover:stub},verify:async()=>true};
 return {dir,landed,coin,transport,open:async(t:TestContext,overrides:Partial<Parameters<typeof openRollupEpochOperator>[0]>={})=>{const op=await openRollupEpochOperator({...options,...overrides});t.after(()=>op.close());return op;}};
}
type World=Awaited<ReturnType<typeof world>>;
type Operator=Awaited<ReturnType<typeof openRollupEpochOperator>>;
const recordAt=(w:World,n:number)=>JSON.parse(readFileSync(join(w.dir,'batches',`${n}.json`),'utf8')) as RollupEpochRecord;
const landedTx=(w:World,n:number)=>({tx:Transaction.fromPSBT(base64.decode(w.landed[n]!.arkTx)),checkpoints:w.landed[n]!.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)))});
const acceptedOf=(s:EpochState)=>({acceptedRoot:s.latestRoot(),acceptedPrevNoteRoot:s.prevNoteRoot,acceptedEpoch:s.epoch,acceptedErCount:s.archive.count(),acceptedRsCount:s.recovered.count(),acceptedNullifiers:s.nullifiers.count()});

/** Admits the clients, pads their batch with slots proved against the anchor it opens with, and lands it. */
async function land(op:Operator,kind:'spend'|'join'|'recover',clients:Spend[]){
 for(const s of clients)await op.submit(s);
 if(kind!=='recover')op.addPadding(padsFor(op.state,kind,BATCH_SLOTS-clients.length));
 const tick=await op.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
}
const KINDS=['spend','join','spend','spend','recover'] as const;
/** epochLen 2: a deposit mints a note in epoch 0, and batch 4 rotates, archiving epoch 0, and recovers that note. */
async function history(w:World,op:Operator){
 const minted=deposit(op.state,1000n),note=noteFrom(minted);
 await land(op,'spend',[spendOf(minted,{coin:w.coin(1)})]);
 await land(op,'join',[joinSpend(op.state)]);
 for(let n=0;n<2;n++)await land(op,'spend',[fastSpend(op.state)]);
 await land(op,'recover',[recoverSpend(op.state,0,note)]);
 return note;
}

test('the operator builds a spend, a join and a recover batch, each through its own leaf',async t=>{
 const w=await world(2),op=await w.open(t),note=await history(w,op);
 const leafOf={spend:[leaves.batch,pool.batch],join:[leaves.batchJoin,pool.batchJoin],recover:[leaves.batchRecover,pool.batchRecover]};
 KINDS.forEach((kind,n)=>{
  const {tx}=landedTx(w,n),[program,collab]=leafOf[kind];
  assert.equal(recordAt(w,n).kind,kind);
  assert.deepEqual(Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.script,program,`batch ${n} names its kind's program`);
  assert.deepEqual(scriptFromTapLeafScript(tx.getInput(0).tapLeafScript![0]!),collab,`batch ${n} spends the head through its kind's leaf`);
 });
 assert.equal(recordAt(w,4).slots.length,1);
 assert.deepEqual([op.state.epoch,op.state.recovered.has(note.nullifier),op.status().archive.head.value],[2,true,101_330]);
});

test('each batch is proved from its circuit input, which carries no field the circuit derives',async t=>{
 const proved:{kind:string;input:Record<string,unknown>;expected:readonly bigint[]}[]=[];
 const recording=(kind:string)=>({prove:async(input:Record<string,unknown>,expected:readonly bigint[])=>{proved.push({kind,input,expected});return proof;}});
 const w=await world(2),op=await w.open(t,{prover:{spend:recording('spend'),join:recording('join'),recover:recording('recover')}});
 await history(w,op);
 assert.deepEqual(proved.map(p=>p.kind),[...KINDS]);
 const mirror=EpochState.genesis(hash,2,false);
 proved.forEach(({kind,input,expected},n)=>{
  const record=recordAt(w,n),{witness,publicSignals}=mirror.apply(record.kind,record.slots.map(slotOf));
  for(const field of EPOCH_DERIVED_FIELDS)assert.equal(field in input,false,`batch ${n} (${kind}) hands the prover ${field}`);
  assert.deepEqual([input,expected],[epochBatchInput(witness),publicSignals],`batch ${n} (${kind}) proves exactly the circuit input of its statement`);
 });
});

test('a recover batch built in TypeScript is accepted by the real recover leaf',async()=>{
 const accepted=await executeVmBinary(DEFAULT_VM_BINARY,wire(fixtureRecover(pool.batchRecover)));
 assert.equal(accepted.ok,true,accepted.error);
 const misrouted=await executeVmBinary(DEFAULT_VM_BINARY,wire(fixtureRecover(pool.batch)));
 assert.equal(misrouted.ok,false,'the same batch spent through the spend leaf is refused');
});

test('admission refuses every recover submission the policy forbids',async t=>{
 let verified=0;
 const w=await world(2),op=await w.open(t,{verify:async()=>{verified++;return true;}}),minted=deposit(op.state,1000n),spentNote=noteFrom(minted);
 await land(op,'spend',[spendOf(minted,{coin:w.coin(1)})]);
 const moved=deposit(op.state,1000n,{inputs:[spentNote],deposit:0n}),note=noteFrom(moved),nextSpent=noteFrom(moved,1);
 await land(op,'spend',[spendOf(moved)]);
 await land(op,'spend',[spendOf(deposit(op.state,0n,{inputs:[nextSpent]}))]);
 await land(op,'spend',[fastSpend(op.state)]);
 const unsound=():[string,Spend,RejectionCode][]=>[
  ['a note its epoch already spent',recoverSpend(op.state,0,spentNote),'double-spend'],
  ['a note the next epoch spent',recoverSpend(op.state,0,nextSpent),'double-spend'],
  ['an anchor that opens another tree',reanchored(recoverSpend(op.state,0,note),anchorOf(hash,op.state.latestRoot(),op.state.latestRoot())),'stale-anchor'],
 ];
 assert.deepEqual([op.state.epoch,op.state.archive.has(0),op.state.rotatesNext()],[1,false,true]);
 const checked=verified;
 for(const [label,spend,code] of unsound())await assert.rejects(op.submit({...spend,id:label}),rejection(code),`${label}, riding the rotation`);
 assert.equal(verified,checked,'a riding refusal costs no proof check');
 await land(op,'spend',[fastSpend(op.state)]);
 assert.deepEqual([op.state.epoch,op.state.archive.has(0),op.state.rotatesNext()],[2,true,false]);
 for(const [label,spend,code] of unsound())await assert.rejects(op.submit({...spend,id:label}),rejection(code),label);
 const good=recoverSpend(op.state,0,note),[nf]=good.slot.nullifiers,program=new Uint8Array(32).fill(0x52);
 const publics=(at:Record<number,bigint>)=>good.publics.map((p,i)=>at[i]??p) as unknown as Spend['publics'],from=(origin:number)=>({...good,origin,slot:{...good.slot,origin}});
 const refused:[string,Spend,RegExp][]=[
  ['two nullifiers',{...good,slot:{...good.slot,nullifiers:[nf!,nf!+1n]}},/one note/],
  ['a deposit coin',{...good,publics:publics({3:1000n}),coin:w.coin(1)},/carries no deposit/],
  ['an asset',{...good,publics:publics({5:assetFieldOfId(x)}),asset:x},/carries no deposit/],
  ['a withdrawal with a program',{...good,publics:publics({4:1000n,6:destinationFieldOf(program)}),program},/carries no deposit/],
  ['a group',{...good,slot:{...good.slot,groupId:7n,groupSize:2}},/never part of a group/],
  ['a slot that names no origin',{...good,slot:{...good.slot,origin:undefined}},/names an origin/],
  ['an unarchived origin',from(9),/not archived/],
  ['the previous, live epoch',from(1),/not archived/],
  ['the current epoch',from(2),/not archived/],
 ];
 for(const [label,spend,reason] of refused)await assert.rejects(op.submit({...spend,id:label}),reason,label);
 assert.deepEqual(op.pendingIds(),[],'nothing was admitted');
 // The lead is on join, so the recover lane runs before the spend lane: an admitted unsound recovery would throw first.
 await land(op,'spend',[fastSpend(op.state)]);
 await op.submit(good);
 assert.deepEqual(op.pendingIds(),[good.id]);
});

const undoneDuringVerify=(spentAt:1|2)=>async(t:TestContext)=>{
 const w=await world(2),gate=()=>{let open=()=>{};return {shut:new Promise<void>(r=>{open=r;}),open:()=>open()};};
 let proving:ReturnType<typeof gate>|undefined,checking:ReturnType<typeof gate>|undefined;
 const prover={prove:async()=>{if(proving){await proving.shut;throw new Error('prover down');}return proof;}};
 const op=await w.open(t,{prover:{spend:prover,join:prover,recover:prover},verify:async()=>{await checking?.shut;return true;}});
 const minted=deposit(op.state,1000n),note=noteFrom(minted);
 await land(op,'spend',[spendOf(minted,{coin:w.coin(1)})]);
 // Batch 2 opens epoch 1, so a note spent at batch 1 is spent in its own epoch and one spent at batch 2 in the next.
 for(let n=1;n<4;n++)await land(op,'spend',[n===spentAt?spendOf(deposit(op.state,1000n,{inputs:[note],deposit:0n})):fastSpend(op.state)]);
 assert.deepEqual([op.state.epoch,op.state.rotatesNext(),op.state.prevNfSet.has(note.nullifier),op.state.nullifiers.has(note.nullifier)],[1,true,spentAt===1,spentAt===2],'the note is spent in its own epoch or the next, and the next batch rotates');
 await op.submit(fastSpend(op.state));op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));
 proving=gate();
 const ticking=op.tick();
 for(let i=0;i<1000&&!op.state.archive.has(0);i++)await new Promise(r=>setImmediate(r));
 assert.ok(op.state.archive.has(0),'the rotating batch is applied while its proof is held');
 checking=gate();
 const admitting=op.submit(recoverSpend(op.state,0,note));
 proving.open();
 await assert.rejects(ticking,/prover down/);
 assert.deepEqual([op.state.archive.has(0),op.state.rotatesNext()],[false,true],'the rotation was undone while the recovery waited');
 checking.open();
 await assert.rejects(admitting,rejection('double-spend'));
};
test('a recovery admitted against an in-flight rotation that is undone during its proof check still meets the riding double-spend check',undoneDuringVerify(1));
test('the riding double-spend check after an undone rotation also covers a note the next epoch spent',undoneDuringVerify(2));

test('admission refuses a fast-path slot apply would refuse, with a rejection rather than a crash',async t=>{
 const w=await world(2),op=await w.open(t),first=fastSpend(op.state);
 await land(op,'spend',[first]);
 for(let n=0;n<2;n++)await land(op,'spend',[fastSpend(op.state)]);
 const good=fastSpend(op.state),{rCur:_,...bare}=good.slot,respent={...good.slot,nullifiers:[first.slot.nullifiers[0]!]};
 const cases:[string,Spend,RejectionCode][]=[
  ['no rCur',{...good,slot:bare},'window-tag'],
  ['an rCur without a root',{...good,slot:{...good.slot,rCur:{epoch:op.state.epoch} as never}},'slot-shape'],
  ['a stale anchor',{...good,slot:{...good.slot,anchor:good.slot.anchor+1n}},'stale-anchor'],
  ['a note the previous epoch spent',{...good,slot:respent,publics:[statementOf(hash,{domain:ROLLUP_DOMAIN,...respent,root:respent.anchor}),...good.publics.slice(1)] as unknown as Spend['publics']},'double-spend'],
 ];
 for(const [label,spend,code] of cases)await assert.rejects(op.submit({...spend,id:label}),rejection(code),label);
 assert.throws(()=>op.addPadding([{...good,slot:bare,receivedAt:Infinity}]),/window leaf/);
 await op.submit(good);
 assert.deepEqual(op.pendingIds(),[good.id]);
});

test('admission checks a double-spend before the anchor, so stale-anchor never hides a landed copy',async t=>{
 const w=await world(2),op=await w.open(t),first=fastSpend(op.state);
 await land(op,'spend',[first]);
 for(const where of ['its own epoch','the epoch after']){
  await land(op,'spend',[fastSpend(op.state)]);
  const twin={...first,slot:{...first.slot,nullifiers:fastSpend(op.state).slot.nullifiers}};
  await assert.rejects(op.submit(twin),rejection('stale-anchor'),`${where}: the anchor has moved on`);
  await assert.rejects(op.submit(first),rejection('double-spend'),`${where}: the spend landed`);
 }
});

test('a pad whose rCur has no root is refused once, and the next tick still builds a batch',async t=>{
 const w=await world(2),op=await w.open(t),good=fastSpend(op.state);
 const bad:[string,unknown][]=[['no root',{epoch:0}],['a root outside the field',{epoch:0,root:ROLLUP_FIELD}],['a fractional epoch',{epoch:0.5,root:1n}]];
 for(const [label,rCur] of bad){
  const slot={...good.slot,rCur:rCur as never};
  await assert.rejects(op.submit({...good,id:label,slot}),rejection('slot-shape'),label);
  assert.throws(()=>op.addPadding([{...good,slot,receivedAt:Infinity}]),rejection('slot-shape'),label);
 }
 assert.deepEqual([op.padding(),op.pending()],[0,0]);
 await land(op,'spend',[good]);
});

test('the padding queue is empty immediately after the rotating batch is accepted, not one tick later',async t=>{
 const w=await world(2),drops:[string[],string][]=[],seen:[boolean,number][]=[];
 let op!:Operator;
 const probe={prove:async()=>{seen.push([op.state.rotatesNext(),op.padding()]);return proof;}};
 op=await w.open(t,{prover:{spend:probe,join:probe,recover:probe},onDrop:(ids,reason)=>drops.push([ids,reason])});
 op.addPadding([...padsFor(op.state,'spend',3),...padsFor(op.state,'join',3)]);
 await land(op,'spend',[fastSpend(op.state)]);
 assert.deepEqual([op.padding('spend'),op.padding('join'),drops],[3,3,[]],'a batch that ends no epoch leaves the queues be');
 await land(op,'spend',[fastSpend(op.state)]);
 assert.deepEqual(seen,[[false,6],[true,0]],'the queue was already empty while the epoch\'s last batch was being proved');
 assert.deepEqual([op.padding('spend'),op.padding('join'),drops.flatMap(([ids])=>ids).length],[0,0,6]);
 for(const [,reason] of drops)assert.match(reason,/rotation/);
});

test('an epoch-ending batch whose proof fails is undone with the pads it took, and lands on the next tick',async t=>{
 const w=await world(2);
 let fail=false;
 const stub={prove:async()=>{if(fail){fail=false;throw new Error('prover down');}return proof;}};
 const op=await w.open(t,{prover:{spend:stub,join:stub,recover:stub}});
 await land(op,'spend',[fastSpend(op.state)]);
 await op.submit(fastSpend(op.state));op.addPadding([...padsFor(op.state,'spend',BATCH_SLOTS-1+4),...padsFor(op.state,'join',3)]);
 fail=true;
 await assert.rejects(op.tick(),/prover down/);
 assert.deepEqual([op.state.rotatesNext(),op.padding('spend'),op.pending()],[false,BATCH_SLOTS-1,1],'the flush at apply time is lost, but not the pads the batch took');
 const again=await op.tick();
 assert.ok(again&&'txid' in again,JSON.stringify(again));
});

test('a receipt the operator cannot read leaves the accepted view at the last accepted batch',async t=>{
 const w=await world(2),op=await w.open(t,{transport:{...w.transport,submit:async(request,first)=>({...await w.transport.submit(request,first),signedArkTx:'not a psbt'})}});
 await op.submit(fastSpend(op.state));op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));
 assert.deepEqual(Object.keys((await op.tick())!),['blocked']);
 assert.deepEqual(op.status(),{...op.status(),...acceptedOf(EpochState.genesis(hash,2,false))});
});

test('a rotation drops every stale in-flight spend and pad with a reason, and the next batch lands',async t=>{
 const drops:[string[],string][]=[],w=await world(64),op=await w.open(t,{onDrop:(ids,reason)=>drops.push([ids,reason])});
 for(let n=0;n<63;n++)await land(op,'spend',[fastSpend(op.state)]);
 // Proved before batch 63 closes epoch 0: one spend more than the batch takes, and spare pads.
 const clients=Array.from({length:BATCH_SLOTS+1},()=>fastSpend(op.state)),spare=padsFor(op.state,'spend',BATCH_SLOTS-1);
 for(const s of clients)await op.submit(s);
 op.addPadding(spare);
 assert.ok('txid' in (await op.tick())!);
 assert.deepEqual([op.state.rotatesNext(),op.pendingIds(),op.padding()],[true,[clients.at(-1)!.id],0]);
 const next=fastSpend(op.state);
 await op.submit(next);op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));
 assert.equal((await op.tick() as {batch:number}).batch,64);
 assert.equal(op.state.epoch,1);
 assert.deepEqual(drops.flatMap(([ids])=>ids).sort(),[clients.at(-1)!.id,...spare.map(s=>s.id)].sort());
 for(const [,reason] of drops)assert.match(reason,/rotation/);
 assert.ok(recordAt(w,64).slots.some(s=>s.nullifiers[0]===String(next.slot.nullifiers[0])));
});

test('every batch is refused once the epoch archive is full',async t=>{
 const w=await world(4),op=await w.open(t);
 for(let n=0;n<5;n++)await land(op,'spend',[fastSpend(op.state)]);
 await op.submit(fastSpend(op.state));op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));
 await op.submit(joinSpend(op.state));op.addPadding(padsFor(op.state,'join',BATCH_SLOTS-1));
 await op.submit(recoverSpend(op.state,-1,dummyInput()));
 const head=op.status().archive.head;
 // Batches 5 to 7 do not rotate, so without the guard the model would let each kind through.
 op.state.archive.count=()=>2**ARCHIVE_DEPTH;
 for(let n=0;n<3;n++)await assert.rejects(op.tick(),(error:unknown)=>error instanceof RollupRejection&&error.code==='archive-full'&&/archive is full/.test(error.message));
 assert.deepEqual([op.status().archive.head,op.pending()],[head,3]);
});

test('a followed batch reproduces the state the transaction committed to, for all three kinds',async t=>{
 const w=await world(2),a=await w.open(t);
 await history(w,a);
 assert.deepEqual(a.status(),{...a.status(),...acceptedOf(a.state)},'a batch the operator landed is accepted');
 const withRecords=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-follower-'))}),chainOnly=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-chain-'))});
 const recover=landedTx(w,4),record=recordAt(w,4),mirror=EpochState.genesis(hash,2,false);
 for(let n=0;n<KINDS.length;n++){
  if(n===4)await assert.rejects(withRecords.follow({...recover,slots:record.slots.map(s=>({...s,origin:1})),at:1}),/not archived|anchor/,'a recover record naming another origin');
  const landed=recordAt(w,n);
  mirror.applyFromChain(landed.kind,landed.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(landed.noteBlockRoot));
  for(const b of [withRecords,chainOnly]){
   assert.deepEqual(await b.follow({...landedTx(w,n),...(b===withRecords?{slots:recordAt(w,n).slots}:{}),at:1}),{batch:n,txid:landedTx(w,n).tx.id});
   assert.equal(headCommitment(b.status().archive.head.sourceTxHex),b.state.commitment(),`batch ${n} reaches the packet it carries`);
   assert.deepEqual(b.status(),{...b.status(),...acceptedOf(mirror)},`batch ${n} is accepted, across the rotations at 2 and 4`);
  }
 }
 assert.deepEqual([withRecords.state.commitment(),chainOnly.state.commitment()],[a.state.commitment(),a.state.commitment()]);
 const {tx:joinTx}=landedTx(w,1);
 assert.deepEqual(readEpochBatchTx(joinTx,leaves),readBatchTx(joinTx,leaves),'the join row reads what the genesis-3 reader reads');
 assert.deepEqual(readEpochBatchTx(joinTx,leaves).nullifiers,recordAt(w,1).slots.map(s=>s.nullifiers.map(BigInt)));
});

test('following the batch that ends an epoch empties the padding queue at once',async t=>{
 const w=await world(2),a=await w.open(t),drops:[string[],string][]=[];
 const b=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-follower-')),onDrop:(ids,reason)=>drops.push([ids,reason])});
 for(let n=0;n<2;n++)await land(a,'spend',[fastSpend(a.state)]);
 await b.follow({...landedTx(w,0),at:1});
 const pads=padsFor(b.state,'spend',3);b.addPadding(pads);
 await b.follow({...landedTx(w,1),at:1});
 assert.deepEqual([b.state.rotatesNext(),b.padding(),drops.flatMap(([ids])=>ids)],[true,0,pads.map(p=>p.id)]);
 for(const [,reason] of drops)assert.match(reason,/rotation/);
});

test('readEpochBatchTx says so when it is handed genesis-3 leaves',()=>{
 const tx=fixtureRecover(pool.batchRecover).arkTx,{batchRecover:_,...classicLeaves}=leaves;
 for(const bad of [classicLeaves,{...leaves,batchRecover:new Uint8Array()}])assert.throws(()=>readEpochBatchTx(tx,bad as never),/recover leaf|not an epoch pool/);
 assert.equal(readEpochBatchTx(tx,leaves).kind,'recover');
});

test('a restart replays its own records back to the committed state across a rotation',async t=>{
 const w=await world(2),op=await w.open(t),note=await history(w,op),commitment=op.state.commitment();
 op.close();
 assert.ok(KINDS.every((_,n)=>recordAt(w,n).noteBlockRoot!==undefined),'every record carries its block root');
 assert.equal(recordAt(w,4).slots[0]!.origin,0);
 const reopened=await w.open(t);
 assert.deepEqual([reopened.state.commitment(),headCommitment(reopened.status().archive.head.sourceTxHex)],[commitment,commitment]);
 assert.deepEqual([reopened.state.epoch,reopened.state.archive.count(),reopened.state.recovered.has(note.nullifier)],[2,2,true]);
 reopened.close();
 const path=join(w.dir,'batches','3.json'),original=readFileSync(path,'utf8'),body=JSON.parse(original) as RollupEpochRecord;
 body.slots[2]!.nullifiers=[String(BigInt(body.slots[2]!.nullifiers[0]!)+1n)];writeFileSync(path,JSON.stringify(body));
 await assert.rejects(w.open(t),/head commits to/);
 writeFileSync(path,original);
 assert.equal((await w.open(t)).state.commitment(),commitment,'the refusal released the journal');
});
