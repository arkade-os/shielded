import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test,type TestContext} from 'node:test';
import {asset,CSVMultisigTapscript,MultisigTapscript,SingleKey,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {F1Field} from 'ffjavascript';
import * as snarkjs from 'snarkjs';
import {BTC_ASSET,ROLLUP_DOMAIN,ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import {clientWitness} from '../packages/protocol/src/rollup/client.ts';
import {destinationFieldOf,ownerOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {DEFAULT_VM_BINARY,executeVmBinary} from '../src/sdk/runtime.ts';
import type {StockWireRequest} from '../src/stock/transport.ts';
import type {RollupSpend} from '../src/rollup/batcher.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {loadRollupLeaves} from '../src/rollup/leaves.ts';
import {openRollupOperator,type RollupArchive,type RollupTransport} from '../src/rollup/operator.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const field=new F1Field(ROLLUP_FIELD);
const toy=(name:string)=>join('tests','fixtures','rollup-toy',name);
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
const owner=ownerOf(hash,ROLLUP_DOMAIN,7n);
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const le32=(value:bigint)=>Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
let counter=5000n;
const fresh=()=>++counter;

/** A toy client proof for a real Poseidon statement: the toy circuit only needs pub = w^2. */
async function toySpend(id:string,root:bigint,leg:{deposit?:bigint;withdraw?:bigint;program?:Uint8Array;coin?:RollupCoin}={}):Promise<Omit<RollupSpend,'receivedAt'>> {
 for(;;){
  const deposit=leg.deposit??0n,withdraw=leg.withdraw??0n,destination=leg.program?destinationFieldOf(leg.program):0n;
  const w=clientWitness(hash,{domain:ROLLUP_DOMAIN,root,asset:BTC_ASSET,inputs:[{amount:withdraw,spendSecret:fresh(),rho:fresh(),index:0,path:Array(32).fill(0n)}],
   outputs:[{amount:deposit,owner,random:fresh()},{amount:0n,owner,random:fresh()}],deposit,withdraw,destination,ctDigest:fresh(),groupId:0n,groupSize:0});
  const root2=field.sqrt(w.publicSignals[0]!);
  if(root2===null)continue;
  const [pub,dep,wd,a,d]=w.publicSignals.map(String);
  const {proof}=await snarkjs.groth16.fullProve({pub,deposit:dep,withdraw:wd,boundaryAsset:a,destination:d,w:String(root2)},toy('covenant-client.wasm'),toy('covenant-client.zkey'));
  return {id,slot:w.slot,publics:w.publicSignals as unknown as RollupSpend['publics'],proof:proof as SnarkProof,...(leg.program?{program:leg.program}:{}),...(leg.coin?{coin:leg.coin}:{})};
 }
}
after(async()=>{await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();});
const pads=(root:bigint,count:number)=>Promise.all(Array.from({length:count},()=>toySpend('pad',root))).then(list=>list.map(s=>({...s,receivedAt:Infinity})));

async function world(){
 const dir=mkdtempSync(join(tmpdir(),'rollup-operator-'));
 writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',slots:11,kind:0,token,operator:'aa'.repeat(32)}));
 const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));
 const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const exitDelay={type:'seconds' as const,value:2048},pool=rollupPoolTree(server,emulator,leaves,exitDelay);
 const depositor=SingleKey.fromHex('03'.repeat(32)),userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
 const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const statePacket=Uint8Array.from([...le32(RollupState.genesis(hash).commitment()),...le32(0n)]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:2_500n},{script:userTree.pkScript,amount:2_500n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,statePacket)]);
 const coin=(vout:number):RollupCoin=>({txid:parent.id,vout,value:2500,sourceTx:parent.toBytes(),tapTree:userTree.encode(),leaf:userTree.findLeaf(hex.encode(userCollab))});
 const genesis:RollupArchive={version:1,head:{txid:parent.id,vout:0,value:100_330,sourceTxHex:hex.encode(parent.toBytes())},reserves:{},batches:0};
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
 const transport:RollupTransport={
  submit:async request=>{
   const r=await executeVmBinary(DEFAULT_VM_BINARY,request);
   if(!r.ok)throw new Error(r.error);
   return {txid:Transaction.fromPSBT(base64.decode(r.arkTx!)).id,checkpointTxids:r.checkpoints!.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:r.arkTx!,signedCheckpointTxs:r.checkpoints!,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};
  },
  lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,
 };
 const signDeposits=async(request:StockWireRequest,spends:RollupSpend[])=>{
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-spends.length;
  const vins=Array.from({length:spends.length},(_,i)=>first+i),signed=await depositor.sign(ark,vins);
  const checkpoints=await Promise.all(request.checkpoints.map(async(encoded,vin)=>vin<first?encoded:base64.encode((await depositor.sign(Transaction.fromPSBT(base64.decode(encoded)),[0])).toPSBT())));
  return {arkTx:base64.encode(signed.toPSBT()),checkpoints} as StockWireRequest|undefined;
 };
 const clock={now:0};
 const options={directory:dir,pin:{version:1 as const,network:'local-stock' as const,descriptorProfileId:sha('rollup-test'),programsHash:sha(leaves.batch),artifactsHash:sha('toy'),checkpointHash:sha(checkpoint.script),genesisTxid:parent.id,serverKey:hex.encode(server),emulatorKey:hex.encode(emulator)},
  genesis,leaves,token,serverKey:server,emulatorKey:emulator,exitDelay,checkpoint,clientKey:fixture.clientKey,hash,transport,signDeposits,now:()=>clock.now,
  prover:{prove:async(_input:Record<string,unknown>,expected:readonly bigint[])=>(await snarkjs.groth16.fullProve({x:expected.map(String)},toy('covenant-batch.wasm'),toy('covenant-batch.zkey'))).proof as SnarkProof}};
 return {dir,options,clock,coin,transport,open:async(t:TestContext,overrides={})=>{const op=await openRollupOperator({...options,...overrides});t.after(()=>op.close());return op;}};
}

test('the operator batches a deposit and then a withdrawal through the covenant, and replays them after a restart',async(t)=>{
 const w=await world(),op=await w.open(t);
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 op.addPadding(await pads(op.state.latestRoot(),10));
 assert.equal(await op.tick(),undefined,'waits for the batch window');
 w.clock.now=10_000;
 assert.deepEqual(Object.keys((await op.tick())!),['txid','batch']);
 assert.equal(op.status().archive.head.value,102_830);
 await op.submit(await toySpend('withdraw',op.state.latestRoot(),{withdraw:1000n,program:new Uint8Array(32).fill(0x52)}));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=20_000;
 assert.equal(((await op.tick()) as {batch:number}).batch,1);
 assert.equal(op.status().archive.head.value,101_830);
 assert.ok(existsSync(join(w.dir,'batches','1.json')));
 const commitment=op.state.commitment();
 op.close();

 const reopened=await w.open(t);
 assert.equal(reopened.state.commitment(),commitment);
});

test('a deposit that is never signed is dropped and the rest of the batch goes through',async(t)=>{
 const w=await world();
 let refuse=true;
 const op=await w.open(t,{signDeposits:async(request:StockWireRequest,spends:RollupSpend[])=>refuse?undefined:w.options.signDeposits(request,spends)});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/did not sign/);
 assert.equal(op.state.batchCount,0);
 assert.equal(op.pending(),1);
 refuse=false;
 assert.equal(((await op.tick()) as {batch:number}).batch,0);
 assert.equal(op.status().archive.head.value,100_330);
});

test('a submission with no outcome blocks the pool until the head is shown unspent, then it is abandoned',async(t)=>{
 const w=await world();
 let down=true;
 const op=await w.open(t,{transport:{...w.transport,submit:async(request:StockWireRequest,first:number)=>{if(down)throw new Error('emulator unreachable');return w.transport.submit(request,first);}}});
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/unreachable/);
 assert.equal(op.state.batchCount,1,'the unconfirmed batch stays applied while its outcome is unknown');
 down=false;
 assert.equal(((await op.tick()) as {batch:number}).batch,0);
 assert.equal(op.status().archive.batches,1);
});

test('an over-weight batch is caught before submission and its newest deposit waits',async(t)=>{
 const w=await world(),op=await w.open(t,{weightLimit:20_000});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/weight/);
 assert.equal(op.state.batchCount,0);
 assert.equal(op.status().pending,undefined,'nothing reached the journal');
 assert.equal(op.pending(),2);
});

test('admission refuses forged statements, proofs and boundary legs, and double spends',async(t)=>{
 const w=await world(),op=await w.open(t),root=op.state.latestRoot();
 const good=await toySpend('a',root);
 await assert.rejects(op.submit({...good,publics:[good.publics[0]+1n,...good.publics.slice(1)] as unknown as RollupSpend['publics']}),/statement/);
 const other=await toySpend('b',root);
 await assert.rejects(op.submit({...good,proof:other.proof}),/Invalid client proof/);
 const payout=await toySpend('c',root,{withdraw:5n,program:new Uint8Array(32).fill(1)});
 await assert.rejects(op.submit({...payout,program:new Uint8Array(32).fill(2)}),/destination/);
 await op.submit(good);
 await assert.rejects(op.submit({...good,id:'again'}),/already spent or pending/);
});
