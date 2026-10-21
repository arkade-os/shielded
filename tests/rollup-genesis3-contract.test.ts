import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {asset,SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {rollupPoolTree} from '../src/rollup/covenant.ts';
import {DEFAULT_VM_BINARY,loadRollupLeaves} from '../src/rollup/leaves.ts';
import type {RollupArchive} from '../src/rollup/operator.ts';
import {ROLLUP_KEY_FILES,rollupProgramsHash} from '../src/rollup/service.ts';
import {openStockJournal,type StockJournalHooks,type StockJournalReceipt,type StockReleasePin} from '../src/stock/journal.ts';

const PROGRAMS_HASH='6d6740d6f21c7255f7ebcd29b85eaae207f74c1e6b1ca0a541fa9c83813ff231';
const POOL_SCRIPT='5120cb04f7f13f283010b626cd17db70b4f02e165ffa318c8692759674b57fb27577';
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown};
const token=asset.AssetId.create('cc'.repeat(32),0).toString();

/** The classic pool from committed fixtures: a spec with no `epoch` field, which is how every genesis-3 pool is built. */
async function genesis3(){
 const dir=mkdtempSync(join(tmpdir(),'rollup-genesis3-'));
 try{
  writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));
  writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',clientJoinKey:'client.json',batchJoinKey:'batch.json',slots:BATCH_SLOTS,token,operator:'aa'.repeat(32)}));
  const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));
  const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
  return {leaves,pool:rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048})};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

test('the genesis-3 pin, leaves and key files are exactly what the live pool advertises',async()=>{
 const {leaves,pool}=await genesis3();
 assert.equal(rollupProgramsHash(leaves),PROGRAMS_HASH);
 assert.equal(hex.encode(pool.tree.pkScript),POOL_SCRIPT);
 assert.deepEqual([...ROLLUP_KEY_FILES],['manifest.json','spend.wasm','spend.zkey','spend.vkey.json','join.wasm','join.zkey','join.vkey.json',
  'batch-spend.wasm','batch-spend.zkey','batch-spend.vkey.json','batch-join.wasm','batch-join.zkey','batch-join.vkey.json']);
});

test('a journal written with a genesis-3 pin reopens under this build',async()=>{
 const {leaves}=await genesis3(),genesisTxid='55'.repeat(32);
 const pin:StockReleasePin={version:1,network:'mutinynet',descriptorProfileId:createHash('sha256').update('rollup-v2-genesis2').digest('hex'),programsHash:PROGRAMS_HASH,artifactsHash:'33'.repeat(32),checkpointHash:'44'.repeat(32),genesisTxid,serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
 const archive:RollupArchive={version:1,head:{txid:genesisTxid,vout:0,value:1000,sourceTxHex:''},reserves:{},batches:0};
 const hooks:StockJournalHooks<RollupArchive,unknown,StockJournalReceipt>={validateArchive:a=>assert.equal(a.version,1),validatePlan:()=>{},verifyReceipt:()=>{},transmit:async()=>{throw new Error('unused');},lookup:async()=>undefined,apply:a=>a};
 const dir=mkdtempSync(join(tmpdir(),'rollup-genesis3-'));
 try{
  (await openStockJournal(dir,pin,archive,hooks)).close();
  // Reopened with the hash this build computes: a pin recomputed on both sides could not see it move.
  const journal=await openStockJournal(dir,{...pin,programsHash:rollupProgramsHash(leaves)},archive,hooks);
  try{assert.equal(journal.status().archive.batches,0);}finally{journal.close();}
  // The close keeps a wrongly accepted open from surfacing as an EPERM in the cleanup instead of here.
  await assert.rejects(openStockJournal(dir,{...pin,programsHash:'ab'.repeat(32)},archive,hooks).then(j=>j.close()),/changed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
