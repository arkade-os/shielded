import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
