import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {asset,CSVMultisigTapscript,Extension,MultisigTapscript,scriptFromTapLeafScript,SingleKey,TapTreeCoder,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {TAP_LEAF_VERSION} from '@scure/btc-signer/payment.js';
import {executeVmBinary,offlineNativeFixture} from './fixtures/native.ts';
import {BATCH_SLOTS,type BatchKind} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupBatchTx,rollupEpochPoolTree,rollupPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type RollupLeg,type SnarkProof} from '../src/rollup/covenant.ts';
import {readBatchTx,readEpochBatchTx} from '../src/rollup/external.ts';
import {DEFAULT_VM_BINARY,loadRollupLeaves,type RollupLeavesSpec} from '../src/rollup/leaves.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';

const vm=DEFAULT_VM_BINARY;
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown;oldPacket:string;newPacket:string;payoutProgram:string;slots:{proof:SnarkProof;publicSignals:string[]}[];batch:{proof:SnarkProof}};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();

async function world(spec:Partial<RollupLeavesSpec>={}){
 const dir=mkdtempSync(join(tmpdir(),'rollup-batch-'));
 writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));
 writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',clientJoinKey:'client.json',batchJoinKey:'batch.json',slots:BATCH_SLOTS,token,operator:'aa'.repeat(32),...spec}));
 const leaves=await loadRollupLeaves(vm,join(dir,'spec.json'));
 const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const pool=rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const epochLeaves={...leaves,batchRecover:Uint8Array.of(0x52)},epoch=rollupEpochPoolTree(server,emulator,epochLeaves,{type:'seconds',value:2048});
 const userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
 const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:2_500n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]);
 const epochParent=offlineNativeFixture([{script:epoch.tree.pkScript,amount:100_330n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,hex.decode(fixture.oldPacket))]);
 const coin=(vout:number,tree:VtxoScript,leaf:Uint8Array,tx=parent)=>({txid:tx.id,vout,value:Number(tx.getOutput(vout).amount),sourceTx:tx.toBytes(),tapTree:tree.encode(),leaf:tree.findLeaf(hex.encode(leaf))});
 const legs:RollupLeg[]=Array.from({length:BATCH_SLOTS},()=>({deposit:0n,withdraw:0n,asset:false}));
 legs[1]={deposit:2500n,withdraw:0n,asset:false};
 legs[3]={deposit:0n,withdraw:1000n,asset:false,program:hex.decode(fixture.payoutProgram)};
 const witness=rollupWitness(fixture.batch.proof,fixture.slots.map(s=>({proof:s.proof,publics:s.publicSignals.map(BigInt)})));
 const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
 const recover={head:coin(0,epoch.tree,epoch.batchRecover,epochParent),deposits:[],legs:[{deposit:0n,withdraw:0n,asset:false}],token,leaves:epochLeaves,witness:rollupWitness(fixture.batch.proof,[{proof:fixture.slots[0]!.proof,publics:fixture.slots[0]!.publicSignals.map(BigInt)}]),newPacket:hex.decode(fixture.newPacket),checkpoint,kind:'recover' as const};
 return {leaves,legs,witness,checkpoint,server,emulator,pool,epoch,recover,head:coin(0,pool.tree,pool.batch),joinHead:coin(0,pool.tree,pool.batchJoin),deposit:coin(1,userTree,userCollab)};
}

test('the pool tree keeps every leaf a batch spends at Taproot depth 2',async()=>{
 const {pool}=await world(),depth=(script:Uint8Array)=>(pool.tree.findLeaf(hex.encode(script))[0].merklePath??[]).length;
 assert.deepEqual([pool.batch,pool.batchJoin,pool.reserve].map(depth),[2,2,2]);
});

test('the genesis-3 pool script is unchanged and the epoch pool is a different script',async()=>{
 const {leaves,server,emulator,pool:five}=await world();
 const epoch=rollupEpochPoolTree(server,emulator,{...leaves,batchRecover:Uint8Array.of(0x52)},{type:'seconds',value:2048});
 assert.notDeepEqual(epoch.tree.pkScript,five.tree.pkScript);
 assert.equal(hex.encode(five.tree.pkScript),'5120cb04f7f13f283010b626cd17db70b4f02e165ffa318c8692759674b57fb27577');
 assert.equal(hex.encode(epoch.tree.pkScript),'51202a7b49273f971b6160f9430e044d2e3498531f5bfd97fa5cd5bb8f225e22d7ce');
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
 assert.equal(hex.encode(epoch.tree.tweakedPublicKey),'2a7b49273f971b6160f9430e044d2e3498531f5bfd97fa5cd5bb8f225e22d7ce');
});

test('a join batch names the join leaf and carries no boundary leg',async()=>{
 const w=await world(),zero=w.legs.map(()=>({deposit:0n,withdraw:0n,asset:false}));
 const join={head:w.joinHead,deposits:[],legs:zero,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint,kind:'join' as const};
 assert.deepEqual(Extension.fromTx(buildRollupBatchTx(join).arkTx).getEmulatorPacket()!.entries[0]!.script,w.leaves.batchJoin);
 assert.throws(()=>buildRollupBatchTx({...join,deposits:[w.deposit],legs:w.legs}),/join batch carries no boundary leg/);
});
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

test('a width-1 recover batch spends the recover leaf and reads back as kind recover',async()=>{
 const w=await world(),facts=readEpochBatchTx(buildRollupBatchTx(w.recover).arkTx,w.recover.leaves);
 assert.equal(facts.kind,'recover');
 assert.equal(facts.nullifiers.length,1);
 assert.equal(facts.nullifiers[0]!.length,1);
 assert.deepEqual(facts.publics,[fixture.slots[0]!.publicSignals.map(BigInt)]);
});

test('a recover batch without a recover leaf fails loudly',async()=>{
 const w=await world();
 for(const leaves of [w.leaves,{...w.leaves,batchRecover:new Uint8Array()}])assert.throws(()=>buildRollupBatchTx({...w.recover,leaves}),/recover leaf/);
});

test('readEpochBatchTx refuses a spend transaction presented as a recover one',async()=>{
 const w=await world(),spend=buildRollupBatchTx({head:w.head,deposits:[w.deposit],legs:w.legs,token,leaves:w.recover.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint}).arkTx;
 assert.throws(()=>readEpochBatchTx(buildRollupBatchTx({...w.recover,witness:w.witness}).arkTx,w.recover.leaves),/wrong shape/);
 assert.deepEqual(readEpochBatchTx(spend,w.recover.leaves),readBatchTx(spend,w.leaves));
});

test('readBatchTx still returns spend or join and still refuses a malformed genesis-3 witness',async()=>{
 const w=await world(),spend={head:w.head,deposits:[w.deposit],legs:w.legs,token,leaves:w.leaves,witness:w.witness,newPacket:hex.decode(fixture.newPacket),checkpoint:w.checkpoint};
 const join={...spend,head:w.joinHead,deposits:[],legs:w.legs.map(()=>({deposit:0n,withdraw:0n,asset:false})),kind:'join' as const};
 const [s,j]=[spend,join].map(b=>readBatchTx(buildRollupBatchTx(b).arkTx,w.leaves)),kinds:BatchKind[]=[s.kind,j.kind],publics=fixture.slots.map(slot=>slot.publicSignals.map(BigInt));
 assert.deepEqual(kinds,['spend','join']);
 assert.deepEqual([s.nullifiers,j.nullifiers],[publics.map(p=>[p[1]]),publics.map(p=>[p[1],p[2]])]);
 for(const witness of [w.witness.slice(1),w.recover.witness])assert.throws(()=>readBatchTx(buildRollupBatchTx({...spend,witness}).arkTx,w.leaves),/wrong shape/);
 assert.throws(()=>readBatchTx(buildRollupBatchTx(w.recover).arkTx,w.recover.leaves),/through a batch leaf/);
});

test('a genesis-3 spec gets no recover leaf, and an epoch spec needs a 2-public recover key',async()=>{
 assert.equal('batchRecover' in (await world()).leaves,false);
 await assert.rejects(world({epoch:true,batchRecoverKey:'batch.json'}),/recover batch key/);
});
