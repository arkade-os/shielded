import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {after,test} from 'node:test';
import express from 'express';
import {ArkAddress,asset,CSVMultisigTapscript,scriptFromTapLeafScript,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {buildRollupTransfer,randomField} from '../packages/protocol/src/rollup/account.ts';
import {BATCH_SLOTS,CHECKPOINT_EVERY,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {anchorOf,EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {epochPaddingTransfer} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {statementOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {rollupEpochPoolTree,rollupPoolTree,ROLLUP_STATE_PACKET,type SnarkProof} from '../src/rollup/covenant.ts';
import {openRollupEpochOperator,type RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {createRollupRouter} from '../src/rollup/http.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves,loadRollupLeaves} from '../src/rollup/leaves.ts';
import type {RollupArchive,RollupTransport} from '../src/rollup/operator.ts';
import {openRollupService,rollupClassicPin,rollupEpochPin,rollupGenesisOf,rollupKeyFilesOf,rollupPoolKindOf,rollupProgramsHash,rollupProvingOf,type RollupPoolKind,type RollupService} from '../src/rollup/service.ts';
import {openStockJournal,stockJournalFingerprint,type StockJournalHooks,type StockJournalReceipt} from '../src/stock/journal.ts';
import {epochHarness,rejection} from './fixtures/epoch.ts';
import {offlineNativeFixture} from './fixtures/native.ts';
import './rollup-genesis3-contract.test.ts';

const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const {deposit,dummyInput,recovery}=epochHarness(hash);
const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
const [serverPub,emulatorPub]=['01','02'].map(b=>secp256k1.getPublicKey(hex.decode(b.repeat(32)),true));
const serverKey=hex.encode(serverPub!.subarray(1)),emulatorKey=hex.encode(emulatorPub!.subarray(1)),exitDelay={type:'seconds' as const,value:2048};
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[serverPub!.subarray(1)],timelock:{type:'seconds',value:4096n}});
const proof:SnarkProof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1']};
const POOL_KEYS=['address','batches','head','maxReserves','operator','padding','pending','reserves','root','script','token'];
const STATUS_KEYS=['fundingAddress','fundingSats','message','minimumFundingSats','network','phase','pool','proving','version'];
// rollupEpochPin with the inputs below, as of its introduction: once a genesis-4 pool is live, a move orphans its journal.
const EPOCH_PIN_FINGERPRINT='93a57a93d9a0f81b50838b1cbbdc3d66acbfaab916adca6e07c45a92f221458e';

// Shared-setup verifying keys from the committed fixtures, built as tests/rollup-service-keys.test.ts builds them; wasm and zkey are stand-ins.
const vkeys=(()=>{
 const read=(file:string)=>JSON.parse(readFileSync(`tools/vm/testdata/${file}`,'utf8')) as Record<'clientKey'|'batchKey',{vk_delta_2:unknown;IC:unknown[]}>;
 const classic=read('rollup-covenant-snarkjs.json'),{clientKey,batchKey}=read('rollup-epoch-covenant-snarkjs.json');
 const wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 return {spend:classic.clientKey,join:classic.clientKey,'batch-spend':classic.batchKey,'batch-join':classic.batchKey,
  'epoch-spend':clientKey,'epoch-join':{...clientKey,vk_delta_2:batchKey.vk_delta_2},'epoch-batch-spend':wide,'epoch-batch-join':wide,'epoch-batch-recover':batchKey} as Record<string,unknown>;
})();
// Removed once every test's own hooks have closed its services: Windows refuses to delete an open journal.
const scratches:string[]=[];
after(()=>{for(const dir of scratches)rmSync(dir,{recursive:true,force:true,maxRetries:10});});
const scratch=(prefix:string)=>{const dir=mkdtempSync(join(tmpdir(),prefix));scratches.push(dir);return dir;};
const keySet=(kind:RollupPoolKind)=>{
 const dir=scratch('rollup-service-keys-'),files:Record<string,string>={};
 for(const name of rollupKeyFilesOf(kind).filter(n=>n!=='manifest.json')){
  const body=name.endsWith('.vkey.json')?JSON.stringify(vkeys[name.slice(0,-10)]):name;
  writeFileSync(join(dir,name),body);files[name]=sha(body);
 }
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({circuits:{all:{files}}}));
 return dir;
};
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);

/** The Arkade Service, indexer and operator wallet in memory; every batch it is sent lands, since stub proofs cannot pass the covenant. */
function offline(){
 const txs=new Map<string,Transaction>(),landed:Transaction[]=[],sent:{payload:Uint8Array;script:string}[]=[],proved:string[]=[],logs:string[]=[];
 const coins:{txid:string;vout:number;value:number;script:string;assets:{assetId:string;amount:bigint}[];isSpent:boolean;expiresAt:Date}[]=[];
 const head=(tx:Transaction)=>{
  for(const c of coins)c.isSpent||=c.txid===hex.encode(tx.getInput(0).txid!)&&c.vout===tx.getInput(0).index;
  txs.set(tx.id,tx);coins.push({txid:tx.id,vout:0,value:Number(tx.getOutput(0).amount),script:hex.encode(tx.getOutput(0).script!),assets:[{assetId:token,amount:1n}],isSpent:false,expiresAt:new Date(Date.now()+30*86400_000)});
 };
 const transport:RollupTransport={
  submit:async request=>{
   const tx=Transaction.fromPSBT(base64.decode(request.arkTx));landed.push(tx);head(tx);
   return {txid:tx.id,checkpointTxids:request.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:request.arkTx,signedCheckpointTxs:request.checkpoints,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};
  },
  lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,spentBy:async()=>undefined,
 };
 const wallet={address:'tark1operator',wallet:{getBalance:async()=>({available:5000}),assetManager:{issue:async()=>({assetId:token})},dispose:async()=>{},
  send:async({recipients:[r]}:{recipients:{address:string;amount:number;extensions:{payload:Uint8Array}[]}[]})=>{
   const script=ArkAddress.decode(r!.address).pkScript,payload=r!.extensions[0]!.payload,tx=offlineNativeFixture([{script,amount:BigInt(r!.amount)}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,payload)]);
   sent.push({payload,script:hex.encode(script)});head(tx);return tx.id;
  }}};
 const indexer={
  getVtxos:async(q:{scripts?:string[];outpoints?:{txid:string;vout:number}[];spendableOnly?:boolean})=>({vtxos:coins.filter(c=>(!q.scripts||q.scripts.includes(c.script))&&(!q.outpoints||q.outpoints.some(p=>p.txid===c.txid&&p.vout===c.vout))&&!(q.spendableOnly&&c.isSpent))}),
  getVirtualTxs:async(ids:string[])=>({txs:ids.flatMap(id=>txs.has(id)?[base64.encode(txs.get(id)!.toPSBT())]:[])}),
 };
 const providers={wallet:async()=>wallet as never,info:async()=>({checkpointTapscript:hex.encode(checkpoint.script),forfeitPubkey:hex.encode(serverPub!)}),indexer:indexer as never,transport:transport as never,
  prover:(a:{zkey:string})=>({prove:async()=>{proved.push(basename(a.zkey,'.zkey'));return proof;}}),verify:async()=>true};
 const answers:Record<string,unknown>={'http://ark.test/v1/info':{network:'mutinynet',signerPubkey:hex.encode(serverPub!),maxTxWeight:'40000',dust:'330',unilateralExitDelay:'2048'},'http://emulator.test/v1/info':{signerPubkey:hex.encode(emulatorPub!),version:'test'}};
 const fetcher=(async(url:URL|string)=>new Response(JSON.stringify(answers[String(url)]))) as typeof fetch;
 const open=(directory:string,keys:string)=>openRollupService({directory,circuits:directory,setupTool:directory,bundled:keys,vmBinary:DEFAULT_VM_BINARY,log:m=>logs.push(m),
  endpoints:{arkUrl:'http://ark.test',emulatorUrl:'http://emulator.test',fetcher},providers});
 return {transport,landed,sent,proved,logs,open};
}
type Offline=ReturnType<typeof offline>;
/** One step of a service on `directory`, which must reach `ready`; closing twice is harmless, and a service left open never lets the file exit. */
async function ready(net:Offline,directory:string,keys:string,epochLen?:string){
 if(epochLen)process.env.SHIELDED_ROLLUP_EPOCH_LEN=epochLen;
 try{const service=await net.open(directory,keys);after(()=>service.close());await service.step();assert.equal(service.status().phase,'ready',service.status().message);return service;}
 finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
}
const until=async(what:string,done:()=>boolean,net:Offline)=>{for(let i=0;i<600&&!done();i++)await new Promise(r=>setTimeout(r,100));assert.ok(done(),`${what}; log: ${net.logs.slice(-5).join(' | ')}`);};
const epochSpend=(w:{slot:unknown;publicSignals:bigint[]},origin?:number)=>({id:hex.encode(randomBytes(16)),slot:w.slot,publics:w.publicSignals,proof,...(origin!==undefined?{origin}:{})}) as never;
const batchesOf=(service:RollupService,from:number,limit:number)=>service.batches(from,limit).batches as unknown as RollupEpochRecord[];

test('an epoch service opens an epoch pool, rotates, and lands a recover batch',async()=>{
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
 assert.deepEqual([service.checkpoint(64),service.scan(0,66)],[undefined,undefined],'past a rotation, a global checkpoint or scan would be wrong');
});

test('a classic service is byte-identical to today',async()=>{
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
 assert.notEqual(service.status().pool!.root,pool.root);
 assert.ok(net.proved.includes('batch-spend')&&net.proved.includes('spend'));
 service.close();
 // The journal reopens under the harness-pinned classic builder, and refuses the epoch one.
 const pinned={leaves,manifest:readFileSync(join(directory,'keys','manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey,emulatorKey};
 const hooks:StockJournalHooks<RollupArchive,unknown,StockJournalReceipt>={validateArchive:()=>{},validatePlan:()=>{},verifyReceipt:()=>{},transmit:async()=>{throw new Error('unused');},lookup:async()=>undefined,apply:a=>a};
 (await openStockJournal(join(directory,'operator','journal'),rollupClassicPin(pinned),saved.archive,hooks)).close();
 await assert.rejects(openStockJournal(join(directory,'operator','journal'),rollupEpochPin({...pinned,leaves:{...leaves,batchRecover:leaves.batch}}),saved.archive,hooks).then(j=>j.close()),/changed/);
});

test('the epoch pool refuses /scan and /checkpoints rather than serving a wrong frontier',async t=>{
 const net=offline(),service=await ready(net,scratch('rollup-epoch-http-'),keySet('epoch'),'64');
 const app=express();app.use('/api/rollup',createRollupRouter(()=>service));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=(path:string)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
 const scan=await request('/api/rollup/scan?from=0');
 assert.equal(scan.status,501);
 assert.match((await scan.json()).error,/Plan 4b/);
 assert.equal((await request('/api/rollup/checkpoints/64')).status,404);
 assert.deepEqual(await (await request('/api/rollup/times')).json(),{every:CHECKPOINT_EVERY,at:[]});
 assert.deepEqual(await (await request('/api/rollup/batches')).json(),{from:0,total:0,batches:[]});
 const status=await (await request('/api/rollup/status')).json();
 assert.deepEqual([Object.keys(status).sort(),Object.keys(status.pool).sort()],[STATUS_KEYS,POOL_KEYS],'the same keys as a classic pool');
 assert.equal(status.pool.root,String(EpochState.genesis(hash,64).latestRoot()));
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
 assert.deepEqual(rollupProvingOf('epoch',files),{spend:pair('epoch-spend'),join:pair('epoch-join'),batch:pair('epoch-batch-spend'),batchJoin:pair('epoch-batch-join')});
});

test('the epoch journal pin is its own, and never the classic one',()=>{
 const leaves={batch:Uint8Array.of(1),batchJoin:Uint8Array.of(2),reserve:Uint8Array.of(3),renew:Uint8Array.of(4),batchRecover:Uint8Array.of(5)};
 const inputs={leaves,manifest:Buffer.from('manifest'),checkpoint:Uint8Array.of(0x51),genesisTxid:'55'.repeat(32),serverKey:'66'.repeat(32),emulatorKey:'77'.repeat(32)};
 const pin=rollupEpochPin(inputs);
 assert.equal(stockJournalFingerprint(pin),EPOCH_PIN_FINGERPRINT);
 assert.notEqual(stockJournalFingerprint(pin),stockJournalFingerprint(rollupClassicPin(inputs)));
 assert.notEqual(pin.programsHash,rollupProgramsHash(leaves));
});
