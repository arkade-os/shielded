import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EngineStore} from '../src/storage.ts';
import {openStockJournal,type StockJournalHooks,type StockReleasePin,type StockJournalReceipt} from '../src/stock/journal.ts';
const pin:StockReleasePin={version:1,network:'local-stock',descriptorProfileId:'11'.repeat(32),programsHash:'22'.repeat(32),artifactsHash:'33'.repeat(32),checkpointHash:'aa'.repeat(32),genesisTxid:'44'.repeat(32),serverKey:'55'.repeat(32),emulatorKey:'66'.repeat(32)};
type Archive={revision:number;head:string};
type Plan={oldHead:string;txid:string;customerOutpoint:string};
const archive:Archive={revision:0,head:pin.genesisTxid},plan:Plan={oldHead:archive.head,txid:'77'.repeat(32),customerOutpoint:'88'.repeat(32)+':1'};
const receipt:StockJournalReceipt={txid:plan.txid,checkpointTxids:['99'.repeat(32)]};
function hooks(overrides:Partial<StockJournalHooks<Archive,Plan,StockJournalReceipt>>={}):StockJournalHooks<Archive,Plan,StockJournalReceipt>{return {
 validateArchive:value=>{assert.ok(Number.isSafeInteger(value.revision)&&value.revision>=0);assert.match(value.head,/^[0-9a-f]{64}$/);},
 validatePlan:(value,state)=>{assert.equal(value.oldHead,state.head);assert.equal(value.customerOutpoint,plan.customerOutpoint);},
 verifyReceipt:(value,result)=>{assert.equal(value.txid,result.txid);assert.deepEqual(result.checkpointTxids,receipt.checkpointTxids);},
 transmit:async()=>receipt,lookup:async()=>undefined,apply:(state,value)=>({revision:state.revision+1,head:value.txid}),...overrides,
};}
test('stock journal freezes unknown outcomes and reconciles exact coins after restart without resubmission',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stock-journal-'));let transmissions=0,lookups=0;
 const opts=hooks({transmit:async()=>{transmissions++;throw new Error('connection lost after submission');},lookup:async()=>{lookups++;return undefined;}});
 let journal=await openStockJournal(dir,pin,archive,opts);
 try{
  await assert.rejects(journal.submit('deposit-one',plan),/connection lost/);
  assert.deepEqual(journal.status().pending,{id:'deposit-one',stage:'submitted'});
  await assert.rejects(journal.submit('deposit-two',{...plan,customerOutpoint:'aa'.repeat(32)+':0'}),/unresolved/);
  assert.equal((await journal.reconcile()).resolved,false);assert.equal(transmissions,1);
  journal.close();journal=await openStockJournal(dir,pin,{revision:0,head:'bb'.repeat(32)},hooks({transmit:async()=>{throw new Error('must not resubmit');},lookup:async value=>{lookups++;assert.deepEqual(value,plan);return receipt;}}));
  assert.equal((await journal.reconcile()).resolved,true);
  assert.deepEqual(journal.status().archive,{revision:1,head:plan.txid});
  const replay=await journal.submit('deposit-one',{customerOutpoint:plan.customerOutpoint,txid:plan.txid,oldHead:plan.oldHead});assert.equal(replay.replay,true);
  await assert.rejects(journal.submit('deposit-one',{...plan,customerOutpoint:'aa'.repeat(32)+':0'}),/reused/);
  assert.equal(transmissions,1);assert.equal(lookups,2);
 }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});
test('accepted stock outcomes survive a local apply failure and reject forged receipts and release changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stock-journal-'));let calls=0;
 let journal=await openStockJournal(dir,pin,archive,hooks({apply:()=>{throw new Error('local apply failed');},transmit:async()=>{calls++;return receipt;}}));
 try{
  await assert.rejects(journal.submit('withdraw-one',plan),/local apply failed/);assert.equal(journal.status().pending?.stage,'accepted');
  journal.close();await assert.rejects(openStockJournal(dir,{...pin,artifactsHash:'00'.repeat(32)},archive,hooks()),/changed/);
  journal=await openStockJournal(dir,pin,archive,hooks({lookup:async()=>{throw new Error('accepted outcome needs no RPC');}}));
  assert.equal((await journal.reconcile()).resolved,true);assert.equal(calls,1);journal.close();
  journal=await openStockJournal(dir,pin,archive,hooks({transmit:async()=>({...receipt,txid:'ff'.repeat(32)})}));
  await assert.rejects(journal.submit('forged',{...plan,oldHead:plan.txid}),/Expected values/);
  assert.equal(journal.status().pending?.stage,'submitted');
 }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});
type Native=StockJournalReceipt&{signedArkTx:string;signedCheckpointTxs:string[]};
const psbt='A'.repeat(7_000),full=(txid:string):Native=>({txid,checkpointTxids:receipt.checkpointTxids,signedArkTx:psbt,signedCheckpointTxs:[psbt]});
const nativeHooks=():StockJournalHooks<Archive,Plan,Native>=>({...hooks(),transmit:async value=>full(value.txid),lookup:async()=>undefined});
const rowBytes=(dir:string)=>{const db=new DatabaseSync(join(dir,'shielded.sqlite'));try{return (db.prepare('SELECT length(ciphertext) AS n FROM checkpoint WHERE id=1').get() as {n:number}).n;}finally{db.close();}};
test('the acceptance journal keeps the newest receipts whole, compacts older ones, and grows a bounded amount per batch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stock-journal-')),kept=64,batches=kept+12;
 const head=(n:number)=>n.toString(16).padStart(64,'0');
 const open=()=>openStockJournal(dir,pin,{revision:0,head:head(0)},nativeHooks());
 let journal=await open();
 const whole=(id:string)=>journal.receipt(id) as Partial<Native>|undefined;
 const fill=async(from:number,to:number)=>{for(let n=from;n<to;n++)await journal.submit('batch-'+n,{oldHead:head(n),txid:head(n+1),customerOutpoint:plan.customerOutpoint});};
 try{
  await fill(0,kept+4);journal.close();const early=rowBytes(dir);
  journal=await open();await fill(kept+4,batches);journal.close();
  const perBatch=(rowBytes(dir)-early)/(batches-kept-4);
  assert.ok(perBatch<1_000,`an accepted batch adds ${Math.round(perBatch)} bytes to the stored row`);

  journal=await open();
  assert.equal(whole('batch-'+(batches-1))?.signedArkTx,psbt,'the newest receipt is kept whole');
  assert.equal(whole('batch-'+(batches-kept))?.signedArkTx,psbt,'the oldest of the newest 64 is kept whole');
  assert.equal(whole('batch-'+(batches-kept-1))?.signedArkTx,undefined,'an older receipt drops its signed transactions');
  assert.equal(journal.receipt('batch-0')?.txid,head(1),'a compacted receipt still answers for its batch');
  assert.deepEqual(journal.receipt('batch-0')?.checkpointTxids,receipt.checkpointTxids);
  const stale={oldHead:head(0),txid:head(1),customerOutpoint:plan.customerOutpoint};
  assert.equal((await journal.submit('batch-0',stale)).replay,true,'a compacted id still replays');
  await assert.rejects(journal.submit('batch-0',{...stale,txid:head(2)}),/reused/);
  journal.close();

  const store=EngineStore.open(dir);
  try{
   const row=store.load<{accepted:Record<string,{fingerprint:string;receipt:Native}>}>()!;
   for(const [id,entry] of Object.entries(row.accepted))row.accepted[id]={fingerprint:entry.fingerprint,receipt:full(entry.receipt.txid)};
   store.save(row);
  }finally{store.close();}
  const unbounded=rowBytes(dir);
  journal=await open();
  assert.equal(whole('batch-0')?.signedArkTx,psbt,'a row written before compaction loads unchanged');
  await journal.updateArchive(archive=>archive);
  assert.equal(whole('batch-0')?.signedArkTx,undefined,'the next persist compacts it');
  assert.equal(journal.receipt('batch-0')?.txid,head(1));
  journal.close();
  assert.ok(unbounded-rowBytes(dir)>(batches-kept)*psbt.length,`the row fell by ${unbounded-rowBytes(dir)} bytes`);

  journal=await openStockJournal(dir,pin,{revision:0,head:head(0)},{...nativeHooks(),apply:()=>{throw new Error('local apply failed');}});
  await assert.rejects(journal.submit('batch-'+batches,{oldHead:head(batches),txid:head(batches+1),customerOutpoint:plan.customerOutpoint}),/local apply failed/);
  journal.close();
  const held=EngineStore.open(dir);
  try{assert.equal(held.load<{pending:{receipt:Native}}>()!.pending.receipt.signedArkTx,psbt,'an unresolved receipt stays whole, because applying it again needs its transactions');}finally{held.close();}
 }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});
