import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {asset,CSVMultisigTapscript,MultisigTapscript,SingleKey,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {DEFAULT_VM_BINARY,executeVmBinary} from '../src/sdk/runtime.ts';
import {buildRollupBatchTx,rollupPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type RollupLeg,type SnarkProof} from '../src/rollup/covenant.ts';
import {loadRollupLeaves} from '../src/rollup/leaves.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';

const vm=DEFAULT_VM_BINARY;
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown;oldPacket:string;newPacket:string;payoutProgram:string;slots:{proof:SnarkProof;publicSignals:string[]}[];batch:{proof:SnarkProof}};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();

async function world(){
 const dir=mkdtempSync(join(tmpdir(),'rollup-batch-'));
 writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',slots:11,kind:0,token,operator:'aa'.repeat(32)}));
 const leaves=await loadRollupLeaves(vm,join(dir,'spec.json'));
 const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const pool=rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
 const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:2_500n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]);
 const coin=(vout:number,tree:VtxoScript,leaf:Uint8Array)=>({txid:parent.id,vout,value:Number(parent.getOutput(vout).amount),sourceTx:parent.toBytes(),tapTree:tree.encode(),leaf:tree.findLeaf(hex.encode(leaf))});
 const legs:RollupLeg[]=Array.from({length:11},()=>({deposit:0n,withdraw:0n,asset:false}));
 legs[1]={deposit:2500n,withdraw:0n,asset:false};
 legs[3]={deposit:0n,withdraw:1000n,asset:false,program:hex.decode(fixture.payoutProgram)};
 const witness=rollupWitness(fixture.batch.proof,fixture.slots.map(s=>({proof:s.proof,publics:s.publicSignals.map(BigInt)})));
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
 return {leaves,legs,witness,checkpoint,server,head:coin(0,pool.tree,pool.batch),deposit:coin(1,userTree,userCollab)};
}
const wire=(built:ReturnType<typeof buildRollupBatchTx>)=>({arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(tx=>base64.encode(tx.toPSBT()))});

test('a batch built from real snarkjs proofs passes the covenant, and a redirected payout does not',async()=>{
 const w=await world();
 const batch={head:w.head,deposits:[w.deposit],legs:w.legs,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint};
 const built=buildRollupBatchTx(batch);
 assert.equal(built.arkTx.getOutput(0).amount,100_330n+2500n-1000n);
 assert.equal(hex.encode(built.arkTx.getOutput(1).script!),'5120'+fixture.payoutProgram);
 const ok=await executeVmBinary(vm,wire(built));
 assert.equal(ok.ok,true,ok.error);
 const legs=w.legs.map(leg=>({...leg}));legs[3]!.program=new Uint8Array(32).fill(0x52);
 const redirected=await executeVmBinary(vm,wire(buildRollupBatchTx({...batch,legs})));
 assert.equal(redirected.ok,false);
});

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
