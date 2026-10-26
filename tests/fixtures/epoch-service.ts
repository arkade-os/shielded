import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {after} from 'node:test';
import express from 'express';
import {ArkAddress,asset,CSVMultisigTapscript,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS} from '../../packages/protocol/src/rollup/constants.ts';
import type {RollupEpochRecord} from '../../packages/protocol/src/rollup/epoch-record.ts';
import {ROLLUP_STATE_PACKET,type SnarkProof} from '../../src/rollup/covenant.ts';
import type {RollupEpochSpend} from '../../src/rollup/epoch-operator.ts';
import {createRollupRouter} from '../../src/rollup/http.ts';
import {DEFAULT_VM_BINARY} from '../../src/rollup/leaves.ts';
import type {RollupTransport} from '../../src/rollup/operator.ts';
import {openRollupService,rollupKeyFilesOf,type RollupPoolKind,type RollupService} from '../../src/rollup/service.ts';
import {encodeEpochSpend,openSpendStore} from '../../src/rollup/spend-store.ts';
import {offlineNativeFixture} from './native.ts';

const poseidon=await buildPoseidon();
export const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
export const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
export const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
export const token=asset.AssetId.create('cc'.repeat(32),0).toString();
const [serverPub,emulatorPub]=['01','02'].map(b=>secp256k1.getPublicKey(hex.decode(b.repeat(32)),true));
export const serverKey=hex.encode(serverPub!.subarray(1)),emulatorKey=hex.encode(emulatorPub!.subarray(1)),exitDelay={type:'seconds' as const,value:2048};
export const checkpoint=CSVMultisigTapscript.encode({pubkeys:[serverPub!.subarray(1)],timelock:{type:'seconds',value:4096n}});
export const proof:SnarkProof={pi_a:['1','2','1'],pi_b:[['1','2'],['3','4'],['1','0']],pi_c:['1','2','1']};
/** The one proof the offline verifier refuses. */
export const badProof:SnarkProof={...proof,pi_a:['0','2','1']};
// What a genesis-3 wallet reads from /status; never edited to fit a new field, which belongs on an epoch pool only.
export const STATUS_KEYS=['fundingAddress','fundingSats','message','minimumFundingSats','network','phase','pool','proving','version'];
export const POOL_KEYS=['address','batches','head','maxReserves','operator','padding','pending','reserves','root','script','token'];
export const PROVING_KEYS=['batch','batchJoin','join','spend'];
export const EPOCH_POOL_KEYS=['batchesInEpoch','epoch','epochLen','erCount','heapBytes','nullifiers','prevNoteRoot','rsCount'];
export const blockRoot=(n:number)=>hash([77n,BigInt(n)]);
export const slotOf=(n:number,s:number)=>({nullifiers:[String(hash([78n,BigInt(n),BigInt(s)]))],commitments:['0','0'] as [string,string],ctDigest:'0',groupId:'0',groupSize:0,publics:[] as string[]});
export const stamp=(n:number)=>({txid:sha(`batch ${n}`),at:1_700_000_000_000+n*1000});
// Epoch 0 is spends; the recoveries after it are one slot wide, which keeps the replay of a second epoch cheap.
// applyFromChain never reads origin and no admission sees a baked record, so the -1 below is only a placeholder.
export const epochRecord=(epochLen:number)=>(n:number):RollupEpochRecord=>({kind:n<epochLen?'spend':'recover',
 slots:n<epochLen?Array.from({length:BATCH_SLOTS},(_,s)=>({anchor:'0',...slotOf(n,s)})):[{anchor:'0',origin:-1,...slotOf(n,0)}],noteBlockRoot:String(blockRoot(n)),...stamp(n)});
/** Leaves each spend pending on disk as submit() stores it, as a crash before its batch settled would. */
export const pendingOnDisk=(directory:string,...spends:Omit<RollupEpochSpend,'receivedAt'>[])=>{
 const store=openSpendStore(join(directory,'spends'));
 for(const s of spends)store.save({id:s.id,status:'pending',nullifier:String(s.slot.nullifiers[0]),at:Date.now(),spend:encodeEpochSpend(s)});
};

// Shared-setup verifying keys from the committed fixtures; wasm and zkey are stand-ins.
const vkeys=(()=>{
 const read=(file:string)=>JSON.parse(readFileSync(`tools/vm/testdata/${file}`,'utf8')) as Record<'clientKey'|'batchKey',{vk_delta_2:unknown;IC:unknown[]}>;
 const classic=read('rollup-covenant-snarkjs.json'),{clientKey,batchKey}=read('rollup-epoch-covenant-snarkjs.json');
 const wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 return {spend:classic.clientKey,join:classic.clientKey,'batch-spend':classic.batchKey,'batch-join':classic.batchKey,
  'epoch-spend':clientKey,'epoch-join':{...clientKey,vk_delta_2:batchKey.vk_delta_2},'epoch-batch-spend':wide,'epoch-batch-join':wide,'epoch-batch-recover':batchKey} as Record<string,unknown>;
})();

// Servers and services close before the scratch directories go: Windows refuses to delete an open journal.
const closers:(()=>unknown)[]=[],scratches:string[]=[];
after(async()=>{
 const failed:unknown[]=[];
 for(const close of closers.reverse())try{await close();}catch(error){failed.push(error);}
 for(const dir of scratches)rmSync(dir,{recursive:true,force:true,maxRetries:10});
 if(failed.length)throw failed[0];
});
export const scratch=(prefix:string)=>{const dir=mkdtempSync(join(tmpdir(),prefix));scratches.push(dir);return dir;};
export const keySet=(kind:RollupPoolKind)=>{
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
export function offline(){
 const txs=new Map<string,Transaction>(),landed:Transaction[]=[],sent:{payload:Uint8Array;script:string}[]=[],proved:string[]=[],logs:string[]=[];
 const coins:{txid:string;vout:number;value:number;script:string;assets:{assetId:string;amount:bigint}[];isSpent:boolean;arkTxId?:string;expiresAt:Date}[]=[];
 const head=(tx:Transaction)=>{
  for(const c of coins)c.isSpent||=c.txid===hex.encode(tx.getInput(0).txid!)&&c.vout===tx.getInput(0).index;
  txs.set(tx.id,tx);coins.push({txid:tx.id,vout:0,value:Number(tx.getOutput(0).amount),script:hex.encode(tx.getOutput(0).script!),assets:[{assetId:token,amount:1n}],isSpent:false,expiresAt:new Date(Date.now()+30*86400_000)});
 };
 let gate:{held:{reached:boolean;release():void};waiting:Promise<void>}|undefined,proveMs=0;
 /** The next batch sent holds at the transport until released, after the operator has already applied it to its state. */
 const hold=()=>{let release=()=>{};const held={reached:false,release:()=>release()};gate={held,waiting:new Promise<void>(r=>{release=r;})};return held;};
 const transport:RollupTransport={
  submit:async request=>{
   if(gate){const {held,waiting}=gate;gate=undefined;held.reached=true;await waiting;}
   const tx=Transaction.fromPSBT(base64.decode(request.arkTx));landed.push(tx);head(tx);
   // A batch spends each coin through its checkpoint, so this is what /external asks the indexer about.
   for(const c of request.checkpoints.map(p=>Transaction.fromPSBT(base64.decode(p)))){
    txs.set(c.id,c);const {txid,index}=c.getInput(0),coin=coins.find(v=>v.txid===hex.encode(txid!)&&v.vout===index);
    if(coin){coin.isSpent=true;coin.arkTxId=tx.id;}
   }
   return {txid:tx.id,checkpointTxids:request.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:request.arkTx,signedCheckpointTxs:request.checkpoints,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};
  },
  lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,spentBy:async()=>undefined,
 };
 const wallet={address:'tark1operator',wallet:{getBalance:async()=>({available:5000}),assetManager:{issue:async()=>({assetId:token})},dispose:async()=>{},
  send:async({recipients:[r]}:{recipients:{address:string;amount:number;extensions:{payload:Uint8Array}[]}[]})=>{
   const script=ArkAddress.decode(r!.address).pkScript,payload=r!.extensions[0]!.payload,tx=offlineNativeFixture([{script,amount:BigInt(r!.amount)}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,payload)]);
   sent.push({payload,script:hex.encode(script)});head(tx);return tx.id;
  }}};
 const newHead=async(payload:Uint8Array)=>{
  const address=new ArkAddress(hex.decode(serverKey),hex.decode(sent[0]!.script).subarray(2),'tark').encode(),txid=await wallet.wallet.send({recipients:[{address,amount:1000,extensions:[{payload}]}]});
  return {txid,vout:0,value:1000,sourceTxHex:hex.encode(txs.get(txid)!.toBytes(true,true))};
 };
 /** A plain coin of a depositor's, indexed with no asset; two of equal script and value would share a txid. */
 const fund=(script:Uint8Array,value:number)=>{
  const tx=offlineNativeFixture([{script,amount:BigInt(value)}]);txs.set(tx.id,tx);
  coins.push({txid:tx.id,vout:0,value,script:hex.encode(script),assets:[],isSpent:false,expiresAt:new Date(Date.now()+30*86400_000)});
  return {txid:tx.id,vout:0};
 };
 const indexer={
  getVtxos:async(q:{scripts?:string[];outpoints?:{txid:string;vout:number}[];spendableOnly?:boolean})=>({vtxos:coins.filter(c=>(!q.scripts||q.scripts.includes(c.script))&&(!q.outpoints||q.outpoints.some(p=>p.txid===c.txid&&p.vout===c.vout))&&!(q.spendableOnly&&c.isSpent))}),
  getVirtualTxs:async(ids:string[])=>({txs:ids.flatMap(id=>txs.has(id)?[base64.encode(txs.get(id)!.toPSBT())]:[])}),
 };
 const providers={wallet:async()=>wallet as never,info:async()=>({checkpointTapscript:hex.encode(checkpoint.script),forfeitPubkey:hex.encode(serverPub!)}),indexer:indexer as never,transport:transport as never,
  prover:(a:{zkey:string})=>({prove:async()=>{proved.push(basename(a.zkey,'.zkey'));if(proveMs)await new Promise(r=>setTimeout(r,proveMs));return proof;}}),verify:async(_key:unknown,_publics:unknown,p:SnarkProof)=>p.pi_a[0]!==badProof.pi_a[0]};
 const answers:Record<string,unknown>={'http://ark.test/v1/info':{network:'mutinynet',signerPubkey:hex.encode(serverPub!),maxTxWeight:'40000',dust:'330',unilateralExitDelay:'2048'},'http://emulator.test/v1/info':{signerPubkey:hex.encode(emulatorPub!),version:'test'}};
 const fetcher=(async(url:URL|string)=>new Response(JSON.stringify(answers[String(url)]))) as typeof fetch;
 const open=(directory:string,keys:string,epochLen?:number|string)=>openRollupService({directory,circuits:directory,setupTool:directory,bundled:keys,vmBinary:DEFAULT_VM_BINARY,log:m=>logs.push(m),
  endpoints:{arkUrl:'http://ark.test',emulatorUrl:'http://emulator.test',fetcher},providers,...(epochLen===undefined?{}:{epochLen})});
 return {transport,landed,sent,proved,logs,open,hold,newHead,fund,delay:(ms:number)=>{proveMs=ms;}};
}
export type Offline=ReturnType<typeof offline>;

/** One step of a service on `directory`, which must reach `ready`; closed with the file's other closers. */
export async function ready(net:Offline,directory:string,keys:string,epochLen?:number|string){
 const service=await net.open(directory,keys,epochLen);closers.push(()=>service.close());await service.step();assert.equal(service.status().phase,'ready',service.status().message);return service;
}
export const until=async(what:string,done:()=>boolean,net:Offline)=>{for(let i=0;i<600&&!done();i++)await new Promise(r=>setTimeout(r,100));assert.ok(done(),`${what}; log: ${net.logs.slice(-5).join(' | ')}`);};

export async function listen(service:RollupService){
 const app=express();app.use('/api/rollup',createRollupRouter(()=>service));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));closers.push(()=>new Promise(r=>server.close(r)));
 // Under a loaded suite an idle close can race the next request into a reset; tests that need a dead socket close one themselves.
 server.keepAliveTimeout=0;
 return Object.assign((path:string,init?:RequestInit)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,init),{server});
}

/**
 * A pool that already ran `batches` batches, as a restart finds it: genesis from a first run, then chain-only records (as /external
 * writes them, so a replay needs no witnesses) and a head whose state packet holds `committed`; a packet of the wrong length reads as none.
 */
export async function bakedPool(o:{epochLen?:number;batches:number;record(n:number):object;committed?:bigint;prepare?(p:{directory:string;saved:Record<string,any>}):Promise<void>|void}){
 const net=offline(),keys=keySet(o.epochLen===undefined?'classic':'epoch'),directory=scratch('rollup-baked-');
 (await ready(net,directory,keys,o.epochLen===undefined?undefined:String(o.epochLen))).close();
 const saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')) as Record<string,any>;
 const head=await net.newHead(Uint8Array.from(o.committed===undefined?[...le32(0n),...le32(0n)]:[...le32(o.committed),...le32(0n),...le32(0n)]));
 const operator=join(directory,'operator'),batches=join(operator,'batches');
 rmSync(operator,{recursive:true,force:true,maxRetries:10});mkdirSync(batches,{recursive:true});
 for(let n=0;n<o.batches;n++)writeFileSync(join(batches,`${n}.json`),JSON.stringify(o.record(n)));
 writeFileSync(join(directory,'genesis.json'),JSON.stringify({...saved,archive:{...saved.archive,head,batches:o.batches}}));
 await o.prepare?.({directory,saved});
 return {net,directory,saved,service:await ready(net,directory,keys)};
}
