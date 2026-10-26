import assert from 'node:assert/strict';
import {mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {base64,hex} from '@scure/base';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {ctDigestOf,ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {rollupEpochPin} from '../src/rollup/service.ts';
import {epochHarness} from './fixtures/epoch.ts';
import {checkpoint,emulatorKey,epochRecord,hash,keySet,le32,listen,offline,proof,ready,scratch,serverKey,sha,token,until} from './fixtures/epoch-service.ts';

// Byte-exact pins of what an epoch pool serves, taken before the classic code goes: no literal here may move in the deletion.
// 202 records at epochLen 68 give two closed epochs and a third holding 66 batches; the seeded operator key fixes the pool script and every leaf.
const EPOCH_LEN=68,BATCHES=202;
type Fetcher=Awaited<ReturnType<typeof listen>>;
const json=async(request:Fetcher,path:string)=>(await request(`/api/rollup${path}`)).json() as Promise<any>;
const without=(o:Record<string,unknown>,...keys:string[])=>Object.fromEntries(Object.entries(o).filter(([key])=>!keys.includes(key)));
const pathsOf=(value:unknown,path=''):string[]=>{
 const entries=value&&typeof value==='object'&&!Array.isArray(value)?Object.entries(value):[];
 return entries.length?entries.flatMap(([key,child])=>pathsOf(child,path?`${path}.${key}`:key)):[path];
};

async function world(batches:number){
 const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-golden-'),record=epochRecord(EPOCH_LEN);
 writeFileSync(join(directory,'secrets.json'),JSON.stringify({wallet:'03'.repeat(32),operator:'04'.repeat(32)}));
 const genesis=await ready(net,directory,keys,String(EPOCH_LEN));
 if(!batches)return {net,directory,service:genesis,request:await listen(genesis)};
 genesis.close();
 const saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')),replica=EpochState.genesis(hash,EPOCH_LEN,false),bodies=join(directory,'operator','batches');
 for(let n=0;n<batches;n++){const r=record(n);replica.applyFromChain(r.kind,r.slots.map(s=>s.nullifiers.map(BigInt)),BigInt(r.noteBlockRoot));}
 const head=await net.newHead(Uint8Array.from([...le32(replica.commitment()),...le32(0n),...le32(0n)]));
 rmSync(join(directory,'operator'),{recursive:true,force:true,maxRetries:10});mkdirSync(bodies,{recursive:true});
 for(let n=0;n<batches;n++)writeFileSync(join(bodies,`${n}.json`),JSON.stringify(record(n)));
 writeFileSync(join(directory,'genesis.json'),JSON.stringify({...saved,archive:{...saved.archive,head,batches}}));
 const service=await ready(net,directory,keys);
 return {net,directory,service,request:await listen(service)};
}
let baked:ReturnType<typeof world>|undefined,fresh:ReturnType<typeof world>|undefined;
const bakedWorld=()=>baked??=world(BATCHES),freshWorld=()=>fresh??=world(0);

test('the epoch /status carries these paths and these values',async()=>{
 const {request}=await bakedWorld(),status=await json(request,'/status');
 assert.deepEqual(pathsOf(status).sort(),[
  'fundingAddress','message','minimumFundingSats','network.arkUrl','network.dust','network.emulatorKey','network.emulatorUrl','network.emulatorVersion','network.exitDelay.type','network.exitDelay.value',
  'network.nativeAdmission','network.network','network.operatorMaxWeight','network.serverKey','network.weightLimit','phase','pool.address','pool.batches','pool.batchesInEpoch','pool.epoch','pool.epochLen',
  'pool.erCount','pool.head.txid','pool.head.value','pool.head.vout','pool.heapBytes','pool.maxReserves','pool.nullifiers','pool.operator','pool.padding','pool.pending','pool.prevNoteRoot','pool.reserves',
  'pool.root','pool.rsCount','pool.script','pool.token','proving.batch.wasm','proving.batch.zkey','proving.batchJoin.wasm','proving.batchJoin.zkey','proving.batchRecover.wasm','proving.batchRecover.zkey',
  'proving.join.wasm','proving.join.zkey','proving.spend.wasm','proving.spend.zkey','version',
 ]);
 const {proving,pool,...top}=without(status,'network') as Record<string,any>,pair=(c:string)=>({wasm:sha(`${c}.wasm`),zkey:sha(`${c}.zkey`)});
 assert.deepEqual(top,{version:1,phase:'ready',message:'The rollup pool is open.',minimumFundingSats:2000,fundingAddress:'tark1operator'});
 assert.deepEqual(without(pool,'heapBytes','lastBatch','pending','padding'),{
  token,operator:'462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b',
  address:'tark1qqdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rc7yrkfkntpvyg80edjkwexza06ca6cl5g3nmusp00k8cvqc75fta7ym2rzt',
  script:'512010764da6b0b0883bf2d959d930bafd63bac7e888cf7c805efb1f0c063d44afbe',batches:202,root:'5867867729133052292667243496802579568941844556107288965176322207124614318495',
  head:{txid:'02a0343f5dfe7d6db63c74f4a067589dbbe0eb95ab31beefd68a0f18d2f02629',vout:0,value:1000},reserves:{},maxReserves:64,epoch:2,epochLen:68,batchesInEpoch:66,
  prevNoteRoot:'16803313003740954983200070491522429907492130960155140569488535423916745783417',erCount:2,rsCount:135,nullifiers:1,
 });
 assert.deepEqual(proving,{spend:pair('epoch-spend'),join:pair('epoch-join'),batch:pair('epoch-batch-spend'),batchJoin:pair('epoch-batch-join'),batchRecover:pair('epoch-batch-recover')});
});

test('the epoch /scan serves these bytes',async()=>{
 const {request}=await bakedWorld(),all=await json(request,'/scan?from=0'),bytes=base64.decode(all.data);
 assert.deepEqual(await json(request,'/scan?from=0&limit=1'),{from:0,total:202,data:'L7Pgb6GiaY9cFD7wEFQ/EUiDk5d+wLnxcKJnv1DjuC4AAIBW/rx4QgAV4EyiuqcBBN2iN/ONfWIm4op6Z336Wh3FGZJSfxSQJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEczdwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBwOJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnPdqoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+4L33AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGIPzmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+iT6pwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6W5eTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABbUJcgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApAmp1QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACf6010'});
 // The whole scan crosses both rotations and holds spend and recover batches alike.
 assert.deepEqual([all.from,all.total,bytes.length,sha(bytes)],[0,202,45678,'b2df5c9892fde3c8becc63d1c0339f72d337eb550307bf099bcba5e55b32644e']);
});

test('the epoch /batches serves the stored records',async()=>{
 const {request}=await bakedWorld(),page=await json(request,'/batches?from=0&limit=1'),[spend]=page.batches,[recover]=(await json(request,'/batches?from=68&limit=1')).batches;
 assert.deepEqual([Object.keys(page).sort(),page.from,page.total,page.batches.length],[['batches','from','total'],0,202,1]);
 assert.deepEqual(Object.keys(spend).sort(),['at','kind','noteBlockRoot','slots','txid']);
 assert.deepEqual([spend.kind,spend.slots.length,spend.noteBlockRoot,spend.txid,spend.at],['spend',10,'17442455691028082884977169158625582588193749552069889874663728477990577561621','2fb3e06fa1a2698f5c143ef010543f11488393977ec0b9f170a267bf50e3b82e',1700000000000]);
 assert.deepEqual(spend.slots[0],{anchor:'0',nullifiers:['20347670708816835373608491907576101923235571169251424054628287411688698246020'],commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:0,publics:[]});
 assert.deepEqual(recover,{kind:'recover',slots:[{anchor:'0',origin:-1,nullifiers:['2103165894274830875442197459956084687970026196468038797827187566313397878608'],commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:0,publics:[]}],
  noteBlockRoot:'21886067780422403159792795430407508490318770980348761015171941139571628103847',txid:'679247bf8c1efc9a861f438398e396cb76732f0be0c5ab84b5b3c5130a1f5ab3',at:1700000068000});
});

test('the epoch /checkpoints/:epoch/:blocks serves this body',async()=>{
 const {request}=await bakedWorld(),answer=await request('/api/rollup/checkpoints/2/64');
 assert.deepEqual([answer.status,answer.headers.get('cache-control'),await answer.json()],[200,'no-store',{epoch:2,blocks:64,filled:[
  '0','0','0','0','0','0','17360344228814267772899595179979933860737348185350762485230771730599709081744','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0','0',
 ]}]);
});

test('the epoch /archives lists its closed epochs and serves their files',async()=>{
 const {request}=await bakedWorld(),file=async(name:string)=>{const answer=await request(`/api/rollup/archives/${name}`);return [answer.status,answer.headers.get('content-type'),answer.headers.get('cache-control'),sha(Buffer.from(await answer.arrayBuffer()))];};
 assert.deepEqual(await json(request,'/archives'),{epochs:[0,1]});
 assert.deepEqual(await file('epoch-0.nf'),[200,'application/octet-stream','public, max-age=31536000, immutable','23ae8ae69595e7437f7223dc4dac69f2d99f248bb7b52dc1416d38a1ffc78cac']);
 assert.deepEqual(await file('epoch-1.nf'),[200,'application/octet-stream','public, max-age=31536000, immutable','c416eaa0ab000240ff266d826b88f16b1bc38808409c27f6573daeff3da28f17']);
});

test('the epoch key allowlist serves the five epoch circuits and the manifest, and nothing classic',async()=>{
 const {directory,service,request}=await bakedWorld(),served=[
  'epoch-batch-join.vkey.json','epoch-batch-join.wasm','epoch-batch-join.zkey','epoch-batch-recover.vkey.json','epoch-batch-recover.wasm','epoch-batch-recover.zkey','epoch-batch-spend.vkey.json','epoch-batch-spend.wasm',
  'epoch-batch-spend.zkey','epoch-join.vkey.json','epoch-join.wasm','epoch-join.zkey','epoch-spend.vkey.json','epoch-spend.wasm','epoch-spend.zkey','manifest.json',
 ],refused=[...['spend','join','batch-spend','batch-join'].flatMap(c=>[`${c}.wasm`,`${c}.zkey`,`${c}.vkey.json`]),'genesis.json','secrets.json','spec.json','..%2Fsecrets.json'];
 const statuses=(names:string[])=>Promise.all(names.map(async name=>(await request(`/api/rollup/proving/${name}`)).status));
 assert.deepEqual(readdirSync(join(directory,'keys')).sort(),served);
 assert.deepEqual([served.filter(name=>!service.keyFile(name)),refused.filter(name=>service.keyFile(name))],[[],[]]);
 assert.deepEqual([await statuses(served),await statuses(refused)],[served.map(()=>200),refused.map(()=>404)]);
});

// The stand-in batch keys are one key, so a swap of the two would leave the leaves alone; the spec text catches it.
test('the epoch spec names each key file for its own circuit',async()=>{
 const {directory}=await bakedWorld();
 assert.equal(readFileSync(join(directory,'spec.json'),'utf8'),`{"clientKey":"keys/epoch-spend.vkey.json","batchKey":"keys/epoch-batch-spend.vkey.json","clientJoinKey":"keys/epoch-join.vkey.json","batchJoinKey":"keys/epoch-batch-join.vkey.json","batchRecoverKey":"keys/epoch-batch-recover.vkey.json","slots":10,"token":"${token}","operator":"462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b","epoch":true}`);
});

test('the epoch journal pin is these hashes',async()=>{
 const {directory}=await bakedWorld(),leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(directory,'spec.json'));
 // Once a genesis-4 pool is live, a move in any of these hashes orphans its journal.
 assert.deepEqual(rollupEpochPin({leaves,manifest:Buffer.from('manifest'),checkpoint:checkpoint.script,genesisTxid:'55'.repeat(32),serverKey,emulatorKey}),{
  version:1,network:'mutinynet',descriptorProfileId:'145cd1a05896624abf5e4449e1e92aad1e3f13445fa5f41471f44474c42cb7e4',programsHash:'16a5b8ccd9260aae9fdb0895cb4ad3137eb7f1f6113bf03050734b399ce5e333',
  artifactsHash:'05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f',checkpointHash:'94c89a0b570387bf357b6a616dc9ea7ea6eb7225f29cc9ae8c100387b8ce89f2',
  genesisTxid:'55'.repeat(32),serverKey:'1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',emulatorKey:'4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
 });
});

test('a batch the epoch operator wrote is served with these paths and this transaction',async()=>{
 const {net,service,request}=await freshWorld(),{deposit}=epochHarness(hash),mirror=EpochState.genesis(hash,EPOCH_LEN,false);
 const spends=Array.from({length:BATCH_SLOTS},(_,n)=>{
  const ciphertext=Uint8Array.from({length:ROLLUP_RECORD_BYTES},(_,i)=>(i+n)%251),built=deposit(mirror,0n,{ctDigest:ctDigestOf(ciphertext)});
  return {id:hex.encode(Uint8Array.from({length:16},()=>n+1)),slot:built.slot,publics:built.publicSignals,proof,ciphertext};
 });
 // Ten spends fill a batch, so none of the random padding proved in the background rides in it; the record's `at` is the wall clock and is left out.
 await Promise.all(spends.map(s=>service.submit(s as never)));
 await until('the batch lands',()=>service.status().pool!.batches===1,net);
 const [record]=(await json(request,'/batches?from=0&limit=1')).batches;
 assert.deepEqual(Object.keys(record).sort(),['at','kind','noteBlockRoot','slots','txid']);
 assert.deepEqual(pathsOf(record.slots[0]).sort(),['anchor','ciphertext','commitments','ctDigest','groupId','groupSize','nullifiers','publics','rCur.epoch','rCur.root']);
 assert.deepEqual([record.kind,record.slots.length,record.noteBlockRoot,record.txid],['spend',10,'10213525036281699254558372429565124490521660675928360058580130848528818887417','29d4be07aa39a125d6d43c0054d9135d8bfb8da380e63a68ed0e1ccdf2626aa7']);
 assert.deepEqual(record.slots,spends.map(({slot:s,publics,ciphertext})=>({anchor:String(s.anchor),rCur:{epoch:s.rCur!.epoch,root:String(s.rCur!.root)},nullifiers:s.nullifiers.map(String),commitments:s.commitments.map(String),
  ctDigest:String(s.ctDigest),groupId:String(s.groupId),groupSize:s.groupSize,publics:publics.map(String),ciphertext:hex.encode(ciphertext)})));
});
