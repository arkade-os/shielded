import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,InMemoryContractRepository,InMemoryWalletRepository,Ramps,SingleKey,Wallet,type SendParams} from '@arkade-os/sdk';
import {bech32,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import info from './fixtures/ark-info.json' with {type:'json'};
import {RollupAccount,type BuiltSpend,type PublishedSlot} from '../packages/protocol/src/rollup/account.ts';
import {ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {assetFieldOfId,noteOf} from '../packages/protocol/src/rollup/notes.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from '../src/shielded/handle.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,shieldedKeysOf,type ShieldedProver} from '../src/shielded/wallet.ts';
import {catchUp} from '../src/shielded/sync.ts';
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
const onchain={getCoins:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never;

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

test('the router carries the shielded rails ahead of the public ones',async()=>{
 const wallet=await open();
 try{
  const router=wallet.router();
  assert.deepEqual((await router.options({raw:wallet.shieldedAddress(),amount:500})).map(o=>o.railId),['shielded']);
  assert.deepEqual((await router.options({raw:POOL_ADDRESS,amount:500})).map(o=>o.railId),['ark'],'the pool itself is never a withdrawal');
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
 try{await first.account.apply({kind:'spend',slots:[],txid:'01'.repeat(32)});await first.save();}finally{await first.dispose();}
 const stored=await repository.getAccount(TOKEN);
 assert.ok(stored,'the snapshot is keyed by the pool token');
 assert.equal(stored!.account.v,1);
 const {fetcher,paths}=poolFetcher(0);
 const second=await open({repository,fetcher});
 try{
  assert.equal(second.resumed,true);
  assert.equal(second.repositoryError,undefined);
  assert.equal(second.batchCount(),1,'the stored cursor, not a replay from zero');
  assert.ok(paths.filter(p=>p.startsWith('/batches')).every(p=>p==='/batches?from=1&limit=50'));
  assert.ok(paths.some(p=>p==='/batches?from=1&limit=50'),'checks the stored head');
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
 const dispose=ShieldedWallet.prototype.dispose;let disposed=0;
 ShieldedWallet.prototype.dispose=function(){disposed++;return dispose.call(this);};
 try{await assert.rejects(open({fetcher}),/fetch failed|did not answer/);}finally{ShieldedWallet.prototype.dispose=dispose;}
 assert.equal(disposed,1);
});

test('disposal stops the watchdog, so the process can exit',async()=>{
 const wallet=await open();
 const timer=(wallet as any).timer;
 assert.ok(timer);
 await wallet.dispose();
 await wallet.dispose();
 assert.equal(timer._destroyed,true,'the watchdog was cancelled, not merely made inert');
 assert.equal((wallet as any).timer,undefined);
 assert.equal(wallet.batchCount(),0);
});

const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const coin=(txid='aa'.repeat(32),value=500)=>({txid,vout:0,value});
const fakeSpend=()=>({witness:{slot:{root:0n,nullifiers:[1n],commitments:[2n,3n],ctDigest:4n,groupId:0n,groupSize:0},publicSignals:[],input:{}},ciphertext:new Uint8Array(),change:0n} as unknown as BuiltSpend);
function readyDeposit(wallet:ShieldedWallet){
 (wallet as any).depositCoin=async(txid:string,value:number)=>({...coin(txid,value),tapTree:'aa',leaf:'bb'});
 wallet.account.spend=async()=>fakeSpend();
 wallet.account.depositAsset=async()=>[fakeSpend(),fakeSpend()];
}

test('self-send selects exactly the plan inputs and reserves its output before discovery',async t=>{
 const wallet=await open(),a=coin('a'.repeat(64),200),b=coin('b'.repeat(64),300),output=coin();
 const discovered=deferred<void>();let selected:unknown,announced=0;
 readyDeposit(wallet);
 wallet.getSpendableVtxos=async()=>[a,b,coin('c'.repeat(64),800)] as never;
 t.mock.method(Wallet.prototype,'send',async(...args:Parameters<Wallet['send']>)=>{const params=args[0];assert.ok('recipients' in params);selected=params.selectedVtxos;return output.txid;});
 (wallet as any).depositCoin=async()=>{await discovered.promise;return {...output,tapTree:'aa',leaf:'bb'};};
 wallet.prover={prove:async()=>{throw new Error('proof failed');}};
 wallet.onAction(()=>{announced++;});
 try{
  const handle=(await wallet.shield([a,b]))!;await flush();
  assert.equal(await wallet.shield([output]),undefined,'self-send output cannot start another deposit');
  assert.deepEqual(selected,[a,b]);assert.equal(announced,1);
  discovered.resolve();await assert.rejects(handle.settled(),/proof failed/);await flush();
  assert.ok(wallet.planFor([output],false),'pre-POST failure releases the discovered output');
 }finally{discovered.resolve();await wallet.dispose();}
});

test('unknown POST and polling outcomes keep deposit reservations, but pre-POST and dropped failures release',async()=>{
 for(const outcome of ['proof','post','poll','dropped','included-sync'] as const){
  const wallet=await open(),input=coin();readyDeposit(wallet);
  wallet.prover={prove:async()=>{if(outcome==='proof')throw new Error('proof');return {pi_a:[],pi_b:[],pi_c:[]};}};
  wallet.api=(async(path:string)=>{
   if(path==='/spends'){if(outcome==='post')throw new Error('post');return {};}
   if(path.startsWith('/spends/')){if(outcome==='poll')throw new Error('poll');return {status:outcome==='dropped'?'dropped':'included',reason:'dropped'};}
   throw new Error('included-sync');
  }) as never;
  try{
   const handle=(await wallet.shield([input]))!;
   await assert.rejects(handle.settled(),new RegExp(outcome));await flush();
   assert.equal(!!wallet.planFor([input],false),outcome==='proof'||outcome==='dropped',outcome);
  }finally{await wallet.dispose();}
 }
});

test('one dropped group member never releases another member with an unknown outcome',async()=>{
 const wallet=await open(),input={...coin(),assets:[{assetId:TOKEN,amount:5n}]};readyDeposit(wallet);
 wallet.pool.status.pool!.reserves={[TOKEN]:'5'};
 const ids:string[]=[];
 wallet.api=(async(path:string,body?:{id:string})=>{
  if(path==='/spends'){ids.push(body!.id);return {};}
  if(path.endsWith(ids[0]!))return {status:'dropped',reason:'dropped'};
  throw new Error('sibling unknown');
 }) as never;
 try{
  const handle=(await wallet.shield([input]))!;
  await assert.rejects(handle.settled(),/sibling unknown/);await flush();
  assert.equal(wallet.planFor([input],false),undefined);
 }finally{await wallet.dispose();}
});

test('a lost response to the second group POST retains the deposit reserved by the first',async()=>{
 const wallet=await open(),input={...coin(),assets:[{assetId:TOKEN,amount:5n}]};readyDeposit(wallet);
 wallet.pool.status.pool!.reserves={[TOKEN]:'5'};let posts=0;
 wallet.api=(async(path:string)=>{
  assert.equal(path,'/spends');if(++posts===2)throw new Error('second reply lost');return {};
 }) as never;
 try{
  const handle=(await wallet.shield([input]))!;
  await assert.rejects(handle.settled(),/second reply lost/);await flush();
  assert.equal(posts,2);assert.equal(wallet.planFor([input],false),undefined);
 }finally{await wallet.dispose();}
});

test('settle timeouts and a finite polling deadline retain reservations until a pool verdict',async t=>{
 const wallet=await open(),input=coin(),pending=deferred<{status:string}>();readyDeposit(wallet);
 wallet.api=(async(path:string)=>path==='/spends'?{}:pending.promise) as never;
 clearTimeout((wallet as any).timer);
 t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  const handle=(await wallet.shield([input]))!;await flush();
  const timeout=assert.rejects(handle.settled({timeoutMs:10}),/timeout/);
  t.mock.timers.tick(30*60_000+1);await timeout;await flush();
  assert.equal(handle.status,'pending');assert.equal(wallet.planFor([input],false),undefined);
  pending.resolve({status:'pending'});await flush();t.mock.timers.tick(1000);await flush();
  assert.equal(handle.status,'failed','every action has a finite polling deadline');
  assert.equal(wallet.planFor([input],false),undefined);
 }finally{pending.resolve({status:'included'});t.mock.timers.tick(1000);await flush();t.mock.timers.reset();await wallet.dispose();}
});

test('dispose during deposit discovery cannot resurrect the contract manager',async t=>{
 const wallet=await open();clearTimeout((wallet as any).timer);t.mock.timers.enable({apis:['setTimeout']});
 const handle=(await wallet.shield([coin()]))!;
 await wallet.dispose();t.mock.timers.tick(1000);await flush();
 try{
  assert.equal((wallet as any)._contractManager,undefined);
  assert.equal(handle.status,'failed');await assert.rejects(handle.settled(),/closed/);
  await assert.rejects(wallet.shield([coin()]),/closed/);
 }finally{t.mock.timers.tick(30_000);await flush();t.mock.timers.reset();await wallet.dispose();}
});

test('auto-shield catches up before planning a newly received pool payout',async()=>{
 const wallet=await open(),input=coin();let posts=0;readyDeposit(wallet);
 wallet.getSpendableVtxos=async()=>[input] as never;
 wallet.api=(async(path:string)=>{
  if(path.startsWith('/batches'))return {total:1,batches:[{kind:'spend',slots:[],txid:input.txid}]};
  posts++;throw new Error('payout submitted');
 }) as never;
 try{
  await (wallet as any).autoShield();await flush();
  assert.equal(wallet.isPoolPayout(input),true);assert.equal(posts,0);
  assert.equal((wallet as any).used.size,0);
 }finally{await wallet.dispose();}
});

test('start auto-shields coins already waiting and isolates action listeners',async()=>{
 const shield=ShieldedWallet.prototype.shield;let starts=0;
 ShieldedWallet.prototype.shield=async()=>{starts++;return undefined;};
 let wallet:ShieldedWallet;
 try{wallet=await open();}finally{ShieldedWallet.prototype.shield=shield;}
 readyDeposit(wallet!);wallet!.api=(async(path:string)=>path==='/spends'?{}:path.startsWith('/spends/')?{status:'included'}:{total:0,batches:[]}) as never;
 let received:ShieldedPaymentHandle|undefined;
 wallet!.onAction(()=>{throw new Error('bad listener');});wallet!.onAction(h=>{received=h;});
 try{
  assert.equal(starts,1);
  const handle=(await wallet!.shield([coin()]))!;await handle.settled();
  assert.equal(received,handle);
 }finally{await wallet!.dispose();}
});

test('pool script stays pinned across a status without a pool',async()=>{
 const wallet=await open();
 try{wallet.pool.status={phase:'starting',message:'restarting'};assert.equal((wallet as any).deps().poolScript,POOL_SCRIPT);}
 finally{await wallet.dispose();}
});

test('a listener attached after create receives the initial auto-shield handle',async()=>{
 const spendable=ShieldedWallet.prototype.getSpendableVtxos,deposit=(ShieldedWallet.prototype as any).depositCoin,input=coin();
 ShieldedWallet.prototype.getSpendableVtxos=async()=>[input] as never;
 (ShieldedWallet.prototype as any).depositCoin=async()=>({...input,tapTree:'aa',leaf:'bb'});
 let wallet:ShieldedWallet|undefined,posts=0;
 const fetcher=(async(url:string,init?:RequestInit)=>{
  const path=String(url).replace('/api/rollup','');
  if(init?.method==='POST'&&path==='/spends')posts++;
  const body=path.startsWith('/batches')?{total:0,batches:[]}:path.startsWith('/spends/')?{status:'included',txid:'cc'.repeat(32)}:{};
  return new Response(JSON.stringify(body),{status:200});
 }) as typeof fetch;
 try{
  wallet=await open({fetcher});
  let received:ShieldedPaymentHandle|undefined;
  wallet.onAction(()=>{throw new Error('replay listener');});wallet.onAction(h=>{received=h;});
  assert.ok(received,'startup publishes before create resolves, so subscribe must replay');
  await received.settled();assert.equal(posts,1);
  await wallet.dispose();let stale=false;wallet.onAction(()=>{stale=true;});assert.equal(stale,false);
 }finally{
  ShieldedWallet.prototype.getSpendableVtxos=spendable;(ShieldedWallet.prototype as any).depositCoin=deposit;
  await wallet?.dispose();
 }
});

test('note holds survive timeouts and unknown submission failures and isolate onFail',async t=>{
 const wallet=await open(),pending=deferred<{txid?:string}>();
 clearTimeout((wallet as any).timer);
 t.mock.timers.enable({apis:['setTimeout']});
 wallet.notes.inFlight.add(1n);
 const handle=shieldedHandle({title:'test',steps:['wait','done'],railId:'test'},()=>pending.promise);
 (wallet as any).hold([1n],handle,()=>{throw new Error('listener');});
 try{
  t.mock.timers.tick(30*60_000+1);await flush();assert.ok(wallet.inFlight.has(1n));
  pending.resolve({});await handle.settled();await flush();assert.equal(wallet.inFlight.size,0);
  wallet.notes.inFlight.add(2n);wallet.api=(async()=>{throw new Error('unknown POST');}) as never;
  const failed=shieldedHandle({title:'test',steps:['wait','done'],railId:'test'},step=>(wallet as any).submit([{built:fakeSpend()}],step));
  (wallet as any).hold([2n],failed,()=>{throw new Error('listener');});
  await assert.rejects(failed.settled(),/unknown POST/);await flush();assert.ok(wallet.inFlight.has(2n));
  for(const outcome of ['proof','dropped']){
   wallet.notes.inFlight.add(3n);
   wallet.prover={prove:async()=>{if(outcome==='proof')throw new Error('proof');return {pi_a:[],pi_b:[],pi_c:[]};}};
   wallet.api=(async(path:string)=>path==='/spends'?{}:{status:'dropped',reason:'dropped'}) as never;
   const safe=shieldedHandle({title:'test',steps:['wait','done'],railId:'test'},step=>(wallet as any).submit([{built:fakeSpend()}],step));
   (wallet as any).hold([3n],safe,()=>{throw new Error('listener');});
   await assert.rejects(safe.settled(),new RegExp(outcome));await flush();assert.equal(wallet.inFlight.has(3n),false);
  }
 }finally{pending.resolve({});t.mock.timers.reset();await wallet.dispose();}
});

test('a contract manager finishing creation across disposal is closed and never returned',async()=>{
 const wallet=await open(),ready=deferred<Awaited<ReturnType<Wallet['getContractManager']>>>(),resume=deferred<void>();
 await Wallet.prototype.dispose.call(wallet);
 const initialize=(wallet as any).initializeContractManager;
 (wallet as any).initializeContractManager=async()=>{
  const manager=await initialize.call(wallet);ready.resolve(manager);await resume.promise;return manager;
 };
 const acquiring=wallet.getContractManager(),follower=wallet.getContractManager();
 const manager=await ready.promise;
 (wallet as any)._restoreInFlight=acquiring;
 const disposing=wallet.dispose();resume.resolve();
 try{
  await Promise.all([assert.rejects(acquiring,/closed/),assert.rejects(follower,/closed/)]);await disposing;
  assert.equal(await manager.isWatching(),false);assert.equal((wallet as any)._contractManager,undefined);
  await assert.rejects(wallet.getContractManager(),/closed/);
 }finally{resume.resolve();await disposing;manager.dispose();await wallet.dispose();}
});

test('SDK self-send output events cannot plan another shield before its database update returns',async t=>{
 const wallet=await open(),a=coin('aa'.repeat(32),200),b=coin('bb'.repeat(32),300),output=coin('cc'.repeat(32)),other=coin('dd'.repeat(32));
 const database=deferred<void>(),entered=deferred<void>(),verdict=deferred<{status:string}>(),lookup=deferred<ReturnType<typeof coin>[]>();
 readyDeposit(wallet);wallet.getSpendableVtxos=async()=>lookup.promise as never;
 const earlier=wallet.shield();
 wallet.getSpendableVtxos=async()=>[a,b] as never;
 wallet.buildAndSubmitOffchainTx=async()=>({arkTxid:output.txid,signedCheckpointTxs:[]}) as never;
 (wallet as any).updateDbAfterOffchainTx=async()=>{entered.resolve();await database.promise;};
 t.mock.method(Wallet.prototype,'send',async()=>(Wallet.prototype as any)._submitOffchainSpend.call(wallet,[],[],{}));
 wallet.api=(async(path:string)=>path==='/spends'?{}:path.startsWith('/spends/')?verdict.promise:{total:0,batches:[]}) as never;
 const announced:ShieldedPaymentHandle[]=[];wallet.onAction(h=>{announced.push(h);});
 try{
  const first=(await wallet.shield([a,b]))!;await entered.promise;
  wallet.getSpendableVtxos=async()=>[output] as never;
  lookup.resolve([output]);assert.equal(await earlier,undefined,'coin reads begun before self-send must recheck the guard');
  await (wallet as any).autoShield();
  assert.equal(announced.length,1,'the SDK tail has not returned the self-send txid yet');
  assert.equal(await wallet.shield([other]),undefined,'explicit planning is guarded too');
  database.resolve();await flush();
  assert.equal(await wallet.shield([output]),undefined,'the txid reservation takes over before planning resumes');
  const second=await wallet.shield([other]);assert.ok(second,'unrelated coins can shield during the original pool wait');
  verdict.resolve({status:'included'});await Promise.all([first.settled(),second.settled()]);
 }finally{lookup.resolve([]);database.resolve();verdict.resolve({status:'included'});await flush();await wallet.dispose();}
});

test('real SDK persistence after an in-flight self-send cannot reopen a disposed wallet',async t=>{
 const wallet=await open(),a=coin('aa'.repeat(32),200),b=coin('bb'.repeat(32),300),entered=deferred<void>();
 const transport=deferred<{arkTxid:string;signedCheckpointTxs:string[]}>();
 wallet.getSpendableVtxos=async()=>[a,b] as never;
 wallet.buildAndSubmitOffchainTx=async()=>{entered.resolve();return transport.promise;};
 t.mock.method(Wallet.prototype,'send',async()=>(Wallet.prototype as any)._submitOffchainSpend.call(wallet,[],[],{
  offchainTapscript:(wallet as any).offchainTapscript,serverPubKey:(wallet as any).arkServerPublicKey,changeAmount:0n,sentAmount:500,changeVout:0,
 }));
 t.mock.method(console,'warn',()=>{});
 try{
  const handle=(await wallet.shield([a,b]))!;await entered.promise;
  await wallet.dispose();assert.equal((wallet as any)._contractManager,undefined);
  transport.resolve({arkTxid:'cc'.repeat(32),signedCheckpointTxs:[]});
  await assert.rejects(handle.settled(),/closed/);
  assert.equal((wallet as any)._contractManager,undefined,'real updateDbAfterOffchainTx must not recreate a watcher');
  await assert.rejects(wallet.getContractManager(),/closed/);
 }finally{transport.resolve({arkTxid:'cc'.repeat(32),signedCheckpointTxs:[]});await wallet.dispose();}
});

test('native entrypoints reject shield reservations and the unknown self-send output phase before reaching the SDK',async t=>{
 const wallet=await open(),input=coin(),sameTxid={...input,vout:1};let submitted=0;
 for(const name of ['send','settle','sendBitcoin','sendSelectedVtxosToSelf'] as const)t.mock.method(Wallet.prototype,name,async()=>{submitted++;return 'native';});
 const attempts=(selected:typeof input)=>[
  ()=>wallet.send({recipients:[{address:POOL_ADDRESS,amount:330}],selectedVtxos:[selected] as never}),
  ()=>wallet.settle({inputs:[selected] as never,outputs:[]}),
  ()=>wallet.sendBitcoin({address:POOL_ADDRESS,amount:330,selectedVtxos:[selected] as never}),
  ()=>wallet.sendSelectedVtxosToSelf([selected] as never),
 ];
 try{
  (wallet as any).used.add(`${input.txid}:0`);
  for(const attempt of attempts(input))await assert.rejects(attempt(),/reserved/i);
  (wallet as any).usedTxids.add(input.txid);
  for(const attempt of attempts(sameTxid))await assert.rejects(attempt(),/reserved/i);
  (wallet as any).used.clear();(wallet as any).usedTxids.clear();(wallet as any).selfSending=true;
  for(const attempt of attempts(input))await assert.rejects(attempt(),/prepar/i);
  (wallet as any).selfSending=false;await wallet.dispose();
  for(const attempt of attempts(input))await assert.rejects(attempt(),/closed/i);
  assert.equal(submitted,0);
 }finally{await wallet.dispose();}
});

test('generic native selection excludes shield inputs and output txids while discovery still sees them',async t=>{
 const wallet=await open(),input=coin(),output=coin('bb'.repeat(32)),other=coin('cc'.repeat(32)),proof=deferred<void>();
 readyDeposit(wallet);wallet.prover={prove:async()=>{await proof.promise;throw new Error('proof cancelled');}};
 const filters:unknown[]=[];
 t.mock.method(Wallet.prototype,'getSpendableVtxos',async(filter:unknown)=>{filters.push(filter);return [input,output,other] as never;});
 const handle=(await wallet.shield([input]))!,finished=assert.rejects(handle.settled(),/proof cancelled/);
 try{
  (wallet as any).usedTxids.add(output.txid);
  const filter={genericallySpendableOnly:true,requireSynced:true,maxSyncAgeMs:5};
  assert.deepEqual(await wallet.getSpendableVtxos(filter),[other]);assert.equal(filters.at(-1),filter);
  assert.deepEqual(await wallet.getSpendableVtxos(),[input,output,other]);
  assert.deepEqual(await wallet.getSpendableVtxos({genericallySpendableOnly:false}),[input,output,other]);
 }finally{proof.resolve();await finished;await wallet.dispose();}
});

test('overlapping native operations block shielding across coin lookup and keep the guard until both finish',async t=>{
 const wallet=await open(),input=coin(),lookup=deferred<ReturnType<typeof coin>[]>(),sent=deferred<string>(),settled=deferred<string>();
 readyDeposit(wallet);wallet.prover={prove:async()=>{throw new Error('unexpected shield');}};
 let sendArgs:unknown,settleArgs:unknown,coinReads=0;
 wallet.coins=async()=>{coinReads++;return lookup.promise;};
 t.mock.method(Wallet.prototype,'send',async(...args:unknown[])=>{sendArgs=args;return sent.promise;});
 t.mock.method(Wallet.prototype,'settle',async(...args:unknown[])=>{settleArgs=args;return settled.promise;});
 const earlier=wallet.shield(),recipient={address:POOL_ADDRESS,amount:330},callback=()=>{};
 const sending=wallet.send(recipient),settling=wallet.settle(undefined,callback);
 try{
  lookup.resolve([input]);assert.equal(await earlier,undefined,'coin reads begun first must recheck native activity');
  assert.equal(await wallet.shield([input]),undefined);assert.equal(await wallet.renew(),undefined);assert.equal(coinReads,1);
  sent.resolve('sent');assert.equal(await sending,'sent');assert.equal(await wallet.shield([input]),undefined);
  settled.resolve('settled');assert.equal(await settling,'settled');
  assert.deepEqual(sendArgs,[recipient]);assert.deepEqual(settleArgs,[undefined,callback]);
  const handle=await wallet.shield([input]);assert.ok(handle);await assert.rejects(handle.settled(),/unexpected shield/);
 }finally{lookup.resolve([]);sent.resolve('sent');settled.resolve('settled');await Promise.all([sending,settling]);await wallet.dispose();}
});

test('each native entrypoint releases its guard on failure and forwards explicit arguments unchanged',async t=>{
 const wallet=await open(),input=coin(),now={type:'height',value:1} as never;
 const send:SendParams={recipients:[{address:POOL_ADDRESS,amount:330}],selectedVtxos:[input] as never};
 const settle={inputs:[input] as never,outputs:[]};
 const bitcoin={address:POOL_ADDRESS,amount:330,selectedVtxos:[input]} as Parameters<Wallet['sendBitcoin']>[0];
 const cases:[keyof Wallet,unknown[],()=>Promise<string>][]=[
  ['send',[send],()=>wallet.send(send)],['settle',[settle],()=>wallet.settle(settle)],
  ['sendBitcoin',[bitcoin],()=>wallet.sendBitcoin(bitcoin)],['sendSelectedVtxosToSelf',[[input],now],()=>wallet.sendSelectedVtxosToSelf([input] as never,now)],
 ];
 try{
  for(const [name,args,run] of cases){
   const stub=t.mock.method(Wallet.prototype,name as 'send',async(...received:unknown[])=>{assert.deepEqual(received,args);throw new Error('native failed');});
   await assert.rejects(run(),/native failed/);assert.equal((wallet as any).nativeOperations,0);stub.mock.restore();
  }
 }finally{await wallet.dispose();}
});

test('listing captures its pool, persists the transaction and refuses missing or closed pools before sending',async t=>{
 const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository}),sent=deferred<string>();let sends=0,request:unknown;
 t.mock.method(Wallet.prototype,'send',async(...args:unknown[])=>{sends++;request=args[0];return sent.promise;});
 try{
  const listing=wallet.listAsset(TOKEN);wallet.pool.status={phase:'starting',message:'restart'};
  sent.resolve('listed');assert.equal(await listing,'listed');
  assert.deepEqual(request,{recipients:[{address:POOL_ADDRESS,amount:330,assets:[{assetId:TOKEN,amount:1n}]}]});
  assert.deepEqual((await repository.getAccount(TOKEN))!.listings,['listed']);
  await assert.rejects(wallet.listAsset(TOKEN),/pool.*not available/i);
  await wallet.dispose();await assert.rejects(wallet.listAsset(TOKEN),/closed/);assert.equal(sends,1);
 }finally{sent.resolve('listed');await wallet.dispose();}
});

test('Ramps refuses an exit input reserved by shielding while it awaits a change address',async t=>{
 const wallet=await open(),input=coin('aa'.repeat(32),1000),entered=deferred<void>(),change=deferred<string>(),proof=deferred<void>();
 readyDeposit(wallet);wallet.prover={prove:async()=>{await proof.promise;throw new Error('proof cancelled');}};
 t.mock.method(Wallet.prototype,'getSpendableVtxos',async()=>[input] as never);
 t.mock.method(wallet,'getAddress',async()=>{entered.resolve();return change.promise;});
 let settled=0;t.mock.method(Wallet.prototype,'settle',async()=>{settled++;return 'exit';});
 const destinationAddress=bech32.encode('tb',[0,...bech32.toWords(new Uint8Array(20).fill(1))]);
 const exiting=new Ramps(wallet).offboardExact({destinationAddress,amount:400n,feeInfo:{intentFee:{},txFeeRate:'0'}});
 const refused=assert.rejects(exiting,/reserved/i);
 let handle:ShieldedPaymentHandle|undefined;
 try{
  await entered.promise;handle=await wallet.shield([input]);assert.ok(handle);
  change.resolve(POOL_ADDRESS);await refused;assert.equal(settled,0);
 }finally{change.resolve(POOL_ADDRESS);proof.resolve();if(handle)await assert.rejects(handle.settled(),/proof cancelled/);await wallet.dispose();}
});

const publishSpend=({witness,ciphertext}:BuiltSpend):PublishedSlot=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:String(witness.slot.groupId),groupSize:witness.slot.groupSize,publics:witness.publicSignals.map(String),ciphertext:hex.encode(ciphertext)});
async function fundPrivate(wallet:ShieldedWallet,notes:{amount:bigint;asset?:bigint}[]){
 const deposits=await Promise.all(notes.map(n=>wallet.account.spend({deposit:n.amount,asset:n.asset},wallet.self)));
 await wallet.account.apply({kind:'spend',slots:deposits.map(publishSpend),txid:'de'.repeat(32)});
}
const recipient=shieldedKeysOf(hash,'22'.repeat(32));

test('existing and new routers keep the original pool excluded after status loses or changes its address',async()=>{
 const wallet=await open(),router=wallet.router(),decoded=ArkAddress.decode(POOL_ADDRESS);
 const elsewhere=new ArkAddress(decoded.serverPubKey,new Uint8Array(32).fill(7),decoded.hrp).encode();
 try{
  await fundPrivate(wallet,[{amount:500n}]);
  assert.equal(wallet.canWithdraw(500n),true);
  assert.equal((await router.route({raw:POOL_ADDRESS,amount:500})).railId,'ark');
  for(const latest of [{phase:'starting',message:'restart'} as RollupPoolStatus,{...status(1),pool:{...status(1).pool!,address:elsewhere}}]){
   wallet.pool.status=latest;
   for(const current of [router,wallet.router()]){
    for(const raw of [POOL_ADDRESS,POOL_ADDRESS.toUpperCase(),`bitcoin:?ark=${POOL_ADDRESS}`])
     assert.equal((await current.route({raw,amount:500})).railId,'ark');
    assert.equal((await current.route({raw:elsewhere,amount:500})).railId,'shielded-withdraw');
   }
  }
 }finally{await wallet.dispose();}
});

test('pay and withdraw announce handles before a shortfall fails at the note selection step',async()=>{
 const wallet=await open(),announced:ShieldedPaymentHandle[]=[];
 wallet.onAction(h=>{announced.push(h);assert.equal(h.stepState().current,0);});
 try{
  for(const run of [()=>wallet.pay(recipient.address,500n),()=>wallet.withdraw(POOL_ADDRESS,500n),()=>wallet.withdraw(POOL_ADDRESS,1n,{asset:TOKEN})]){
   const handle=await run();assert.equal(announced.at(-1),handle);
   await assert.rejects(handle.settled(),/No (three|single) note/);
   assert.equal(handle.status,'failed');assert.equal(handle.stepState().current,0);assert.match(handle.stepState().error!,/No (three|single) note/);
  }
  assert.equal(wallet.inFlight.size,0);
 }finally{await wallet.dispose();}
});

test('a joined payment holds both inputs against a queued payment and records one recipient output',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository}),proof=deferred<void>(),started=deferred<BuiltSpend>();
 let published:PublishedSlot|undefined;
 wallet.prover={joinReady:()=>true,prove:async(built,circuit)=>{assert.equal(circuit,'join');started.resolve(built);await proof.promise;return {pi_a:[],pi_b:[],pi_c:[]};}};
 wallet.api=(async(path:string)=>{
  if(path==='/spends')return {};
  if(path.startsWith('/spends/'))return {status:'included',txid:'ef'.repeat(32)};
  const slots=published?[published]:[];published=undefined;
  return {total:2,batches:slots.length?[{kind:'join',slots,txid:'ef'.repeat(32)}]:[]};
 }) as never;
 try{
  await fundPrivate(wallet,[{amount:400n},{amount:500n}]);
  assert.equal(wallet.maxPrivatePayment(),900n);assert.equal(wallet.canWithdraw(400n),true);
  const first=await wallet.pay(recipient.address,800n),built=await started.promise;
  assert.equal(wallet.inFlight.size,2);assert.deepEqual(new Set(built.witness.slot.nullifiers),wallet.inFlight);
  assert.equal(wallet.maxPrivatePayment(),0n);assert.equal(wallet.canWithdraw(330n),false);
  const second=await wallet.pay(recipient.address,300n);await assert.rejects(second.settled(),/No three notes/);
  assert.equal(wallet.inFlight.size,2,'the rejected second action must not release the first action inputs');
  const stored=(await repository.getAccount(TOKEN))!,[firstNf,secondNf]=built.witness.slot.nullifiers;
  assert.deepEqual(Object.keys(stored.sent),[String(firstNf)]);assert.equal(wallet.sentOf(secondNf!),undefined);
  const sent=stored.sent[String(firstNf)]!;assert.equal(sent.to,recipient.address);assert.equal(sent.note!.amount,'800');
  assert.equal(noteOf(hash,ROLLUP_DOMAIN,BigInt(sent.note!.amount),BigInt(sent.note!.asset),recipient.self.owner,BigInt(sent.note!.rho)),built.witness.slot.commitments[0]);
  published=publishSpend(built);proof.resolve();await first.settled();await flush();
  assert.equal(wallet.inFlight.size,0);assert.equal(wallet.shieldedBalance(),100n);assert.equal(wallet.shieldedHistory().at(-1)!.slots.length,1);
  assert.equal(wallet.shieldedHistory().at(-1)!.spent.length,2);
 }finally{proof.resolve();await wallet.dispose();}
});

test('private action reservations release only after a safe outcome',async()=>{
 for(const action of ['pay','withdraw','withdraw-btc'] as const)for(const outcome of ['proof','post','poll','signing','dropped','included-sync'] as const){
  const wallet=await open();let posts=0;
  try{
   await fundPrivate(wallet,action==='pay'?[{amount:400n},{amount:500n}]:action==='withdraw'?[{amount:40n,asset:assetFieldOfId(TOKEN)},{amount:500n}]:[{amount:500n}]);
   wallet.prover={joinReady:()=>true,prove:async()=>{if(outcome==='proof')throw new Error('proof');return {pi_a:[],pi_b:[],pi_c:[]};}};
   wallet.api=(async(path:string,body?:{program?:string;asset?:string;publics:string[];slot:{groupSize:number}})=>{
    if(path==='/spends'){
     if(action!=='pay'){
      assert.equal(body!.program,'e2d99617ad6f0911ce658123284c11e2dbf2ed7eaa3b7b5eb9804173c674016e');
      assert.equal(body!.asset,action==='withdraw'&&posts===0?TOKEN:undefined);
      assert.equal(body!.publics[2],action==='withdraw'?(posts===0?'40':'400'):'400');
      assert.equal(body!.slot.groupSize,action==='withdraw'?2:0);
     }
     posts++;if(outcome==='post')throw new Error('post');return {};
    }
    if(path.startsWith('/spends/')){
     if(outcome==='poll')throw new Error('poll');
     return outcome==='signing'?{status:'signing',arkTx:'unexpected'}:{status:outcome==='dropped'?'dropped':'included',reason:'dropped'};
    }
    throw new Error('included-sync');
   }) as never;
   const handle=await (action==='pay'?wallet.pay(recipient.address,800n):action==='withdraw'?wallet.withdraw(POOL_ADDRESS,40n,{asset:TOKEN,sats:400n}):wallet.withdraw(POOL_ADDRESS,400n));
   await assert.rejects(handle.settled(),outcome==='signing'?/no deposit coin/:new RegExp(outcome));await flush();
   const safe=outcome==='proof'||outcome==='dropped';
   assert.equal(wallet.inFlight.size,safe?0:action==='withdraw-btc'?1:2,`${action}: ${outcome}`);
   assert.equal(action==='pay'?wallet.maxPrivatePayment():action==='withdraw'?wallet.canWithdraw(40n,{asset:TOKEN}):wallet.canWithdraw(400n),action==='pay'?(safe?900n:0n):safe);
  }finally{await wallet.dispose();}
 }
});

test('withdrawal availability is total and respects asset and carrier reservations',async()=>{
 const wallet=await open();
 try{
  await fundPrivate(wallet,[{amount:40n,asset:assetFieldOfId(TOKEN)},{amount:500n}]);
  assert.equal(wallet.canWithdraw(1n,{asset:'bad'}),false);
  assert.equal(wallet.canWithdraw(0n,{asset:TOKEN}),false);assert.equal(wallet.canWithdraw(329n),false);
  assert.equal(wallet.canWithdraw(40n,{asset:TOKEN}),true);assert.equal(wallet.canWithdraw(41n,{asset:TOKEN}),false);
  assert.equal(wallet.canWithdraw(40n,{asset:TOKEN,sats:501n}),false);
  wallet.notes.inFlight.add(wallet.account.notes()[0]!.nullifier);
  assert.equal(wallet.canWithdraw(40n,{asset:TOKEN}),false);
  const handle=await wallet.withdraw(POOL_ADDRESS,40n,{asset:TOKEN});await assert.rejects(handle.settled(),/BTC note/);
  assert.equal(handle.stepState().current,0);
 }finally{await wallet.dispose();}
});

test('pay and withdraw cannot select notes after disposal or persist a selection that finishes after disposal',async()=>{
 for(const action of ['pay','withdraw'] as const){
  const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository}),picked=deferred<void>(),resume=deferred<void>();
  await fundPrivate(wallet,[{amount:500n}]);
  const spend=wallet.account.spend.bind(wallet.account);
  wallet.account.spend=async(...args)=>{const built=await spend(...args);picked.resolve();await resume.promise;return built;};
  const run=()=>action==='pay'?wallet.pay(recipient.address,400n):wallet.withdraw(POOL_ADDRESS,400n);
  try{
   const handle=await run();await picked.promise;await wallet.dispose();resume.resolve();
   await assert.rejects(handle.settled(),/closed/);await flush();
   assert.equal(wallet.inFlight.size,0);assert.equal(await repository.getAccount(TOKEN),undefined);
   const after=await run();await assert.rejects(after.settled(),/closed/);assert.equal(after.stepState().current,0);
  }finally{resume.resolve();await wallet.dispose();}
 }
});

test('private persistence waits for catch-up and refuses a new snapshot after disposal',async()=>{
 for(const action of ['pay','withdraw'] as const)for(const closed of [false,true]){
  const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository}),resume=deferred<void>(),picked=deferred<void>();
  await fundPrivate(wallet,[{amount:500n}]);
  const barrier=catchUp(wallet.account,(async()=>{await resume.promise;return {total:1,batches:[]};}) as never);
  const spend=wallet.account.spend.bind(wallet.account);let snapshots=0,posts=0;
  wallet.account.spend=async(...args)=>{const result=await spend(...args);picked.resolve();return result;};
  const snapshot=wallet.account.snapshot.bind(wallet.account);wallet.account.snapshot=()=>{snapshots++;return snapshot();};
  wallet.api=(async(path:string)=>{assert.equal(path,'/spends');posts++;throw new Error('post');}) as never;
  try{
   const handle=await (action==='pay'?wallet.pay(recipient.address,400n):wallet.withdraw(POOL_ADDRESS,400n));await picked.promise;await flush();
   assert.equal(snapshots,0);assert.equal(posts,0);
   if(closed)await wallet.dispose();resume.resolve();await barrier;
   await assert.rejects(handle.settled(),closed?/closed/:/post/);await flush();
   assert.equal(snapshots,closed?0:1);assert.equal(posts,closed?0:1);assert.equal(wallet.inFlight.size,closed?0:1);
   assert.equal(!!await repository.getAccount(TOKEN),!closed);
  }finally{resume.resolve();await barrier;await wallet.dispose();}
 }
});
