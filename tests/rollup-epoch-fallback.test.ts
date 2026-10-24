import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {promisify} from 'node:util';
import {asset,CSVMultisigTapscript,EmulatorPacket,Extension,scriptFromTapLeafScript,SingleKey,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {RawWitness} from '@scure/btc-signer';
import {F1Field} from 'ffjavascript';
import * as snarkjs from 'snarkjs';
import {ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {EPOCH_DERIVED_FIELDS} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import type {RollupNullifiers} from '../packages/protocol/src/rollup/nullifiers.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {rollupEpochPoolTree,rollupWitness,ROLLUP_STATE_PACKET,type SnarkProof} from '../src/rollup/covenant.ts';
import {encodeEpochNfArchive} from '../src/rollup/epoch-archive-file.ts';
import type {RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {buildEpochFallbackBatch,openEpochReplica,type EpochFallbackSpend,type EpochReplica} from '../src/rollup/epoch-replica.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupSpecOf,type RollupService} from '../src/rollup/service.ts';
import {cacheBatch,cacheEpochArchive,replayEpochMirror} from '../tools/rollup-cache.ts';
import {epochPool,opens,posted} from './fixtures/epoch-pool.ts';
import {hash,le32,listen,proof as stub,scratch,token} from './fixtures/epoch-service.ts';
import {executeVmBinary,offlineNativeFixture} from './fixtures/native.ts';

const EPOCH_LEN=4,run=promisify(execFile),field=new F1Field(ROLLUP_FIELD),toy=(name:string)=>join('tests','fixtures','rollup-toy',name);
// The classic fixture carries the toy circuits' keys, so a toy proof passes the real covenant for any statement whose pub is a square.
const classic=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:object;batchKey:{IC:unknown[]}};
const leaves=await (async()=>{
 const dir=scratch('rollup-epoch-fallback-keys-');mkdirSync(join(dir,'keys'));
 const keys={'epoch-spend':classic.clientKey,'epoch-join':classic.clientKey,'epoch-batch-spend':classic.batchKey,'epoch-batch-join':classic.batchKey,'epoch-batch-recover':{...classic.batchKey,nPublic:2,IC:classic.batchKey.IC.slice(0,3)}};
 for(const [name,key] of Object.entries(keys))writeFileSync(join(dir,'keys',`${name}.vkey.json`),JSON.stringify(key));
 writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf('epoch',token,'aa'.repeat(32))));
 return loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));
})();
const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
const pool=rollupEpochPoolTree(server,emulator,leaves,{type:'seconds',value:2048}),checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
after(async()=>{await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();});

const toyClient=async(publics:readonly bigint[])=>{
 const w=field.sqrt(publics[0]!),[pub,nf0,nf1,deposit,withdraw,boundaryAsset,destination]=publics.map(String);
 return w===null?undefined:(await snarkjs.groth16.fullProve({pub,nf0,nf1,deposit,withdraw,boundaryAsset,destination,w:String(w)},toy('covenant-client.wasm'),toy('covenant-client.zkey'))).proof as SnarkProof;
};
const proved=async(build:()=>Promise<EpochFallbackSpend['built']>):Promise<EpochFallbackSpend>=>{for(;;){const built=await build(),proof=await toyClient(built.witness.publicSignals);if(proof)return {built,proof};}};
const toyBatch={prove:async(input:Record<string,unknown>,expected:readonly bigint[])=>{
 assert.ok('statement' in input&&EPOCH_DERIVED_FIELDS.every(key=>!(key in input)),'the batch prover gets the circuit\'s input, never a field the circuit derives');
 return (await snarkjs.groth16.fullProve({x:Array.from({length:11},(_,i)=>String(expected[i]??0n))},toy('covenant-batch.wasm'),toy('covenant-batch.zkey'))).proof as SnarkProof;
}};

const [aliceKeys,bobKeys]=['11','22'].map(b=>deriveRollupKeys2(b.repeat(32),'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>,ReturnType<typeof deriveRollupKeys2>];
const [alice,bob]=[aliceKeys,bobKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));
/** Alice and Bob are paid in epoch 0 and Alice again in epoch 1; batch 8 rotates and archives epoch 0, Bob recovers his note at 9, and 10 was followed chain-only. */
const world=await (async()=>{
 const fake=epochPool(hash,EPOCH_LEN),frozen:RollupNullifiers[]=[];
 const land=(...a:Parameters<typeof fake.land>)=>{const epoch=fake.state.epoch;fake.land(...a);if(fake.state.epoch>epoch)frozen.push(fake.state.prevNfSet);};
 land('spend',[await fake.deposit(alice,5000n),await fake.deposit(bob,700n)]);
 while(fake.state.batchCount<5)land();
 land('spend',[await fake.deposit(alice,3000n)]);
 while(fake.state.batchCount<9)land();
 const bobs=EpochAccount.owning(hash,bobKeys,{epochLen:EPOCH_LEN});for(const r of fake.records)await bobs.apply(r);
 land('recover',[posted(await bobs.recover(bobs.notes()[0]!,bob))]);
 land('spend',[],true);
 return {records:fake.records,state:fake.state,frozen};
})();
const mirrorOf=(records:RollupEpochRecord[]=world.records,archives:RollupNullifiers[]=world.frozen)=>{
 const dir=scratch('rollup-epoch-fallback-');mkdirSync(join(dir,'batches'));mkdirSync(join(dir,'nullifiers'));
 records.forEach((r,i)=>cacheBatch(dir,i,r as never));
 archives.forEach((set,e)=>writeFileSync(join(dir,'nullifiers',`epoch-${e}.nf`),encodeEpochNfArchive(e,set)));
 return dir;
};
const open=(dir:string)=>openEpochReplica({dir,hash,epochLen:EPOCH_LEN,leaves});
const bound=async(dir:string)=>{const replica=await open(dir);await replica.catchUpFromChain('',world.state.commitment(),async()=>undefined);return replica;};
const accountOf=async(keys:typeof aliceKeys,replica:EpochReplica)=>{const account=EpochAccount.owning(hash,keys,{epochLen:EPOCH_LEN,replica:true});for(const r of replica.records)await account.apply(r);return account;};
/** The pool head as the indexer would show it, carrying the bound replica's commitment. */
const headOf=(replica:EpochReplica)=>{
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,Uint8Array.from([...le32(replica.state.commitment()),...le32(0n),...le32(0n)]))]);
 return {txid:parent.id,vout:0,value:100_330,sourceTx:parent.toBytes()};
};
const vm=(built:{arkTx:Transaction;checkpoints:Transaction[]})=>executeVmBinary(DEFAULT_VM_BINARY,{arkTx:base64.encode(built.arkTx.toPSBT()),checkpoints:built.checkpoints.map(c=>base64.encode(c.toPSBT()))});
/** Each record's batch transaction, its state packet holding the commitment after it, each spending the one before. */
const chainOf=(records:RollupEpochRecord[])=>{
 const state=EpochState.genesis(hash,EPOCH_LEN,false),txs:Transaction[]=[];
 for(const r of records){
  state.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));
  const witness=RawWitness.encode(rollupWitness(stub,r.slots.map(s=>({proof:stub,publics:s.publics.map(BigInt)}))));
  const ext=Extension.create([EmulatorPacket.create([{vin:0,script:r.kind==='recover'?leaves.batchRecover:leaves.batch,witness}]),new UnknownPacket(ROLLUP_STATE_PACKET,Uint8Array.from([...le32(state.commitment()),...le32(0n),...le32(BigInt(r.noteBlockRoot))]))]);
  const tx=new Transaction({allowUnknownOutputs:true});tx.addInput({txid:txs.at(-1)?.id??'ab'.repeat(32),index:0});tx.addOutput({script:pool.tree.pkScript,amount:1000n});tx.addOutput(ext.txOut());
  txs.push(tx);
 }
 return txs;
};

test('a replica replayed from mirrored records reaches the pool\'s commitment across two rotations',async()=>{
 const replica=await open(mirrorOf(world.records,[]));
 assert.deepEqual([replica.records.length,replica.state.epoch,replica.state.archive.count(),replica.state.recovered.has(BigInt(world.records[9]!.slots[0]!.nullifiers[0]!))],[11,2,2,true]);
 assert.equal(replica.state.commitment(),world.state.commitment(),'through a recover batch, with no archive file in the mirror');
});

test('a record whose anchor is wrong but whose chain facts are right no longer stops the replica',async()=>{
 const records=structuredClone(world.records);records[5]!.slots[1]!.anchor='1';
 const replica=await bound(mirrorOf(records)),account=await accountOf(aliceKeys,replica);
 assert.deepEqual([replica.state.commitment(),account.balance()],[world.state.commitment(),8000n]);
});

test('a tampered archive file is refused against the ER leaf the replica rebuilt',async()=>{
 // 4b Task 6 checks it on write; this checks it again on load, from the replica's own records
 const dir=mirrorOf(),replica=await bound(dir),[nf0,nf1]=world.frozen,file=join(dir,'nullifiers','epoch-0.nf'),flipped=encodeEpochNfArchive(0,nf0);flipped[20]!^=1;
 for(const [label,bytes] of [["epoch 1's set labelled as epoch 0's",encodeEpochNfArchive(0,nf1)],['a flipped bit',flipped]] as const){
  writeFileSync(file,bytes);assert.throws(()=>replica.preload(0),/does not rebuild the root epoch 0 archived/,label);
 }
 unlinkSync(file);replica.preload(0);
 writeFileSync(file,encodeEpochNfArchive(0,nf0));replica.preload(0);
});

test('a forged record and the archive it implies are refused: the replay never reaches the head, so no archive is trusted',async()=>{
 const forged=structuredClone(world.records);forged[1]!.slots[0]!.nullifiers=['12345'];
 const self=EpochState.genesis(hash,EPOCH_LEN,false),sets:RollupNullifiers[]=[];
 for(const r of forged){const epoch=self.epoch;self.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));if(self.epoch>epoch)sets.push(self.prevNfSet);}
 const dir=mirrorOf(forged,[]);
 sets.forEach((set,e)=>cacheEpochArchive(dir,replayEpochMirror(dir,hash,EPOCH_LEN),e,encodeEpochNfArchive(e,set),hash));
 const replica=await open(dir);
 await assert.rejects(replica.catchUpFromChain(forged.at(-1)!.txid!,world.state.commitment(),async()=>undefined),/chain stops/);
 assert.throws(()=>replica.preload(0),/not bound to the pool head/);
});

test('a stale replica catches up from the chain to the head\'s commitment and only then trusts an archive',async()=>{
 const chain=chainOf(world.records),replica=await open(mirrorOf(world.records.slice(0,9).map((r,i)=>({...r,txid:chain[i]!.id}))));
 assert.throws(()=>replica.preload(0),/not bound to the pool head/);
 assert.equal(await replica.catchUpFromChain(chain[8]!.id,world.state.commitment(),async({txid})=>chain[chain.findIndex(tx=>tx.id===txid)+1]),2);
 assert.deepEqual(replica.records.slice(9).map(r=>[r.txid,r.kind,r.at]),[[chain[9]!.id,'recover',undefined],[chain[10]!.id,'spend',undefined]],'placeholders, which no pool stamps with at');
 assert.equal(replica.state.commitment(),world.state.commitment());
 replica.preload(0);
});

test('fallback withdraw builds a ten-slot epoch batch whose covenant witness the VM accepts',async()=>{
 const replica=await bound(mirrorOf()),account=await accountOf(aliceKeys,replica),note=account.notes().find(n=>n.epoch===1)!,program=new Uint8Array(32).fill(0xab);
 const spends=[await proved(()=>account.spend({input:note,withdraw:1000n,program},alice))];
 while(spends.length<10)spends.push(await proved(()=>replica.pad()));
 const built=await buildEpochFallbackBatch(replica,{kind:'spend',spends,program,prover:toyBatch,head:headOf(replica),pool,leaves,token,checkpoint});
 assert.deepEqual([built.record.kind,built.record.slots.length,built.record.slots[0]!.publics[4],hex.encode(built.arkTx.getOutput(1).script!)],['spend',10,'1000','5120'+'ab'.repeat(32)]);
 assert.deepEqual(scriptFromTapLeafScript(built.arkTx.getInput(0).tapLeafScript![0]!),pool.batch);
 const accepted=await vm(built);
 assert.equal(accepted.ok,true,accepted.error);
});

test('pads built as an epoch ends open against the root it ends on, which the rotating batch checks',async()=>{
 const replica=await open(mirrorOf(world.records.slice(0,8)));
 assert.equal(replica.state.rotatesNext(),true);
 replica.state.clone().apply('spend',await Promise.all(Array.from({length:10},async()=>(await replica.pad()).slot)));
});

test('fallback recover builds a one-slot batch through the batchRecover leaf',async()=>{
 const replica=await bound(mirrorOf()),account=await accountOf(aliceKeys,replica),note=account.notes().find(n=>n.epoch===0)!;
 replica.preload(0);
 const built=await buildEpochFallbackBatch(replica,{kind:'recover',spends:[await proved(()=>account.recover(note,alice))],prover:toyBatch,head:headOf(replica),pool,leaves,token,checkpoint});
 assert.deepEqual([built.record.kind,built.record.slots.length,built.record.slots[0]!.origin,built.record.slots[0]!.rCur],['recover',1,0,undefined]);
 assert.deepEqual(scriptFromTapLeafScript(built.arkTx.getInput(0).tapLeafScript![0]!),pool.batchRecover);
 const accepted=await vm(built);
 assert.equal(accepted.ok,true,accepted.error);
});

test('publish posts an epoch record /external accepts, and a chain-only record without slots',async()=>{
 const dir=mirrorOf(),calls:unknown[][]=[];
 writeFileSync(join(dir,'pool.json'),JSON.stringify({token,operator:'',script:'',network:{},epochLen:EPOCH_LEN}));
 const echo=await listen({ready:()=>true,epochPool:true,external:async(txid:string,slots:unknown)=>{calls.push([txid,slots]);return {txid};}} as unknown as RollupService);
 const base=`http://127.0.0.1:${(echo.server.address() as AddressInfo).port}`;
 for(const batch of [5,10])assert.match((await run(process.execPath,['--import','tsx','tools/rollup-fallback.ts','publish',dir,base,String(batch)])).stdout,/ 200 /);
 const [paid,bare]=[world.records[5]!,world.records[10]!];
 assert.deepEqual(calls,[[paid.txid,paid.slots.map(({publics:_,...slot})=>slot)],[bare.txid,undefined]]);
});

test('a replica over a chain-only record reaches the right commitment, and a note of that epoch still spends',async()=>{
 const replica=await bound(mirrorOf()),account=await accountOf(bobKeys,replica),note=account.notes().find(n=>n.epoch===2)!;
 assert.equal(replica.state.commitment(),world.state.commitment(),'batch 10, in the note\'s epoch, was followed chain-only');
 const mine=await account.spend({input:note,withdraw:400n,program:new Uint8Array(32).fill(0xcd)},bob);
 assert.ok(opens(hash,account.owner,mine,[note]),'the account\'s path folds to the root its sel selects');
 replica.state.clone().apply('spend',[mine.slot,...await Promise.all(Array.from({length:9},async()=>(await replica.pad()).slot))]);
});

