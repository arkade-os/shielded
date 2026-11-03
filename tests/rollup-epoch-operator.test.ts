import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {asset,CSVMultisigTapscript,EmulatorPacket,Extension,MultisigTapscript,scriptFromTapLeafScript,SingleKey,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {RawWitness} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import {inputNullifierOf} from '../packages/protocol/src/rollup/client.ts';
import {ARCHIVE_DEPTH,BATCH_SLOTS,ROLLUP_DOMAIN,ROLLUP_FIELD,RollupRejection,type RejectionCode} from '../packages/protocol/src/rollup/constants.ts';
import type {DepositFeeSchedule} from '../packages/protocol/src/rollup/deposit-fee.ts';
import {anchorOf,EpochState,type EpochSlot} from '../packages/protocol/src/rollup/epoch.ts';
import {chainOnly,EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {EPOCH_DERIVED_FIELDS,epochBatchInput,epochTransfer} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import type {RollupEpochRecord,RollupEpochRecordSlot} from '../packages/protocol/src/rollup/epoch-record.ts';
import {assetFieldOfId,destinationFieldOf,groupIdOf,noteOf,statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {ctDigestOf,openRollupNotes,ROLLUP_RECORD_BYTES,rollupRecipientOf,sealRollupNotes,type RollupNote,type RollupRecipient} from '../packages/protocol/src/rollup/wallet.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupPublicItems,rollupWitness,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {openRollupEpochOperator,ROLLUP_QUICK_REFUSAL_MS,ROLLUP_RESEND_GRACE_MS,slotOf,type RollupEpochSpend,type RollupTransport} from '../src/rollup/epoch-operator.ts';
import {headCommitment} from '../src/rollup/epoch-snapshot.ts';
import {readEpochBatchTx} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupSpecOf} from '../src/rollup/service.ts';
import type {StockNativeReceipt,StockWireRequest} from '../src/stock/transport.ts';
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
 writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf(token,'aa'.repeat(32))));
 try{return await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));}finally{rmSync(dir,{recursive:true,force:true});}
})();
const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
const exitDelay={type:'seconds' as const,value:2048},pool=rollupEpochPoolTree(server,emulator,leaves,exitDelay);
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
const wire=(built:ReturnType<typeof buildRollupBatchTx>):StockWireRequest=>({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))});
/** The fixture's real recover batch, built in TypeScript on a head that carries its old packet, spent through `leaf`. */
const fixtureRecover=(leaf:Uint8Array,publics=fixture.slots[0]!.publicSignals.map(BigInt))=>{
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]),[slot]=fixture.slots;
 return buildRollupBatchTx({kind:'recover',head:{txid:parent.id,vout:0,value:100_330,sourceTx:parent.toBytes(),tapTree:pool.tree.encode(),leaf:pool.tree.findLeaf(hex.encode(leaf))},deposits:[],legs:[{deposit:0n,withdraw:0n,asset:false}],token,leaves,
  witness:rollupWitness(fixture.batch.proof,[{proof:slot!.proof,publics}]),newPacket:hex.decode(fixture.newPacket),checkpoint});
};
const pastField=([pub,nf0,nf1,...rest]:bigint[])=>[pub!,nf0!+ROLLUP_FIELD,nf1!+ROLLUP_FIELD,...rest];

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
 const coinOf=(tx:Transaction,vout:number,sourceTx=tx.toBytes(true,true)):RollupCoin=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTx,tapTree:userTree.encode(),leaf:userTree.findLeaf(hex.encode(userCollab))});
 const coin=(vout:number)=>coinOf(parent,vout,parent.toBytes()),cash=(sats:bigint)=>coinOf(offlineNativeFixture([{script:userTree.pkScript,amount:sats}]),0);
 const feeView=x25519.utils.randomSecretKey(),feeTo=rollupRecipientOf(hash,5n,6n,feeView),payer=rollupRecipientOf(hash,11n,13n,x25519.utils.randomSecretKey());
 const fee=(schedule:DepositFeeSchedule={fixedSats:100,bps:0})=>({depositFee:{schedule,owner:feeTo.owner,viewSecret:feeView}});
 const shield=async(s:EpochState,sats:bigint,o:{fee?:bigint;to?:RollupRecipient;dummy?:{nk:bigint;rho:bigint};group?:{id:bigint;size:number};coin?:RollupCoin}={})=>{
  const built=await epochTransfer(hash,{rPrev:s.nextAnchorRoot(),rCur:{epoch:s.epoch,root:s.latestRoot()},sel:[],ask:0n,nk:0n,self:payer,group:o.group,request:{deposit:sats,dummy:o.dummy,to:o.fee===undefined?undefined:{recipient:o.to??feeTo,amount:o.fee}}});
  return spendOf({slot:built.slot,publicSignals:built.witness.publicSignals},{ciphertext:built.ciphertext,coin:o.coin??cash(sats)});
 };
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
 return {dir,landed,coin,coinOf,cash,program:userTree.pkScript.subarray(2),feeTo,feeView,fee,shield,transport,open:async(t:TestContext,overrides:Partial<Parameters<typeof openRollupEpochOperator>[0]>={})=>{const op=await openRollupEpochOperator({...options,...overrides});t.after(()=>op.close());return op;}};
}
type World=Awaited<ReturnType<typeof world>>;
type Operator=Awaited<ReturnType<typeof openRollupEpochOperator>>;
const recordIn=(dir:string,n:number)=>JSON.parse(readFileSync(join(dir,'batches',`${n}.json`),'utf8')) as RollupEpochRecord;
const recordAt=(w:World,n:number)=>recordIn(w.dir,n);
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

test('a quiet pool batches the first spend at once, and the next one batchWaitMs after that batch',async t=>{
 let clock=1_000_000;
 const w=await world(64),op=await w.open(t,{batchWaitMs:10_000,now:()=>clock});
 await land(op,'spend',[fastSpend(op.state)]);
 clock+=1_000;await op.submit(fastSpend(op.state));op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));
 assert.equal(await op.tick(),undefined);
 clock+=8_999;assert.equal(await op.tick(),undefined);
 clock+=1;const tick=await op.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
});

test('each kind keeps its own clock, so a spend batch never delays a join',async t=>{
 let clock=1_000_000;
 const w=await world(64),op=await w.open(t,{batchWaitMs:10_000,joinWaitMs:60_000,now:()=>clock});
 await land(op,'spend',[fastSpend(op.state)]);
 clock+=1_000;await land(op,'join',[joinSpend(op.state)]);
});

test('a partial join waits joinWaitMs after the last join',async t=>{
 let clock=1_000_000;
 const w=await world(64),op=await w.open(t,{joinWaitMs:60_000,now:()=>clock});
 await land(op,'join',[joinSpend(op.state)]);
 clock+=1_000;await op.submit(joinSpend(op.state));op.addPadding(padsFor(op.state,'join',BATCH_SLOTS-1));
 assert.equal(await op.tick(),undefined);
 clock+=59_000;const tick=await op.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
});

test('a followed batch starts its kind\'s clock, as one this operator lands does',async t=>{
 let clock=1_000_000;
 const w=await world(64),a=await w.open(t);
 await land(a,'spend',[fastSpend(a.state)]);
 const b=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-follower-')),batchWaitMs:10_000,now:()=>clock});
 await b.follow({...landedTx(w,0),slots:recordAt(w,0).slots,at:1});
 clock+=1_000;await b.submit(fastSpend(b.state));b.addPadding(padsFor(b.state,'spend',BATCH_SLOTS-1));
 assert.equal(await b.tick(),undefined);
 clock+=9_000;const tick=await b.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
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

test('the real recover leaf accepts nullifiers encoded past the field, not pub, and the batch reads back canonical',async()=>{
 const publics=fixture.slots[0]!.publicSignals.map(BigInt),built=fixtureRecover(pool.batchRecover,pastField(publics));
 const accepted=await executeVmBinary(DEFAULT_VM_BINARY,wire(built));
 assert.equal(accepted.ok,true,accepted.error);
 const facts=readEpochBatchTx(built.arkTx,leaves);
 assert.deepEqual([facts.publics,facts.nullifiers],[[publics],[[publics[1]]]]);
 const shiftedPub=await executeVmBinary(DEFAULT_VM_BINARY,wire(fixtureRecover(pool.batchRecover,[publics[0]!+ROLLUP_FIELD,...publics.slice(1)])));
 assert.equal(shiftedPub.ok,false,'pub reaches OP_ECMUL unreduced, so it is read as is');
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
 assert.deepEqual(readEpochBatchTx(joinTx,leaves).nullifiers,recordAt(w,1).slots.map(s=>s.nullifiers.map(BigInt)));
});

test('a batch carrying nullifiers past the field is followed chain-only to the same state, not refused as out of range',async t=>{
 const w=await world(2),a=await w.open(t);
 await land(a,'spend',[fastSpend(a.state)]);
 const {tx,checkpoints}=landedTx(w,0),vout=[...Array(tx.outputsLength).keys()].find(i=>Extension.isExtension(tx.getOutput(i).script!))!;
 const packets=Extension.fromTx(tx).getPackets().map(p=>p.type()!==EmulatorPacket.PACKET_TYPE?p:EmulatorPacket.create(EmulatorPacket.fromBytes(p.serialize()).entries.map(e=>{
  if(e.vin!==0)return e;
  const items=RawWitness.decode(e.witness!);items.splice(16,7,...rollupPublicItems(pastField(readEpochBatchTx(tx,leaves).publics.at(-1)!)));
  return {...e,witness:RawWitness.encode(items)};
 })));
 tx.updateOutput(vout,{script:Extension.create([...packets]).txOut().script});
 const b=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-past-field-'))});
 assert.deepEqual(await b.follow({tx,checkpoints,at:1}),{batch:0,txid:tx.id});
 assert.equal(b.state.commitment(),a.state.commitment());
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

test('a batch followed chain-only is enriched by its real record, and a wallet syncing from scratch then finds the note it was paid',async t=>{
 const w=await world(64),a=await w.open(t),keys={ask:11n,nk:13n,viewSecret:x25519.utils.randomSecretKey()};
 const self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 const built=await epochTransfer(hash,{rPrev:a.state.nextAnchorRoot(),rCur:{epoch:a.state.epoch,root:a.state.latestRoot()},sel:[],ask:0n,nk:0n,self,request:{deposit:1000n}});
 await land(a,'spend',[{id:'paid',slot:built.slot,publics:built.witness.publicSignals as unknown as Spend['publics'],proof,ciphertext:built.ciphertext,coin:w.coin(1)}]);
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-enrich-')),b=await w.open(t,{directory:dir}),{tx}=landedTx(w,0);
 await b.follow({...landedTx(w,0),at:7});
 const paid=async(record:RollupEpochRecord)=>{const account=EpochAccount.owning(hash,keys,{epochLen:64});await account.apply(record);return account.balance();};
 const bare=recordIn(dir,0);
 assert.deepEqual([chainOnly(bare),await paid(bare)],[true,0n],'the chain-only record hides the note the batch paid');
 // Someone holding the commitments but not the note records fills the record in first, as a griefer would.
 assert.deepEqual(await b.enrich(tx.id,recordAt(w,0).slots.map(({ciphertext:_c,...s})=>s)),{batch:0,txid:tx.id});
 assert.deepEqual([chainOnly(recordIn(dir,0)),await paid(recordIn(dir,0))],[false,0n],'without its note records the record still hides the note');
 assert.deepEqual(await b.enrich(tx.id,recordAt(w,0).slots),{batch:0,txid:tx.id},'the note records are added afterwards, so nothing was locked');
 const full=recordIn(dir,0);
 assert.deepEqual([chainOnly(full),await paid(full)],[false,1000n],'the enriched record pays a wallet that syncs it from scratch');
 assert.deepEqual([full.txid,full.at,full.kind,full.noteBlockRoot],[bare.txid,7,bare.kind,bare.noteBlockRoot]);
 assert.deepEqual(full.slots.map(s=>s.publics),bare.slots.map(s=>s.publics),'every slot keeps the publics the transaction carries');
 assert.deepEqual([b.state.commitment(),b.status().archive.batches],[a.state.commitment(),1],'enriching moves no state');
 b.close();
 assert.equal((await w.open(t,{directory:dir})).state.commitment(),a.state.commitment(),'the enriched record still replays to the commitment its head carries');
});

test('an enrichment that does not match the chain data its record holds is refused, and the record stays chain-only',async t=>{
 const w=await world(64),a=await w.open(t);
 for(let n=0;n<2;n++)await land(a,'spend',[fastSpend(a.state)]);
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-forged-')),b=await w.open(t,{directory:dir});
 await b.follow({...landedTx(w,0),at:1});
 await b.follow({...landedTx(w,1),slots:recordAt(w,1).slots,at:1});
 const real=recordAt(w,0).slots,bare=recordIn(dir,0),[first,second]=[landedTx(w,0).tx.id,landedTx(w,1).tx.id];
 const edit=(i:number,patch:Partial<RollupEpochRecordSlot>)=>real.map((s,n)=>n===i?{...s,...patch}:s);
 const refused:[string,string,RollupEpochRecordSlot[],RegExp][]=[
  ['commitments that do not rebuild the block root',first,edit(0,{commitments:[real[0]!.commitments[1]!,real[0]!.commitments[0]!]}),/block root/],
  ['nullifiers the transaction does not carry',first,edit(0,{nullifiers:[String(BigInt(real[0]!.nullifiers[0]!)+1n)]}),/notes the transaction carries/],
  ['a slot whose statement is not the one the transaction carries',first,edit(1,{anchor:String(BigInt(real[1]!.anchor)+1n)}),/statement/],
  ['a ciphertext that does not match its digest',first,edit(0,{ciphertext:hex.encode(new Uint8Array(ROLLUP_RECORD_BYTES))}),/digest/],
  ['fewer slots than the batch has',first,real.slice(1),/number of slots/],
  ['a batch followed with every note record it has',second,recordAt(w,1).slots,/already carries every note record/],
  ['a transaction this pool never followed','ff'.repeat(32),real,/holds no followed record/],
 ];
 for(const [label,txid,slots,reason] of refused)await assert.rejects(b.enrich(txid,slots),reason,label);
 assert.deepEqual(recordIn(dir,0),bare,'no refusal wrote anything');
 assert.deepEqual(await b.enrich(first,real),{batch:0,txid:first},'the record is still enrichable by its real slots');
 await assert.rejects(b.enrich(first,real),/already carries every note record/,'an enrichment that adds nothing is refused');
});

test('a batch followed chain-only stays enrichable after a restart, however many batches follow it',async t=>{
 const w=await world(64),a=await w.open(t);
 for(let n=0;n<3;n++)await land(a,'spend',[fastSpend(a.state)]);
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-indexed-')),b=await w.open(t,{directory:dir});
 await b.follow({...landedTx(w,0),at:1});
 for(let n=1;n<3;n++)await b.follow({...landedTx(w,n),slots:recordAt(w,n).slots,at:1});
 b.close();
 const {tx}=landedTx(w,0),c=await w.open(t,{directory:dir}),index=()=>JSON.parse(readFileSync(join(dir,'chain-only.json'),'utf8'));
 // These spends carry no note records, so the two batches followed with their records can still be filled in too.
 const fillable=Object.fromEntries([0,1,2].map(n=>[landedTx(w,n).tx.id,n]));
 assert.deepEqual(index(),fillable,'every followed batch that can still be filled in is indexed');
 assert.deepEqual(await c.enrich(tx.id,recordAt(w,0).slots),{batch:0,txid:tx.id},'the index survives the restart, so no scan of later records is needed');
 assert.equal(chainOnly(recordIn(dir,0)),false);
 c.close();writeFileSync(join(dir,'chain-only.json'),'{not json');
 const warned=t.mock.method(console,'warn',()=>{});
 assert.equal((await w.open(t,{directory:dir})).state.commitment(),a.state.commitment(),'a damaged index never keeps the operator from opening');
 assert.ok(warned.mock.calls.some(call=>/Rebuilding .*chain-only\.json/.test(String(call.arguments[0]))));
 assert.deepEqual(index(),fillable,'it is rebuilt from the committed records');
});

test('a recover batch followed chain-only is enriched by its one slot, with no archive file of its origin on disk',async t=>{
 const w=await world(2),a=await w.open(t);
 await history(w,a);
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-enrich-recover-')),b=await w.open(t,{directory:dir});
 for(let n=0;n<KINDS.length;n++)await b.follow({...landedTx(w,n),at:1});
 const {tx}=landedTx(w,4),real=recordAt(w,4).slots;
 assert.deepEqual([recordAt(w,4).kind,real.length,real[0]!.origin],['recover',1,0]);
 rmSync(join(dir,'nullifiers'),{recursive:true,force:true});
 assert.deepEqual(await b.enrich(tx.id,real),{batch:4,txid:tx.id},'enrichment verifies statements, not state, so it reads no frozen set');
 assert.deepEqual([chainOnly(recordIn(dir,4)),recordIn(dir,4).slots[0]!.origin],[false,undefined],'an origin the statement does not bind is not served');
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

const queue=async(op:Operator,client=fastSpend(op.state))=>{await op.submit(client);op.addPadding(padsFor(op.state,'spend',BATCH_SLOTS-1));return client;};
const blocked=async(op:Operator)=>{const tick=await op.tick();assert.ok(tick&&'blocked' in tick,JSON.stringify(tick));return tick.blocked;};
const landsAs=async(op:Operator)=>{const tick=await op.tick();assert.ok(tick&&'txid' in tick,JSON.stringify(tick));return tick.batch;};
const refused=(message='internal error')=>Object.assign(new Error(message),{refused:true});
const carried=(dir:string,n:number,s:Spend)=>(JSON.parse(readFileSync(join(dir,'batches',`${n}.json`),'utf8')) as RollupEpochRecord).slots.some(slot=>slot.nullifiers[0]===String(s.slot.nullifiers[0]));
const stateAt=(op:Operator)=>[op.state.batchCount,op.state.commitment()],headAt=(op:Operator)=>[op.status().archive.batches,headCommitment(op.status().archive.head.sourceTxHex)];
const kept=(w:World)=>readdirSync(join(w.dir,'abandoned')).length;

test('a head another prover spent stops batching with a pointer to /external, keeps the spend and its pads, and the batch after the followed one carries it',async t=>{
 const w=await world(64),a=await w.open(t),genesis=a.status().archive.head.txid,dir=mkdtempSync(join(tmpdir(),'rollup-epoch-follower-'));
 await land(a,'spend',[fastSpend(a.state)]);
 const taker=landedTx(w,0).tx.id,b=await w.open(t,{directory:dir,transport:{...w.transport,spentBy:async head=>head.txid===genesis?taker:undefined}});
 const mine=await queue(b);
 assert.match(await blocked(b),new RegExp(`spent by ${taker}.*/api/rollup/external`));
 assert.deepEqual([b.pendingIds(),b.padding('spend'),b.status().pending,b.state.batchCount,w.landed.length],[[mine.id],BATCH_SLOTS-1,undefined,0,1],'nothing was applied or sent on a spent head');
 const followed={...landedTx(w,0),slots:recordAt(w,0).slots,at:1};
 assert.deepEqual(await b.follow(followed),{batch:0,txid:taker});
 await assert.rejects(b.follow(followed),/not this pool's head/,'the same batch cannot be followed twice');
 assert.equal(await landsAs(b),1);
 assert.ok(carried(dir,1,mine));
});

test('an operator whose own batch lost the race never abandons it on a spent head, drops it on following the winner, and re-sends its spend',async t=>{
 let clock=1_000_000,fails=Infinity;
 const w=await world(64),dir=mkdtempSync(join(tmpdir(),'rollup-epoch-loser-'));
 const spent=(coin:{txid:string;vout:number})=>w.landed.some(r=>r.checkpoints.some(c=>{const input=Transaction.fromPSBT(base64.decode(c)).getInput(0);return hex.encode(input.txid!)===coin.txid&&input.index===coin.vout;}));
 const a=await w.open(t),b=await w.open(t,{directory:dir,now:()=>clock,transport:{...w.transport,unspent:async coin=>!spent(coin),
  submit:async(request,first)=>{if(fails-->0)throw new Error('proxy timeout');return w.transport.submit(request,first);}}});
 const mine=await queue(b);
 assert.match(await blocked(b),/proxy timeout/);
 await land(a,'spend',[fastSpend(a.state)]);
 for(let n=1;n<=2;n++){clock+=ROLLUP_RESEND_GRACE_MS;assert.match(await blocked(b),/proxy timeout/,`re-send ${n}: a head another batch spent is never abandoned`);}
 assert.deepEqual(await b.follow({...landedTx(w,0),slots:recordAt(w,0).slots,at:1}),{batch:0,txid:landedTx(w,0).tx.id});
 assert.deepEqual([b.status().pending,b.state.commitment(),b.pendingIds(),b.padding('spend')],[undefined,a.state.commitment(),[mine.id],BATCH_SLOTS-1]);
 fails=1;assert.match(await blocked(b),/proxy timeout/);
 clock+=ROLLUP_RESEND_GRACE_MS;assert.equal(await landsAs(b),1,'the dropped batch\'s tries do not count against this one');
 assert.ok(carried(dir,1,mine));
});

test('after a restart, following the winner drops the journaled plan with no applied batch to undo',async t=>{
 const w=await world(64),a=await w.open(t),dir=mkdtempSync(join(tmpdir(),'rollup-epoch-restarted-')),dead={...w.transport,submit:async()=>{throw new Error('proxy timeout');}};
 let c=await w.open(t,{directory:dir,transport:dead});
 await queue(c);assert.match(await blocked(c),/proxy timeout/);
 c.close();c=await w.open(t,{directory:dir,transport:dead});
 await land(a,'spend',[fastSpend(a.state)]);
 assert.deepEqual(await c.follow({...landedTx(w,0),slots:recordAt(w,0).slots,at:1}),{batch:0,txid:landedTx(w,0).tx.id});
 assert.deepEqual([c.status().pending,c.state.commitment()],[undefined,a.state.commitment()]);
});

test('a follow whose journal write fails applies nothing, and the batch is followed once the journal is free',async t=>{
 const w=await world(64),a=await w.open(t);
 await land(a,'spend',[fastSpend(a.state)]);
 const b=await w.open(t,{directory:mkdtempSync(join(tmpdir(),'rollup-epoch-unwritten-'))}),{archive}=b.status();
 const before=[b.state.commitment(),b.status()];
 // relocate holds the journal as the renewal and listing work that moves the head does, so this follow's commit cannot land.
 const moving=b.relocate({head:archive.head,reserves:archive.reserves});
 await assert.rejects(b.follow({...landedTx(w,0),at:1}),/in flight/);
 assert.deepEqual([b.state.commitment(),b.status()],before,'the refused follow left no batch applied ahead of the journal');
 await moving;
 assert.deepEqual(await b.follow({...landedTx(w,0),at:1}),{batch:0,txid:landedTx(w,0).tx.id});
 assert.deepEqual([b.state.commitment(),headCommitment(b.status().archive.head.sourceTxHex)],[a.state.commitment(),a.state.commitment()]);
});

test('a batch the network keeps refusing is abandoned: its deposit is dropped, the rest is rebuilt and lands, and the kept plan goes once the head moves',async t=>{
 let clock=1_000_000,submits=0,flaky=1;
 const w=await world(64),drops:[string[],string][]=[];
 const op=await w.open(t,{now:()=>clock,onDrop:(ids,reason)=>drops.push([ids,reason]),transport:{...w.transport,submit:async(request,first)=>{
  submits++;
  if(Transaction.fromPSBT(base64.decode(request.arkTx)).inputsLength>1)throw refused('arkd rejected the deposit input');
  if(flaky-->0)throw refused();
  return w.transport.submit(request,first);
 }}});
 const paid=spendOf(deposit(op.state,1000n),{coin:w.coin(1)}),transfer=fastSpend(op.state);
 await op.submit(paid);await queue(op,transfer);
 assert.match(await blocked(op),/rejected the deposit/);
 for(const next of [/rejected the deposit/,/abandoned/]){clock+=ROLLUP_QUICK_REFUSAL_MS-1;assert.match(await blocked(op),/no known outcome/);clock+=1;assert.match(await blocked(op),next);}
 assert.deepEqual([op.state.batchCount,op.pendingIds(),op.padding('spend'),kept(w),drops],[0,[transfer.id],BATCH_SLOTS-1,1,[[[paid.id],'The network kept refusing the batch with this deposit.']]]);
 assert.match(await blocked(op),/internal error/);
 clock+=ROLLUP_QUICK_REFUSAL_MS;assert.equal(await landsAs(op),0,'the rebuilt batch is re-sent, not abandoned on the abandoned one\'s tries');
 assert.deepEqual([op.status().archive.head.value,submits],[100_330,4]);
 assert.deepEqual([await op.tick(),kept(w)],[undefined,0],'the kept plan goes once the head moves past it');
});

test('a refusal slower than the quick window keeps the long grace, as a finalize that hung may still land',async t=>{
 let clock=1_000_000;
 const w=await world(64),op=await w.open(t,{now:()=>clock,transport:{...w.transport,submit:async()=>{clock+=ROLLUP_QUICK_REFUSAL_MS;throw refused();}}});
 await queue(op);assert.match(await blocked(op),/internal error/);
 clock+=ROLLUP_QUICK_REFUSAL_MS;assert.match(await blocked(op),/no known outcome/);
});

test('a batch the network shows only at the last look before abandoning lands instead, deposit included',async t=>{
 let clock=1_000_000,submits=0;
 const w=await world(64),drops:string[][]=[],landing=new Map<string,StockNativeReceipt>(),seen=new Map<string,StockNativeReceipt>();
 const op=await w.open(t,{now:()=>clock,onDrop:ids=>drops.push(ids),transport:{...w.transport,
  // The indexer shows a landing one look late, so reconcile's look misses it and only the abandon check's look sees it.
  lookup:async request=>{const found=seen.get(request.arkTx),landed=landing.get(request.arkTx);if(landed)seen.set(request.arkTx,landed);return found;},
  submit:async(request,first)=>{if(++submits===2)landing.set(request.arkTx,await w.transport.submit(request,first));throw new Error('proxy timeout');}}});
 await queue(op,spendOf(deposit(op.state,1000n),{coin:w.coin(1)}));
 assert.match(await blocked(op),/proxy timeout/);
 clock+=ROLLUP_RESEND_GRACE_MS;assert.match(await blocked(op),/proxy timeout/);
 clock+=ROLLUP_RESEND_GRACE_MS;assert.equal(await landsAs(op),0);
 assert.deepEqual([drops,op.status().archive.head.value,kept(w)],[[],101_330,0]);
});

test('an abandoned batch that lands late is adopted after a restart, head and record included',async t=>{
 let clock=1_000_000;
 const w=await world(64),net={landed:undefined as {arkTx:string;receipt:StockNativeReceipt}|undefined,indexed:false,sent:[] as string[]};
 const transport:RollupTransport={...w.transport,unspent:async()=>!(net.indexed&&net.landed),
  lookup:async request=>net.indexed&&net.landed?.arkTx===request.arkTx?net.landed.receipt:undefined,
  submit:async(request,first)=>{
   net.sent.push(request.arkTx);
   if(net.landed)throw new Error('the emulator already knows this batch');
   net.landed={arkTx:request.arkTx,receipt:await w.transport.submit(request,first)};throw new Error('proxy timeout after the emulator accepted it');
  }};
 let op=await w.open(t,{transport,now:()=>clock});
 const mine=await queue(op);
 assert.match(await blocked(op),/proxy timeout/);
 for(const reason of [/already knows/,/abandoned/]){clock+=ROLLUP_RESEND_GRACE_MS;assert.match(await blocked(op),reason);}
 op.close();op=await w.open(t,{transport,now:()=>clock});
 assert.deepEqual([await op.tick(),kept(w)],[undefined,1],'a kept plan the network does not show stays kept');
 net.indexed=true;
 assert.deepEqual(await op.tick(),{txid:net.landed!.receipt.txid,batch:0});
 assert.deepEqual([kept(w),stateAt(op)],[0,headAt(op)]);
 assert.ok(carried(w.dir,0,mine));
 assert.deepEqual([...new Set(net.sent)],[net.landed!.arkTx],'only one transaction is ever built on the head');
});

test('a refused batch is re-sent after its grace, never abandoned on the tries of the batch before, whether that one landed or was found landed',async t=>{
 let clock=1_000_000;
 const w=await world(64),found=new Map<string,StockNativeReceipt>(),steps=['land','refuse','land','land-refused','refuse','land'];
 const op=await w.open(t,{now:()=>clock,transport:{...w.transport,lookup:async request=>found.get(request.arkTx),
  submit:async(request,first)=>{
   const step=steps.shift();if(step==='refuse')throw refused();
   const receipt=await w.transport.submit(request,first);if(step==='land')return receipt;
   found.set(request.arkTx,receipt);throw refused();
  }}});
 await queue(op);assert.equal(await landsAs(op),0);
 await queue(op);assert.match(await blocked(op),/internal error/);
 clock+=ROLLUP_QUICK_REFUSAL_MS;assert.equal(await landsAs(op),1,'after a batch that landed at once');
 await queue(op);assert.match(await blocked(op),/internal error/);
 assert.equal(await landsAs(op),2,'found landed on the next tick');
 await queue(op);assert.match(await blocked(op),/internal error/);
 clock+=ROLLUP_QUICK_REFUSAL_MS;assert.equal(await landsAs(op),3,'after a batch found landed');
});

test('after a restart a batch left in flight is found landed, or re-sent at once and abandoned without undoing an accepted batch',async t=>{
 let clock=1_000_000,mode:'up'|'lost'|'down'='up';
 const w=await world(64),found=new Map<string,StockNativeReceipt>();
 const transport:RollupTransport={...w.transport,lookup:async request=>found.get(request.arkTx),
  submit:async(request,first)=>{
   if(mode==='down')throw new Error('fetch failed');
   const receipt=await w.transport.submit(request,first);if(mode==='up')return receipt;
   found.set(request.arkTx,receipt);throw new Error('proxy timeout');
  }};
 const reopen=(op?:Operator)=>{op?.close();return w.open(t,{transport,now:()=>clock});};
 let op=await reopen();
 await land(op,'spend',[fastSpend(op.state)]);
 mode='lost';await queue(op);assert.match(await blocked(op),/proxy timeout/);
 op=await reopen(op);
 assert.equal(await landsAs(op),1);
 assert.deepEqual(stateAt(op),headAt(op),'the replayed state takes the found batch from its plan');
 mode='down';await queue(op);assert.match(await blocked(op),/fetch failed/);
 op=await reopen(op);
 assert.match(await blocked(op),/fetch failed/,'re-sent at once');
 clock+=ROLLUP_QUICK_REFUSAL_MS;assert.match(await blocked(op),/no known outcome/,'an unreachable network keeps the long grace');
 for(const reason of [/fetch failed/,/abandoned/]){clock+=ROLLUP_RESEND_GRACE_MS;assert.match(await blocked(op),reason);}
 assert.deepEqual(stateAt(op),headAt(op),'abandoning after a restart undoes nothing accepted');
});

const owes=(sats:bigint,owed:bigint,paid:bigint)=>(error:unknown)=>rejection('fee-missing')(error)&&(error as Error).message===`A deposit of ${sats} sats owes a ${owed}-sat deposit fee to this pool; this one carries ${paid}. Reload the page to shield at the current fee.`;
const groupOf=(size=2)=>{const dummies=Array.from({length:size},dummyInput);return {dummies,group:{id:groupIdOf(hash,dummies.map(d=>inputNullifierOf(hash,ROLLUP_DOMAIN,d))),size}};};
const coinless=({coin:_,...s}:Spend):Spend=>s;
const p2tr=(program:Uint8Array)=>Uint8Array.of(0x51,0x20,...program);
const withdrawal=(w:World,op:Operator,program=w.program)=>spendOf(deposit(op.state,0n,{withdraw:1000n,destination:destinationFieldOf(program)}),{program});
const paidOut=async(w:World,op:Operator)=>{
 await land(op,'spend',[withdrawal(w,op)]);
 const {tx}=landedTx(w,w.landed.length-1);
 assert.equal(hex.encode(tx.getOutput(1).script!),hex.encode(p2tr(w.program)),'output 1 is the payout');
 return w.coinOf(tx,1);
};
/** Batch n as a lander may rebuild it: a coin of its own spent in after the inputs and out at `at`, just past the payouts; with `reserve` that coin has the pool's script and also takes output 1, though no asset leg needs it. */
const forgedBatch=(w:World,n:number,at=2,reserve=false)=>{
 const landed=landedTx(w,n),src=landed.tx,tx=new Transaction({version:src.version,lockTime:src.lockTime}),outs=Array.from({length:src.outputsLength},(_,i)=>src.getOutput(i));
 const spare=offlineNativeFixture([{script:reserve?pool.tree.pkScript:p2tr(w.program),amount:5000n}]);
 if(reserve)outs.splice(1,0,{script:pool.tree.pkScript,amount:5000n});
 outs.splice(at,0,{script:p2tr(w.program),amount:5000n});
 for(let i=0;i<src.inputsLength;i++){const {txid,index}=src.getInput(i);tx.addInput({txid:txid!,index:index!});}
 tx.addInput({txid:spare.id,index:0});
 for(const {script,amount} of outs)tx.addOutput({script:script!,amount:amount!});
 return {tx,checkpoints:[...landed.checkpoints,spare]};
};
const listed=(op:Operator)=>{
 const source=offlineNativeFixture([{script:pool.tree.pkScript,amount:330n}]);
 return op.relocate({head:op.status().archive.head,reserves:{[x]:{txid:source.id,vout:0,value:330,sourceTxHex:hex.encode(source.toBytes()),amount:'1000'}}});
};
const assetDeposit=(w:World,op:Operator,sats:bigint)=>{
 const {dummies:[a,b],group}=groupOf(),g={groupId:group.id,groupSize:2};
 return [spendOf(deposit(op.state,5000n,{asset:assetFieldOfId(x),inputs:[a],...g}),{asset:x,coin:{...w.cash(sats),assetAmount:5000n}}),spendOf(deposit(op.state,sats,{inputs:[b],...g}))] as const;
};
const resealed=async(w:World,s:Spend,note:RollupNote):Promise<Spend>=>{
 const ciphertext=await sealRollupNotes([w.feeTo,w.feeTo],[note,note]),slot={...s.slot,ctDigest:ctDigestOf(ciphertext)};
 return {...s,slot,ciphertext,publics:[statementOf(hash,{domain:ROLLUP_DOMAIN,...slot,root:slot.anchor}),...s.publics.slice(1)] as unknown as Spend['publics']};
};

test('a deposit that pays the advertised fee to the pool\'s fee address is admitted',async t=>{
 const w=await world(64),op=await w.open(t,w.fee());
 await land(op,'spend',[await w.shield(op.state,10_000n,{fee:100n})]);
 const [slot]=recordAt(w,0).slots,[note]=await openRollupNotes(hex.decode(slot!.ciphertext!),w.feeView);
 assert.equal(slot!.commitments[0],String(noteOf(hash,ROLLUP_DOMAIN,100n,0n,w.feeTo.owner,note!.rho)),'the fee wallet opens and owns output 0');
 assert.equal(op.status().archive.head.value,110_330);
});

test('a deposit that carries no fee note is refused as fee-missing and reserves no nullifier',async t=>{
 const w=await world(64),op=await w.open(t,w.fee()),dummy=dummyInput();
 const bare=await w.shield(op.state,10_000n,{dummy}),paid=await w.shield(op.state,10_000n,{dummy,fee:100n});
 assert.deepEqual(paid.slot.nullifiers,bare.slot.nullifiers,'one note, proved twice');
 await assert.rejects(op.submit(bare),owes(10_000n,100n,0n));
 await assert.rejects(op.submit({...paid,ciphertext:undefined}),owes(10_000n,100n,0n),'a paying spend sent without its note record');
 assert.equal(op.pending(),0);
 await land(op,'spend',[paid]);
});

test('an underpaid fee note, and one sealed to another key, are both refused',async t=>{
 const w=await world(64),op=await w.open(t,w.fee({fixedSats:100,bps:50})),feeNote=async(s:Spend)=>(await openRollupNotes(s.ciphertext!,w.feeView))[0]!;
 const fair=await w.shield(op.state,10_000n,{fee:100n}),cheap=await w.shield(op.state,10_000n,{fee:1n});
 const refused:[string,Spend,bigint,bigint,bigint][]=[
  ['one sat short',await w.shield(op.state,10_000n,{fee:99n}),10_000n,100n,99n],
  ['the floor alone, where the bps share is higher',await w.shield(op.state,100_000n,{fee:100n}),100_000n,500n,100n],
  ['sealed to another view key',await w.shield(op.state,10_000n,{fee:100n,to:{...w.feeTo,viewPublic:x25519.getPublicKey(x25519.utils.randomSecretKey())}}),10_000n,100n,0n],
  ['owned by another key',await w.shield(op.state,10_000n,{fee:100n,to:rollupRecipientOf(hash,7n,6n,w.feeView)}),10_000n,100n,0n],
  ['a record claiming more than its commitment',await resealed(w,cheap,{...await feeNote(cheap),amount:100n}),10_000n,100n,0n],
  ['a record claiming an asset',await resealed(w,fair,{...await feeNote(fair),asset:1n}),10_000n,100n,0n],
 ];
 for(const [label,spend,sats,owed,paid] of refused)await assert.rejects(op.submit(spend),owes(sats,owed,paid),label);
 assert.equal(op.pending(),0);
 await land(op,'spend',[fair]);
});

test('a fee-less deposit of a coin this pool paid out is admitted, and still is after a restart',async t=>{
 const w=await world(64);
 let op=await w.open(t,w.fee());
 const payout=await paidOut(w,op);
 await assert.rejects(op.submit(spendOf(deposit(op.state,1000n),{coin:w.coin(1)})),owes(1000n,100n,0n),'the same deposit of a coin the pool did not pay out');
 await op.submit(spendOf(deposit(op.state,1000n),{coin:payout}));
 op.close();op=await w.open(t,w.fee());
 await land(op,'spend',[spendOf(deposit(op.state,1000n),{coin:payout})]);
});

test('a coin from a transaction that only copies a batch\'s packets owes the fee',async t=>{
 const w=await world(64),op=await w.open(t,w.fee());
 await paidOut(w,op);
 const decoy=offlineNativeFixture([{script:p2tr(w.program),amount:330n},{script:p2tr(w.program),amount:5000n}],Extension.fromTx(landedTx(w,0).tx).getPackets());
 assert.equal(readEpochBatchTx(decoy,leaves).kind,'spend','its packets alone read as this pool\'s batch');
 await assert.rejects(op.submit(spendOf(deposit(op.state,5000n),{coin:w.coinOf(decoy,1)})),owes(5000n,100n,0n),'output 1, where that batch\'s payout sits');
});

test('a followed batch exempts its payout, but not an output its lander added right after it',async t=>{
 const w=await world(64),a=await w.open(t);
 await paidOut(w,a);
 const {tx,checkpoints}=forgedBatch(w,0),b=await w.open(t,{...w.fee(),directory:mkdtempSync(join(tmpdir(),'rollup-epoch-fee-follower-'))});
 await assert.rejects(b.submit(spendOf(deposit(b.state,1000n),{coin:w.coinOf(tx,1)})),owes(1000n,100n,0n),'before the follow');
 await b.follow({tx,checkpoints,at:1});
 await assert.rejects(b.submit(spendOf(deposit(b.state,5000n),{coin:w.coinOf(tx,2)})),owes(5000n,100n,0n),'the lander\'s own output');
 await land(b,'spend',[spendOf(deposit(b.state,1000n),{coin:w.coinOf(tx,1)})]);
});

test('a payout to the pool\'s own script in a batch with no asset leg leaves its other payouts exempt, and no output past them',async t=>{
 const w=await world(64),a=await w.open(t);
 await land(a,'spend',[withdrawal(w,a,pool.tree.pkScript.subarray(2)),withdrawal(w,a)]);
 const {tx,checkpoints}=forgedBatch(w,0,3),b=await w.open(t,{...w.fee(),directory:mkdtempSync(join(tmpdir(),'rollup-epoch-fee-follower-'))});
 assert.equal(hex.encode(tx.getOutput(1).script!),hex.encode(pool.tree.pkScript),'output 1 looks like a reserve');
 await b.follow({tx,checkpoints,at:1});
 await assert.rejects(b.submit(spendOf(deposit(b.state,5000n),{coin:w.coinOf(tx,3)})),owes(5000n,100n,0n),'the lander\'s own output');
 await land(b,'spend',[spendOf(deposit(b.state,1000n),{coin:w.coinOf(tx,2)})]);
});

test('a lander\'s needless reserve in a batch with no asset leg still leaves its own output paying',async t=>{
 const w=await world(64),a=await w.open(t);
 await paidOut(w,a);
 const {tx,checkpoints}=forgedBatch(w,0,3,true),b=await w.open(t,{...w.fee(),directory:mkdtempSync(join(tmpdir(),'rollup-epoch-fee-follower-'))});
 await b.follow({tx,checkpoints,at:1});
 await assert.rejects(b.submit(spendOf(deposit(b.state,5000n),{coin:w.coinOf(tx,3)})),owes(5000n,100n,0n));
});

test('after a reserve at output 1 the payouts start at output 2, and the reserve is no payout',async t=>{
 const w=await world(64),op=await w.open(t,w.fee());
 await listed(op);
 await land(op,'spend',[...assetDeposit(w,op,330n),withdrawal(w,op)]);
 const {tx}=landedTx(w,0);
 assert.equal(hex.encode(tx.getOutput(1).script!),hex.encode(pool.tree.pkScript),'output 1 is the reserve');
 await assert.rejects(op.submit(spendOf(deposit(op.state,330n),{coin:w.coinOf(tx,1)})),owes(330n,100n,0n),'the reserve output');
 await land(op,'spend',[spendOf(deposit(op.state,1000n),{coin:w.coinOf(tx,2)})]);
});

test('an asset payout shares its carrier\'s output, so it adds no payout output',async t=>{
 const w=await world(64),a=await w.open(t),{dummies:[i,j],group}=groupOf(),g={groupId:group.id,groupSize:2},{program}=w,destination=destinationFieldOf(program);
 await listed(a);
 await land(a,'spend',[spendOf(deposit(a.state,0n,{asset:assetFieldOfId(x),withdraw:500n,destination,inputs:[i],...g}),{asset:x,program}),spendOf(deposit(a.state,0n,{withdraw:330n,destination,inputs:[j],...g}),{program})]);
 const {tx,checkpoints}=forgedBatch(w,0,3),b=await w.open(t,{...w.fee(),directory:mkdtempSync(join(tmpdir(),'rollup-epoch-fee-follower-'))});
 await b.follow({tx,checkpoints,at:1});
 await assert.rejects(b.submit(spendOf(deposit(b.state,5000n),{coin:w.coinOf(tx,3)})),owes(5000n,100n,0n),'the output past the one shared payout');
 await b.submit(spendOf(deposit(b.state,330n),{coin:w.coinOf(tx,2)}));
});

test('a record the fee check cannot read never keeps the pool from opening, and a coin its batch paid out pays the fee',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{});
 const reopen=(op:Operator,fee={})=>{op.close();return w.open(t,{snapshotEvery:1,...fee});};
 let op=await w.open(t,{snapshotEvery:1});
 const payout=await paidOut(w,op);
 writeFileSync(join(w.dir,'batches','0.json'),'{not json');
 op=await reopen(op);
 assert.equal(warned.mock.calls.length,0,'with no fee configured, open reads no record the snapshot covers');
 op=await reopen(op,w.fee());
 assert.ok(warned.mock.calls.some(call=>/Batch 0's record is unreadable/.test(String(call.arguments[0]))));
 await assert.rejects(op.submit(spendOf(deposit(op.state,1000n),{coin:payout})),owes(1000n,100n,0n));
});

const txidIndex=(dir:string)=>join(dir,'batch-txids.json');
const indexed=(dir:string)=>JSON.parse(readFileSync(txidIndex(dir),'utf8')) as string[];
const redeposit=(op:Operator,coin:RollupCoin)=>spendOf(deposit(op.state,1000n),{coin});

test('a fee-charging pool keeps its batch txids on disk, so a restart exempts a payout without reading its record',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{}),open=()=>w.open(t,{snapshotEvery:1,...w.fee()});
 let op=await open();
 assert.deepEqual(indexed(w.dir),[],'a first open writes the index');
 const payout=await paidOut(w,op);
 assert.deepEqual(indexed(w.dir),[payout.txid],'a landed batch is indexed');
 op.close();rmSync(join(w.dir,'batches','0.json'));
 op=await open();
 await land(op,'spend',[redeposit(op,payout)]);
 assert.equal(warned.mock.calls.length,0);
});

test('an index that cannot be read is rebuilt from the batch records at open',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{});
 let op=await w.open(t,w.fee());
 const payout=await paidOut(w,op);
 for(const bad of ['{not json','{"0":"x"}','[7]']){
  op.close();writeFileSync(txidIndex(w.dir),bad);
  op=await w.open(t,w.fee());
  assert.match(String(warned.mock.calls.at(-1)!.arguments[0]),/Rebuilding .*batch-txids\.json/,bad);
  assert.deepEqual(indexed(w.dir),[payout.txid],bad);
  await op.submit(redeposit(op,payout));
 }
});

test('an index longer than the journal is cut back at open, so a batch that never landed keeps no exemption',async t=>{
 const w=await world(64),open=()=>w.open(t,{snapshotEvery:1,...w.fee()});
 let op=await open();
 const payout=await paidOut(w,op),{tx}=forgedBatch(w,0);
 op.close();writeFileSync(txidIndex(w.dir),JSON.stringify([payout.txid,tx.id]));
 op=await open();
 assert.deepEqual(indexed(w.dir),[payout.txid]);
 await assert.rejects(op.submit(redeposit(op,w.coinOf(tx,1))),owes(1000n,100n,0n));
 await op.submit(redeposit(op,payout));
});

test('an index behind the journal is filled in from the records it lacks only, and a fee-less run leaves it alone',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{}),off={snapshotEvery:1},on={...off,...w.fee()};
 let op=await w.open(t,on);
 const first=await paidOut(w,op);
 op.close();op=await w.open(t,off);
 const second=await paidOut(w,op);
 op.close();
 assert.deepEqual(indexed(w.dir),[first.txid],'a batch landed with no fee is not indexed');
 rmSync(join(w.dir,'batches','0.json'));
 op=await w.open(t,on);
 assert.deepEqual(indexed(w.dir),[first.txid,second.txid]);
 for(const coin of [first,second])await op.submit(redeposit(op,coin));
 assert.equal(warned.mock.calls.length,0,'the record the index covers was not read');
});

test('a record that gives no txid leaves an empty slot, so the later batches stay aligned, and a repaired record is picked up',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{}),open=()=>w.open(t,{snapshotEvery:1,...w.fee()}),path=join(w.dir,'batches','0.json');
 let op=await w.open(t,{snapshotEvery:1});
 const lost=await paidOut(w,op),kept=await paidOut(w,op),intact=readFileSync(path,'utf8');
 op.close();writeFileSync(path,'{not json');
 op=await open();
 assert.match(String(warned.mock.calls[0]!.arguments[0]),/Batch 0's record is unreadable/);
 assert.deepEqual(indexed(w.dir),['',kept.txid]);
 await op.submit(redeposit(op,kept));
 await assert.rejects(op.submit(redeposit(op,lost)),owes(1000n,100n,0n));
 op.close();writeFileSync(path,intact);
 op=await open();
 assert.deepEqual(indexed(w.dir),[lost.txid,kept.txid]);
 await op.submit(redeposit(op,lost));
});

test('a followed batch is indexed as it is recorded, so a restart still exempts its payout',async t=>{
 const w=await world(64),a=await w.open(t),dir=mkdtempSync(join(tmpdir(),'rollup-epoch-fee-indexed-')),open=()=>w.open(t,{...w.fee(),snapshotEvery:1,directory:dir});
 const payout=await paidOut(w,a),{tx,checkpoints}=landedTx(w,0);
 let b=await open();
 await b.follow({tx,checkpoints,at:1});
 assert.deepEqual(indexed(dir),[tx.id]);
 b.close();rmSync(join(dir,'batches','0.json'));
 b=await open();
 await land(b,'spend',[redeposit(b,payout)]);
});

test('a commit that fails leaves its index entry ahead of the journal, and the retried batch takes that place',async t=>{
 const w=await world(64),a=await w.open(t);
 await land(a,'spend',[fastSpend(a.state)]);
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-fee-unwritten-')),b=await w.open(t,{...w.fee(),directory:dir}),{archive}=b.status(),{tx}=landedTx(w,0);
 const moving=b.relocate({head:archive.head,reserves:archive.reserves});
 await assert.rejects(b.follow({...landedTx(w,0),at:1}),/in flight/);
 assert.deepEqual(indexed(dir),[tx.id],'the entry is written before the commit');
 await moving;
 await b.follow({...landedTx(w,0),at:1});
 assert.deepEqual(indexed(dir),[tx.id],'the retry replaces it, so later batches stay aligned');
});

test('with no deposit fee the operator neither writes the batch txid index nor reads one',async t=>{
 const w=await world(64),warned=t.mock.method(console,'warn',()=>{});
 let op=await w.open(t,{snapshotEvery:1});
 await paidOut(w,op);op.close();
 assert.equal(readdirSync(w.dir).includes('batch-txids.json'),false);
 writeFileSync(txidIndex(w.dir),'{not json');
 op=await w.open(t,{snapshotEvery:1});
 await paidOut(w,op);
 assert.equal(readFileSync(txidIndex(w.dir),'utf8'),'{not json');
 assert.equal(warned.mock.calls.length,0);
});

test('a group whose id does not commit to its members answers group-invalid before its missing fee',async t=>{
 const w=await world(64),op=await w.open(t,w.fee()),{dummies:[a,b]}=groupOf(),g={groupId:groupOf().group.id,groupSize:2};
 const first=spendOf(deposit(op.state,1000n,{inputs:[a],...g}),{coin:w.cash(2000n)});
 await op.submit(first);
 await assert.rejects(op.submit(spendOf(deposit(op.state,1000n,{inputs:[b],...g}))),rejection('group-invalid'));
 assert.deepEqual(op.pendingIds(),[first.id],'group-invalid strands the rest of the group, as before');
});

test('a payout exempts its unit only when every coin in the unit is one',async t=>{
 const w=await world(64),op=await w.open(t,w.fee()),payout=await paidOut(w,op),{dummies:[a,b],group}=groupOf();
 await op.submit(spendOf(deposit(op.state,10_000n,{inputs:[a],groupId:group.id,groupSize:2}),{coin:payout}));
 await assert.rejects(op.submit(await w.shield(op.state,1000n,{fee:100n,dummy:b,group,coin:w.cash(10_000n)})),owes(10_000n,100n,0n));
});

test('the fee check runs after the double-spend check, so a landed copy still answers double-spend',async t=>{
 const w=await world(64),op=await w.open(t,w.fee()),paid=await w.shield(op.state,10_000n,{fee:100n}),{ciphertext:_,...stripped}=paid;
 await land(op,'spend',[paid]);
 await assert.rejects(op.submit({...stripped,id:'stripped'}),rejection('double-spend'));
});

test('an asset deposit\'s carrier pays nothing at the free allowance and the fee above it',async t=>{
 const drops:string[][]=[],w=await world(64),op=await w.open(t,{...w.fee(),onDrop:ids=>drops.push(ids)});
 await listed(op);
 const [free,allowance]=assetDeposit(w,op,330n),[waiting,carrier]=assetDeposit(w,op,1000n);
 for(const s of [free,allowance,waiting])await op.submit(s);
 await assert.rejects(op.submit(carrier),owes(1000n,100n,0n));
 await assert.rejects(op.submit(spendOf(deposit(op.state,330n),{coin:w.cash(330n)})),owes(330n,100n,0n),'a plain deposit of the allowance');
 assert.deepEqual([op.pendingIds(),drops],[[free.id,allowance.id],[[waiting.id]]],'the refused group leaves whole, its asset leg reported dropped');
});

test('an asset unit owes one carrier fee on its BTC total, and one leg\'s note must cover it alone',async t=>{
 const w=await world(64),op=await w.open(t,w.fee());
 await listed(op);
 const unit=async(fees:bigint[])=>{
  const {dummies:[a,...legs],group}=groupOf(3),g={groupId:group.id,groupSize:3};
  const members=[spendOf(deposit(op.state,5000n,{asset:assetFieldOfId(x),inputs:[a],...g}),{asset:x,coin:{...w.cash(660n),assetAmount:5000n}}),...await Promise.all(legs.map((d,i)=>w.shield(op.state,330n,{fee:fees[i],dummy:d,group}).then(coinless)))];
  for(const s of members.slice(0,-1))await op.submit(s);
  return op.submit(members.at(-1)!);
 };
 await assert.rejects(unit([]),owes(660n,100n,0n),'two 330-sat carriers pay on 660 together');
 await assert.rejects(unit([50n,50n]),owes(660n,100n,50n),'two notes that cover it only when summed');
 await unit([100n]);
});

test('a fee refusal drops its whole group at once, so the same notes rebuilt with the fee are admitted',async t=>{
 const drops:[string[],string][]=[],w=await world(64),op=await w.open(t,{...w.fee(),onDrop:(ids,reason)=>drops.push([ids,reason])});
 await listed(op);
 const {dummies:[a,b],group}=groupOf(),assetLeg=spendOf(deposit(op.state,5000n,{asset:assetFieldOfId(x),inputs:[a],groupId:group.id,groupSize:2}),{asset:x,coin:{...w.cash(1000n),assetAmount:5000n}});
 await op.submit(assetLeg);
 await assert.rejects(op.submit(coinless(await w.shield(op.state,1000n,{dummy:b,group}))),owes(1000n,100n,0n));
 assert.deepEqual([drops.map(([ids])=>ids),op.pending()],[[[assetLeg.id]],0]);
 assert.match(drops[0]![1],/deposit fee/);
 await op.submit({...assetLeg,id:'rebuilt'});
 await op.submit(coinless(await w.shield(op.state,1000n,{dummy:b,group,fee:100n})));
 assert.equal(op.pending(),2);
});

test('a pool with no deposit fee configured admits a fee-less deposit unchanged',async t=>{
 const w=await world(64),op=await w.open(t);
 await land(op,'spend',[await w.shield(op.state,10_000n)]);
 assert.equal(op.status().archive.head.value,110_330);
});
