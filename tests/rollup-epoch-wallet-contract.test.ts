import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {CSVMultisigTapscript,MultisigTapscript,SingleKey,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import type {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {EPOCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {decodeDisclosure,verifyDisclosure,type Disclosure} from '../packages/protocol/src/rollup/disclosure.ts';
import {EpochAccount,type EpochAccountSnapshot,type EpochOwnedNote} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {decodeEpochScan} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {openRollupEpochOperator,type RollupEpochRecord,type RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupEpochPin,type RollupService} from '../src/rollup/service.ts';
import {epochFreshAccount,epochMatchesPool,loadEpochAccount} from '../src/shielded/epoch-checkpoint.ts';
import {epochRevealLinkOf} from '../src/shielded/epoch-disclosure.ts';
import {epochTransferBody} from '../src/shielded/epoch-pool.ts';
import {archivesHeld,needsRecovery} from '../src/shielded/epoch-recovery.ts';
import {epochCatchUp,type EpochBatchPage} from '../src/shielded/epoch-sync.ts';
import {checkSigningRequest,poolApiOf,signDeposit,waitForSpend,type PoolApi,type RollupPoolStatus} from '../src/shielded/pool.ts';
import type {ScanPage} from '../src/shielded/sync.ts';
import {epochHarness} from './fixtures/epoch.ts';
import {bakedPool,checkpoint,emulatorKey,epochRecord,exitDelay,hash,listen,proof,ready,serverKey,token,until} from './fixtures/epoch-service.ts';

const EPOCH_LEN=64,BAKED=60,{recovery,dummyInput}=epochHarness(hash),stub={prove:async()=>proof};
const [aliceKeys,bobKeys]=['11','22'].map(b=>deriveRollupKeys2(b.repeat(32),'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>,ReturnType<typeof deriveRollupKeys2>];
const [aliceTo,bobTo]=[aliceKeys,bobKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret)) as [RollupRecipient,RollupRecipient];
const [aliceAddress,bobAddress]=[aliceTo,bobTo].map(rollupAddressOf) as [string,string];
const depositor=SingleKey.fromHex('03'.repeat(32)),user=await depositor.xOnlyPublicKey();
const collab=MultisigTapscript.encode({pubkeys:[user,hex.decode(serverKey)]}).script;
const userTree=new VtxoScript([collab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
const refusal=(sent:Promise<unknown>)=>sent.then(()=>({}),(e:{status?:number;code?:string})=>({status:e.status,code:e.code}));
const kindsOf=(a:EpochAccount)=>a.history.map(e=>[e.kind,e.batch,e.epoch]);
/** Disclose.tsx's /verify: a note's batch is floor(index / 32), its slot and output the rest of the index. */
const verifyOnPool=async(api:PoolApi,d:Disclosure)=>{
 const batches=new Map<number,RollupEpochRecord|undefined>();
 for(const n of new Set(d.notes.map(note=>Math.floor(note.index/32))))batches.set(n,(await api<EpochBatchPage>(`/batches?from=${n}&limit=1`)).batches[0]);
 return verifyDisclosure(hash,d,index=>batches.get(Math.floor(index/32))?.slots[Math.floor((index%32)/2)]?.commitments[index%2]);
};

/**
 * One real epoch service of 64-batch epochs, driven over HTTP. Batches 0-59 are baked chain-only; Alice shields at 60 and 61 and pays Bob at 62;
 * Bob shields at 63 and pays Alice in the rotating batch 64; Alice renews two notes at 65. Batches 66-127 are one-slot recoveries of epoch -1
 * through the operator itself, the service closed. At 128 Alice recovers an un-renewed note riding the rotation, at 129 another from the
 * archive, and at 130 pays Bob again. At 131 she settles a zero deposit; 132 and 133 are three more with the first held at the transport,
 * so 133 carries two live slots.
 */
let built:ReturnType<typeof buildWorld>|undefined;
const world=()=>(built??=buildWorld());
async function buildWorld(){
 const {net,directory,service:opened}=await bakedPool({epochLen:EPOCH_LEN,batches:BAKED,record:epochRecord(EPOCH_LEN)});
 let service:RollupService=opened,{server}=await listen(service);
 const origin=()=>`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const api:PoolApi=(path,body,before)=>poolApiOf(origin())(path,body,before);
 const status=async()=>(await api<RollupPoolStatus>('/status')).pool!,poolScript=(await status()).script;
 const settle=async(spend:EpochBuiltSpend,extra:Parameters<typeof epochTransferBody>[3]={})=>{
  const id=hex.encode(randomBytes(16)),body=epochTransferBody(id,spend,proof,extra);
  await api('/spends',body);
  const done=await waitForSpend(id,async request=>{checkSigningRequest(request,extra.coin!,poolScript);await api(`/spends/${id}/sign`,await signDeposit(depositor,request));},api,50,60_000);
  assert.equal(done.status,'included',done.reason);
  return {spend,slot:JSON.parse(JSON.stringify(body.slot)) as Record<string,unknown>,batch:done.batch!};
 };
 const shield=async(account:EpochAccount,self:RollupRecipient,sats:number,split?:bigint)=>{
  const coin={...net.fund(userTree.pkScript,sats),tapTree:hex.encode(userTree.encode()),leaf:hex.encode(collab)};
  await epochCatchUp(account,api);
  return settle(await account.spend({deposit:BigInt(sats),...(split?{to:{recipient:self,amount:split}}:{})},self),{coin});
 };
 const pay=async(from:EpochAccount,self:RollupRecipient,to:RollupRecipient,amount:bigint)=>{
  await epochCatchUp(from,api);
  const {spends}=await from.pay(to,amount,self);
  assert.equal(spends.length,1);
  return settle(spends[0]!);
 };

 const alice=await epochFreshAccount(hash,aliceKeys,BAKED,api),bob=await epochFreshAccount(hash,bobKeys,BAKED,api);
 await shield(alice,aliceTo,10_000,6000n);
 await shield(alice,aliceTo,1000,400n);
 const early=await pay(alice,aliceTo,bobTo,2500n);
 await epochCatchUp(alice,api);
 const unsent=await alice.spend({input:alice.notes().find(n=>n.amount===6000n)!,to:{recipient:bobTo,amount:100n}},aliceTo);
 await shield(bob,bobTo,3000);
 const stale=await refusal(api('/spends',epochTransferBody(hex.encode(randomBytes(16)),unsent,proof)));
 const riding=await pay(bob,bobTo,aliceTo,1000n);
 await epochCatchUp(alice,api);
 const renewal=alice.renewalDue({random:()=>0});
 assert.ok(renewal?.kind==='join');
 const renewed=await settle(await alice.join(renewal.due,aliceTo));
 await epochCatchUp(alice,api);
 const snapshot=JSON.parse(JSON.stringify(alice.snapshot())) as EpochAccountSnapshot,unrenewed=alice.renewalDue({random:()=>0})!;

 // The fillers, through the operator alone, opened with the pin the service must have used.
 service.close();
 const genesis=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')),leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json'));
 const operator=await openRollupEpochOperator({directory:join(directory,'operator'),epochLen:EPOCH_LEN,genesis:genesis.archive,leaves,token,serverKey:hex.decode(serverKey),emulatorKey:hex.decode(emulatorKey),exitDelay,checkpoint,hash,
  pin:rollupEpochPin({leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:genesis.txid,serverKey,emulatorKey}),
  clientKey:{spend:{},join:{},recover:{}},prover:{spend:stub,join:stub,recover:stub},transport:net.transport,signDeposits:async()=>undefined,verify:async()=>true,batchWaitMs:0});
 try{
  while(operator.status().archive.batches<2*EPOCH_LEN){
   const w=recovery(operator.state,-1,dummyInput());
   await operator.submit({id:hex.encode(randomBytes(16)),slot:w.slot,origin:-1,publics:w.publicSignals as unknown as RollupEpochSpend['publics'],proof});
   const tick=await operator.tick();
   assert.ok(tick&&'txid' in tick,JSON.stringify(tick));
  }
 }finally{operator.close();}
 service=await ready(net,directory,join(directory,'keys'));({server}=await listen(service));

 await epochCatchUp(alice,api);
 const plan=alice.anchorPlan(),late=[6000n,1500n].map(amount=>alice.notes().find(n=>n.epoch===0&&n.amount===amount)!) as [EpochOwnedNote,EpochOwnedNote];
 const at128={rotatesNext:plan.rotatesNext,liveEpoch:plan.liveEpoch,spendable:late.map(n=>alice.spendable(n,plan)),recovery:late.map(n=>needsRecovery(n,plan))};
 const [first,again]=[await alice.recover(late[1],aliceTo),await alice.recover(late[1],aliceTo)],held=[await archivesHeld(api,0)],rsBefore=(await status()).rsCount!;
 const ridden=await settle(first);
 await epochCatchUp(alice,api);
 held.push(await archivesHeld(api,0));
 const archived=await settle(await alice.recover(late[0],aliceTo));
 const twice=await refusal(api('/spends',epochTransferBody(hex.encode(randomBytes(16)),again,proof)));
 const after=await pay(alice,aliceTo,bobTo,700n);
 await epochCatchUp(alice,api);
 const idle=await settle(await alice.spend({deposit:0n},aliceTo));
 await epochCatchUp(alice,api);
 const gate=net.hold(),ids:string[]=[],post=async(spend:EpochBuiltSpend)=>{const id=hex.encode(randomBytes(16));await api('/spends',epochTransferBody(id,spend,proof));ids.push(id);};
 const trio=await Promise.all([0,1,2].map(()=>alice.spend({deposit:0n},aliceTo)));
 try{
  await post(trio[0]!);
  await until('the first of three reaches the transport',()=>gate.reached,net);
  await post(trio[1]!);await post(trio[2]!);
 }finally{gate.release();}
 const crowd=await Promise.all(ids.map(id=>waitForSpend(id,async()=>undefined,api,50,60_000)));
 await Promise.all([epochCatchUp(alice,api),epochCatchUp(bob,api)]);
 return {api,origin,status,alice,bob,early,stale,riding,renewal,renewed,snapshot,unrenewed,at128,held,rsBefore,ridden,archived,twice,after,idle,trio,crowd};
}

test('a wallet deposits, syncs and spends on the fast path across two rotations of the real epoch service',async()=>{
 const w=await world(),pool=await w.status();
 assert.deepEqual(kindsOf(w.alice),[['shield',60,0],['shield',61,0],['send',62,0],['receive',64,1],['merge',65,1],['recover',128,2],['recover',129,2],['send',130,2]]);
 assert.deepEqual(kindsOf(w.bob),[['receive',62,0],['shield',63,0],['send',64,1],['receive',130,2]]);
 assert.deepEqual([w.alice.balance(),w.bob.balance()],[8800n,5200n]);
 assert.deepEqual([w.early,w.riding,w.after].map(p=>[p.batch,(p.slot.rCur as {epoch:number}).epoch,p.spend.witness.input.sel]),[[62,0,0n],[64,0,1n],[130,2,1n]],'a previous-epoch note opens with sel 1, in the rotating batch too');
 assert.deepEqual(w.stale,{status:400,code:'stale-anchor'},'a spend built before the epoch\'s last batch is refused after it');
 const page=await w.api<ScanPage>(`/scan?from=${BAKED}`),entries=decodeEpochScan(base64.decode(page.data),page.from,EPOCH_LEN);
 assert.deepEqual(entries.filter(e=>e.rotated).map(e=>[e.batch,e.kind]),[[64,'spend'],[128,'recover']]);
 const fresh=EpochAccount.owning(hash,aliceKeys,{epochLen:EPOCH_LEN,bornAt:BAKED}),mine=new Set(w.alice.history.map(e=>e.batch));
 for(const e of entries.filter(e=>mine.has(e.batch)))assert.ok(await fresh.concerns(e),`the scan entry of batch ${e.batch} names Alice's view key`);
 assert.deepEqual([pool.batches,pool.epoch,BigInt(pool.root),BigInt(pool.prevNoteRoot!)],[134,2,w.alice.latestRoot(),w.alice.prevNoteRoot()]);
});

test('a zero-deposit self-spend, the smoke driver\'s idle step, settles with no coin and leaves the wallet no note or entry',async()=>{
 const w=await world(),[record]=(await w.api<EpochBatchPage>(`/batches?from=${w.idle.batch}&limit=1`)).batches;
 assert.deepEqual([w.idle.batch,record!.kind,record!.slots.length,record!.slots[0]!.nullifiers,record!.slots[0]!.publics[3]],[131,'spend',EPOCH_SLOTS.spend,w.idle.slot.nullifiers,'0']);
 assert.deepEqual(w.alice.history.filter(e=>e.batch>130),[]);
});

test('three zero-deposit spends, the first held at the transport, land as a lone batch and then one with two live slots',async()=>{
 const w=await world(),[solo,pair]=(await w.api<EpochBatchPage>(`/batches?from=${w.crowd[0]!.batch}&limit=2`)).batches;
 const [a,b,c]=w.trio.map(s=>String(s.slot.nullifiers[0])),live=(r?:RollupEpochRecord)=>r!.slots.map(s=>s.nullifiers[0]!).filter(n=>[a,b,c].includes(n)).sort();
 assert.deepEqual(w.crowd.map(s=>s.batch),[132,133,133]);
 assert.deepEqual([solo,pair].map(r=>[r!.kind,r!.slots.length]),[['spend',EPOCH_SLOTS.spend],['spend',EPOCH_SLOTS.spend]]);
 assert.deepEqual([solo,pair].map(live),[[a],[b,c].sort()],'the rest of each is the pool\'s padding');
});

test('a v2 snapshot from epoch 1 and a cold restore from the birthday both reach the real pool\'s root and notes',async()=>{
 const w=await world(),same=(a:EpochAccount)=>[a.batchCount,a.latestRoot(),a.prevNoteRoot(),a.notes(),kindsOf(a)];
 assert.deepEqual([w.snapshot.v,w.snapshot.epoch,w.snapshot.batch,w.snapshot.frozen.map(f=>f.epoch)],[2,1,66,[0]]);
 const resumed=await loadEpochAccount(hash,aliceKeys,{snapshot:w.snapshot,bornAt:BAKED,api:w.api});
 const cold=await loadEpochAccount(hash,aliceKeys,{bornAt:BAKED,api:w.api});
 assert.deepEqual([resumed.resumed,resumed.error,cold.resumed,cold.error,cold.account.batchCount],[true,undefined,false,undefined,0]);
 assert.ok(await epochMatchesPool(cold.account,w.api));
 for(const a of [resumed.account,cold.account])assert.deepEqual(same(a),same(w.alice));
 assert.equal(BigInt((await w.status()).root),cold.account.latestRoot());
});

test('a renewal plan runs in the epoch after its notes, and the notes left un-renewed fall to recovery two rotations later',async()=>{
 const w=await world(),[record]=(await w.api<EpochBatchPage>('/batches?from=65&limit=1')).batches;
 assert.deepEqual([w.renewal.due.map(n=>[n.epoch,n.amount]),w.renewal.deadlineBatch,w.renewed.batch,w.renewed.spend.witness.input.sel],[[[0,400n],[0,600n]],2*EPOCH_LEN-1,65,[1n,1n]]);
 assert.deepEqual([record!.kind,record!.slots.every(s=>s.nullifiers.length===2)],['join',true]);
 assert.deepEqual([w.unrenewed.kind,w.unrenewed.due.map(n=>n.amount)],['join',[1500n,6000n]],'still due once the plan ran, and deliberately left');
 assert.deepEqual(w.at128,{rotatesNext:true,liveEpoch:2,spendable:[false,false],recovery:[true,true]});
});

test('the un-renewed notes are recovered through /spends with origin, riding the rotation and from the archive, and a second recovery is refused',async()=>{
 const w=await world(),{batches}=await w.api<EpochBatchPage>('/batches?from=128&limit=2');
 assert.deepEqual([w.ridden,w.archived].map(p=>[p.batch,p.slot.origin,'rCur' in p.slot]),[[128,0,false],[129,0,false]]);
 assert.deepEqual(batches.map(r=>[r.kind,r.slots.length,r.slots[0]!.origin,'rCur' in r.slots[0]!]),[['recover',1,0,false],['recover',1,0,false]]);
 assert.deepEqual(w.held,['partial','held'],'/archives lists epoch 1 only once it closes; the riding recovery needs neither file');
 assert.deepEqual(w.twice,{status:400,code:'double-spend'});
 assert.equal((await w.status()).rsCount,w.rsBefore+2,'the refused one adds nothing');
 assert.deepEqual(w.alice.history.filter(e=>e.kind==='recover').map(e=>e.created.map(n=>[n.epoch,n.index,n.amount])),[[[2,0,1500n]],[[2,32,6000n]]]);
});

test('the reveal link of a note received after a rotation verifies against the real /batches',async()=>{
 const w=await world();
 for(const [account,self] of [[w.alice,aliceAddress],[w.bob,bobAddress]] as const){
  const late=account.history.filter(e=>e.kind==='receive'&&e.epoch>0);
  assert.equal(late.length,1);
  const entry=late[0]!,link=epochRevealLinkOf(w.origin(),entry,{self,sentOf:()=>undefined})!,disclosure=decodeDisclosure(link.split('#')[1]!);
  assert.deepEqual([link.startsWith(`${w.origin()}/verify#`),disclosure.to,await verifyOnPool(w.api,disclosure)],[true,self,[true]],`batch ${entry.batch}`);
  const leaves={...disclosure,notes:disclosure.notes.map((n,i)=>({...n,index:entry.created[i]!.index}))};
  assert.deepEqual(await verifyOnPool(w.api,leaves),[false],'the per-epoch leaf index is no /batches locator');
 }
});

/** A second real service, of Mutinynet's 128-batch epochs and 72 batches into its epoch 1: the shape that has an in-epoch checkpoint, at 64, to start from. */
let sibling:ReturnType<typeof buildCheckpointPool>|undefined;
const checkpointPool=()=>(sibling??=buildCheckpointPool());
async function buildCheckpointPool(){
 const {service}=await bakedPool({epochLen:128,batches:200,record:epochRecord(128)}),{server}=await listen(service);
 return poolApiOf(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

test('a fresh account starts from the real service\'s in-epoch checkpoint, born on it or past it, and matches the pool',async()=>{
 const api=await checkpointPool(),pool=(await api<RollupPoolStatus>('/status')).pool!;
 for(const bornAt of [192,200]){
  const asked:string[]=[],logged=((path:string,...rest:[unknown?,(()=>void)?])=>{asked.push(path);return api(path,...rest);}) as PoolApi;
  const account=await epochFreshAccount(hash,aliceKeys,bornAt,logged);
  assert.deepEqual(asked,['/status','/checkpoints/1/64','/batches?from=192&limit=50','/status'],`born at ${bornAt}: no replay from the epoch before`);
  assert.deepEqual([account.batchCount,account.epoch,account.latestRoot(),account.prevNoteRoot()],[pool.batches,pool.epoch,BigInt(pool.root),BigInt(pool.prevNoteRoot!)],`born at ${bornAt}`);
 }
});

test('EpochAccount satisfies the account port wallet.ts reads, and history, concerns and skip stay outside it, each on its own',()=>{
 type AccountPort=Pick<RollupAccount,'owner'|'txids'|'canSkip'|'batchCount'|'latestRoot'|'notes'|'balance'|'join'|'pay'|'consolidate'|'depositAsset'|'withdrawAsset'>;
 const account=undefined as unknown as EpochAccount,port:AccountPort=account;
 // @ts-expect-error its kinds add renew and recover; Plan 6 widens wallet.ts to EpochHistoryEntry
 const history:Pick<RollupAccount,'history'>=account;
 // @ts-expect-error it takes an EpochScanBatch; Plan 6 widens the scan loop
 const concerns:Pick<RollupAccount,'concerns'>=account;
 // @ts-expect-error as concerns
 const skip:Pick<RollupAccount,'skip'>=account;
 assert.deepEqual([port,history,concerns,skip],Array(4).fill(undefined));
});
