import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {asset,CSVMultisigTapscript,SingleKey,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,EPOCH_NULLIFIER_DEPTH,ROLLUP_FIELD,SUBTREE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState,type EpochSlot} from '../packages/protocol/src/rollup/epoch.ts';
import {RollupNullifiers} from '../packages/protocol/src/rollup/nullifiers.ts';
import {rollupEpochPoolTree,ROLLUP_STATE_PACKET,type SnarkProof} from '../src/rollup/covenant.ts';
import {encodeEpochNfArchive,epochNfArchivePath,readEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';
import {openRollupEpochOperator,type RollupEpochRecord,type RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {decodeEpochSnapshot,encodeEpochSnapshot,EPOCH_SNAPSHOT_VERSION} from '../src/rollup/epoch-snapshot.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {ROLLUP_RESEND_GRACE_MS,type RollupTransport} from '../src/rollup/operator.ts';
import {rollupSpecOf} from '../src/rollup/service.ts';
import {headCommitment,writeSnapshot} from '../src/rollup/snapshot.ts';
import type {StockReleasePin} from '../src/stock/journal.ts';
import type {StockWireRequest} from '../src/stock/transport.ts';
import {epochHarness,rejection} from './fixtures/epoch.ts';
import {offlineNativeFixture} from './fixtures/native.ts';

const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const {deposit,dummyInput,fill,recovery,recoverSlot}=epochHarness(hash);
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const pin:StockReleasePin={version:1,network:'local-stock',descriptorProfileId:'11'.repeat(32),programsHash:'22'.repeat(32),artifactsHash:'33'.repeat(32),checkpointHash:'44'.repeat(32),genesisTxid:'55'.repeat(32),serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
const resealed=(bytes:Buffer,edit:(b:Buffer)=>void)=>{const b=Buffer.from(bytes);edit(b);createHash('sha256').update(b.subarray(0,-32)).digest().copy(b,b.length-32);return b;};
/** epochLen 2: batches 2 and 4 rotate, archiving epochs -1 and 0, then batch 5 recovers a note of epoch 0. */
const grown=()=>{
 const s=EpochState.genesis(hash,2,false);
 let nf0=s.prevNf;
 for(let n=0;n<5;n++){s.apply('spend',fill(s));if(n===2)nf0=s.prevNf;}
 s.apply('recover',[recoverSlot(s,0,dummyInput())]);
 return {s,nf0};
};

test('an epoch snapshot plus its archive file restores the state it was taken from',()=>{
 const {s,nf0}=grown(),dir=mkdtempSync(join(tmpdir(),'rollup-epoch-snapshot-')),bytes=encodeEpochSnapshot(s,pin),file=(e:number)=>epochNfArchivePath(dir,e);
 writeSnapshot(file(0),encodeEpochNfArchive(0,nf0));writeSnapshot(file(1),encodeEpochNfArchive(1,s.prevNf));
 const parts=decodeEpochSnapshot(bytes,hash,pin,6)!,restored=EpochState.restore(hash,{...parts,prevNf:readEpochNfArchive(file(1),hash,{epoch:1,root:parts.prevNfRoot})},false);
 assert.deepEqual([restored.commitment(),restored.epoch,restored.archive.count()],[s.commitment(),2,2]);
 assert.deepEqual(encodeEpochSnapshot(restored,pin),bytes);
 const next=[recoverSlot(s,0,dummyInput())];
 assert.throws(()=>restored.apply('recover',next),rejection('recover-unarchived'),'a restored archive holds no frozen set until its file is loaded');
 restored.archive.load(0,readEpochNfArchive(file(0),hash,{epoch:0,root:restored.archive.list()[1]!.nfFinal}));restored.archive.load(1,restored.prevNf);
 assert.deepEqual(restored.apply('recover',next),s.apply('recover',next));
});

test('a snapshot from another pin, another version, or a damaged body is ignored, not half-read',()=>{
 const {s}=grown(),good=encodeEpochSnapshot(s,pin),flipped=Buffer.from(good);flipped[200]!^=1;
 const reencoded=(edit:(r:EpochState)=>void)=>{const r=EpochState.restore(hash,{...decodeEpochSnapshot(good,hash,pin,6)!,prevNf:s.prevNf},false);edit(r);return encodeEpochSnapshot(r,pin);};
 const cases:Record<string,[Buffer,StockReleasePin?]>={
  'another pin':[good,{...pin,genesisTxid:'ee'.repeat(32)}],'another version':[resealed(good,b=>{b.writeUInt16LE(EPOCH_SNAPSHOT_VERSION+1,4);})],'a flipped body byte':[flipped],truncated:[good.subarray(0,-1)],
  'an archive node off its children':[reencoded(r=>r.archive.tree.place(1,0,r.archive.tree.node(1,0)+1n))],
  'an archive record off its tree leaf':[reencoded(r=>{const list=r.archive.list();r.archive.list=()=>list.map((a,i)=>i===1?{...a,nfFinal:a.nfFinal+1n}:a);})],
  // Poseidon reduces mod p, so the largest value plus p keeps the list sorted and the root unchanged.
  'a hot nullifier past the field':[reencoded(r=>{const scan=r.nullifiers.scanLeaves.bind(r.nullifiers);r.nullifiers.scanLeaves=visit=>scan((value,next)=>visit(next===0&&value>0n?value+ROLLUP_FIELD:value,next));})],
 };
 assert.ok(decodeEpochSnapshot(reencoded(()=>{}),hash,pin,6));
 for(const [name,[bytes,p=pin]] of Object.entries(cases))assert.equal(decodeEpochSnapshot(bytes,hash,p,6),undefined,name);
});

test('the epoch note-count invariant is the current epoch, not the whole history',()=>{
 const {s}=grown(),good=encodeEpochSnapshot(s,pin),block=2**SUBTREE_DEPTH;
 // Header: magic 0, version 4, depths 6, pin 11, then batchCount 43, noteCount 47, nfCount, rsCount, erCount, epoch 63.
 assert.deepEqual([s.batchCount,s.epoch,s.noteCount],[6,2,2*block]);
 assert.equal(decodeEpochSnapshot(good,hash,pin,6)?.noteCount,2*block,'the epoch-local count is accepted');
 const cases={'the global count':resealed(good,b=>{b.writeUInt32LE(6*block,47);}),'an epoch its batch count never reaches':resealed(good,b=>{b.writeUInt32LE(1,63);b.writeUInt32LE(4*block,47);})};
 for(const [name,bytes] of Object.entries(cases))assert.equal(decodeEpochSnapshot(bytes,hash,pin,6),undefined,name);
});

test('a nullifier archive file is refused unless it rebuilds the archived root',()=>{
 const set=(...values:bigint[])=>{const s=new RollupNullifiers(hash,EPOCH_NULLIFIER_DEPTH);values.forEach(v=>s.insert(v));return s;};
 const nf0=set(11n,22n),nf1=set(5n,30n,17n),expect={epoch:1,root:nf1.root()},dir=mkdtempSync(join(tmpdir(),'rollup-nf-archive-')),good=encodeEpochNfArchive(1,nf1);
 const file=(name:string,bytes:Buffer)=>{const path=join(dir,name);writeFileSync(path,bytes);return path;};
 const flipped=(at:number)=>{const b=Buffer.from(good);b[at]!^=1;return b;};
 assert.deepEqual(readEpochNfArchive(file('good',good),hash,expect).root(),expect.root);
 const bad={truncatedFile:good.subarray(0,-1),flippedLeafByte:flipped(14+36),anotherEpochsFile:encodeEpochNfArchive(0,nf0),flippedTrailer:flipped(good.length-1),relabeledSet:encodeEpochNfArchive(1,nf0)};
 const accepted=Object.entries(bad).filter(([name,bytes])=>{try{readEpochNfArchive(file(name,bytes),hash,expect);return true;}catch(error){return !/archive/.test((error as Error).message);}});
 assert.deepEqual(accepted.map(([name])=>name),[]);
});

const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-epoch-covenant-snarkjs.json','utf8')) as {clientKey:{vk_delta_2:unknown;IC:unknown[]};batchKey:{vk_delta_2:unknown;IC:unknown[]}};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
// Built as tests/rollup-epoch-operator.test.ts builds them; every batch here is stub-proved.
const leaves=await (async()=>{
 const {clientKey,batchKey}=fixture,dir=mkdtempSync(join(tmpdir(),'rollup-epoch-keys-'));
 const wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 const keys={'epoch-spend':clientKey,'epoch-join':{...clientKey,vk_delta_2:batchKey.vk_delta_2},'epoch-batch-spend':wide,'epoch-batch-join':wide,'epoch-batch-recover':batchKey};
 mkdirSync(join(dir,'keys'));
 for(const [name,key] of Object.entries(keys))writeFileSync(join(dir,'keys',`${name}.vkey.json`),JSON.stringify(key));
 writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf('epoch',token,'aa'.repeat(32))));
 try{return await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));}finally{rmSync(dir,{recursive:true,force:true});}
})();
const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
const exitDelay={type:'seconds' as const,value:2048},pool=rollupEpochPoolTree(server,emulator,leaves,exitDelay);
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
const proof:SnarkProof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1']};
type Spend=Omit<RollupEpochSpend,'receivedAt'>;
type Operator=Awaited<ReturnType<typeof openRollupEpochOperator>>;
let ids=0;
const spendOf=(w:{slot:EpochSlot;publicSignals:bigint[]},origin?:number):Spend=>({id:`s${++ids}`,slot:w.slot,publics:w.publicSignals as unknown as Spend['publics'],proof,...(origin===undefined?{}:{origin})});
const fastSpend=(s:EpochState,inputs?:ReturnType<typeof dummyInput>[])=>spendOf(deposit(s,0n,inputs?{inputs}:{}));
const recoverSpend=(s:EpochState,origin:number,note=dummyInput())=>spendOf(recovery(s,origin,note),origin);

async function world(){
 const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-restart-')),landed:StockWireRequest[]=[],submitted:string[][]=[],net={down:false,now:0};
 const le32=(value:bigint)=>Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n)),files=()=>readdirSync(join(dir,'nullifiers')).sort();
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,Uint8Array.from([...le32(EpochState.genesis(hash,2).commitment()),...le32(0n),...le32(0n)]))]);
 const transport:RollupTransport={
  submit:async request=>{if(net.down)throw new Error('The Arkade Service is unreachable.');landed.push(request);submitted.push(files());return {txid:Transaction.fromPSBT(base64.decode(request.arkTx)).id,checkpointTxids:request.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:request.arkTx,signedCheckpointTxs:request.checkpoints,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};},
  lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,
 };
 const stub={prove:async()=>proof};
 const options={directory:dir,epochLen:2,hash,leaves,token,serverKey:server,emulatorKey:emulator,exitDelay,checkpoint,transport,signDeposits:async()=>undefined,batchWaitMs:0,snapshotEvery:1,verify:async()=>true,now:()=>net.now,
  pin:{version:1 as const,network:'local-stock' as const,descriptorProfileId:sha('rollup-epoch-restart-test'),programsHash:sha(leaves.batchRecover),artifactsHash:sha('stub'),checkpointHash:sha(checkpoint.script),genesisTxid:parent.id,serverKey:hex.encode(server),emulatorKey:hex.encode(emulator)},
  genesis:{version:1 as const,head:{txid:parent.id,vout:0,value:100_330,sourceTxHex:hex.encode(parent.toBytes())},reserves:{},batches:0},
  clientKey:{spend:{},join:{},recover:{}},prover:{spend:stub,join:stub,recover:stub}};
 return {dir,landed,submitted,net,files,nf:(e:number)=>epochNfArchivePath(join(dir,'nullifiers'),e),
  open:async(t:TestContext,directory=dir)=>{const op=await openRollupEpochOperator({...options,directory});t.after(()=>op.close());return op;}};
}
type World=Awaited<ReturnType<typeof world>>;
const landedTx=(w:World,n:number)=>({tx:Transaction.fromPSBT(base64.decode(w.landed[n]!.arkTx)),checkpoints:w.landed[n]!.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)))});
const recordAt=(w:World,n:number)=>JSON.parse(readFileSync(join(w.dir,'batches',`${n}.json`),'utf8')) as RollupEpochRecord;
const queue=async(op:Operator,client:Spend)=>{await op.submit(client);op.addPadding(Array.from({length:BATCH_SLOTS-1},()=>({...fastSpend(op.state),receivedAt:Infinity})));};
async function land(op:Operator,client:Spend){
 await queue(op,client);
 const tick=await op.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
}

test('the operator writes one archive file per rotation and reopens from the snapshot across one',async t=>{
 const w=await world(),op=await w.open(t),snapshot=join(w.dir,'snapshot.bin'),after:string[][]=[],[e0,e1]=['epoch-0.nf','epoch-1.nf'];
 let before=Buffer.alloc(0);
 for(let n=0;n<5;n++){await land(op,fastSpend(op.state));after.push(w.files());if(n===3)before=readFileSync(snapshot);}
 // Batches 2 and 4 rotate: each frozen set is written once the journal accepts its batch, and not while that batch is sent.
 assert.deepEqual([w.submitted,after],[[[],[],[],[e0],[e0]],[[],[],[e0],[e0],[e0,e1]]]);
 const commitment=op.state.commitment(),head=readFileSync(snapshot),records=Array.from({length:4},(_,n)=>join(w.dir,'batches',`${n}.json`)),kept=records.map(path=>readFileSync(path));
 op.close();records.forEach(path=>rmSync(path));
 const reopened=await w.open(t);
 assert.deepEqual([reopened.state.commitment(),headCommitment(reopened.status().archive.head.sourceTxHex)],[commitment,commitment]);
 assert.deepEqual([reopened.state.epoch,reopened.state.archive.count(),reopened.state.archive.loaded(0)],[2,2,false],'resumed from the snapshot, without batches 0 to 3');
 reopened.close();
 writeFileSync(snapshot,before);rmSync(w.nf(1));
 const across=await w.open(t);
 assert.deepEqual([across.state.commitment(),existsSync(w.nf(1))],[commitment,true],'a snapshot from before batch 4 replays its rotation and writes the set it froze');
 across.close();
 const damaged=readFileSync(w.nf(1));damaged[20]!^=1;
 records.forEach((path,n)=>writeFileSync(path,kept[n]!));writeFileSync(snapshot,head);writeFileSync(w.nf(1),damaged);
 const replayed=await w.open(t);
 assert.deepEqual([replayed.state.commitment(),replayed.state.archive.loaded(0)],[commitment,true],'a previous-epoch archive that does not rebuild its root sends the boot back to genesis');
 assert.equal(readEpochNfArchive(w.nf(1),hash,{epoch:1,root:replayed.state.prevNfRoot}).root(),replayed.state.prevNfRoot,'which writes it again');
});

test('a rotating batch writes no archive file while its acceptance is unresolved',async t=>{
 const w=await world(),op=await w.open(t);
 for(let n=0;n<2;n++)await land(op,fastSpend(op.state));
 w.net.down=true;await queue(op,fastSpend(op.state));
 assert.match((await op.tick() as {blocked:string}).blocked,/unreachable/);
 assert.deepEqual([op.state.epoch,op.status().archive.batches,w.files()],[1,2,[]],'applied and rotated, but not accepted');
 w.net.down=false;w.net.now+=ROLLUP_RESEND_GRACE_MS;
 assert.equal((await op.tick() as {batch:number}).batch,2);
 assert.deepEqual(w.files(),['epoch-0.nf']);
});

test('after a restart a recovery loads its origin\'s archive files at admission, at the batch and when followed',async t=>{
 const w=await world(),op=await w.open(t),spent=dummyInput(),followerDir=mkdtempSync(join(tmpdir(),'rollup-epoch-follower-'));
 await land(op,fastSpend(op.state,[spent]));
 for(let n=1;n<5;n++)await land(op,fastSpend(op.state));
 const b=await w.open(t,followerDir);
 for(let n=0;n<5;n++)await b.follow({...landedTx(w,n),at:1});
 op.close();b.close();
 const a=await w.open(t),follower=await w.open(t,followerDir);
 assert.deepEqual([a.state.archive.loaded(0),follower.state.archive.loaded(0)],[false,false],'both resumed from a snapshot');
 await assert.rejects(a.submit(recoverSpend(a.state,0,spent)),rejection('double-spend'),'the loaded file holds what epoch 0 spent');
 await a.submit(recoverSpend(a.state,0));
 // Unloads every frozen set, as an eviction would, so the batch must load them again.
 a.state.archive.restore(a.state.archive.list());
 const tick=await a.tick();
 assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
 await follower.follow({...landedTx(w,5),slots:recordAt(w,5).slots,at:1});
 assert.deepEqual([follower.state.commitment(),headCommitment(a.status().archive.head.sourceTxHex)],[a.state.commitment(),a.state.commitment()]);
 a.close();rmSync(w.nf(0));
 const c=await w.open(t);
 await assert.rejects(c.submit(recoverSpend(c.state,0)),(error:unknown)=>rejection('recover-unarchived')(error)&&(error as Error).message.includes(w.nf(0)));
 await land(c,fastSpend(c.state));
});
