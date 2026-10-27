import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {asset,CSVMultisigTapscript,Extension,MultisigTapscript,scriptFromTapLeafScript,SingleKey,TapTreeCoder,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {TAP_LEAF_VERSION} from '@scure/btc-signer/payment.js';
import {offlineNativeFixture} from './fixtures/native.ts';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type RollupLeg,type SnarkProof} from '../src/rollup/covenant.ts';
import {readEpochBatchTx} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves,type RollupLeavesSpec} from '../src/rollup/leaves.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';

const vm=DEFAULT_VM_BINARY;
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:{IC:unknown[]};oldPacket:string;newPacket:string;payoutProgram:string;slots:{proof:SnarkProof;publicSignals:string[]}[];batch:{proof:SnarkProof}};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
// The recover leaf needs a 2-public batch key from the client key's phase-1 setup: the toy batch key, cut to two publics.
const recoverKey={...fixture.batchKey,nPublic:2,IC:fixture.batchKey.IC.slice(0,3)};

async function world(spec:Partial<RollupLeavesSpec>={}){
 const dir=mkdtempSync(join(tmpdir(),'rollup-batch-'));
 writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));writeFileSync(join(dir,'recover.json'),JSON.stringify(recoverKey));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',clientJoinKey:'client.json',batchJoinKey:'batch.json',batchRecoverKey:'recover.json',slots:BATCH_SLOTS,token,operator:'aa'.repeat(32),epoch:true,...spec}));
 const leaves=await loadRollupEpochLeaves(vm,join(dir,'spec.json'));
 const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const epoch=rollupEpochPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
 const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const parent=offlineNativeFixture([{script:epoch.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:2_500n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]);
 const coin=(vout:number,tree:VtxoScript,leaf:Uint8Array)=>({txid:parent.id,vout,value:Number(parent.getOutput(vout).amount),sourceTx:parent.toBytes(),tapTree:tree.encode(),leaf:tree.findLeaf(hex.encode(leaf))});
 const legs:RollupLeg[]=Array.from({length:BATCH_SLOTS},()=>({deposit:0n,withdraw:0n,asset:false}));
 legs[1]={deposit:2500n,withdraw:0n,asset:false};
 legs[3]={deposit:0n,withdraw:1000n,asset:false,program:hex.decode(fixture.payoutProgram)};
 const witness=rollupWitness(fixture.batch.proof,fixture.slots.map(s=>({proof:s.proof,publics:s.publicSignals.map(BigInt)})));
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
 const recover={head:coin(0,epoch.tree,epoch.batchRecover),deposits:[],legs:[{deposit:0n,withdraw:0n,asset:false}],token,leaves,witness:rollupWitness(fixture.batch.proof,[{proof:fixture.slots[0]!.proof,publics:fixture.slots[0]!.publicSignals.map(BigInt)}]),newPacket:hex.decode(fixture.newPacket),checkpoint,kind:'recover' as const};
 return {leaves,legs,witness,checkpoint,server,epoch,recover,head:coin(0,epoch.tree,epoch.batch),joinHead:coin(0,epoch.tree,epoch.batchJoin),deposit:coin(1,userTree,userCollab)};
}

test('the epoch pool script is pinned, with batch and batchJoin at depth 2 and batchRecover and reserve at depth 3',async()=>{
 const {epoch}=await world();
 assert.equal(hex.encode(epoch.tree.pkScript),'5120aaa42fb812e1e5c8ecb73cf5276ec09818b0d4122dc294493a907e2e13c6161d');
 const depth=(script:Uint8Array)=>(epoch.tree.findLeaf(hex.encode(script))[0].merklePath??[]).length;
 assert.deepEqual([epoch.batch,epoch.batchJoin,epoch.batchRecover,epoch.reserve].map(depth),[2,2,3,3]);
});

test('the six-leaf epoch tree survives every tapTree encoding a writer produces',async()=>{
 const {epoch}=await world();
 // The SDK's toBIP371TapTree, which the package does not export. Not leaf[0].version: a control block's version carries the key's parity bit.
 const bip371=TapTreeCoder.encode(epoch.tree.leaves.map(leaf=>({depth:leaf[0].merklePath.length,version:TAP_LEAF_VERSION,script:Uint8Array.from(scriptFromTapLeafScript(leaf))})));
 for(const bytes of [epoch.tree.encode(),bip371]){
  assert.deepEqual(VtxoScript.decode(bytes).scripts,epoch.tree.scripts);
  assert.equal(hex.encode(VtxoScript.decode(bytes).pkScript),hex.encode(epoch.tree.pkScript));
 }
 assert.notDeepEqual(TapTreeCoder.decode(bip371).map(l=>l.script),epoch.tree.scripts);   // six is a count where DFS order differs
 assert.equal(hex.encode(epoch.tree.tweakedPublicKey),'aaa42fb812e1e5c8ecb73cf5276ec09818b0d4122dc294493a907e2e13c6161d');
});

test('a join batch names the join leaf and carries no boundary leg',async()=>{
 const w=await world(),zero=w.legs.map(()=>({deposit:0n,withdraw:0n,asset:false}));
 const join={head:w.joinHead,deposits:[],legs:zero,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint,kind:'join' as const};
 assert.deepEqual(Extension.fromTx(buildRollupBatchTx(join).arkTx).getEmulatorPacket()!.entries[0]!.script,w.leaves.batchJoin);
 assert.throws(()=>buildRollupBatchTx({...join,deposits:[w.deposit],legs:w.legs}),/join batch carries no boundary leg/);
});
const wire=(built:ReturnType<typeof buildRollupBatchTx>)=>({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))});

test('the builder refuses batches that cannot balance',async()=>{
 const w=await world();
 const batch={head:w.head,deposits:[w.deposit],legs:w.legs,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint};
 assert.throws(()=>buildRollupBatchTx({...batch,deposits:[]}),/exactly the deposited sats/);
 const assetPayout=w.legs.map(leg=>({...leg}));assetPayout[5]={deposit:0n,withdraw:10n,asset:true};
 assert.throws(()=>buildRollupBatchTx({...batch,legs:assetPayout}),/carrier slot next/);
 const noProgram=w.legs.map(leg=>({...leg}));delete noProgram[3]!.program;
 assert.throws(()=>buildRollupBatchTx({...batch,legs:noProgram}),/32-byte P2TR program/);
});

test('the live transport refuses an over-weight batch before the emulator, and reads coin freshness from the indexer',async()=>{
 const w=await world();
 const built=buildRollupBatchTx({head:w.head,deposits:[w.deposit],legs:w.legs,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint});
 const facts={txid:'aa'.repeat(32),vout:0,value:2500,script:'5120'+'33'.repeat(32),assets:[]};
 const coin={...facts,isSpent:false,isSwept:false,isUnrolled:false,expiresAt:new Date(Date.now()+2*3600_000)};
 let reached=false;
 const transport=createRollupTransport({serverKey:hex.encode(w.server),operatorMaxWeight:20_000,arkUrl:'https://unused.invalid',emulatorUrl:'https://unused.invalid'} as unknown as StockNetworkInfo,{
  emulator:{submitTx:async()=>{reached=true;throw new Error('unreachable');}},
  indexer:{getVtxos:async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:outpoints.some(o=>o.txid===coin.txid)?[coin]:[]}),getVirtualTxs:async()=>({txs:[]})},
 } as never);
 await assert.rejects(transport.submit(wire(built),1),/exceeds/);
 assert.equal(reached,false);
 assert.equal(await transport.fresh(facts,3600_000),true);
 assert.equal(await transport.fresh(facts,3*3600_000),false);
 assert.equal(await transport.unspent({txid:'bb'.repeat(32),vout:0}),false);
});

test('a width-1 recover batch spends the recover leaf and reads back as kind recover',async()=>{
 const w=await world(),facts=readEpochBatchTx(buildRollupBatchTx(w.recover).arkTx,w.recover.leaves);
 assert.equal(facts.kind,'recover');
 assert.equal(facts.nullifiers.length,1);
 assert.equal(facts.nullifiers[0]!.length,1);
 assert.deepEqual(facts.publics,[fixture.slots[0]!.publicSignals.map(BigInt)]);
});

test('a recover batch without a recover leaf fails loudly',async()=>{
 const w=await world(),{batchRecover:_,...noRecover}=w.leaves;
 for(const leaves of [noRecover as never,{...w.leaves,batchRecover:new Uint8Array()}])assert.throws(()=>buildRollupBatchTx({...w.recover,leaves}),/recover leaf/);
});

test('readEpochBatchTx refuses a spend transaction presented as a recover one',async()=>{
 const w=await world();
 assert.throws(()=>readEpochBatchTx(buildRollupBatchTx({...w.recover,witness:w.witness}).arkTx,w.recover.leaves),/wrong shape/);
});

test('an epoch spec needs a 2-public recover key',async()=>{
 await assert.rejects(world({epoch:true,batchRecoverKey:'batch.json'}),/recover batch key/);
});
