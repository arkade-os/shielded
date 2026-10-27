import {execFile,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,statfsSync,writeFileSync} from 'node:fs';
import {freemem,totalmem} from 'node:os';
import {dirname,join} from 'node:path';
import {ArkAddress,Extension,RestArkProvider,RestIndexerProvider,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {schnorr} from '@noble/curves/secp256k1.js';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,CHECKPOINT_EVERY,MAX_EPOCH_LEN,SUBTREE_DEPTH,type BatchKind} from '../../packages/protocol/src/rollup/constants.ts';
import {buildRollupTransfer,randomField} from '../../packages/protocol/src/rollup/account.ts';
import {EpochState} from '../../packages/protocol/src/rollup/epoch.ts';
import {epochPaddingTransfer} from '../../packages/protocol/src/rollup/epoch-circuit.ts';
import {encodeEpochScan,rotatesAt} from '../../packages/protocol/src/rollup/epoch-scan.ts';
import {checkpointOf} from '../../packages/protocol/src/rollup/frontier.ts';
import {encodeScan} from '../../packages/protocol/src/rollup/scan.ts';
import {RollupState} from '../../packages/protocol/src/rollup/state.ts';
import {rollupRecipientOf} from '../../packages/protocol/src/rollup/wallet.ts';
import {openCustomerArkWallet,withArkWallet} from '../stock/ark-wallet.ts';
import {validateStockCheckpoint} from '../stock/checkpoint.ts';
import {decodeStockIndexerTransaction} from '../stock/indexer.ts';
import type {StockReleasePin} from '../stock/journal.ts';
import {isStorageLocked} from '../storage.ts';
import {preflightStockMutinynet,type StockNetworkInfo} from '../stock/network.ts';
import type {StockWireRequest} from '../stock/transport.ts';
import type {RollupSpend} from './batcher.ts';
import {rollupEpochPoolTree,rollupPoolTree,ROLLUP_STATE_PACKET,type RollupCoin,type RollupEpochLeaves,type RollupLeaves} from './covenant.ts';
import {epochNfArchivePath} from './epoch-archive-file.ts';
import {openRollupEpochOperator,type RollupEpochOperator,type RollupEpochRecord,type RollupEpochSpend,type RollupEpochStatus} from './epoch-operator.ts';
import {loadRollupEpochLeaves,loadRollupLeaves,type RollupLeavesSpec} from './leaves.ts';
import {openRollupOperator,type RollupArchive,type RollupOperator,type RollupPoolCoin,type RollupRecord,type RollupTimings,type RollupTransport} from './operator.ts';
import {createRollupProver,type CircuitArtifacts,type RollupProver,type verifyRollupProof} from './prover.ts';
import {carriedReserves,flushRollupIntent,leftoverRenewal,renewalChunks,renewedRollupPool,renewRollupPool,rollupPoolPoints,rollupRenewalDue} from './renewal.ts';
import {listingsOf,MAX_RESERVES} from './listings.ts';
import {decodeEpochSpend,decodeSpend,encodeEpochSpend,encodeSpend,openSpendStore,type CoinRef,type EncodedEpochSpend,type EncodedSpend} from './spend-store.ts';
import {createRollupTransport} from './transport.ts';

export const ROLLUP_KEY_FILES=['manifest.json',...['spend','join','batch-spend','batch-join'].flatMap(c=>[`${c}.wasm`,`${c}.zkey`,`${c}.vkey.json`])] as const;
const EPOCH_CIRCUITS=['epoch-spend','epoch-join','epoch-batch-spend','epoch-batch-join','epoch-batch-recover'];
const EPOCH_KEY_FILES=['manifest.json',...EPOCH_CIRCUITS.flatMap(c=>[`${c}.wasm`,`${c}.zkey`,`${c}.vkey.json`])];
const ARCHIVE_FILE=/^epoch-(0|[1-9][0-9]*)\.nf$/;
export type RollupPoolKind='classic'|'epoch';
export const EPOCH_LEN_FLOOR=64;
export const rollupKeyFilesOf=(kind:RollupPoolKind):readonly string[]=>kind==='classic'?ROLLUP_KEY_FILES:EPOCH_KEY_FILES;
// A batch closes as soon as a spend is admitted, and a lone spend takes ten pads, so two batches' worth stay ready.
const HEAD_SATS=1000,MINIMUM_FUNDING_SATS=2000,SIGN_TIMEOUT_MS=30_000,PADDING_TARGET=2*BATCH_SLOTS;
// The batch-join setup alone peaked at 4.11 GiB single-threaded; the server process needs room beside it.
const SETUP_MEMORY_BYTES=6*1024**3,SETUP_ATTEMPTS=3,SETUP_RETRY_MS=10*60_000;
// arkd sweeps a pool coin at its batch expiry, so the pool moves to a fresh round well before. A batch inherits its
// earliest input expiry, so a deposit coin may shorten the head's life, but never below the renewal threshold's reach.
const RENEW_BEFORE_MS=48*3600_000,RENEW_CHECK_MS=10*60_000,DEPOSIT_FLOOR_MS=24*3600_000,LIST_CHECK_MS=60_000;

export type RollupPhase='starting'|'keys'|'funding'|'genesis'|'ready'|'blocked';
export type RollupStatusBatch={batch:number;at:number;rotated?:boolean}&RollupTimings;
export interface RollupStatus {
 version:1;phase:RollupPhase;message:string;minimumFundingSats:number;fundingAddress?:string;fundingSats?:number;
 pool?:{token:string;operator:string;notice?:string;address:string;script:string;batches:number;root:string;head:{txid:string;vout:number;value:number};pending:number;padding:number;lastBatch?:RollupStatusBatch;reserves:Record<string,string>;maxReserves:number;
  epoch?:number;epochLen?:number;batchesInEpoch?:number;prevNoteRoot?:string;erCount?:number;rsCount?:number;nullifiers?:number;heapBytes?:number};
 network?:StockNetworkInfo;
 proving?:Record<'spend'|'join'|'batch'|'batchJoin',{wasm:string;zkey:string}>&{batchRecover?:{wasm:string;zkey:string}};
}
export interface RollupSpendStatus {status:'pending'|'signing'|'included'|'dropped';batch?:number;txid?:string;reason?:string;arkTx?:string;checkpoint?:string;checkpoints?:string[];vin?:number}
interface Genesis {version:1|2;token:string;txid:string;archive:RollupArchive;serverKey:string;emulatorKey:string;epochLen?:number}
interface Session {arkTx:string;checkpoints:string[];vin:number;signed?:{arkTx:string;checkpoint:string}}
/** Stand-ins for the operator wallet, the Arkade Service, the indexer and snarkjs; only tests pass them. */
export interface RollupServiceProviders {
 wallet?():ReturnType<typeof openCustomerArkWallet>;
 info?():Promise<{checkpointTapscript:string;forfeitPubkey:string}>;
 indexer?:Pick<RestIndexerProvider,'getVtxos'|'getVirtualTxs'>;
 transport?:RollupTransport;
 prover?(artifacts:CircuitArtifacts):RollupProver;
 verify?:typeof verifyRollupProof;
}

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const readJson=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;
/** A recovery spends into the recovered set, which only an epoch pool keeps. */
const landed=(state:RollupState|EpochState,nf:bigint)=>state.nullifiers.has(nf)||(state instanceof EpochState&&state.recovered.has(nf));
type Submission=Omit<RollupSpend,'receivedAt'>|Omit<RollupEpochSpend,'receivedAt'>;
type FollowedSlots<O extends RollupOperator|RollupEpochOperator>=Parameters<O['follow']>[0]['slots'];
/** Each operator refuses the other's slot shape at admission, so a spend is admitted, and stored, only as the live pool's kind. */
const admit=(operator:RollupOperator|RollupEpochOperator,spend:Submission)=>operator.state instanceof EpochState
 ?(operator as RollupEpochOperator).submit(spend as Omit<RollupEpochSpend,'receivedAt'>):(operator as RollupOperator).submit(spend as Omit<RollupSpend,'receivedAt'>);

type KeyManifest={circuits:Record<string,{files:Record<string,string>}>};
/** Every served file must be in the manifest and match it, so a key set that lacks a circuit fails closed. */
export function verifyRollupKeys(keys:string,kind:RollupPoolKind='classic'):KeyManifest {
 const manifest=readJson<KeyManifest>(join(keys,'manifest.json')),listed:Record<string,string>=Object.assign({},...Object.values(manifest.circuits).map(c=>c.files));
 for(const name of rollupKeyFilesOf(kind).filter(n=>n!=='manifest.json')){
  if(!listed[name])throw new Error(`Rollup key ${name} is missing from the manifest.`);
  if(sha(readFileSync(join(keys,name)))!==listed[name])throw new Error(`Rollup key ${name} does not match its manifest.`);
 }
 return manifest;
}
/** Moves a finished key set over a leftover incomplete one; a set with a manifest may be a live pool's, so it is never replaced. */
const promoteRollupKeys=(partial:string,keys:string)=>{if(!existsSync(join(keys,'manifest.json')))rmSync(keys,{recursive:true,force:true});renameSync(partial,keys);};
/** Installs a pre-built key set whole or not at all, so a broken mount is fixed by mounting again. */
export function installRollupKeys(from:string,keys:string,kind:RollupPoolKind='classic'){
 const partial=keys+'.partial';rmSync(partial,{recursive:true,force:true});mkdirSync(partial,{recursive:true,mode:0o700});
 for(const name of rollupKeyFilesOf(kind))copyFileSync(join(from,name),join(partial,name));
 verifyRollupKeys(partial,kind);promoteRollupKeys(partial,keys);
}
export const rollupKeyPath=(keys:string,name:string,kind:RollupPoolKind='classic')=>rollupKeyFilesOf(kind).includes(name)?join(keys,name):undefined;
/** The journal pin's programs hash: every leaf hashed on its own, so no byte can move between leaves unnoticed. */
export const rollupProgramsHash=(leaves:Pick<RollupLeaves,'batch'|'batchJoin'|'reserve'|'renew'>)=>sha([leaves.batch,leaves.batchJoin,leaves.reserve,leaves.renew].map(leaf=>sha(leaf)).join(''));
export const rollupEpochProgramsHash=(leaves:RollupEpochLeaves)=>sha([leaves.batch,leaves.batchJoin,leaves.batchRecover,leaves.reserve,leaves.renew].map(leaf=>sha(leaf)).join(''));
/** A classic (genesis-3) pool's journal pin: any byte it moves orphans the live journal. */
export const rollupClassicPin=(o:{leaves:RollupLeaves;manifest:Uint8Array;checkpoint:Uint8Array;genesisTxid:string;serverKey:string;emulatorKey:string}):StockReleasePin=>
 ({version:1,network:'mutinynet',descriptorProfileId:sha('rollup-v2-genesis2'),programsHash:rollupProgramsHash(o.leaves),artifactsHash:sha(o.manifest),checkpointHash:sha(o.checkpoint),genesisTxid:o.genesisTxid,serverKey:o.serverKey,emulatorKey:o.emulatorKey});
/** An epoch (genesis-4) pool's journal pin: its own profile and programs hash, so neither kind's journal opens as the other's. */
export const rollupEpochPin=(o:{leaves:RollupEpochLeaves;manifest:Uint8Array;checkpoint:Uint8Array;genesisTxid:string;serverKey:string;emulatorKey:string}):StockReleasePin=>
 ({version:1,network:'mutinynet',descriptorProfileId:sha('rollup-v2-genesis4'),programsHash:rollupEpochProgramsHash(o.leaves),artifactsHash:sha(o.manifest),checkpointHash:sha(o.checkpoint),genesisTxid:o.genesisTxid,serverKey:o.serverKey,emulatorKey:o.emulatorKey});
/** genesis.json: a classic pool's keeps its version-1 fields in order; an epoch pool's must say version 2, as a missing version reads as classic. */
export const rollupGenesisOf=(o:{token:string;head:RollupPoolCoin;serverKey:string;emulatorKey:string;epochLen?:number}):Genesis=>{
 const fields={token:o.token,txid:o.head.txid,serverKey:o.serverKey,emulatorKey:o.emulatorKey,archive:{version:1 as const,head:o.head,reserves:{},batches:0}};
 return o.epochLen===undefined?{version:1,...fields}:{version:2,...fields,epochLen:o.epochLen};
};
export const rollupSpecOf=(kind:RollupPoolKind,token:string,operator:string):RollupLeavesSpec=>kind==='classic'
 ?{clientKey:'keys/spend.vkey.json',batchKey:'keys/batch-spend.vkey.json',clientJoinKey:'keys/join.vkey.json',batchJoinKey:'keys/batch-join.vkey.json',slots:BATCH_SLOTS,token,operator}
 :{clientKey:'keys/epoch-spend.vkey.json',batchKey:'keys/epoch-batch-spend.vkey.json',clientJoinKey:'keys/epoch-join.vkey.json',batchJoinKey:'keys/epoch-batch-join.vkey.json',batchRecoverKey:'keys/epoch-batch-recover.vkey.json',slots:BATCH_SLOTS,token,operator,epoch:true};
/** An epoch pool also advertises its recover batch key, the one a fallback proves with; a classic pool has none. */
export function rollupProvingOf(kind:RollupPoolKind,files:Record<string,string>):NonNullable<RollupStatus['proving']> {
 const pair=(c:string)=>({wasm:files[`${c}.wasm`]!,zkey:files[`${c}.zkey`]!});
 return kind==='classic'?{spend:pair('spend'),join:pair('join'),batch:pair('batch-spend'),batchJoin:pair('batch-join')}
  :{spend:pair('epoch-spend'),join:pair('epoch-join'),batch:pair('epoch-batch-spend'),batchJoin:pair('epoch-batch-join'),batchRecover:pair('epoch-batch-recover')};
}
/** An epoch pool's own /status fields, all as of the last accepted batch except heapBytes, a live process gauge. */
const epochFieldsOf=(epochLen:number,batches:number,a:RollupEpochStatus)=>({epoch:a.acceptedEpoch,epochLen,batchesInEpoch:batches-a.acceptedEpoch*epochLen,prevNoteRoot:String(a.acceptedPrevNoteRoot),erCount:a.acceptedErCount,rsCount:a.acceptedRsCount,nullifiers:a.acceptedNullifiers,heapBytes:process.memoryUsage().heapUsed});
/** The persisted genesis decides; the epoch length only shapes a pool that has no genesis yet. */
export function rollupPoolKindOf(o:{genesis?:{version?:number;epochLen?:number};epochLen?:number|string}):{kind:RollupPoolKind;epochLen?:number} {
 const epoch=(epochLen:unknown)=>{
  if(typeof epochLen!=='number'||!Number.isSafeInteger(epochLen)||epochLen<EPOCH_LEN_FLOOR||epochLen>MAX_EPOCH_LEN)throw new Error(`The rollup epoch length must be a whole number of batches from ${EPOCH_LEN_FLOOR} to ${MAX_EPOCH_LEN}; got ${JSON.stringify(epochLen)}.`);
  return {kind:'epoch' as const,epochLen};
 };
 if(!o.genesis)return o.epochLen===undefined?{kind:'classic'}:epoch(typeof o.epochLen==='string'&&/^[1-9][0-9]*$/.test(o.epochLen)?Number(o.epochLen):o.epochLen);
 // Only a classic pool can lack the field (an epoch genesis always writes 2), and refusing it would block the live pool.
 if(o.genesis.version===1||o.genesis.version===undefined)return {kind:'classic'};
 if(o.genesis.version===2)return epoch(o.genesis.epochLen);
 throw new Error(`The rollup genesis has version ${JSON.stringify(o.genesis.version)}, which this build cannot open; run the build that created it.`);
}

/**
 * `circuits` holds the image's compiled spend and batch circuits; the one-time key setup runs from them unless
 * `bundled` already holds keys. Afterwards the volume's keys define the pool, whatever later images hold.
 */
export async function openRollupService(o:{directory:string;circuits:string;setupTool:string;bundled?:string;vmBinary:string;rapidsnark?:string;endpoints:{arkUrl?:string;emulatorUrl?:string;indexerUrl?:string;fetcher?:typeof fetch};renewBeforeMs?:number;epochLen?:number|string;log?:(message:string)=>void;providers?:RollupServiceProviders}){
 const log=o.log??((message:string)=>console.log('[rollup] '+message)),keys=join(o.directory,'keys'),p=o.providers??{};
 mkdirSync(o.directory,{recursive:true,mode:0o700});
 const secretsPath=join(o.directory,'secrets.json');
 if(!existsSync(secretsPath))writeFileSync(secretsPath,JSON.stringify({wallet:randomBytes(32).toString('hex'),operator:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});
 const secrets=readJson<{wallet:string;operator:string}>(secretsPath),identity=SingleKey.fromHex(secrets.wallet),operatorSecret=hex.decode(secrets.operator);
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
 let status:RollupStatus={version:1,phase:'starting',message:'Starting the rollup pool.',minimumFundingSats:MINIMUM_FUNDING_SATS};
 let manifest:KeyManifest|undefined,poolKind:RollupPoolKind='classic',setup:ChildProcess|undefined,setupFailures=0,setupRetryAt=0;

 /** Ready keys, or undefined while the one-time setup runs in a child process. */
 function ensureKeys(kind:RollupPoolKind):KeyManifest|undefined {
  if(manifest)return manifest;
  if(!existsSync(join(keys,'manifest.json'))){
   if(existsSync(join(o.directory,'genesis.json')))throw new Error('The rollup keys are missing from a pool that already exists; restore the volume.');
   if(o.bundled&&existsSync(join(o.bundled,'manifest.json')))installRollupKeys(o.bundled,keys,kind);
   else{
    const memory=process.constrainedMemory()||totalmem(),gib=(bytes:number)=>(bytes/1024**3).toFixed(1)+' GiB';
    // The batch key setup holds gigabytes; refuse a small host and back off after failures.
    if(memory<SETUP_MEMORY_BYTES){status={...status,phase:'blocked',message:`Key setup needs ${gib(SETUP_MEMORY_BYTES)} of memory; this host has ${gib(memory)}.`};return undefined;}
    if(!setup&&setupFailures>=SETUP_ATTEMPTS){status={...status,phase:'blocked',message:`Key setup failed ${setupFailures} times; see the server log. Free memory: ${gib(freemem())}.`};return undefined;}
    if(!setup&&Date.now()>=setupRetryAt){
     const partial=keys+'.partial';rmSync(partial,{recursive:true,force:true});
     status={...status,phase:'keys',message:`Generating the development proving keys (one time). Memory: ${gib(memory)}.`};
     setup=execFile(process.execPath,[o.setupTool,'--development-only','--single-thread','--build',o.circuits,'--ptau',join(o.directory,'ptau','powersOfTau28_hez_final_20.ptau'),'--out',partial,...(kind==='epoch'?['--circuits',EPOCH_CIRCUITS.join()]:[])],{maxBuffer:16*1024*1024,windowsHide:true},error=>{
      setup=undefined;
      if(error){setupFailures++;setupRetryAt=Date.now()+SETUP_RETRY_MS;status={...status,message:`Key setup failed (${setupFailures}/${SETUP_ATTEMPTS}): `+error.message.slice(0,300)};log(status.message);return;}
      promoteRollupKeys(partial,keys);rmSync(join(o.directory,'ptau'),{recursive:true,force:true});log('development proving keys ready');
     });
     setup.stdout?.on('data',(chunk:Buffer)=>{for(const line of String(chunk).split(/\r?\n/))if(line.startsWith('ROLLUP_SETUP_PROGRESS=')){try{status={...status,message:`Generating the development proving keys (one time): ${JSON.parse(line.slice(22)).stage}.`};}catch{}}});
    }
    return undefined;
   }
  }
  manifest=verifyRollupKeys(keys,kind);poolKind=kind;
  status={...status,proving:rollupProvingOf(kind,Object.assign({},...Object.values(manifest.circuits).map(c=>c.files)))};
  return manifest;
 }
 let live:{operator:RollupOperator|RollupEpochOperator;network:StockNetworkInfo;genesis:Genesis;address:string;pool:ReturnType<typeof rollupPoolTree>;leaves:Awaited<ReturnType<typeof loadRollupLeaves>>;indexer:Pick<RestIndexerProvider,'getVtxos'|'getVirtualTxs'>}|undefined;
 let stopped=false,kick=()=>{};
 const timers=new Set<ReturnType<typeof setTimeout>>();
 const later=(fn:()=>void,ms:number)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;};
 const checkpointTimes:number[]=[];
 // Why batching is stuck, once it has been for a while, so wallets can say why a spend waits.
 let blocked:{message:string;since:number}|undefined;
 // In memory only: after a restart it is absent until this process publishes a batch.
 let lastBatch:RollupStatusBatch|undefined;
 const sessions=new Map<string,Session>(),tracked=new Map<string,RollupSpendStatus&{nullifier:string;at:number}>(),store=openSpendStore(join(o.directory,'spends'));
 /** Moves a tracked spend to a new status, on disk too, so a restart neither forgets nor re-runs it. */
 const settle=(id:string,patch:Partial<RollupSpendStatus>)=>{
  const t=tracked.get(id);if(!t)return;Object.assign(t,patch);
  store.save({id,status:t.status==='signing'?'pending':t.status,nullifier:t.nullifier,at:t.at,...(t.batch!==undefined?{batch:t.batch}:{}),...(t.txid?{txid:t.txid}:{}),...(t.reason?{reason:t.reason}:{})});
 };
 /** A deposit coin as the indexer knows it: value, script and asset holdings come from there, never from the client. */
 const resolveCoin=async(c:CoinRef):Promise<RollupCoin&{assetAmount?:bigint;assetId?:string}>=>{
  const raw=(await live!.indexer.getVirtualTxs([c.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===c.txid);
  const output=raw&&c.vout<raw.outputsLength?raw.getOutput(c.vout):undefined,tree=VtxoScript.decode(hex.decode(c.tapTree));
  if(!raw||!output?.script||hex.encode(output.script)!==hex.encode(tree.pkScript))throw new Error('The deposit coin is not indexed under that tree.');
  const assets=(await live!.indexer.getVtxos({outpoints:[{txid:c.txid,vout:c.vout}]})).vtxos.find(v=>v.txid===c.txid&&v.vout===c.vout)?.assets??[];
  if(assets.length>1)throw new Error('A deposit coin may hold at most one asset.');
  return {txid:c.txid,vout:c.vout,value:Number(output.amount),sourceTx:raw.toBytes(true,true),tapTree:tree.encode(),leaf:tree.findLeaf(c.leaf),...(assets[0]?{assetAmount:BigInt(assets[0].amount),assetId:assets[0].assetId}:{})};
 };
 /** Re-admits spends that were waiting when the service stopped, oldest first so groups keep the order their id commits to. */
 async function restore(operator:RollupOperator|RollupEpochOperator){
  for(const record of store.load()){
   if(Date.now()-record.at>3600_000){store.remove(record.id);continue;}
   tracked.set(record.id,{status:record.status,nullifier:record.nullifier,at:record.at,...(record.batch!==undefined?{batch:record.batch}:{}),...(record.txid?{txid:record.txid}:{}),...(record.reason?{reason:record.reason}:{})});
   if(record.status!=='pending'||!record.spend)continue;
   if(landed(operator.state,BigInt(record.nullifier))){settle(record.id,{status:'included'});continue;}
   try{const {spend}=record,coin=spend.coin?await resolveCoin(spend.coin):undefined;await admit(operator,{...('anchor' in spend.slot?decodeEpochSpend(spend as EncodedEpochSpend):decodeSpend(spend as EncodedSpend)),...(coin?{coin}:{})});}
   catch(error){settle(record.id,{status:'dropped',reason:'It could not be re-admitted after the pool restarted: '+(error as Error).message});}
  }
 }

 const specFile=(token:string)=>{
  writeFileSync(join(o.directory,'spec.json'),JSON.stringify(rollupSpecOf(poolKind,token,hex.encode(schnorr.getPublicKey(operatorSecret)))));
  return join(o.directory,'spec.json');
 };
 const spec=async(token:string)=>loadRollupLeaves(o.vmBinary,specFile(token));
 const epochSpec=async(token:string)=>loadRollupEpochLeaves(o.vmBinary,specFile(token));

 const genesis=(network:StockNetworkInfo,epochLen?:number)=>withArkWallet(()=>p.wallet?.()??openCustomerArkWallet(identity,network),ark=>firstGenesis(ark,network,epochLen));
 /** Issues the pool token and sends the head with the genesis state packet; a crash in between re-finds the head by its script. */
 async function firstGenesis(ark:Awaited<ReturnType<typeof openCustomerArkWallet>>,network:StockNetworkInfo,epochLen?:number):Promise<Genesis|undefined> {
  const wallet=ark.wallet,balance=await wallet.getBalance();
  status={...status,phase:'funding',fundingAddress:ark.address,fundingSats:balance.available,message:`Fund the operator wallet with at least ${MINIMUM_FUNDING_SATS} sats to create the pool.`};
  const tokenPath=join(o.directory,'genesis-token.json');
  if(!existsSync(tokenPath)){
   if(balance.available<MINIMUM_FUNDING_SATS)return undefined;
   status={...status,phase:'genesis',message:'Issuing the pool token.'};
   writeFileSync(tokenPath,JSON.stringify({token:(await wallet.assetManager.issue({amount:1n})).assetId}),{flag:'wx'});
  }
  const {token}=readJson<{token:string}>(tokenPath),serverKey=hex.decode(network.serverKey),emulatorKey=hex.decode(network.emulatorKey);
  const pool=epochLen===undefined?rollupPoolTree(serverKey,emulatorKey,await spec(token),network.exitDelay):rollupEpochPoolTree(serverKey,emulatorKey,await epochSpec(token),network.exitDelay);
  const indexer=p.indexer??new RestIndexerProvider(network.indexerUrl??network.arkUrl),script=hex.encode(pool.tree.pkScript);
  let head=(await indexer.getVtxos({scripts:[script],spendableOnly:true})).vtxos.find(v=>v.assets?.some(a=>a.assetId===token));
  if(!head){
   status={...status,phase:'genesis',message:'Sending the pool head.'};
   const address=new ArkAddress(serverKey,pool.tree.pkScript.subarray(2),'tark').encode();
   // An epoch head carries all three fields a batch writes, so the operator checks its genesis commitment before the first batch.
   const packet=Uint8Array.from(epochLen===undefined?[...le32(RollupState.genesis(hash).commitment()),...le32(0n)]:[...le32(EpochState.genesis(hash,epochLen).commitment()),...le32(0n),...le32(0n)]);
   const txid=await wallet.send({recipients:[{address,amount:HEAD_SATS,assets:[{assetId:token,amount:1n}],tapTree:pool.tree.encode(),extensions:[{type:ROLLUP_STATE_PACKET,payload:packet}]}]});
   for(let i=0;i<30&&!head;i++){await sleep(1000);head=(await indexer.getVtxos({scripts:[script],spendableOnly:true})).vtxos.find(v=>v.txid===txid);}
   if(!head)throw new Error(`Genesis ${txid} is not indexed yet.`);
  }
  const raw=(await indexer.getVirtualTxs([head.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===head!.txid)!;
  if(!Extension.fromTx(raw).getPacketByType(ROLLUP_STATE_PACKET))throw new Error('The pool head carries no state packet.');
  const saved=rollupGenesisOf({token,head:{txid:head.txid,vout:head.vout,value:head.value,sourceTxHex:hex.encode(raw.toBytes(true,true))},serverKey:network.serverKey,emulatorKey:network.emulatorKey,...(epochLen===undefined?{}:{epochLen})});
  if(o.epochLen!==undefined&&saved.version!==2)throw new Error('Refusing to write a classic genesis: the service was given an epoch length.');
  writeFileSync(join(o.directory,'genesis.json'),JSON.stringify(saved),{flag:'wx'});
  log(`genesis ${head.txid}:${head.vout} token ${token}`);
  return saved;
 }

 const signDeposits=async(request:StockWireRequest,deposits:Pick<RollupSpend,'id'>[])=>{
  const first=Transaction.fromPSBT(base64.decode(request.arkTx)).inputsLength-deposits.length;
  deposits.forEach((d,i)=>sessions.set(d.id,{arkTx:request.arkTx,checkpoints:request.checkpoints,vin:first+i}));
  for(const deadline=Date.now()+SIGN_TIMEOUT_MS;Date.now()<deadline&&deposits.some(d=>!sessions.get(d.id)?.signed);)await sleep(250);
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),checkpoints=[...request.checkpoints];
  for(const d of deposits){
   const s=sessions.get(d.id);sessions.delete(d.id);
   if(!s?.signed)continue;
   ark.updateInput(s.vin,{tapScriptSig:Transaction.fromPSBT(base64.decode(s.signed.arkTx)).getInput(s.vin).tapScriptSig});
   checkpoints[s.vin]=s.signed.checkpoint;
  }
  return {arkTx:base64.encode(ark.toPSBT()),checkpoints};
 };

 const connect=async(network:StockNetworkInfo)=>{
  const fundingAddress=await withArkWallet(()=>p.wallet?.()??openCustomerArkWallet(identity,network),async ark=>ark.address),info=await (p.info?.()??new RestArkProvider(network.arkUrl).getInfo());
  const checkpoint=validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey),indexer=p.indexer??new RestIndexerProvider(network.indexerUrl??network.arkUrl);
  const prover=(name:string)=>(p.prover??(artifacts=>createRollupProver(artifacts,o.rapidsnark)))({wasm:join(keys,`${name}.wasm`),zkey:join(keys,`${name}.zkey`)});
  return {fundingAddress,checkpoint,indexer,prover,transport:p.transport??createRollupTransport(network),verify:p.verify};
 };
 const onDrop=(ids:string[],reason:string)=>{for(const id of ids)if(tracked.get(id)?.status==='pending')settle(id,{status:'dropped',reason});};

 async function open(network:StockNetworkInfo,saved:Genesis){
  const leaves=await spec(saved.token),pool=rollupPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
  const {fundingAddress,checkpoint,indexer,prover,transport,verify}=await connect(network);
  const operator=await openRollupOperator({directory:join(o.directory,'operator'),
   pin:rollupClassicPin({leaves,manifest:readFileSync(join(keys,'manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey:network.serverKey,emulatorKey:network.emulatorKey}),
   genesis:saved.archive,leaves,token:saved.token,serverKey:hex.decode(network.serverKey),emulatorKey:hex.decode(network.emulatorKey),exitDelay:network.exitDelay,checkpoint,
   clientKey:{spend:readJson(join(keys,'spend.vkey.json')),join:readJson(join(keys,'join.vkey.json'))},hash,prover:{spend:prover('batch-spend'),join:prover('batch-join')},transport,signDeposits,depositFloorMs:DEPOSIT_FLOOR_MS,dustSats:network.dust,batchWaitMs:0,joinWaitMs:0,
   onDrop,verify});
  const address=new ArkAddress(hex.decode(network.serverKey),pool.tree.pkScript.subarray(2),'tark').encode();
  live={operator,network,genesis:saved,address,pool,leaves,indexer};
  await restore(operator);
  status={...status,phase:'ready',message:'The rollup pool is open.',fundingAddress};
  run({spend:prover('spend'),join:prover('join')});
 }
 /** open()'s sibling for an epoch pool, kept apart so the classic open() stays as genesis 3 runs it. */
 async function openEpoch(network:StockNetworkInfo,saved:Genesis,epochLen:number){
  const leaves=await epochSpec(saved.token),pool=rollupEpochPoolTree(hex.decode(network.serverKey),hex.decode(network.emulatorKey),leaves,network.exitDelay);
  const {fundingAddress,checkpoint,indexer,prover,transport,verify}=await connect(network),spendKey=readJson(join(keys,'epoch-spend.vkey.json'));
  const operator=await openRollupEpochOperator({directory:join(o.directory,'operator'),epochLen,
   pin:rollupEpochPin({leaves,manifest:readFileSync(join(keys,'manifest.json')),checkpoint:checkpoint.script,genesisTxid:saved.txid,serverKey:network.serverKey,emulatorKey:network.emulatorKey}),
   genesis:saved.archive,leaves,token:saved.token,serverKey:hex.decode(network.serverKey),emulatorKey:hex.decode(network.emulatorKey),exitDelay:network.exitDelay,checkpoint,
   // A recover slot carries the spend client proof, as the recover leaf does.
   clientKey:{spend:spendKey,join:readJson(join(keys,'epoch-join.vkey.json')),recover:spendKey},hash,
   prover:{spend:prover('epoch-batch-spend'),join:prover('epoch-batch-join'),recover:prover('epoch-batch-recover')},transport,signDeposits,depositFloorMs:DEPOSIT_FLOOR_MS,dustSats:network.dust,batchWaitMs:0,joinWaitMs:0,
   onDrop,verify});
  const address=new ArkAddress(hex.decode(network.serverKey),pool.tree.pkScript.subarray(2),'tark').encode();
  live={operator,network,genesis:saved,address,pool,leaves,indexer};
  await restore(operator);
  status={...status,phase:'ready',message:'The rollup pool is open.',fundingAddress};
  run({spend:prover('epoch-spend'),join:prover('epoch-join')});
 }

 function run(clientProvers:Record<BatchKind,ReturnType<typeof createRollupProver>>){
  const {operator}=live!;let paused=false,ticking:Promise<unknown>|undefined,lastError='',lock:Promise<unknown>=Promise.resolve();
  /** Renewal and listing move the head or reserves, so batches pause and they run one at a time. */
  const exclusive=(work:()=>Promise<void>)=>{const turn=lock.then(async()=>{paused=true;try{await ticking?.catch(()=>{});if(operator.status().pending)throw new Error('a submitted batch is unresolved; this waits.');await work();}finally{paused=false;}});lock=turn.catch(()=>{});return turn;};
  const note=(message:string)=>{if(message!==lastError)log(message);lastError=message;};
  const included=(batch:number,txid:string)=>{
   const record=readJson<RollupRecord>(join(o.directory,'operator','batches',`${batch}.json`)),spent=new Set(record.slots.flatMap(s=>s.nullifiers));
   for(const [id,t] of tracked)if(t.status==='pending'&&spent.has(t.nullifier))settle(id,{status:'included',batch,txid});
  };
  const sweep=()=>{
   const waiting=new Set(operator.pendingIds());
   for(const [id,t] of tracked){
    if(t.status==='pending'&&!waiting.has(id)&&!sessions.has(id))settle(id,landed(operator.state,BigInt(t.nullifier))?{status:'included'}:{status:'dropped',reason:'The operator dropped this spend before it reached a batch; build it again.'});
    if(Date.now()-t.at>3600_000){tracked.delete(id);store.remove(id);}
   }
  };
  let running=false,again=false,next:ReturnType<typeof setTimeout>|undefined;
  const schedule=(ms:number)=>{if(stopped)return;if(next){clearTimeout(next);timers.delete(next);}next=later(()=>{next=undefined;void tick();},ms);};
  const tick=async()=>{
   if(stopped)return;
   running=true;again=false;
   try{
    if(!paused){
     try{ticking=operator.tick();const r=await ticking as Awaited<ReturnType<RollupOperator['tick']>>;if(r&&'txid' in r){log(`batch ${r.batch} ${r.txid}`+(r.timings?` (waited ${r.timings.waitedMs} ms, proved in ${r.timings.proveMs} ms, published in ${r.timings.publishMs} ms)`:''));if(r.timings)lastBatch={batch:r.batch,at:Date.now(),...r.timings,...(operator.state instanceof EpochState?{rotated:rotatesAt(r.batch,operator.state.epochLen)}:{})};included(r.batch,r.txid);blocked=undefined;}else if(r){note(r.blocked);blocked={message:r.blocked,since:blocked?.since??Date.now()};}else blocked=undefined;}
     catch(error){note((error as Error).message);blocked={message:(error as Error).message,since:blocked?.since??Date.now()};}
     finally{ticking=undefined;}
     sweep();
    }
   }finally{running=false;}
   schedule(again?0:1000);
  };
  // An admitted spend can make a batch due at once; the next scheduled tick would only add up to a second.
  kick=()=>{if(running)again=true;else schedule(0);};
  /** Keeps a batch's worth of zero spends (one dummy input) or zero joins (two) proved and ready. */
  const pad=async(kind:BatchKind)=>{
   const recipient=rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey());
   while(!stopped){
    if(operator.padding(kind)>=PADDING_TARGET){await sleep(2000);continue;}
    try{
     const {state}=operator;
     if(state instanceof EpochState){
      // The root the next batch opens against, not prevNoteRoot: a pad proved just before a rotation then survives it.
      const built=await epochPaddingTransfer(hash,{rPrev:state.nextAnchorRoot(),rCur:{epoch:state.epoch,root:state.latestRoot()},self:recipient,width:kind==='join'?2:1});
      const proof=await clientProvers[kind].prove(built.witness.input,built.witness.publicSignals);
      (operator as RollupEpochOperator).addPadding([{id:'pad-'+randomBytes(8).toString('hex'),slot:built.slot,publics:built.witness.publicSignals as unknown as RollupSpend['publics'],proof,ciphertext:built.ciphertext,receivedAt:Infinity}]);
      continue;
     }
     const built=await buildRollupTransfer(hash,{root:operator.state.latestRoot(),ask:randomField(),nk:randomField(),self:recipient,request:{},width:kind==='join'?2:1});
     const proof=await clientProvers[kind].prove(built.witness.input,built.witness.publicSignals);
     (operator as RollupOperator).addPadding([{id:'pad-'+randomBytes(8).toString('hex'),slot:built.witness.slot,publics:built.witness.publicSignals as unknown as RollupSpend['publics'],proof,ciphertext:built.ciphertext,receivedAt:Infinity}]);
    }catch(error){note(`${kind} padding: `+(error as Error).message);await sleep(10_000);}
   }
  };
  const renewalPath=join(o.directory,'renewal.json');
  const settleRenewal=async()=>{
   if(!existsSync(renewalPath))return;
   const pending=readJson<{intentId:string;head:{txid:string;vout:number};reserves?:string[]}>(renewalPath),{archive}=operator.status();
   const next=leftoverRenewal(pending,archive.head,(await live!.indexer.getVtxos({outpoints:[pending.head]})).vtxos[0]);
   if(next==='moved')throw new Error('The pool head was spent outside this operator, which cannot follow that yet.');
   if(next==='adopt'){
    const moved=await renewedRollupPool(live!.indexer,live!.pool.tree,live!.genesis.token,{reserves:carriedReserves(archive.reserves,pending.reserves)});
    await operator.relocate({head:moved.head,reserves:{...archive.reserves,...moved.reserves}});log('adopted the head an interrupted renewal created');
   }
   if(next==='flush')log(`interrupted renewal intent ${pending.intentId}: ${await flushRollupIntent({arkUrl:live!.network.arkUrl,intentId:pending.intentId,topics:[archive.head,...Object.values(archive.reserves)].map(c=>`${c.txid}:${c.vout}`)})}`);
   rmSync(renewalPath,{force:true});
  };
  const renew=async()=>{
   if(stopped)return;
   try{
    if(existsSync(renewalPath))await exclusive(settleRenewal);
    const {archive}=operator.status(),points=rollupPoolPoints(archive),{vtxos}=await live!.indexer.getVtxos({outpoints:points});
    // rollupRenewalDue below refuses any point the indexer left out, so the 0 never sorts a missing coin first.
    const expiresAt=(c:{txid:string;vout:number})=>vtxos.find(v=>v.txid===c.txid&&v.vout===c.vout)?.expiresAt?.getTime()??0;
    // A chunk per round, each under the lock alone, so batches keep landing between rounds.
    if(rollupRenewalDue(points,vtxos,o.renewBeforeMs??RENEW_BEFORE_MS,Date.now()))for(const chunk of renewalChunks(archive.reserves,expiresAt))await exclusive(async()=>{
     const from=operator.status().archive.head;
     try{
      const moved=await renewRollupPool({network:live!.network,identity,operatorSecret,pool:live!.pool.tree,renewLeaf:live!.pool.renew,leaves:live!.leaves,token:live!.genesis.token,archive:operator.status().archive,reserves:chunk,providers:{wallet:p.wallet},
       onIntent:intentId=>writeFileSync(renewalPath,JSON.stringify({intentId,head:{txid:from.txid,vout:from.vout},reserves:chunk}))});
      await operator.relocate({head:moved.head,reserves:{...operator.status().archive.reserves,...moved.reserves}});rmSync(renewalPath,{force:true});
      log(`renewed the head and ${chunk.length} reserve(s) into round ${moved.commitment}, head ${moved.head.txid}`);
     }catch(error){await settleRenewal().catch(e=>note('renewal: '+(e as Error).message));throw error;}
    });
   }catch(error){note('renewal: '+(error as Error).message);}
   later(renew,RENEW_CHECK_MS);
  };
  const turnedAway=new Set<string>();
  const list=async()=>{
   if(stopped)return;
   try{
    const {archive}=operator.status(),{vtxos}=await live!.indexer.getVtxos({scripts:[hex.encode(live!.pool.tree.pkScript)],spendableOnly:true});
    const found=listingsOf(vtxos,live!.genesis.token,new Set(Object.keys(archive.reserves)));
    for(const assetId of found.dropped)if(!turnedAway.has(assetId)){turnedAway.add(assetId);log(`the pool already holds ${MAX_RESERVES} reserves, so the listing of ${assetId} is ignored`);}
    if(found.adopt.length)await exclusive(async()=>{
     const reserves={...operator.status().archive.reserves};
     for(const f of found.adopt){
      const raw=(await live!.indexer.getVirtualTxs([f.coin.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===f.coin.txid);
      if(!raw)continue;
      reserves[f.assetId]={txid:f.coin.txid,vout:f.coin.vout,value:f.coin.value,sourceTxHex:hex.encode(raw.toBytes(true,true)),amount:String(f.amount)};
      log(`listed asset ${f.assetId} with ${f.amount} units at ${f.coin.txid}:${f.coin.vout}`);
     }
     await operator.relocate({head:operator.status().archive.head,reserves});
    });
   }catch(error){note('listing: '+(error as Error).message);}
   later(list,LIST_CHECK_MS);
  };
  const start=()=>{void tick();void pad('spend');void pad('join');void renew();void list();};
  // A batch started before the leftover intent clears would only be refused, and its deposits dropped.
  if(existsSync(renewalPath))void exclusive(settleRenewal).catch(error=>note('renewal: '+(error as Error).message)).finally(start);else start();
 }

 const archives=join(o.directory,'operator','nullifiers');
 /** The closed epochs whose frozen nullifier files the pool holds, as of its last accepted batch; a classic pool keeps none. */
 const archiveEpochs=()=>{
  const operator=live?.operator;
  if(!(operator?.state instanceof EpochState))return undefined;
  const closed=(operator as RollupEpochOperator).status().acceptedEpoch;
  return readdirSync(archives).map(name=>Number(ARCHIVE_FILE.exec(name)?.[1])).filter(epoch=>epoch<closed).sort((a,b)=>a-b);
 };

 return {
  status:():RollupStatus=>{
   if(!live)return status;
   const {operator,genesis,address,network,pool}=live,view=operator.status(),{archive}=view,{state}=operator;
   // EpochState has no rootAfter (its window holds hashes), so an epoch pool reports what its operator remembers as accepted.
   return {...status,network,pool:{token:genesis.token,operator:hex.encode(schnorr.getPublicKey(operatorSecret)),...(blocked&&Date.now()-blocked.since>30_000?{notice:blocked.message}:{}),address,script:hex.encode(pool.tree.pkScript),batches:archive.batches,root:String(state instanceof EpochState?(view as RollupEpochStatus).acceptedRoot:state.rootAfter(archive.batches)),head:{txid:archive.head.txid,vout:archive.head.vout,value:archive.head.value},pending:operator.pending(),padding:operator.padding(),...(lastBatch?{lastBatch}:{}),
    reserves:Object.fromEntries(Object.entries(archive.reserves).map(([assetId,reserve])=>[assetId,reserve.amount])),maxReserves:MAX_RESERVES,
    ...(state instanceof EpochState?epochFieldsOf(state.epochLen,archive.batches,view as RollupEpochStatus):{})}};
  },
  /** Advances setup by one step; once ready, the batch, padding and renewal loops run on their own. */
  step:async()=>{
   if(live||stopped)return;
   try{
    const path=join(o.directory,'genesis.json'),known=existsSync(path)?readJson<Genesis>(path):undefined;
    const {kind,epochLen}=rollupPoolKindOf({genesis:known,epochLen:o.epochLen});
    if(o.epochLen!==undefined&&kind==='classic')throw new Error('This directory holds a classic pool; an epoch pool needs its own data directory.');
    if(!ensureKeys(kind))return;
    const network=await preflightStockMutinynet({...o.endpoints,...(known?{expected:{serverKey:known.serverKey,emulatorKey:known.emulatorKey}}:{})});
    const saved=known??await genesis(network,epochLen);
    if(saved)await (epochLen===undefined?open(network,saved):openEpoch(network,saved,epochLen));
   }catch(error){
    // A deploy starts the new instance before stopping the old one, which still holds the pool's journal.
    const locked=isStorageLocked(error);
    status=locked?{...status,message:'Waiting for the previous instance to release the pool.'}:{...status,phase:status.phase==='starting'?'blocked':status.phase,message:(error as Error).message};
    log(status.message);
   }
  },
  ready:()=>!!live,
  /** The write routes parse the epoch slot shape only for an epoch operator. */
  get epochPool(){return live?.operator.state instanceof EpochState;},
  // The batch key is published too, so anyone can prove a batch, and the pool keeps moving, if this operator stops.
  keyFile:(name:string)=>manifest?rollupKeyPath(keys,name,poolKind):undefined,
  archiveEpochs,
  /** Allowlisted like keyFile, and the path is rebuilt from a listed epoch's number, so no caller text reaches it. */
  archiveFile:(name:string)=>{const epoch=Number(ARCHIVE_FILE.exec(name)?.[1]);return archiveEpochs()?.includes(epoch)?epochNfArchivePath(archives,epoch):undefined;},
  /** The volume holding the pool's directory, so a launch can check there is room before it copies keys onto it. */
  storage:()=>{const s=statfsSync(dirname(o.directory));return {freeBytes:s.bavail*s.bsize,totalBytes:s.blocks*s.bsize};},
  batches:(from:number,limit:number)=>{
   const total=live?.operator.status().archive.batches??0,to=Math.min(total,from+limit),list:RollupRecord[]=[];
   for(let n=from;n<to;n++)list.push(readJson<RollupRecord>(join(o.directory,'operator','batches',`${n}.json`)));
   return {from,total,batches:list};
  },
  /** A restore's compact view of committed batches; a classic pool's block roots come off the operator's note tree. */
  scan:(from:number,limit:number)=>{
   const operator=live?.operator;
   if(!operator)return {from,total:0,data:''};
   if(operator.state instanceof EpochState){
    const state=operator.state,total=operator.status().archive.batches,entries=[];
    for(let n=from;n<Math.min(total,from+limit);n++){
     const record=readJson<RollupEpochRecord>(join(o.directory,'operator','batches',`${n}.json`)),root=BigInt(record.noteBlockRoot),epoch=Math.floor(n/state.epochLen);
     // The live tree holds only the current epoch, so a closed epoch's root is the record's alone.
     if(epoch===state.epoch&&root!==state.notes.node(SUBTREE_DEPTH,n-epoch*state.epochLen))throw new Error(`Batch ${n}'s recorded block root is not the one the live note tree holds.`);
     entries.push({record,root,rotated:rotatesAt(n,state.epochLen)});
    }
    return {from,total,data:base64.encode(encodeEpochScan(entries))};
   }
   const total=operator.status().archive.batches,to=Math.min(total,from+limit),entries=[];
   for(let n=from;n<to;n++)entries.push({record:readJson<RollupRecord>(join(o.directory,'operator','batches',`${n}.json`)),root:operator.state.notes.node(SUBTREE_DEPTH,n)});
   return {from,total,data:base64.encode(encodeScan(entries))};
  },
  /** When every CHECKPOINT_EVERY-th batch landed, so a restore turns a date into a checkpoint without telling the pool the date. */
  times:()=>{
   const total=live?.operator.status().archive.batches??0;
   for(let n=checkpointTimes.length*CHECKPOINT_EVERY;n<total;n+=CHECKPOINT_EVERY)checkpointTimes.push(readJson<RollupRecord>(join(o.directory,'operator','batches',`${n}.json`)).at??0);
   return {every:CHECKPOINT_EVERY,at:[...checkpointTimes]};
  },
  /** The note frontier after a committed multiple of CHECKPOINT_EVERY batches; it never changes once served. */
  checkpoint:(blocks:number)=>{
   const operator=live?.operator;
   // The note tree restarts at every rotation, so a global batch count would name another epoch's frontier.
   if(operator?.state instanceof EpochState)return undefined;
   return operator&&blocks>0&&blocks%CHECKPOINT_EVERY===0&&blocks<=operator.status().archive.batches?checkpointOf(operator.state.notes,blocks):undefined;
  },
  /** The current epoch's frontier after a multiple of CHECKPOINT_EVERY of its accepted batches; a closed epoch's tree is gone, and `state` runs ahead of the journal while a batch is in flight. */
  checkpointAt:(epoch:number,blocks:number)=>{
   const operator=live?.operator,state=operator?.state;
   if(!operator||!(state instanceof EpochState))return undefined;
   return epoch===state.epoch&&blocks>0&&blocks%CHECKPOINT_EVERY===0&&blocks<=operator.status().archive.batches-epoch*state.epochLen?{epoch,...checkpointOf(state.notes,blocks)}:undefined;
  },
  /** Fills a deposit coin from the indexer; the client names the outpoint and the tree that locks it. */
  depositCoin:resolveCoin,
  /** Follows a batch another prover got accepted; its transaction, checkpoints and reserve come from the indexer, never the caller. Without slots it is followed chain-only. */
  external:async(txid:string,slots?:FollowedSlots<RollupOperator>|FollowedSlots<RollupEpochOperator>)=>{
   if(!live)throw new Error('The rollup pool is not open yet.');
   const {operator,indexer}=live,txs=async(ids:string[])=>(await indexer.getVirtualTxs(ids)).txs.map(decodeStockIndexerTransaction);
   const tx=(await txs([txid])).find(t=>t.id===txid);if(!tx)throw new Error('The indexer does not know that transaction.');
   const ids=Array.from({length:tx.inputsLength},(_,vin)=>hex.encode(tx.getInput(vin).txid!)),found=await txs(ids),checkpoints=ids.map(id=>found.find(t=>t.id===id));
   if(checkpoints.some(c=>!c))throw new Error('The indexer lacks a checkpoint of that transaction.');
   const {archive}=operator.status(),[head]=(await indexer.getVtxos({outpoints:[{txid:archive.head.txid,vout:archive.head.vout}]})).vtxos;
   if(!head?.isSpent||head.arkTxId!==txid)throw new Error("That transaction has not spent this pool's head.");
   const second=checkpoints[1]?.getInput(0),moved=second&&Object.entries(archive.reserves).find(([,c])=>c.txid===hex.encode(second.txid!)&&c.vout===second.index)?.[0];
   const outs=(await indexer.getVtxos({outpoints:[{txid,vout:0},{txid,vout:1}]})).vtxos,created=outs.find(v=>v.vout===0)?.createdAt;
   const reserveAmount=moved?String(outs.find(v=>v.vout===1)?.assets?.find(a=>a.assetId===moved)?.amount??0):undefined;
   const followed={tx,checkpoints:checkpoints as Transaction[],at:created instanceof Date?created.getTime():Date.now(),...(reserveAmount!==undefined?{reserveAmount}:{})};
   return operator.state instanceof EpochState?(operator as RollupEpochOperator).follow({...followed,slots:slots as FollowedSlots<RollupEpochOperator>})
    :(operator as RollupOperator).follow({...followed,slots:slots as FollowedSlots<RollupOperator>});
  },
  submit:async(spend:Submission,coin?:CoinRef)=>{
   if(!live)throw new Error('The rollup pool is not open yet.');
   if(tracked.has(spend.id))throw new Error('Duplicate rollup spend id.');
   await admit(live.operator,spend);kick();
   const record={status:'pending' as const,nullifier:String(spend.slot.nullifiers[0]),at:Date.now()};
   tracked.set(spend.id,record);store.save({id:spend.id,...record,spend:'anchor' in spend.slot?encodeEpochSpend(spend as Omit<RollupEpochSpend,'receivedAt'>,coin):encodeSpend(spend as Omit<RollupSpend,'receivedAt'>,coin)});
  },
  spend:(id:string):RollupSpendStatus|undefined=>{
   const s=sessions.get(id),t=tracked.get(id);
   if(s&&!s.signed)return {status:'signing',arkTx:s.arkTx,checkpoint:s.checkpoints[s.vin]!,checkpoints:s.checkpoints,vin:s.vin};
   if(!t)return undefined;
   const {nullifier:_n,at:_a,...rest}=t;return rest;
  },
  sign:(id:string,signed:{arkTx:string;checkpoint:string})=>{
   const s=sessions.get(id);
   if(!s||s.signed)throw new Error('This spend has no open signing round.');
   const same=(a:string,b:string)=>Transaction.fromPSBT(base64.decode(a)).id===Transaction.fromPSBT(base64.decode(b)).id;
   if(!same(signed.arkTx,s.arkTx)||!same(signed.checkpoint,s.checkpoints[s.vin]!))throw new Error('The signed transactions are not this batch.');
   s.signed=signed;
  },
  close:()=>{stopped=true;for(const t of timers)clearTimeout(t);setup?.kill();live?.operator.close();},
 };
}
export type RollupService=Awaited<ReturnType<typeof openRollupService>>;
