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
test('the acceptance journal keeps only the newest receipts, so its row stops growing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stock-journal-')),kept=64,batches=kept+12;
 const head=(n:number)=>n.toString(16).padStart(64,'0');
 const open=()=>openStockJournal(dir,pin,{revision:0,head:head(0)},nativeHooks());
 let journal=await open();
 const stored=()=>{const store=EngineStore.open(dir);try{return store.load<{accepted:Record<string,{receipt:Native}>}>()!.accepted;}finally{store.close();}};
 const fill=async(from:number,to:number)=>{for(let n=from;n<to;n++)await journal.submit('batch-'+n,{oldHead:head(n),txid:head(n+1),customerOutpoint:plan.customerOutpoint});};
 try{
  await fill(0,kept+4);journal.close();const early=rowBytes(dir);
  journal=await open();await fill(kept+4,batches);journal.close();
  assert.ok(Math.abs(rowBytes(dir)-early)<200,`eight more batches moved the stored row by ${rowBytes(dir)-early} bytes`);
  const accepted=stored();
  assert.deepEqual(Object.keys(accepted),Array.from({length:kept},(_,i)=>'batch-'+(batches-kept+i)));
  assert.equal(accepted['batch-'+(batches-kept)]!.receipt.signedArkTx,psbt,'a kept receipt stays whole');

  journal=await open();
  const last={oldHead:head(batches-1),txid:head(batches),customerOutpoint:plan.customerOutpoint};
  assert.equal((await journal.submit('batch-'+(batches-1),last)).replay,true,'a kept id still replays');
  await assert.rejects(journal.submit('batch-'+(batches-1),{...last,txid:head(2)}),/reused/);
  await assert.rejects(journal.submit('batch-0',{oldHead:head(0),txid:head(1),customerOutpoint:plan.customerOutpoint}),/Expected values/,'a dropped id is a new submission, so its old head is refused');
  await assert.rejects(journal.submit('4096',last),/Invalid stock request identity/,'an all-digit id would sort ahead of the older entries');
  journal.close();

  journal=await openStockJournal(dir,pin,{revision:0,head:head(0)},{...nativeHooks(),apply:()=>{throw new Error('local apply failed');}});
  await assert.rejects(journal.submit('batch-'+batches,{oldHead:head(batches),txid:head(batches+1),customerOutpoint:plan.customerOutpoint}),/local apply failed/);
  journal.close();
  const held=EngineStore.open(dir);
  try{assert.equal(held.load<{pending:{receipt:Native}}>()!.pending.receipt.signedArkTx,psbt,'an unresolved receipt stays whole, because applying it again needs its transactions');}finally{held.close();}
 }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});
test('an accepted all-digit id from an older journal still replays, while a new one is refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stock-journal-'));
 let journal=await openStockJournal(dir,pin,archive,hooks());
 try{
  await journal.submit('deposit-one',plan);journal.close();
  const store=EngineStore.open(dir);
  try{const row=store.load<{accepted:Record<string,unknown>}>()!;row.accepted={'7':row.accepted['deposit-one']};store.save(row);}finally{store.close();}
  journal=await openStockJournal(dir,pin,archive,hooks());
  assert.equal((await journal.submit('7',plan)).replay,true);
  await assert.rejects(journal.submit('8',plan),/Invalid stock request identity/);
 }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});
