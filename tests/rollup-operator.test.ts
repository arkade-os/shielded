import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
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
import {assetFieldOfId,destinationFieldOf,groupIdOf,nullifierOf,ownerOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {DEFAULT_VM_BINARY,executeVmBinary} from '../src/sdk/runtime.ts';
import type {StockNativeReceipt,StockWireRequest} from '../src/stock/transport.ts';
import type {RollupSpend} from '../src/rollup/batcher.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {loadRollupLeaves} from '../src/rollup/leaves.ts';
import {openRollupOperator,type RollupArchive,type RollupDepositFacts,type RollupTransport} from '../src/rollup/operator.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const field=new F1Field(ROLLUP_FIELD);
const toy=(name:string)=>join('tests','fixtures','rollup-toy',name);
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown};
const token=asset.AssetId.create('cc'.repeat(32),0).toString(),x=asset.AssetId.create('dd'.repeat(32),0).toString();
const owner=ownerOf(hash,ROLLUP_DOMAIN,7n);
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const le32=(value:bigint)=>Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));
let counter=5000n;
const fresh=()=>++counter;

interface Leg {deposit?:bigint;withdraw?:bigint;asset?:string;program?:Uint8Array;coin?:RollupCoin&{assetAmount?:bigint};groupId?:bigint;groupSize?:number;ctDigest?:bigint}
const spendOf=async(id:string,w:ReturnType<typeof clientWitness>,root2:unknown,leg:Leg):Promise<Omit<RollupSpend,'receivedAt'>>=>{
 const [pub,deposit,withdraw,boundaryAsset,destination]=w.publicSignals.map(String);
 const {proof}=await snarkjs.groth16.fullProve({pub,deposit,withdraw,boundaryAsset,destination,w:String(root2)},toy('covenant-client.wasm'),toy('covenant-client.zkey'));
 return {id,slot:w.slot,publics:w.publicSignals as unknown as RollupSpend['publics'],proof:proof as SnarkProof,
  ...(leg.asset&&(leg.deposit||leg.withdraw)?{asset:leg.asset}:{}),...(leg.program?{program:leg.program}:{}),...(leg.coin?{coin:leg.coin}:{})};
};
const witnessOf=(root:bigint,leg:Leg,input:{spendSecret:bigint;rho:bigint},groupId:bigint,groupSize:number)=>
 clientWitness(hash,{domain:ROLLUP_DOMAIN,root,asset:leg.asset?assetFieldOfId(leg.asset):BTC_ASSET,inputs:[{amount:leg.withdraw??0n,...input,index:0,path:Array(32).fill(0n)}],
  outputs:[{amount:leg.deposit??0n,owner,random:fresh()},{amount:0n,owner,random:fresh()}],deposit:leg.deposit??0n,withdraw:leg.withdraw??0n,
  destination:leg.program?destinationFieldOf(leg.program):0n,ctDigest:leg.ctDigest??fresh(),groupId,groupSize});

/** A toy client proof for a real Poseidon statement: the toy circuit only needs pub = w^2. */
async function toySpend(id:string,root:bigint,leg:Leg={}):Promise<Omit<RollupSpend,'receivedAt'>> {
 for(;;){
  const w=witnessOf(root,leg,{spendSecret:fresh(),rho:fresh()},leg.groupId??0n,leg.groupSize??0);
  const root2=field.sqrt(w.publicSignals[0]!);
  if(root2===null)continue;
  return spendOf(id,w,root2,leg);
 }
}
/** A toy group, whose id commits to its members' first nullifiers as the batch requires. */
async function toyGroup(ids:string[],root:bigint,legs:Leg[]):Promise<Omit<RollupSpend,'receivedAt'>[]> {
 for(;;){
  const inputs=legs.map(()=>({spendSecret:fresh(),rho:fresh()}));
  const groupId=groupIdOf(hash,inputs.map(i=>nullifierOf(hash,ROLLUP_DOMAIN,i.spendSecret,i.rho)));
  const made=legs.map((leg,i)=>witnessOf(root,leg,inputs[i]!,groupId,legs.length));
  const roots=made.map(w=>field.sqrt(w.publicSignals[0]!));
  if(roots.some(r=>r===null))continue;
  const group:Omit<RollupSpend,'receivedAt'>[]=[];
  // One proof at a time: two concurrent first proofs race to build snarkjs's curve, and only one gets terminated.
  for(const [i,w] of made.entries())group.push(await spendOf(ids[i]!,w,roots[i],legs[i]!));
  return group;
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
 return {dir,options,clock,coin,transport,depositor,open:async(t:TestContext,overrides={})=>{const op=await openRollupOperator({...options,...overrides});t.after(()=>op.close());return op;}};
}

/** A network that accepts one batch, loses the reply, and indexes it only once the test says so. */
function lossyNetwork(w:Awaited<ReturnType<typeof world>>){
 const net={landed:undefined as {arkTx:string;receipt:StockNativeReceipt}|undefined,indexed:false,sent:[] as string[]};
 const transport:RollupTransport={...w.transport,
  submit:async(request:StockWireRequest,first:number)=>{
   net.sent.push(request.arkTx);
   if(net.landed)throw new Error(net.landed.arkTx===request.arkTx?'the emulator already knows this batch':'the head is already spent');
   net.landed={arkTx:request.arkTx,receipt:await w.transport.submit(request,first)};
   throw new Error('proxy timeout after the emulator accepted it');
  },
  lookup:async request=>net.indexed&&net.landed?.arkTx===request.arkTx?net.landed.receipt:undefined,
  unspent:async()=>!(net.indexed&&net.landed),
 };
 return {net,transport};
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
 const w=await world(),drops:[string[],string][]=[];
 let refuse=true;
 const op=await w.open(t,{signDeposits:async(request:StockWireRequest,spends:RollupSpend[])=>refuse?undefined:w.options.signDeposits(request,spends),onDrop:(ids:string[],reason:string)=>drops.push([ids,reason])});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/did not sign/);
 assert.equal(op.state.batchCount,0);
 assert.equal(op.pending(),1);
 assert.deepEqual(drops.map(([ids])=>ids),[['deposit']]);
 assert.match(drops[0]![1],/did not sign/);
 refuse=false;
 assert.equal(((await op.tick()) as {batch:number}).batch,0);
 assert.equal(op.status().archive.head.value,100_330);
});

test('a submission with no outcome blocks the pool, then the exact batch is re-sent',async(t)=>{
 const w=await world();
 let down=true;
 const op=await w.open(t,{transport:{...w.transport,submit:async(request:StockWireRequest,first:number)=>{if(down)throw new Error('emulator unreachable');return w.transport.submit(request,first);}}});
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/unreachable/);
 assert.equal(op.state.batchCount,1,'the unconfirmed batch stays applied while its outcome is unknown');
 assert.match(((await op.tick()) as {blocked:string}).blocked,/no known outcome/,'re-sends are rate limited');
 down=false;w.clock.now+=300_000;
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

test('a batch whose reply was lost is re-sent and recorded instead of being replaced',async(t)=>{
 const w=await world(),{net,transport}=lossyNetwork(w),op=await w.open(t,{transport});
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/proxy timeout/);
 w.clock.now+=300_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/already knows/,'the exact journaled batch is re-sent');
 net.indexed=true;w.clock.now+=300_000;
 assert.deepEqual(await op.tick(),{txid:net.landed!.receipt.txid,batch:0});
 assert.equal(op.status().archive.batches,1);
 assert.ok(existsSync(join(w.dir,'batches','0.json')),'the accepted batch is published');
 assert.deepEqual([...new Set(net.sent)],[net.landed!.arkTx],'only one transaction is ever built on the head');
});

test('an abandoned batch that lands late is adopted, head and record included',async(t)=>{
 const w=await world(),{net,transport}=lossyNetwork(w),op=await w.open(t,{transport});
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/proxy timeout/);
 w.clock.now+=300_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/already knows/);
 w.clock.now+=300_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/abandoned/);
 assert.equal(op.state.batchCount,0,'the abandoned batch is undone');
 net.indexed=true;
 assert.deepEqual(await op.tick(),{txid:net.landed!.receipt.txid,batch:0});
 assert.equal(op.status().archive.batches,1);
 assert.ok(existsSync(join(w.dir,'batches','0.json')),'the adopted batch is published');
 assert.deepEqual([...new Set(net.sent)],[net.landed!.arkTx],'only one transaction is ever built on the head');
});

test('a deposit the network keeps refusing is dropped, and the honest spend still lands',async(t)=>{
 const w=await world();let submits=0;
 const transport:RollupTransport={...w.transport,submit:async(request:StockWireRequest,first:number)=>{
  submits++;
  if(Transaction.fromPSBT(base64.decode(request.arkTx)).inputsLength>1)throw new Error('arkd rejected the deposit input');
  return w.transport.submit(request,first);
 }};
 const op=await w.open(t,{transport});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/rejected the deposit/);
 w.clock.now+=300_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/rejected the deposit/,'the exact journaled batch is re-sent');
 w.clock.now+=300_000;
 assert.match(((await op.tick()) as {blocked:string}).blocked,/abandoned/);
 assert.equal(op.pending(),1,'the refused deposit is dropped and the transfer waits');
 assert.equal(readdirSync(join(w.dir,'abandoned')).length,1);
 assert.deepEqual(Object.keys((await op.tick())!),['txid','batch']);
 assert.equal(op.status().archive.head.value,100_330,'the batch that lands carries no deposit');
 assert.equal(submits,3,'the refused deposit is never proven or sent again');
 assert.equal(await op.tick(),undefined);
 assert.equal(readdirSync(join(w.dir,'abandoned')).length,0,'the kept plan is dropped once the head moves past it');
});

test('a deposit nobody signed drops only its own group, and the signed one still lands',async(t)=>{
 const w=await world();
 const signAllBut=(coin:number)=>async(request:StockWireRequest,spends:RollupSpend[])=>{
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-spends.length;
  const vins=spends.map((_,i)=>first+i).filter((_,i)=>spends[i]!.coin!.vout!==coin);
  const signed=await w.depositor.sign(ark,vins);
  const checkpoints=await Promise.all(request.checkpoints.map(async(encoded,vin)=>vins.includes(vin)?base64.encode((await w.depositor.sign(Transaction.fromPSBT(base64.decode(encoded)),[0])).toPSBT()):encoded));
  return {arkTx:base64.encode(signed.toPSBT()),checkpoints} as StockWireRequest|undefined;
 };
 const op=await w.open(t,{signDeposits:signAllBut(1)}),root=op.state.latestRoot();
 for(const s of await toyGroup(['unsigned','carrier'],root,[{deposit:2500n,coin:w.coin(1)},{}]))await op.submit(s);
 await op.submit(await toySpend('signed',root,{deposit:2500n,coin:w.coin(2)}));
 await op.submit(await toySpend('transfer',root));
 op.addPadding(await pads(root,9));
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/did not sign/);
 assert.equal(op.pending(),2,'the refused group goes, carrier included; the rest waits');
 w.clock.now+=10_000;
 assert.deepEqual(Object.keys((await op.tick())!),['txid','batch']);
 assert.equal(op.status().archive.head.value,102_830,'the signed deposit still lands');
 assert.equal(op.pending(),0);
});

test('a depositor that signs another coin than the one the operator built on is refused',async(t)=>{
 const w=await world();
 const op=await w.open(t,{signDeposits:async(request:StockWireRequest,spends:RollupSpend[])=>{
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-spends.length;
  const checkpoint=Transaction.fromPSBT(base64.decode(request.checkpoints[first]!));
  ark.updateInput(first,{index:2},true);checkpoint.updateInput(0,{index:2},true);
  const checkpoints=[...request.checkpoints];
  checkpoints[first]=base64.encode((await w.depositor.sign(checkpoint,[0])).toPSBT());
  return {arkTx:base64.encode((await w.depositor.sign(ark,[first])).toPSBT()),checkpoints} as StockWireRequest|undefined;
 }});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/not the batch the operator built/);
 assert.equal(op.status().archive.batches,0,'the swapped coin never reaches the emulator');
});

test('admission refuses every spend the batch itself would reject',async(t)=>{
 const w=await world(),op=await w.open(t),root=op.state.latestRoot();
 await assert.rejects(op.submit(await toySpend('lone',root,{groupId:0n,groupSize:2})),/group/,'a group size no batch can place');
 const shifted=await toySpend('shifted',root);
 await assert.rejects(op.submit({...shifted,slot:{...shifted.slot,nullifiers:[shifted.slot.nullifiers[0]!+ROLLUP_FIELD]}}),/field/,'a nullifier above the field');
 await assert.rejects(op.submit({...shifted,slot:{...shifted.slot,commitments:[shifted.slot.commitments[0]+ROLLUP_FIELD,shifted.slot.commitments[1]]}}),/field/,'a commitment above the field');
 const pair=await toyGroup(['first','second'],root,[{},{}]);
 await op.submit(pair[0]!);
 await assert.rejects(op.submit(await toySpend('odd',root,{groupId:pair[0]!.slot.groupId,groupSize:3})),/group/,'a member that disagrees on the group size');
 const payout=await toyGroup(['payout','carrier'],root,[{withdraw:5n,asset:x,program:new Uint8Array(32).fill(0x53)},{withdraw:330n,program:new Uint8Array(32).fill(0x53)}]);
 await assert.rejects(op.submit(payout[0]!),/reserve/,'an asset with no reserve to move it');
 const both=await Promise.allSettled([op.submit(shifted),op.submit({...shifted,id:'retry'})]);
 assert.deepEqual(both.map(r=>r.status),['fulfilled','rejected'],'a concurrent retry of the same request is admitted once');
 assert.equal(op.pending(),2);
});

test('a selection whose asset reserve vanished is evicted and gives its padding back',async(t)=>{
 const w=await world(),op=await w.open(t),root=op.state.latestRoot(),head=op.status().archive.head;
 await op.relocate({head,reserves:{[x]:{...head,amount:'10'}}});
 const payout=await toyGroup(['payout','carrier'],root,[{withdraw:5n,asset:x,program:new Uint8Array(32).fill(0x53)},{withdraw:330n,program:new Uint8Array(32).fill(0x53)}]);
 for(const s of payout)await op.submit(s);
 await op.submit(await toySpend('transfer',root));
 op.addPadding(await pads(root,10));
 await op.relocate({head,reserves:{}});
 w.clock.now=10_000;
 await assert.rejects(op.tick(),/No reserve/);
 assert.equal(op.pending(),0,'the selection is evicted instead of being retried forever');
 await op.submit(await toySpend('after',root));
 w.clock.now+=10_000;
 assert.deepEqual(Object.keys((await op.tick())!),['txid','batch'],'the evicted batch gave its padding back');
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

test('a deposit coin that is no longer fresh is dropped before the batch, with the reason',async(t)=>{
 const w=await world(),drops:[string[],string][]=[],floors:number[]=[];
 const op=await w.open(t,{transport:{...w.transport,fresh:async(_coin:RollupDepositFacts,floorMs:number)=>{floors.push(floorMs);return false;}},depositFloorMs:86_400_000,onDrop:(ids:string[],reason:string)=>drops.push([ids,reason])});
 await op.submit(await toySpend('deposit',op.state.latestRoot(),{deposit:2500n,coin:w.coin(1)}));
 await op.submit(await toySpend('transfer',op.state.latestRoot()));
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=10_000;
 assert.deepEqual(Object.keys((await op.tick())!),['txid','batch']);
 assert.deepEqual(floors,[86_400_000]);
 assert.deepEqual(drops.map(([ids])=>ids),[['deposit']]);
 assert.match(drops[0]![1],/expires/);
});

test('admission refuses a payout below the network dust limit, which arkd would reject',async(t)=>{
 const w=await world(),op=await w.open(t,{dustSats:330}),root=op.state.latestRoot(),program=new Uint8Array(32).fill(0x54);
 await assert.rejects(op.submit(await toySpend('small',root,{withdraw:300n,program})),/dust/);
 await op.submit(await toySpend('enough',root,{withdraw:330n,program}));
 assert.deepEqual(op.pendingIds(),['enough']);
});

test('a group whose other members never arrive is dropped after a wait, freeing its notes',async(t)=>{
 const w=await world(),drops:[string[],string][]=[];
 const op=await w.open(t,{onDrop:(ids:string[],reason:string)=>drops.push([ids,reason])});
 const pair=await toyGroup(['first','second'],op.state.latestRoot(),[{},{}]);
 await op.submit(pair[0]!);
 op.addPadding(await pads(op.state.latestRoot(),10));
 w.clock.now=60_000;
 assert.equal(await op.tick(),undefined);
 assert.deepEqual(op.pendingIds(),['first'],'a straggler still has time to arrive');
 w.clock.now=200_000;
 assert.equal(await op.tick(),undefined);
 assert.deepEqual(op.pendingIds(),[]);
 assert.deepEqual(drops.map(([ids])=>ids),[['first']]);
 assert.match(drops[0]![1],/group/);
 await op.submit({...pair[0]!,id:'again'});
 assert.deepEqual(op.pendingIds(),['again'],'its note is no longer reserved');
});

test('a note record is admitted only under its digest and is published with its batch',async(t)=>{
 const w=await world(),op=await w.open(t),root=op.state.latestRoot();
 const record=Uint8Array.from({length:ROLLUP_RECORD_BYTES},(_,i)=>i),digest=ctDigestOf(record);
 const sealed=await toySpend('sealed',root,{ctDigest:digest});
 await assert.rejects(op.submit({...sealed,ciphertext:record.map(b=>b^1)}),/note record/);
 await assert.rejects(op.submit({...sealed,ciphertext:record.subarray(1)}),/note record/);
 await op.submit({...sealed,ciphertext:record});
 assert.deepEqual(op.pendingIds(),['sealed']);
 op.addPadding(await pads(root,10));
 w.clock.now=10_000;
 assert.equal(((await op.tick()) as {batch:number}).batch,0);
 assert.deepEqual(op.pendingIds(),[]);
 const body=JSON.parse(readFileSync(join(w.dir,'batches','0.json'),'utf8')) as {slots:{ctDigest:string;ciphertext?:string}[]};
 assert.equal(body.slots.find(s=>s.ctDigest===String(digest))?.ciphertext,hex.encode(record));
 assert.equal(body.slots.filter(s=>s.ciphertext).length,1,'padding publishes no record');
});
