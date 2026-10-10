import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InMemoryContractRepository,InMemoryWalletRepository,SingleKey,Wallet} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import info from './fixtures/ark-info.json' with {type:'json'};
import {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,type ShieldedProver} from '../src/shielded/wallet.ts';
import type {RollupPoolStatus} from '../src/shielded/pool.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const TOKEN='2df7aa3628161299e03ef35e71916d68952490aa7b37423e358ab32bbe26a7de0000';
const POOL_SCRIPT='5120e2d99617ad6f0911ce658123284c11e2dbf2ed7eaa3b7b5eb9804173c674016e';
const POOL_ADDRESS='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const status=(batches:number):RollupPoolStatus=>({phase:'ready',message:'',proving:{spend:{wasm:'a',zkey:'b'},join:{wasm:'c',zkey:'d'},batch:{wasm:'e',zkey:'f'},batchJoin:{wasm:'g',zkey:'h'}},
 pool:{token:TOKEN,address:POOL_ADDRESS,script:POOL_SCRIPT,batches,root:'0',head:{txid:'ab'.repeat(32),vout:0,value:1000},pending:0,padding:0,reserves:{}}});

const prover:ShieldedProver={prove:async()=>({pi_a:[],pi_b:[],pi_c:[]})};
const ark={serverUrl:'https://mutinynet.arkade.sh',getInfo:async()=>info} as never;
const indexer={getVtxos:async()=>({vtxos:[],page:undefined}),getVirtualTxs:async()=>({txs:[]}),
 subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never;
const onchain={getCoins:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1})} as never;

/** Counts what the pool was asked for, so a resumed wallet can be shown not to re-read the published batches. */
function poolFetcher(batches:number){
 const paths:string[]=[];
 const fetcher=(async(url:string)=>{
  const path=String(url).replace('/api/rollup','');
  paths.push(path);
  const body=path==='/status'?status(batches):path.startsWith('/batches')?{total:batches,batches:[]}:{};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 }) as unknown as typeof fetch;
 return {fetcher,paths};
}
const open=(o:{batches?:number;repository?:InMemoryShieldedNoteRepository;fetcher?:typeof fetch;secret?:string}={})=>
 ShieldedWallet.create({identity:SingleKey.fromHex(o.secret??'11'.repeat(32)),arkProvider:ark,indexerProvider:indexer,onchainProvider:onchain,
  storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},settlementConfig:false,walletMode:'static',
  pool:{origin:'',status:status(o.batches??0)},secret:o.secret??'11'.repeat(32),hash,prover,
  fetcher:o.fetcher??poolFetcher(o.batches??0).fetcher,...(o.repository?{shieldedRepository:o.repository}:{})});

// The spec's written-first test: the inherited factory must produce the subclass against the patched SDK.
test('ShieldedWallet.create returns a ShieldedWallet, which is also a Wallet',async()=>{
 const wallet=await open();
 try{
  assert.ok(wallet instanceof ShieldedWallet,'the patched `new this(` must construct the subclass');
  assert.ok(wallet instanceof Wallet,'and it is still a real SDK wallet');
  assert.ok(wallet.account instanceof RollupAccount);
  assert.match(wallet.shieldedAddress(),/^shrol21/);
  assert.match(wallet.viewKey(),/^shview2/);
  assert.match(wallet.fullViewingKey(),/^shfvk2/);
  assert.equal(wallet.shieldedBalance(),0n);
  assert.equal(wallet.batchCount(),0);
  assert.equal(wallet.resumed,false);
  assert.equal(wallet.repositoryError,undefined);
  assert.ok((await wallet.getAddress()).startsWith('tark1'));
 }finally{await wallet.dispose();}
});

test("two wallets on one repository keep each other's sent entries",async()=>{
 const repository=new InMemoryShieldedNoteRepository();
 const [a,b]=await Promise.all([open({repository}),open({repository})]);
 try{
  a.recordSent([[1n,{to:'shrol21a'}]]);await a.save();
  b.recordSent([[2n,{to:'shrol21b'}]]);await b.save();
  assert.deepEqual(Object.keys((await repository.getAccount(TOKEN))!.sent).sort(),['1','2']);
  assert.equal(b.sentOf(1n)?.to,'shrol21a');
 }finally{await Promise.all([a.dispose(),b.dispose()]);}
});

test('a second open resumes from the repository and does not re-read the published batches',async()=>{
 const repository=new InMemoryShieldedNoteRepository();
 const first=await open({repository,batches:3});
 try{await first.save();}finally{await first.dispose();}
 const stored=await repository.getAccount(TOKEN);
 assert.ok(stored,'the snapshot is keyed by the pool token');
 assert.equal(stored!.account.v,1);
 const {fetcher,paths}=poolFetcher(0);
 const second=await open({repository,fetcher});
 try{
  assert.equal(second.resumed,true);
  assert.equal(second.repositoryError,undefined);
  assert.equal(second.batchCount(),0,'the stored cursor, not a replay from zero');
  assert.deepEqual(paths.filter(p=>p.startsWith('/batches')),['/batches?from=0&limit=50'],'one page to check the head, no backfill');
 }finally{await second.dispose();}
});

test('a snapshot from another seed is ignored, reported once, and the wallet syncs instead',async()=>{
 const repository=new InMemoryShieldedNoteRepository();
 const theirs=await open({repository,secret:'22'.repeat(32)});
 try{await theirs.save();}finally{await theirs.dispose();}
 const mine=await open({repository,secret:'11'.repeat(32)});
 try{
  assert.equal(mine.resumed,false);
  assert.match(mine.repositoryError!,/another key/i);
  assert.equal(mine.shieldedBalance(),0n);
 }finally{await mine.dispose();}
});

test('a pool that will not answer leaves no live wallet behind',async()=>{
 const fetcher=(async()=>{throw new TypeError('fetch failed');}) as unknown as typeof fetch;
 await assert.rejects(open({fetcher}),/fetch failed|did not answer/);
});

test('disposal stops the watchdog, so the process can exit',async()=>{
 const wallet=await open();
 await wallet.dispose();
 await wallet.dispose();
 assert.equal(wallet.batchCount(),0);
});
