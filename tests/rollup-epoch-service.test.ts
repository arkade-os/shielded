import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {scriptFromTapLeafScript,VtxoScript} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildRollupTransfer,randomField} from '../packages/protocol/src/rollup/account.ts';
import {BATCH_SLOTS,CHECKPOINT_EVERY,ROLLUP_DOMAIN,SUBTREE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {anchorOf,EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {epochPaddingTransfer} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {decodeEpochScan,rotatesAt} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {decodeScan,encodeScan,nullifierHint} from '../packages/protocol/src/rollup/scan.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {rollupEpochPoolTree,rollupPoolTree} from '../src/rollup/covenant.ts';
import {openRollupEpochOperator,type RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves,loadRollupLeaves} from '../src/rollup/leaves.ts';
import type {RollupArchive,RollupRecord} from '../src/rollup/operator.ts';
import {rollupClassicPin,rollupEpochPin,rollupGenesisOf,rollupKeyFilesOf,rollupPoolKindOf,rollupProgramsHash,rollupProvingOf,type RollupService} from '../src/rollup/service.ts';
import {encodeSpend,openSpendStore} from '../src/rollup/spend-store.ts';
import {openStockJournal,stockJournalFingerprint,type StockJournalHooks,type StockJournalReceipt} from '../src/stock/journal.ts';
import {epochHarness,rejection} from './fixtures/epoch.ts';
import {bakedPool,checkpoint,emulatorKey,EPOCH_POOL_KEYS,epochRecord,exitDelay,hash,keySet,le32,listen,offline,POOL_KEYS,proof,ready,scratch,serverKey,sha,STATUS_KEYS,token,until} from './fixtures/epoch-service.ts';
import './rollup-genesis3-contract.test.ts';

const {deposit,dummyInput,recovery}=epochHarness(hash);
// rollupEpochPin with the inputs below, as of its introduction: once a genesis-4 pool is live, a move orphans its journal.
const EPOCH_PIN_FINGERPRINT='93a57a93d9a0f81b50838b1cbbdc3d66acbfaab916adca6e07c45a92f221458e';

const epochSpend=(w:{slot:unknown;publicSignals:bigint[]},origin?:number)=>({id:hex.encode(randomBytes(16)),slot:w.slot,publics:w.publicSignals,proof,...(origin!==undefined?{origin}:{})}) as never;
const batchesOf=(service:RollupService,from:number,limit:number)=>service.batches(from,limit).batches as unknown as RollupEpochRecord[];
type ScanPage={from:number;total:number;data:string};
type Stored={id:string;slot:{nullifiers:bigint[]}};
/** Leaves each spend pending on disk as submit() stores it, as a crash before its batch settled would. */
const pendingOnDisk=(directory:string,...spends:Stored[])=>{const store=openSpendStore(join(directory,'spends'));for(const s of spends)store.save({id:s.id,status:'pending',nullifier:String(s.slot.nullifiers[0]),at:Date.now(),spend:encodeSpend(s as never)});};

test('an epoch service opens an epoch pool, rotates, and lands a recover batch that reads included after a restart',async t=>{
 const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-epoch-service-');
 const first=await ready(net,directory,keys,'64'),saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8'));
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json')),pool=rollupEpochPoolTree(hex.decode(serverKey),hex.decode(emulatorKey),leaves,exitDelay);
 assert.deepEqual([saved.version,saved.epochLen],[2,64]);
 assert.equal(VtxoScript.decode(pool.tree.encode()).leaves.length,6);
 assert.deepEqual([net.sent[0]!.script,first.status().pool!.script],[hex.encode(pool.tree.pkScript),hex.encode(pool.tree.pkScript)],'the head funds the six-leaf tree the operator spends');
 assert.deepEqual([...net.sent[0]!.payload],[...le32(EpochState.genesis(hash,64).commitment()),...le32(0n),...le32(0n)]);
 first.close();
 // 63 batches straight through the operator, opened with the pin the service must have used, or its journal would refuse.
 const operator=await openRollupEpochOperator({directory:join(directory,'operator'),epochLen:64,genesis:saved.archive,leaves,token,serverKey:hex.decode(serverKey),emulatorKey:hex.decode(emulatorKey),exitDelay,checkpoint,hash,
  pin:rollupEpochPin({leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey,emulatorKey}),
  clientKey:{spend:{},join:{},recover:{}},prover:{spend:{prove:async()=>proof},join:{prove:async()=>proof},recover:{prove:async()=>proof}},transport:net.transport,signDeposits:async()=>undefined,verify:async()=>true,batchWaitMs:0});
 after(()=>operator.close());
 for(let n=0;n<63;n++){
  await operator.submit(epochSpend(deposit(operator.state,0n)));
  operator.addPadding(Array.from({length:BATCH_SLOTS-1},()=>({...epochSpend(deposit(operator.state,0n)) as object,receivedAt:Infinity}) as never));
  assert.ok('txid' in (await operator.tick())!);
 }
 const mirror=operator.state;operator.close();
 const service=await ready(net,directory,keys);
 const opened=service.status().pool!.root,follow=(from:number,count:number)=>{for(const r of batchesOf(service,from,count))mirror.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));};
 assert.deepEqual([service.status().pool!.batches,opened],[63,String(mirror.latestRoot())]);
 // Batch 63 closes epoch 0, leaving pads that open against epoch -1's root; the rotating batch 64 needs pads proved against epoch 0's.
 await service.submit(epochSpend(deposit(mirror,0n)));
 await until('batch 63 lands',()=>service.status().pool!.batches===64,net);
 follow(63,1);
 assert.equal(mirror.rotatesNext(),true);
 await service.submit(epochSpend(deposit(mirror,0n)));
 await until('the rotating spend batch lands',()=>service.status().pool!.batches===65,net);
 follow(64,1);
 assert.deepEqual([mirror.epoch,mirror.archive.has(-1)],[1,true],'batch 64 rotated');
 const recover=epochSpend(recovery(mirror,-1,dummyInput()),-1);await service.submit(recover);
 await until('the recover batch lands',()=>service.status().pool!.batches===66,net);
 const [r63,r64,r65]=batchesOf(service,63,3);
 assert.deepEqual([r63!.kind,r64!.kind,r65!.kind,r65!.slots.length,r65!.slots[0]!.origin],['spend','spend','recover',1,-1]);
 for(const s of r64!.slots)assert.equal(s.anchor,String(anchorOf(hash,mirror.prevNoteRoot,BigInt(s.rCur!.root))),'every slot of the rotating batch opens against epoch 0\'s final root');
 const recoverTx=net.landed.at(-1)!;
 assert.deepEqual(scriptFromTapLeafScript(recoverTx.getInput(0).tapLeafScript![0]!),pool.batchRecover,'the recover batch spends the head through the recover leaf');
 assert.ok(net.proved.includes('epoch-batch-recover')&&net.proved.includes('epoch-batch-spend'));
 assert.ok(['epoch-spend','epoch-join'].every(c=>net.proved.includes(c)),'padding is proved with the epoch client circuits');
 follow(65,1);
 assert.equal(service.status().pool!.root,String(mirror.latestRoot()));
 assert.notEqual(service.status().pool!.root,opened);
 assert.deepEqual(service.spend((recover as {id:string}).id),{status:'included',batch:65,txid:recoverTx.id});
 assert.equal(service.checkpoint(64),undefined,'past a rotation, a global checkpoint would be wrong');
 const request=await listen(service);
 await t.test('an epoch pool serves /scan, and its page decodes to the batches it served',async()=>{
  const answer=await request('/api/rollup/scan?from=0'),page=await answer.json() as ScanPage;
  assert.deepEqual([answer.status,answer.headers.get('cache-control'),page.from,page.total],[200,'no-store',0,66]);
  const entries=decodeEpochScan(base64.decode(page.data),0,64),served=batchesOf(service,0,66);
  assert.deepEqual(entries.map(e=>[e.batch,e.epoch,e.blockInEpoch,e.rotated]),served.map((_,n)=>[n,n<64?0:1,n%64,n===64]));
  assert.deepEqual(entries.map(e=>[e.kind,e.txid,e.at,e.root]),served.map(r=>[r.kind,r.txid,r.at,BigInt(r.noteBlockRoot)]));
  assert.deepEqual(entries.map(e=>e.slots.map(s=>s.nullifiers)),served.map(r=>r.slots.map(s=>s.nullifiers.map(nf=>nullifierHint(BigInt(nf))))));
  assert.deepEqual(entries.slice(64).map(e=>[e.kind,e.slots.length]),[['spend',BATCH_SLOTS],['recover',1]]);
  const tail=await (await request('/api/rollup/scan?from=64&limit=2')).json() as ScanPage;
  assert.deepEqual([tail.from,tail.total,decodeEpochScan(base64.decode(tail.data),tail.from,64)],[64,66,entries.slice(64)]);
 });
 await t.test('a recorded block root that the live note tree does not hold is refused, not served',()=>{
  const path=join(directory,'operator','batches','65.json'),original=readFileSync(path,'utf8'),record=JSON.parse(original) as RollupEpochRecord;
  writeFileSync(path,JSON.stringify({...record,noteBlockRoot:String(BigInt(record.noteBlockRoot)+1n)}));
  try{
   assert.throws(()=>service.scan(64,2),/live note tree/);
   assert.equal(service.scan(0,64).total,66,'a closed epoch has no live tree to differ from');
  }finally{writeFileSync(path,original);}
  assert.equal(service.scan(64,2).total,66);
 });
 const beforeRestart=service.scan(0,66);
 service.close();
 // Restore skips a record with no spend body, which leaves it to the sweep.
 pendingOnDisk(directory,recover);
 openSpendStore(join(directory,'spends')).save({id:'swept',status:'pending',nullifier:String((recover as Stored).slot.nullifiers[0]),at:Date.now()});
 const reopened=await ready(net,directory,keys);
 assert.deepEqual(reopened.scan(0,66),beforeRestart,'a replayed state passes the live-tree check and serves the same page');
 assert.deepEqual(reopened.spend((recover as Stored).id),{status:'included'},'restore reads the recovered set');
 await until('the sweep settles the record restore skipped',()=>reopened.spend('swept')?.status!=='pending',net);
 assert.deepEqual(reopened.spend('swept'),{status:'included'},'so does the sweep');
});

test('on restart an epoch pool keeps an included spend included and drops a waiting one by name, not by a decode error',async()=>{
 const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-epoch-restart-'),state=EpochState.genesis(hash,64);
 const first=await ready(net,directory,keys,'64'),landed:Stored=epochSpend(deposit(state,0n)),waiting:Stored=epochSpend(deposit(state,0n));
 await first.submit(landed as never);
 await until('a batch lands',()=>first.status().pool!.batches===1,net);
 first.close();
 pendingOnDisk(directory,landed,waiting);
 const service=await ready(net,directory,keys);
 assert.deepEqual([service.spend(landed.id),service.spend(waiting.id)],[{status:'included'},{status:'dropped',reason:'An epoch pool does not re-admit pending spends after a restart; build the spend again.'}]);
});

test('a classic service is byte-identical to today',async t=>{
 const net=offline(),keys=keySet('classic'),directory=scratch('rollup-classic-service-');
 const service=await ready(net,directory,keys,undefined),status=service.status(),pool=status.pool!;
 assert.deepEqual([Object.keys(status).sort(),Object.keys(pool).sort()],[STATUS_KEYS,POOL_KEYS]);
 assert.deepEqual(status.proving,rollupProvingOf('classic',JSON.parse(readFileSync(join(keys,'manifest.json'),'utf8')).circuits.all.files));
 assert.equal(readFileSync(join(directory,'spec.json'),'utf8'),`{"clientKey":"keys/spend.vkey.json","batchKey":"keys/batch-spend.vkey.json","clientJoinKey":"keys/join.vkey.json","batchJoinKey":"keys/batch-join.vkey.json","slots":10,"token":"${token}","operator":"${pool.operator}"}`);
 const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json'));
 assert.equal(pool.script,hex.encode(rollupPoolTree(hex.decode(serverKey),hex.decode(emulatorKey),leaves,exitDelay).tree.pkScript));
 assert.deepEqual([...net.sent[0]!.payload],[...le32(RollupState.genesis(hash).commitment()),...le32(0n)]);
 const saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8'));
 assert.deepEqual([Object.keys(saved),Object.keys(saved.archive),Object.keys(saved.archive.head),saved.version,saved.archive.version],
  [['version','token','txid','serverKey','emulatorKey','archive'],['version','head','reserves','batches'],['txid','vout','value','sourceTxHex'],1,1]);
 assert.deepEqual(rollupPoolKindOf({genesis:saved,epochLenEnv:'128'}),{kind:'classic'});
 // A batch through the classic padding path.
 const recipient=rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey());
 const built=await buildRollupTransfer(hash,{root:RollupState.genesis(hash).latestRoot(),ask:randomField(),nk:randomField(),self:recipient,request:{},width:1});
 await service.submit({id:hex.encode(randomBytes(16)),slot:built.witness.slot,publics:built.witness.publicSignals as never,proof,ciphertext:built.ciphertext});
 await until('a classic batch lands',()=>service.status().pool!.batches===1,net);
 assert.deepEqual(Object.keys(service.status().pool!).sort(),[...POOL_KEYS,'lastBatch'].sort());
 assert.deepEqual(Object.keys(service.status().pool!.lastBatch!).sort(),['at','batch','proveMs','publishMs','waitedMs']);
 assert.notEqual(service.status().pool!.root,pool.root);
 assert.ok(net.proved.includes('batch-spend')&&net.proved.includes('spend'));
 await t.test('a classic pool /scan is byte-identical to today',async()=>{
  const record=service.batches(0,1).batches[0] as RollupRecord,commitments=record.slots.flatMap(s=>s.commitments.map(BigInt));
  let level=Array.from({length:2**SUBTREE_DEPTH},(_,i)=>commitments[i]??0n);
  while(level.length>1)level=Array.from({length:level.length/2},(_,i)=>hash([level[2*i]!,level[2*i+1]!]));
  const page=await (await (await listen(service))('/api/rollup/scan?from=0')).json() as ScanPage;
  assert.deepEqual(page,{from:0,total:1,data:base64.encode(encodeScan([{record,root:level[0]!}]))});
  assert.deepEqual(decodeScan(base64.decode(page.data),0).map(b=>[b.kind,b.root,b.slots.length]),[['spend',level[0]!,BATCH_SLOTS]]);
  assert.equal(base64.decode(page.data).length,453);
 });
 service.close();
 // The journal reopens under the harness-pinned classic builder, and refuses the epoch one.
 const pinned={leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey,emulatorKey};
 const hooks:StockJournalHooks<RollupArchive,unknown,StockJournalReceipt>={validateArchive:()=>{},validatePlan:()=>{},verifyReceipt:()=>{},transmit:async()=>{throw new Error('unused');},lookup:async()=>undefined,apply:a=>a};
 (await openStockJournal(join(directory,'operator','journal'),rollupClassicPin(pinned),saved.archive,hooks)).close();
 await assert.rejects(openStockJournal(join(directory,'operator','journal'),rollupEpochPin({...pinned,leaves:{...leaves,batchRecover:leaves.batch}}),saved.archive,hooks).then(j=>j.close()),/changed/);
});

test('the epoch pool serves an empty /scan, and still refuses /checkpoints rather than serving a wrong frontier',async()=>{
 const net=offline(),service=await ready(net,scratch('rollup-epoch-http-'),keySet('epoch'),'64'),request=await listen(service);
 assert.deepEqual(await (await request('/api/rollup/scan?from=0')).json(),{from:0,total:0,data:''});
 assert.equal((await request('/api/rollup/checkpoints/64')).status,404);
 assert.deepEqual(await (await request('/api/rollup/times')).json(),{every:CHECKPOINT_EVERY,at:[]});
 assert.deepEqual(await (await request('/api/rollup/batches')).json(),{from:0,total:0,batches:[]});
 const status=await (await request('/api/rollup/status')).json();
 assert.deepEqual([Object.keys(status).sort(),Object.keys(status.pool).sort()],[STATUS_KEYS,[...POOL_KEYS,...EPOCH_POOL_KEYS].sort()],'a classic pool\'s keys, and the epoch fields beside them');
 assert.equal(status.pool.root,String(EpochState.genesis(hash,64).latestRoot()));
 assert.deepEqual([status.pool.epoch,status.pool.batchesInEpoch,status.pool.prevNoteRoot,status.pool.erCount,status.pool.rsCount,status.pool.nullifiers],[0,0,status.pool.root,0,1,1],'the empty epoch 0, whose previous root is its own');
});

test('epoch padding is proved against the root the next batch opens against',async()=>{
 const state=EpochState.genesis(hash,2),self=rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey());
 const pads=(rPrev:bigint,width:1|2)=>Promise.all(Array.from({length:BATCH_SLOTS},()=>epochPaddingTransfer(hash,{rPrev,rCur:{epoch:state.epoch,root:state.latestRoot()},self,width})));
 for(let n=0;n<2;n++)state.apply('spend',(await pads(state.nextAnchorRoot(),1)).map(p=>p.slot));
 assert.equal(state.rotatesNext(),true);
 const stale=await pads(state.prevNoteRoot,1),fresh=await pads(state.nextAnchorRoot(),1);
 assert.throws(()=>state.clone().apply('spend',stale.map(p=>p.slot)),rejection('stale-anchor'));
 for(const p of fresh){
  assert.equal(p.witness.publicSignals[0],statementOf(hash,{domain:ROLLUP_DOMAIN,...p.slot,root:p.slot.anchor}),'the proof states the slot the batch reads');
  assert.deepEqual([p.witness.input.rPrev,p.witness.input.rCur,p.witness.input.sel,'root' in p.witness.input],[state.nextAnchorRoot(),state.latestRoot(),0n,false]);
 }
 state.apply('spend',fresh.map(p=>p.slot));
 assert.equal(state.epoch,1);
 const joins=await pads(state.nextAnchorRoot(),2);
 assert.deepEqual(joins[0]!.witness.input.sel,[0n,0n]);
 state.apply('join',joins.map(p=>p.slot));
});

test('the stall across a rotation is measured and the pool resumes',async t=>{
 const {net,service}=await bakedPool({epochLen:64,batches:63,record:epochRecord(64)}),pool=()=>service.status().pool!;
 const spend=()=>{const p=pool(),view={epoch:p.epoch,latestRoot:()=>BigInt(p.root),nextAnchorRoot:()=>BigInt(rotatesAt(p.batches,64)?p.root:p.prevNoteRoot!)};return epochSpend(deposit(view as unknown as EpochState,0n));};
 // Two kinds at PADDING_TARGET, filled before the delay starts. A full batch of clients takes no pad, so all of them are stale at the rotation.
 await until('both padding queues are full',()=>pool().padding===4*BATCH_SLOTS,net);
 net.delay(100);
 await Promise.all(Array.from({length:BATCH_SLOTS},()=>service.submit(spend())));
 await until('the last batch of epoch 0 lands',()=>pool().batches===64,net);
 const final=BigInt(pool().root);
 await service.submit(spend());
 await until('the first batch of epoch 1 lands',()=>pool().batches===65,net);
 const [last,first]=batchesOf(service,63,2);
 t.diagnostic(`rotation stall ${first!.at!-last!.at!} ms with 100 ms stub proofs`);
 assert.equal(last!.slots.some(s=>s.ciphertext),false,'the last batch of the epoch took no padding');
 assert.deepEqual([pool().epoch,pool().batchesInEpoch],[1,1]);
 for(const s of first!.slots)assert.equal(s.anchor,String(anchorOf(hash,final,BigInt(s.rCur!.root))),'every slot opens against epoch 0\'s final root');
});

test('an epoch genesis writes version 2 and reads back as epoch; a classic one keeps its bytes',()=>{
 const head={txid:'55'.repeat(32),vout:0,value:1000,sourceTxHex:'abcd'},keys={serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
 assert.equal(JSON.stringify(rollupGenesisOf({token,head,...keys})),
  `{"version":1,"token":"${token}","txid":"${'55'.repeat(32)}","serverKey":"${'66'.repeat(32)}","emulatorKey":"${'77'.repeat(32)}","archive":{"version":1,"head":{"txid":"${'55'.repeat(32)}","vout":0,"value":1000,"sourceTxHex":"abcd"},"reserves":{},"batches":0}}`);
 const epoch=JSON.parse(JSON.stringify(rollupGenesisOf({token,head,...keys,epochLen:128})));
 assert.deepEqual([epoch.version,epoch.epochLen],[2,128]);
 assert.deepEqual(rollupPoolKindOf({genesis:epoch}),{kind:'epoch',epochLen:128});
});

test('each epoch proving name serves its own circuit',()=>{
 const files=Object.fromEntries(rollupKeyFilesOf('epoch').map(n=>[n,sha(n)])),pair=(c:string)=>({wasm:sha(`${c}.wasm`),zkey:sha(`${c}.zkey`)});
 assert.deepEqual(rollupProvingOf('epoch',files),{spend:pair('epoch-spend'),join:pair('epoch-join'),batch:pair('epoch-batch-spend'),batchJoin:pair('epoch-batch-join'),batchRecover:pair('epoch-batch-recover')});
});

test('the epoch journal pin is its own, and never the classic one',()=>{
 const leaves={batch:Uint8Array.of(1),batchJoin:Uint8Array.of(2),reserve:Uint8Array.of(3),renew:Uint8Array.of(4),batchRecover:Uint8Array.of(5)};
 const inputs={leaves,manifest:Buffer.from('manifest'),checkpoint:Uint8Array.of(0x51),genesisTxid:'55'.repeat(32),serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
 const pin=rollupEpochPin(inputs);
 assert.equal(stockJournalFingerprint(pin),EPOCH_PIN_FINGERPRINT);
 assert.notEqual(stockJournalFingerprint(pin),stockJournalFingerprint(rollupClassicPin(inputs)));
 assert.notEqual(pin.programsHash,rollupProgramsHash(leaves));
});
