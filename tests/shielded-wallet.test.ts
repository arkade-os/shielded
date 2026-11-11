import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,InMemoryContractRepository,InMemoryWalletRepository,Ramps,SingleKey,Wallet,makeHandle,type SendParams} from '@arkade-os/sdk';
import {bech32,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import info from './fixtures/ark-info.json' with {type:'json'};
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {BATCH_SLOTS,BTC_ASSET,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import type {DepositFee,DepositFeeSchedule} from '../packages/protocol/src/rollup/deposit-fee.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {assetFieldOfId,destinationFieldOf,noteOf} from '../packages/protocol/src/rollup/notes.ts';
import {openRollupNotes,parseRollupAddress} from '../packages/protocol/src/rollup/wallet.ts';
import {shieldedHandle,type ShieldedPaymentHandle} from '../src/shielded/handle.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,programOf,shieldedKeysOf,shieldedSteps,type ShieldedProver} from '../src/shielded/wallet.ts';
import {WATCHDOG_MS,epochCatchUp} from '../src/shielded/epoch-sync.ts';
import {epochFreshAccount,epochMatchesPool} from '../src/shielded/epoch-checkpoint.ts';
import {epochTransferBody,type EpochSpendBody} from '../src/shielded/epoch-pool.ts';
import type {SubmitMember} from '../src/shielded/submit.ts';
import type {PoolApi,RollupPoolStatus} from '../src/shielded/pool.ts';
import {epochLeafPool,epochPool,fromBody,posted,type PoolSpend} from './fixtures/epoch-pool.ts';
import {pageSheet} from '../app/src/shielded-page.ts';
import {PAUSED_ERROR} from '../app/src/rollup-client.ts';
import type {SyncProgressObserver} from '../src/shielded/sync-progress.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const TOKEN='2df7aa3628161299e03ef35e71916d68952490aa7b37423e358ab32bbe26a7de0000';
const POOL_SCRIPT='5120e2d99617ad6f0911ce658123284c11e2dbf2ed7eaa3b7b5eb9804173c674016e';
const POOL_ADDRESS='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const EPOCH_LEN=128,{pool:genesis}=await epochPool(hash,EPOCH_LEN).api<RollupPoolStatus>('/status');
const status=(batches:number,root=genesis!.root,depositFee?:DepositFee):RollupPoolStatus=>({phase:'ready',message:'',proving:{spend:{wasm:'a',zkey:'b'},join:{wasm:'c',zkey:'d'},batch:{wasm:'e',zkey:'f'},batchJoin:{wasm:'g',zkey:'h'}},
 pool:{token:TOKEN,address:POOL_ADDRESS,script:POOL_SCRIPT,batches,root,head:{txid:'ab'.repeat(32),vout:0,value:1000},pending:0,padding:0,reserves:{},epoch:0,epochLen:EPOCH_LEN,prevNoteRoot:genesis!.prevNoteRoot,...(depositFee?{depositFee}:{})}});
const chainOnlyRecord=(txid:string):RollupEpochRecord=>({kind:'spend',noteBlockRoot:'0',txid,slots:Array.from({length:BATCH_SLOTS},(_,s)=>({anchor:'0',nullifiers:[String(s+1)],commitments:['0','0'] as [string,string],ctDigest:'0',groupId:'0',groupSize:0,publics:[]}))});

const prover:ShieldedProver={prove:async()=>({pi_a:[],pi_b:[],pi_c:[]})};
const ark={serverUrl:'https://mutinynet.arkade.sh',getInfo:async()=>info} as never;
const indexer={getVtxos:async()=>({vtxos:[],page:undefined}),getVirtualTxs:async()=>({txs:[]}),
 subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never;
const onchain={getCoins:async()=>[],getTransactions:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never;

/** Counts what the pool was asked for, so a resumed wallet can be shown not to re-read the published batches. */
function poolFetcher(batches:number,root?:string,depositFee?:DepositFee){
 const paths:string[]=[];let empty=0;
 const fetcher=(async(url:string)=>{
  const path=String(url).replace('/api/rollup','');
  paths.push(path);
  empty=path.startsWith('/batches')&&Number(/from=(\d+)/.exec(path)?.[1])<batches?empty+1:0;
  if(empty>3)throw new Error('the wallet kept asking for pages after an empty one');
  const body=path==='/status'?status(batches,root,depositFee):path.startsWith('/batches')?{total:batches,batches:[]}:{};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 }) as unknown as typeof fetch;
 return {fetcher,paths};
}
const fetcherOf=(api:PoolApi)=>(async(url:string)=>{
 try{return new Response(JSON.stringify(await api(String(url).replace('/api/rollup',''))),{status:200});}
 catch(error){return new Response(JSON.stringify({error:(error as Error).message}),{status:(error as {status?:number}).status??404});}
}) as unknown as typeof fetch;
const opening=(o:{batches?:number;repository?:InMemoryShieldedNoteRepository;fetcher?:typeof fetch;secret?:string;bornAt?:number;onArkAddress?:(address:string)=>void;depositFee?:DepositFee;maxDepositFee?:DepositFeeSchedule;indexer?:object;networkPrivacy?:boolean;onSyncProgress?:SyncProgressObserver}={})=>
 ShieldedWallet.create({identity:SingleKey.fromHex(o.secret??'11'.repeat(32)),arkProvider:ark,indexerProvider:(o.indexer??indexer) as never,onchainProvider:onchain,
  storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},settlementConfig:false,walletMode:'static',
  pool:{origin:'',status:status(o.batches??0,undefined,o.depositFee)},secret:o.secret??'11'.repeat(32),hash,prover,
  fetcher:o.fetcher??poolFetcher(o.batches??0,undefined,o.depositFee).fetcher,networkPrivacy:o.networkPrivacy,onSyncProgress:o.onSyncProgress,...(o.repository?{shieldedRepository:o.repository}:{}),...(o.bornAt?{bornAt:o.bornAt}:{}),...(o.onArkAddress?{onArkAddress:o.onArkAddress}:{}),...(o.maxDepositFee?{maxDepositFee:o.maxDepositFee}:{})});
/** Start-up finished, which is what most tests assume; `opening` is for the few that watch it run. */
const open=async(o:Parameters<typeof opening>[0]={})=>{const wallet=await opening(o);await wallet.started;return wallet;};

// The spec's written-first test: the inherited factory must produce the subclass against the patched SDK.
test('ShieldedWallet.create returns a ShieldedWallet, which is also a Wallet',async()=>{
 const wallet=await open();
 try{
  assert.ok(wallet instanceof ShieldedWallet,'the patched `new this(` must construct the subclass');
  assert.ok(wallet instanceof Wallet,'and it is still a real SDK wallet');
  assert.ok(wallet.account instanceof EpochAccount);
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

test('ShieldedWallet.create announces its Arkade address once, before it reads the pool',async()=>{
 const {fetcher,paths}=poolFetcher(0),announced:{address:string;reads:number}[]=[];
 const wallet=await open({fetcher,onArkAddress:address=>announced.push({address,reads:paths.length})});
 try{assert.deepEqual(announced,[{address:await wallet.getAddress(),reads:0}]);}
 finally{await wallet.dispose();}
});

test('private startup reuses its supplied status once, but later account reloads read fresh status',async()=>{
 const {fetcher,paths}=poolFetcher(0),progress:Parameters<SyncProgressObserver>[0][]=[];
 const wallet=await open({fetcher,networkPrivacy:true,onSyncProgress:p=>{progress.push(p);}});
 try{
  assert.equal(paths.filter(path=>path==='/status').length,0);
  assert.ok(paths.some(path=>path.startsWith('/batches?from=0&')));
  assert.ok(progress.some(p=>p.stage==='verified'));
  paths.length=0;
  await (wallet as unknown as {load():Promise<void>}).load();
  assert.equal(paths.filter(path=>path==='/status').length,1);
 }finally{await wallet.dispose();}
});

test('private startup resumes a compatible saved snapshot without another status circuit',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),first=await open({repository,networkPrivacy:true});
 try{await first.save();}finally{await first.dispose();}
 const {fetcher,paths}=poolFetcher(0),second=await open({repository,networkPrivacy:true,fetcher});
 try{assert.equal(second.resumed,true);assert.equal(paths.filter(path=>path==='/status').length,0);}
 finally{await second.dispose();}
});

test('a disposed wallet does not publish delayed sync progress',async()=>{
 const served=poolFetcher(0),entered=deferred<void>(),release=deferred<void>(),progress:Parameters<SyncProgressObserver>[0][]=[];let hold=false;
 const fetcher=(async(url:string)=>{if(hold&&String(url).includes('/batches?')){entered.resolve();await release.promise;}return served.fetcher(url);}) as typeof fetch;
 const wallet=await open({fetcher,onSyncProgress:p=>{progress.push(p);}});
 hold=true;const pending=wallet.sync();
 try{
  await entered.promise;await wallet.dispose();const before=progress.length;
  release.resolve();await pending;
  assert.equal(progress.length,before);
 }finally{release.resolve();await pending;await wallet.dispose();}
});

test('ShieldedWallet.create starts its contract manager while it reads the pool',async()=>{
 let subscribed=()=>{},first=true,waited=false;const started=new Promise<void>(resolve=>{subscribed=resolve;});
 const {fetcher:pool}=poolFetcher(0),fetcher=(async(url:string)=>{if(first){first=false;waited=await Promise.race([started.then(()=>false),new Promise<boolean>(r=>setTimeout(()=>r(true),2000))]);}return pool(url);}) as unknown as typeof fetch;
 const wallet=await open({fetcher,indexer:{...indexer as object,subscribeForScripts:async()=>{subscribed();return 'sub';}}});
 try{assert.equal(waited,false,'the first pool read found the manager already subscribing');}
 finally{await wallet.dispose();}
});

test('ShieldedWallet.create resolves before a stalled watch setup finishes',async()=>{
 const gate=deferred<void>();let done=false;
 const wallet=await opening({indexer:{...indexer as object,subscribeForScripts:async()=>{await gate.promise;return 'sub';}}});
 const settled=wallet.started.then(()=>{done=true;});
 try{
  assert.deepEqual([wallet.batchCount(),wallet.shieldedBalance(),wallet.resumed],[0,0n,false],'the account is loaded and usable');
  await flush();assert.equal(done,false,'the watch setup is still waiting on the indexer');
  gate.resolve();await settled;assert.equal(done,true,'and `started` resolves once it is through');
 }finally{gate.resolve();await wallet.dispose();}
});

test('a watch setup that fails rejects started, not create, and leaves the watchdog armed',async t=>{
 const unhandled:unknown[]=[],note=(error:unknown)=>{unhandled.push(error);};process.on('unhandledRejection',note);
 t.mock.method(Wallet.prototype,'notifyIncomingFunds',async()=>{throw new Error('the indexer refused the funds watch');});
 const wallet=await opening();
 try{
  assert.ok((wallet as any).timer,'armed before the watch setup, so a failed setup still leaves a tick to retry');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(unhandled,[],'a caller that never reads `started` must not raise an unhandled rejection');
  await assert.rejects(wallet.started,/refused the funds watch/);
 }finally{process.off('unhandledRejection',note);await wallet.dispose();}
});

test('a wallet closed while its watch setup waits registers nothing once that setup resumes',async t=>{
 const entered=deferred<void>(),gate=deferred<void>();let off=0;
 t.mock.method(Wallet.prototype,'notifyIncomingFunds',async()=>{entered.resolve();await gate.promise;return ()=>{off++;};});
 const wallet=await opening();
 await entered.promise;await wallet.dispose();
 gate.resolve();await wallet.started;await flush();
 assert.deepEqual([off,(wallet as any).unwatch.length],[1,0],'the late incoming-funds watch was stopped, never kept');
});

test('self-native withdrawal keeps its SDK receipt while external withdrawals in the same batch remain visible',async t=>{
 const wallet=await open(),txid='cd'.repeat(32),assetId='ee'.repeat(34),field=assetFieldOfId(assetId);
 try{
  const address=await wallet.getAddress(),script=hex.encode(ArkAddress.decode(address).pkScript),nativeDestination=destinationFieldOf(programOf(address)),externalDestination=destinationFieldOf(new Uint8Array(32).fill(7)),manager=await wallet.getContractManager(),[contract]=await manager.getContracts({script});assert.ok(contract);
  t.mock.method(manager,'getContractsWithVtxos',async()=>[{contract,vtxos:[{txid,vout:0,value:1000,script,createdAt:new Date(2000),status:{isLeaf:false},isPreconfirmed:true,isSpent:false,isUnrolled:false,commitmentTxIds:[]}]}] as never);
  wallet.pool.status.pool!.reserves={[assetId]:'reserve'};wallet.account.txids.add(txid);
  const base={kind:'withdraw' as const,batch:3,epoch:0,txid,at:1000,spent:[7n],created:[]};
  wallet.account.history.push({...base,destination:nativeDestination,amounts:[{asset:0n,amount:1000n}],slots:[0]},
   {...base,destination:externalDestination,amounts:[{asset:0n,amount:2113n}],slots:[1]},
   {...base,destination:externalDestination,amounts:[{asset:field,amount:9n},{asset:0n,amount:330n}],slots:[2,3]});
  const items=await wallet.getActivityHistory();assert.equal(items.length,3);assert.deepEqual(items.map(item=>item.amount),[1000,-2113,-330]);assert.ok(items.every(item=>item.intent?.kind==='unshield'));
  assert.deepEqual(items[2]!.txs[0]!.assets,[{assetId,amount:9n}]);assert.deepEqual((await wallet.getActivityHistory()).map(item=>item.id),items.map(item=>item.id));
 }finally{await wallet.dispose();}
});

/** Stands in for the companion's fresh-key payouts: a new address per exit, and the coin only once the pool has paid. */
function exitPayouts(hrp='tark',serverPubKey=ArkAddress.decode(POOL_ADDRESS).serverPubKey){
 const log:string[]=[],views:unknown[]=[];let next=0,paid=false;
 const address=(n:number)=>new ArkAddress(serverPubKey,new Uint8Array(32).fill(n+1),hrp).encode();
 const exitPayout=async()=>{
  const n=next++,view={view:n};views.push(view);log.push(`reserve ${n}`);
  return {address:address(n),wallet:view as never,
   coin:async(value:number)=>paid?{...coin('cd'.repeat(32),value),vout:1} as never:undefined,
   release:async({spent}:{spent:boolean})=>{log.push(`release ${n} ${spent}`);}};
 };
 const swaps={exitPayout,markets:async()=>[],resolve:async()=>({eligible:1}),accept:async()=>{throw new Error('not accepted here');},onUpdate:()=>()=>{},[Symbol.asyncDispose]:async()=>{}};
 return {swaps:swaps as unknown as ShieldedWallet['swaps'],log,views,address,pay(){paid=true;}};
}
const exitHandle=()=>makeHandle('onchain',async emit=>{const result={railId:'onchain',txid:'ef'.repeat(32)};emit({status:'settled',result});return result;});
const DEST={to:'tb1qvfnn7k2a4xnr2vnjeadnknmjmvkppk3qp2rnkt',sats:1000};

test('an exit from the pool pays a fresh single-use key, holds auto-shield off, then exits that payout alone',async()=>{
 const wallet=await open(),withdrawn:[string,bigint][]=[],records:unknown[]=[],exited:unknown[][]=[],p=exitPayouts();
 let during=-1;
 wallet.swaps=p.swaps;
 (wallet as any).withdrawal=(to:string,amount:bigint,opts?:{record?:unknown})=>{withdrawn.push([to,amount]);records.push(opts?.record);p.log.push('withdraw');p.pay();return {settled:async()=>({railId:'shielded-withdraw',txid:'cd'.repeat(32)})};};
 const exit=async(c:unknown,view:unknown)=>{exited.push([c,view]);during=(wallet as any).nativeOperations;return exitHandle();};
 try{
  const result=await wallet.exitFromPool(1002,'Sending 1,000 sats on-chain',exit,DEST).settled();
  assert.deepEqual(records,[{to:DEST.to,onchainSats:1000,onchainTxid:'ef'.repeat(32)}],'the withdrawal records where the exit went, what arrived and its on-chain transaction');
  assert.deepEqual(withdrawn,[[p.address(0),1002n]],'the whole amount, to the fresh key and not to the funding address');
  assert.notEqual(p.address(0),await wallet.getAddress(),'the address deposits arrive at is never the payout');
  assert.deepEqual(p.log,['reserve 0','withdraw','release 0 true'],'the key is reserved before the withdrawal is submitted');
  assert.deepEqual([exited[0]![0],result.txid,during,(wallet as any).nativeOperations],[{...coin('cd'.repeat(32),1002),vout:1},'ef'.repeat(32),1,0]);
  assert.equal(exited[0]![1],p.views[0],'the payout signs with its own descriptor wallet, not the funding identity');
 }finally{await wallet.dispose();}
});

test('a second exit takes another fresh key, so no two exits share a payout address',async()=>{
 const wallet=await open(),withdrawn:string[]=[],p=exitPayouts();
 wallet.swaps=p.swaps;
 (wallet as any).withdrawal=(to:string)=>{withdrawn.push(to);p.pay();return {settled:async()=>({railId:'shielded-withdraw'})};};
 try{
  for(const i of [0,1])assert.equal((await wallet.exitFromPool(1002,`Exit ${i}`,async()=>exitHandle(),DEST).settled()).txid,'ef'.repeat(32));
  assert.deepEqual(withdrawn,[p.address(0),p.address(1)]);
  assert.equal(new Set([...withdrawn,await wallet.getAddress()]).size,3,'both payouts and the funding address are distinct');
 }finally{await wallet.dispose();}
});

test('an exit that fails after the payout keeps it registered for recovery and says so',async()=>{
 const wallet=await open(),records:unknown[]=[],p=exitPayouts();
 wallet.swaps=p.swaps;
 (wallet as any).withdrawal=(_to:string,_amount:bigint,opts?:{record?:unknown})=>{records.push(opts?.record);p.pay();return {settled:async()=>({railId:'shielded-withdraw'})};};
 try{
  await assert.rejects(wallet.exitFromPool(1002,'Again',async()=>{throw new Error('batch swap failed');},DEST).settled(),
   /after the pool paid 1,002 sats to a fresh single-use key: batch swap failed[\s\S]*shield back into the pool/);
  assert.deepEqual(p.log,['reserve 0','release 0 false'],'the unspent payout is handed back for auto-shielding');
  assert.deepEqual(records,[{to:DEST.to,onchainSats:1000}],'a failed exit records no on-chain transaction');
  assert.equal((wallet as any).nativeOperations,0);
 }finally{await wallet.dispose();}
});

test('a settled exit resolves and cleans up even when saving its transaction hangs',async()=>{
 const wallet=await open(),p=exitPayouts();
 wallet.swaps=p.swaps;
 (wallet as any).withdrawal=()=>{p.pay();return {settled:async()=>({railId:'shielded-withdraw'})};};
 (wallet as any).persist=()=>new Promise(()=>{});
 try{
  const outcome=await Promise.race([wallet.exitFromPool(1002,'Sending',async()=>exitHandle(),DEST).settled(),new Promise(r=>setTimeout(()=>r('hung'),2000))]);
  assert.deepEqual(outcome,{railId:'shielded-exit',txid:'ef'.repeat(32)});
  assert.deepEqual([p.log,(wallet as any).nativeOperations],[['reserve 0','release 0 true'],0]);
 }finally{await wallet.dispose();}
});

test('a tab that saved before an exit settled keeps the settled transaction when it saves again',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),a=await open({repository}),b=await open({repository});
 try{
  a.recordSent([[7n,{to:DEST.to,onchainSats:1000}]]);await a.save();await b.save();
  a.sentOf(7n)!.onchainTxid='ef'.repeat(32);await a.save();await b.save();
  const c=await open({repository});
  try{assert.deepEqual([b.sentOf(7n),c.sentOf(7n)].map(r=>r?.onchainTxid),['ef'.repeat(32),'ef'.repeat(32)]);}
  finally{await c.dispose();}
 }finally{await a.dispose();await b.dispose();}
});

test('a tab whose spend of the same note lost takes the settled exit whole, destination included',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),a=await open({repository}),b=await open({repository});
 const settled={to:DEST.to,onchainSats:1000,onchainTxid:'ef'.repeat(32)};
 try{
  a.recordSent([[7n,{to:DEST.to,onchainSats:1000}]]);await a.save();
  b.recordSent([[7n,{to:'tb1qq0ser',onchainSats:500}]]);await b.save();
  a.sentOf(7n)!.onchainTxid=settled.onchainTxid;await a.save();await b.save();
  const c=await open({repository});
  try{assert.deepEqual([b.sentOf(7n),c.sentOf(7n)],[settled,settled]);}
  finally{await c.dispose();}
 }finally{await a.dispose();await b.dispose();}
});

test('an exit refuses rather than fall back to the funding address when no fresh key is available',async()=>{
 const wallet=await open(),withdrawn:string[]=[];
 (wallet as any).withdrawal=(to:string)=>{withdrawn.push(to);return {settled:async()=>({railId:'shielded-withdraw'})};};
 try{
  assert.equal(wallet.canExitPrivately(),false);
  await assert.rejects(wallet.exitFromPool(1002,'No companion',async()=>exitHandle(),DEST).settled(),/needs the recoverable companion wallet/);
  const foreign=exitPayouts('ark');wallet.swaps=foreign.swaps;
  assert.equal(wallet.canExitPrivately(),true);
  await assert.rejects(wallet.exitFromPool(1002,'Foreign key',async()=>exitHandle(),DEST).settled(),/belongs to another Arkade server/);
  assert.deepEqual(withdrawn,[],'nothing leaves the pool on either refusal');
  assert.deepEqual(foreign.log,['reserve 0','release 0 false']);
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
 try{await first.account.apply(chainOnlyRecord('01'.repeat(32)));await first.save();}finally{await first.dispose();}
 const stored=await repository.getAccount(TOKEN);
 assert.ok(stored,'the snapshot is keyed by the pool token');
 assert.equal(stored!.account.v,2);
 const {fetcher,paths}=poolFetcher(1,String(first.account.latestRoot()));
 const second=await open({repository,fetcher});
 try{
  assert.equal(second.resumed,true);
  assert.equal(second.repositoryError,undefined);
  assert.equal(second.batchCount(),1,'the stored cursor, not a replay from zero');
  assert.deepEqual(paths,['/status','/batches?from=1&limit=50','/batches?from=1&limit=50'],'one status read checks the stored head, and only the sync after the watches follows');
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

test('a pool that stops answering after an online open leaves no live wallet behind',async()=>{
 const fetcher=(async(url:string)=>{if(!String(url).endsWith('/status'))throw new TypeError('fetch failed');return new Response(JSON.stringify(status(0)),{status:200});}) as unknown as typeof fetch;
 const dispose=ShieldedWallet.prototype.dispose;let disposed=0;
 ShieldedWallet.prototype.dispose=function(){disposed++;return dispose.call(this);};
 try{await assert.rejects(open({fetcher}),/fetch failed|did not answer/);}finally{ShieldedWallet.prototype.dispose=dispose;}
 assert.equal(disposed,1);
});

test('a wallet created while its pool is unreachable opens with the reason, and the first tick that reaches the pool checks it and catches up',async()=>{
 const fake=epochPool(hash,4),{keys,self}=shieldedKeysOf(hash,'11'.repeat(32)),repository=new InMemoryShieldedNoteRepository(),asked:string[]=[];let down=true;
 while(fake.state.batchCount<8)fake.land();
 // Born at batch 8, it replays from epoch 1 and learns that epoch's final root only on crossing into epoch 2.
 await repository.saveAccount(TOKEN,{v:2,token:TOKEN,account:(await epochFreshAccount(hash,keys,8,fake.api)).snapshot(),sent:{},listings:[],links:[]});
 fake.land('spend',[await fake.deposit(self,700n)]);
 const up=fetcherOf(fake.api),fetcher=(async(url:string)=>{if(down)throw new TypeError('fetch failed');asked.push(String(url).replace('/api/rollup',''));return up(url);}) as unknown as typeof fetch;
 const wallet=await open({repository,fetcher});
 try{
  clearTimeout((wallet as any).timer);
  assert.deepEqual([wallet.repositoryError,wallet.resumed,wallet.batchCount(),wallet.maxPrivatePayment()],['Opened without the pool, so the saved notes are unchecked: fetch failed',true,4,0n]);
  wallet.recordSent([[7n,{to:'shrol21offline'}]]);
  down=false;await (wallet as any).tick();await wallet.notes.pick(async()=>undefined,()=>[]);
  assert.deepEqual(asked.slice(0,4),['/status','/status','/batches?from=4&limit=50','/batches?from=9&limit=50'],'the tick, the resume check, then the tick\'s sync');
  assert.deepEqual([wallet.repositoryError,wallet.batchCount(),wallet.shieldedBalance(),wallet.maxPrivatePayment(),wallet.sentOf(7n)?.to],[undefined,9,700n,700n,'shrol21offline']);
 }finally{await wallet.dispose();}
});

/** 500 sats at batch 6 of a 4-batch pool, opened from their snapshot while the pool 404s; `drift` corrupts the saved previous-epoch root. */
const offlineWallet=async(drift=false,seen:(path:string)=>void=()=>{},networkPrivacy=false)=>{
 const fake=epochPool(hash,4),{keys,self}=shieldedKeysOf(hash,'11'.repeat(32)),repository=new InMemoryShieldedNoteRepository(),saved=EpochAccount.owning(hash,keys,{epochLen:4}),pool={down:true};
 fake.land('spend',[await fake.deposit(self,500n)]);
 while(fake.state.batchCount<6)fake.land();
 await epochCatchUp(saved,fake.api);
 await repository.saveAccount(TOKEN,{v:2,token:TOKEN,account:{...saved.snapshot(),...(drift?{prevNoteRoot:String(saved.prevNoteRoot()!+1n)}:{})},sent:{},listings:[],links:[]});
 const wallet=await open({repository,networkPrivacy,fetcher:fetcherOf((async(path:string)=>{if(pool.down)throw new Error('The pool did not answer.');seen(path);return fake.api(path);}) as PoolApi)});
 clearTimeout((wallet as any).timer);
 return {wallet,pool};
};

test('private offline startup retains a saved snapshot when supplied status has incompatible history metadata',async()=>{
 const {wallet}=await offlineWallet(false,()=>{},true);
 try{
  assert.equal(wallet.resumed,true);assert.equal(wallet.account.epochLen,4);assert.equal(wallet.batchCount(),6);
  assert.match(wallet.repositoryError!,/^Opened without the pool, so the saved notes are unchecked/);
 }finally{await wallet.dispose();}
});

test('once the pool answers, an offline wallet whose saved previous-epoch root drifted reports it and is not adopted',async()=>{
 const {wallet,pool}=await offlineWallet(true);
 try{
  const unchecked=wallet.account;
  assert.match(wallet.repositoryError!,/^Opened without the pool, so the saved notes are unchecked/);
  pool.down=false;await (wallet as any).tick();
  assert.match(wallet.repositoryError!,/drifted across a rotation/);
  assert.equal(wallet.account,unchecked);
  await assert.rejects((await wallet.pay(shieldedKeysOf(hash,'22'.repeat(32)).address,100n)).settled(),/drifted across a rotation/);
  assert.equal(wallet.inFlight.size,0);
 }finally{await wallet.dispose();}
});

test('until a tick checks it, an offline wallet builds no Lightning funding and no automatic shield deposit',async()=>{
 const {wallet}=await offlineWallet(),rows:unknown[]=[],announced:string[]=[];
 const journal={get:async()=>undefined,list:async()=>[],create:async(r:unknown)=>{rows.push(r);return r;},finish:async()=>{}} as never;
 const p=ArkAddress.decode(POOL_ADDRESS),htlc=new ArkAddress(p.serverPubKey,new Uint8Array(32).fill(9),p.hrp).encode();
 try{
  await assert.rejects(wallet.fundLightning('ln-1','33'.repeat(32),htlc,330n,journal),/Opened without the pool/);
  wallet.onAction(handle=>announced.push(handle.title));wallet.coins=async()=>[{txid:'aa'.repeat(32),vout:0,value:1000}];
  await (wallet as any).tick();await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual([rows,announced,wallet.inFlight.size],[[],[],0]);
 }finally{await wallet.dispose();}
});

test('a wallet closed while its reconnect check runs sends nothing more once the check returns',async()=>{
 const asked:string[]=[];let closing:Promise<void>|undefined;
 const {wallet,pool}=await offlineWallet(false,path=>{asked.push(path);if(path.startsWith('/batches'))closing??=wallet.dispose();});
 try{
  pool.down=false;await (wallet as any).tick();
  assert.deepEqual(asked,['/status','/status','/batches?from=6&limit=50']);
 }finally{await (closing??wallet.dispose());}
});

test('disposal stops the watchdog, so the process can exit',async()=>{
 const wallet=await open();
 const timer=(wallet as any).timer,statusTimer=(wallet as any).statusTimer;
 assert.ok(timer);assert.ok(statusTimer);
 await wallet.dispose();
 await wallet.dispose();
 assert.equal(timer._destroyed,true,'the watchdog was cancelled, not merely made inert');
 assert.equal(statusTimer._destroyed,true);
 assert.equal((wallet as any).timer,undefined);
 assert.equal((wallet as any).statusTimer,undefined);
 assert.equal(wallet.batchCount(),0);
});

const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const coin=(txid='aa'.repeat(32),value=500)=>({txid,vout:0,value});
const fakeSpend=()=>({witness:{slot:{root:0n,nullifiers:[1n],commitments:[2n,3n],ctDigest:4n,groupId:0n,groupSize:0},publicSignals:[],input:{}},slot:{anchor:0n,rCur:{epoch:0,root:0n},nullifiers:[1n],commitments:[2n,3n],ctDigest:4n,groupId:0n,groupSize:0},ciphertext:new Uint8Array(),change:0n} as unknown as EpochBuiltSpend);
function readyDeposit(wallet:ShieldedWallet){
 const requests:unknown[]=[];
 (wallet as any).depositCoin=async(txid:string,value:number)=>({...coin(txid,value),tapTree:'aa',leaf:'bb'});
 wallet.account.spend=async request=>{requests.push(request);return fakeSpend();};
 wallet.account.depositAsset=async()=>[fakeSpend(),fakeSpend()];
 return requests;
}

for(const asset of [false,true]){
 test(`${asset?'asset':'BTC'} shielding submits each reserved sibling outpoint`,async()=>{
  const wallet=await open(),a={...coin(),...(asset?{assets:[{assetId:TOKEN,amount:5n}]}:{}),tapTree:new Uint8Array([1]),intentTapLeafScript:[{},new Uint8Array([0x51,0xc0])]},b={...a,vout:1};
  const submitted:number[]=[];
  wallet.pool.status.pool!.reserves={[TOKEN]:'10'};
  wallet.getSpendableVtxos=async()=>[b,a] as never;
  (wallet as any).submit=async(members:SubmitMember[])=>{const vout=members[0]!.coin!.vout;submitted.push(vout);return {txid:String(vout)};};
  try{
   const one=(await wallet.shield([a]))!,two=(await wallet.shield([b]))!;
   assert.ok(one);assert.ok(two);assert.equal(await wallet.shield([a,b]),undefined);
   assert.deepEqual(new Set((wallet as any).used),new Set([`${a.txid}:0`,`${a.txid}:1`]));
   assert.deepEqual((await Promise.all([one.settled(),two.settled()])).map(result=>result.txid),['0','1']);
   assert.deepEqual(submitted.sort(),[0,1]);
  }finally{await wallet.dispose();}
 });

 test(`${asset?'asset':'BTC'} shielding waits for its exact output while an equal sibling is visible`,async()=>{
  const wallet=await open(),sibling={...coin(),...(asset?{assets:[{assetId:TOKEN,amount:5n}]}:{}),tapTree:new Uint8Array([1]),intentTapLeafScript:[{},new Uint8Array([0x51,0xc0])]},selected={...sibling,vout:1};
  let reads=0;const submitted:number[]=[];
  wallet.pool.status.pool!.reserves={[TOKEN]:'10'};
  wallet.getSpendableVtxos=async()=>{
   reads++;assert.deepEqual(submitted,[],'no deposit is submitted before the selected output appears');
   return (reads===1?[sibling]:[sibling,selected]) as never;
  };
  (wallet as any).submit=async(members:SubmitMember[])=>{submitted.push(members[0]!.coin!.vout);return {};};
  try{
   const handle=(await wallet.shield([selected]))!;assert.ok(handle);await handle.settled();
   assert.equal(reads,2);assert.deepEqual(submitted,[1]);
  }finally{await wallet.dispose();}
 });
}

test('consolidated shielding discovers an unknown output vout under its whole transaction reservation',async t=>{
 const wallet=await open(),a=coin('a'.repeat(64),200),b=coin('b'.repeat(64),300),output={...coin(),vout:3,tapTree:new Uint8Array([1]),intentTapLeafScript:[{},new Uint8Array([0x51,0xc0])]};
 let sent=false;const submitted:number[]=[];
 wallet.getSpendableVtxos=async()=>{
  if(sent){assert.ok((wallet as any).usedTxids.has(output.txid));return [output] as never;}
  return [a,b] as never;
 };
 t.mock.method(Wallet.prototype,'send',async()=>{sent=true;return output.txid;});
 (wallet as any).submit=async(members:SubmitMember[])=>{submitted.push(members[0]!.coin!.vout);return {};};
 try{
  const handle=(await wallet.shield([a,b]))!;assert.ok(handle);await handle.settled();
  assert.deepEqual(submitted,[3]);assert.equal(wallet.planFor([output],false),undefined);
 }finally{await wallet.dispose();}
});

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
  if(path.startsWith('/batches'))return {total:1,batches:[chainOnlyRecord(input.txid)]};
  posts++;throw new Error('payout submitted');
 }) as never;
 try{
  await (wallet as any).autoShield();await flush();
  assert.equal(wallet.isPoolPayout(input),true);assert.equal(posts,0);
  assert.equal((wallet as any).used.size,0);
 }finally{await wallet.dispose();}
});

const FEE=shieldedKeysOf(hash,'33'.repeat(32)),feeOf=(fixedSats:number,bps=0):DepositFee=>({fixedSats,bps,address:FEE.address});
const feeTo=(amount:bigint)=>({recipient:parseRollupAddress(FEE.address),amount});
/** A pool advertising `fee` that answers its first `refused` POSTs fee-missing and includes the rest. */
function feePool(fee?:DepositFee,refused=0){
 const bodies:EpochSpendBody[]=[],asked:string[]=[];
 const api=(async(path:string,body?:EpochSpendBody)=>{
  asked.push(path);
  if(path==='/status')return status(0,undefined,fee);
  if(path==='/spends'){bodies.push(body!);if(bodies.length<=refused)throw Object.assign(new Error('This deposit owes a deposit fee to this pool. Reload the page to shield at the current fee.'),{status:400,code:'fee-missing'});return {};}
  return path.startsWith('/spends/')?{status:'included',txid:'cc'.repeat(32)}:{total:0,batches:[]};
 }) as PoolApi;
 return {api,bodies,asked};
}
/** Undefined unless `promise` settles within `ms`, so a regression fails the test rather than hanging it. */
const within=<T,>(promise:Promise<T>,ms=3000)=>{let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([promise,new Promise<undefined>(resolve=>{timer=setTimeout(resolve,ms,undefined);})]).finally(()=>clearTimeout(timer));};

test('a deposit on a pool with a fee pays it to the fee address in output 0 and keeps the change',async()=>{
 const fee=feeOf(100),wallet=await open({depositFee:fee,maxDepositFee:fee}),pool=feePool(fee),requests:unknown[]=[];
 (wallet as any).depositCoin=async(txid:string,value:number)=>({...coin(txid,value),tapTree:'aa',leaf:'bb'});
 const spend=wallet.account.spend.bind(wallet.account);wallet.account.spend=async(request,...rest)=>{requests.push(request);return spend(request,...rest);};
 wallet.api=pool.api;
 try{
  await (await wallet.shield([coin('aa'.repeat(32),10_000)]))!.settled();
  assert.deepEqual(requests,[{deposit:10_000n,to:feeTo(100n)}]);
  const [body]=pool.bodies,record=hex.decode(body!.ciphertext),[paid]=await openRollupNotes(record,FEE.keys.viewSecret),[,change]=await openRollupNotes(record,shieldedKeysOf(hash,'11'.repeat(32)).keys.viewSecret);
  assert.deepEqual([body!.publics[3],paid?.amount,paid?.asset,change?.amount],['10000',100n,0n,9_900n]);
  assert.equal(noteOf(hash,ROLLUP_DOMAIN,paid!.amount,0n,FEE.self.owner,paid!.rho),BigInt(body!.slot.commitments[0]!),'output 0 commits to the fee note, as the operator checks');
 }finally{await wallet.dispose();}
});

test('a pool with no fee builds the same deposit as before',async()=>{
 const wallet=await open(),requests=readyDeposit(wallet),pool=feePool(),input=coin('aa'.repeat(32),10_000),deposited={...input,tapTree:'aa',leaf:'bb'};
 wallet.api=pool.api;
 try{
  await (await wallet.shield([input]))!.settled();
  assert.deepEqual(requests,[{deposit:10_000n}]);
  assert.deepEqual(pool.bodies,[epochTransferBody(pool.bodies[0]!.id,fakeSpend(),{pi_a:[],pi_b:[],pi_c:[]},{coin:deposited})]);
 }finally{await wallet.dispose();}
});

test('a deposit of a coin the pool paid out carries no fee',async()=>{
 const fee=feeOf(100),wallet=await open({depositFee:fee,maxDepositFee:fee}),requests=readyDeposit(wallet),payout=coin('ab'.repeat(32),400),plain=coin('cd'.repeat(32),10_000);
 wallet.account.txids.add(payout.txid);wallet.api=feePool(fee).api;
 try{
  assert.deepEqual([wallet.depositFeeOnPlan(wallet.planFor([payout],false)!),wallet.depositFeeOnPlan(wallet.planFor([plain])!)],[0n,100n],'what the page shows for each');
  assert.equal(await wallet.shield([coin('ef'.repeat(32),400)]),undefined,'a plain coin of the same 400 sats stays outside, since the fee would eat it');
  await (await wallet.shield([payout]))!.settled();
  assert.deepEqual(requests,[{deposit:400n}],'charged, 400 sats would net under the minimum');
 }finally{await wallet.dispose();}
});

test('the sheet of a deposit names the fee its plan pays, never the schedule, and reads as before when it pays none',async()=>{
 const fee=feeOf(100),charging=await open({depositFee:fee,maxDepositFee:fee}),free=await open(),payout=coin('ab'.repeat(32),400),plain=coin('cd'.repeat(32),10_000);
 const carried=(txid:string,value:number)=>({...coin(txid,value),assets:[{assetId:TOKEN,amount:5n}]});
 for(const wallet of [charging,free]){readyDeposit(wallet);wallet.api=feePool(wallet===charging?fee:undefined).api;wallet.pool.status.pool!.reserves={[TOKEN]:'10'};}
 charging.account.txids.add(payout.txid);
 const sheet=async(wallet:ShieldedWallet,input:{txid:string;vout:number;value:number}):Promise<[string,readonly string[]]>=>{const handle=(await wallet.shield([input]))!;await handle.settled();return [handle.title,handle.steps];};
 try{
  assert.deepEqual(await sheet(charging,plain),['Shielding 10,000 sats with a 100-sat deposit fee',shieldedSteps.shield]);
  assert.deepEqual(await sheet(charging,payout),['Shielding 400 sats',shieldedSteps.shield],'a pool payout pays none, so the sheet names none');
  assert.deepEqual(await sheet(charging,carried('a1'.repeat(32),1000)),['Shielding 5 units of asset 2df7aa36…0000 with a 100-sat deposit fee',shieldedSteps.shield],'the carrier pays');
  assert.deepEqual(await sheet(charging,carried('a2'.repeat(32),330)),['Shielding 5 units of asset 2df7aa36…0000',shieldedSteps.shield],'a dust carrier is free');
  assert.deepEqual(await sheet(free,plain),['Shielding 10,000 sats',shieldedSteps.shield],'a pool with no fee');
  assert.deepEqual(await sheet(free,carried('a3'.repeat(32),1000)),['Shielding 5 units of asset 2df7aa36…0000',shieldedSteps.shield]);
 }finally{await charging.dispose();await free.dispose();}
});

test('an asset deposit pays the carrier fee on its BTC leg, and nothing on a dust carrier',async()=>{
 const fee=feeOf(100),wallet=await open({depositFee:fee,maxDepositFee:fee}),carriers:unknown[]=[];
 try{
  const [,carrier]=await wallet.account.depositAsset(assetFieldOfId(TOKEN),5n,1000n,wallet.self,feeTo(100n));
  assert.equal((await openRollupNotes(carrier.ciphertext,FEE.keys.viewSecret))[0]?.amount,100n,'the carrier leg\'s output 0 is the fee note');
  readyDeposit(wallet);wallet.api=feePool(fee).api;wallet.pool.status.pool!.reserves={[TOKEN]:'10'};
  wallet.account.depositAsset=async(...args)=>{carriers.push(args[4]);return [fakeSpend(),fakeSpend()];};
  for(const [txid,value] of [['a1'.repeat(32),1000],['a2'.repeat(32),330]] as const)await (await wallet.shield([{...coin(txid,value),assets:[{assetId:TOKEN,amount:5n}]}]))!.settled();
  assert.deepEqual(carriers,[feeTo(100n),undefined]);
 }finally{await wallet.dispose();}
});

test('an asset deposit on a pool with no fee builds both legs as before',async()=>{
 const wallet=await open(),requests=readyDeposit(wallet);
 wallet.account.depositAsset=EpochAccount.prototype.depositAsset;wallet.api=feePool().api;wallet.pool.status.pool!.reserves={[TOKEN]:'10'};
 try{
  await (await wallet.shield([{...coin('a1'.repeat(32),1000),assets:[{assetId:TOKEN,amount:5n}]}]))!.settled();
  assert.deepEqual((requests as {dummy?:unknown}[]).map(({dummy:_,...request})=>request),[{asset:assetFieldOfId(TOKEN),deposit:5n},{deposit:1000n}]);
 }finally{await wallet.dispose();}
});

test('an asset group refused for its fee is rebuilt once with the carrier fee, and freed when refused again',async()=>{
 for(const refusals of [1,Infinity]){
  const fee=feeOf(100),wallet=await open({depositFee:fee,maxDepositFee:fee}),carriers:unknown[]=[],posts:EpochSpendBody[]=[],input={...coin('a1'.repeat(32),1000),assets:[{assetId:TOKEN,amount:5n}]};
  readyDeposit(wallet);wallet.pool.status.pool!.reserves={[TOKEN]:'10'};wallet.account.txids.add(input.txid);
  wallet.account.depositAsset=async(...args)=>{carriers.push(args[4]);return [fakeSpend(),fakeSpend()];};
  let refused=0;
  // The carrier completes the unit, so it is the member the pool refuses; the asset member before it was admitted.
  wallet.api=(async(path:string,body?:EpochSpendBody)=>{
   if(path==='/status')return status(0,undefined,fee);
   if(path==='/spends'){posts.push(body!);if(!body!.asset&&refused++<refusals)throw Object.assign(new Error('Its group does not carry the deposit fee it owes; rebuild the group with the fee.'),{status:400,code:'fee-missing'});return {};}
   return path.startsWith('/spends/')?{status:'included',txid:'cc'.repeat(32)}:{total:0,batches:[]};
  }) as never;
  try{
   const settled=(await wallet.shield([input]))!.settled();
   if(refusals===1)assert.equal((await settled).txid,'cc'.repeat(32));else{await assert.rejects(settled,/deposit fee/);await flush();}
   assert.deepEqual([carriers,posts.map(p=>p.asset)],[[undefined,feeTo(100n)],[TOKEN,undefined,TOKEN,undefined]],'both members, then the group once more with the fee');
   if(refusals!==1)assert.equal((wallet as any).used.has(`${input.txid}:0`),false,'refused again, the coin is free');
  }finally{await wallet.dispose();}
 }
});

test('auto-shield pauses when the advertised fee exceeds the accepted one, and resumes once the shown fee is accepted',async()=>{
 const wallet=await open({depositFee:feeOf(100)}),requests=readyDeposit(wallet),pool=feePool(feeOf(500)),input=coin('aa'.repeat(32),10_000),resumed=deferred<ShieldedPaymentHandle>();
 clearTimeout((wallet as any).timer);
 try{
  assert.deepEqual(wallet.depositFeePaused,feeOf(100),'a wallet that accepted nothing pauses on any fee');
  await wallet.acceptDepositFee(feeOf(100));await flush();
  assert.deepEqual([wallet.acceptedDepositFee,wallet.depositFeePaused],[{fixedSats:100,bps:0},undefined]);
  wallet.api=pool.api;
  await (wallet as any).tick();clearTimeout((wallet as any).timer);
  assert.deepEqual(wallet.depositFeePaused,feeOf(500));
  wallet.coins=async()=>[input];wallet.onAction(h=>resumed.resolve(h));
  assert.equal(await (wallet as any).autoShield(),undefined);await flush();
  assert.deepEqual([pool.bodies.length,requests.length],[0,0],'paused: nothing built or submitted');
  await assert.rejects(wallet.shield([input]),/500 sats.*acceptDepositFee\(\{fixedSats:500,bps:0\}\).*maxDepositFee/);
  await wallet.acceptDepositFee(feeOf(100));await flush();
  assert.deepEqual([wallet.depositFeePaused,pool.bodies.length],[feeOf(500),0],'a banner the tick made stale accepts only what it showed');
  await wallet.acceptDepositFee(feeOf(500));
  await (await within(resumed.promise))!.settled();
  assert.deepEqual([requests,pool.bodies.length],[[{deposit:10_000n,to:feeTo(500n)}],1]);
 }finally{await wallet.dispose();}
});

test('a fee-missing refusal refreshes the schedule and rebuilds the deposit once, with the fee',async()=>{
 const fee=feeOf(100),wallet=await open({depositFee:fee,maxDepositFee:fee}),requests=readyDeposit(wallet),pool=feePool(fee,1),payout=coin('ab'.repeat(32),10_000);
 wallet.account.txids.add(payout.txid);wallet.api=pool.api;
 try{
  assert.equal((await (await wallet.shield([payout]))!.settled()).txid,'cc'.repeat(32));
  assert.deepEqual(requests,[{deposit:10_000n},{deposit:10_000n,to:feeTo(100n)}],'the wallet took the coin for its payout and the pool did not, so the rebuild pays');
  assert.deepEqual(pool.asked.filter(p=>p==='/spends'||p==='/status'),['/spends','/status','/spends']);
 }finally{await wallet.dispose();}
});

test('a fee-missing rebuild submits nothing when the new fee is not accepted or eats the deposit, and frees the coin',async()=>{
 for(const [value,advertised,refusal] of [[10_000,feeOf(500),/acceptDepositFee/],[400,feeOf(100),/330-sat minimum after its 100-sat deposit fee/]] as const){
  const wallet=await open({maxDepositFee:feeOf(100)}),requests=readyDeposit(wallet),pool=feePool(advertised,Infinity),input=coin('aa'.repeat(32),value);
  wallet.api=pool.api;
  try{
   await assert.rejects((await wallet.shield([input]))!.settled(),refusal);await flush();
   assert.deepEqual([pool.bodies.length,requests.length],[1,1],'the one refused deposit, and no rebuild');
   assert.equal((wallet as any).used.has(`${input.txid}:0`),false,'the coin is free again');
  }finally{await wallet.dispose();}
 }
});

const PAUSED_500='Deposits are paused: this pool now charges a deposit fee of 500 sats or 0 bps of the deposit, whichever is more, which is above what this wallet has accepted. Once it is shown, accept it with acceptDepositFee({fixedSats:500,bps:0}), or pass maxDepositFee of at least that.';

test('the fee-paused refusal keeps its message, carries a stable code through a rebuild\'s wrapping, and the page hears of the pause',async()=>{
 const wallet=await open({maxDepositFee:feeOf(100)}),requests=readyDeposit(wallet),pool=feePool(feeOf(500),Infinity),input=coin('aa'.repeat(32),10_000),heard:(number|undefined)[]=[];
 clearTimeout((wallet as any).timer);wallet.api=pool.api;wallet.onShieldedChange(()=>heard.push(wallet.depositFeePaused?.fixedSats));
 try{
  const failure:any=await (await wallet.shield([input]))!.settled().catch((error:unknown)=>error);await flush();
  assert.equal(failure.message,PAUSED_500);
  assert.equal(failure.cause.code,'fee-paused','the reservation wraps it; the code is on its cause');
  assert.ok(heard.includes(500),'the refresh that left deposits paused told the page');
  assert.equal(heard[0],500,'and it did so before anything else did');
  assert.equal(requests.length,1,'the rebuild built nothing');
  await assert.rejects(wallet.shield([input]),error=>(error as {code?:string}).code==='fee-paused'&&(error as Error).message===PAUSED_500);
 }finally{await wallet.dispose();}
});

test('a status refresh tells the page only when the paused fee changes',async()=>{
 const wallet=await open({maxDepositFee:feeOf(100)}),heard:(number|undefined)[]=[];
 clearTimeout((wallet as any).timer);wallet.onShieldedChange(()=>heard.push(wallet.depositFeePaused?.fixedSats));
 const refresh=async(fee?:DepositFee)=>{wallet.api=feePool(fee).api;await (wallet as any).refreshStatus();};
 try{
  await refresh();await refresh(feeOf(100));
  assert.deepEqual(heard,[],'no fee, then one already accepted: nothing paused before or after');
  await refresh(feeOf(500));await refresh(feeOf(500));
  assert.deepEqual(heard,[500],'newly paused once, not again for the same fee');
  await refresh(feeOf(500,10));
  assert.deepEqual(heard,[500,500],'a bps-only change reaches the page');
  await refresh(feeOf(900));await refresh(feeOf(100));
  assert.deepEqual(heard,[500,500,900,undefined],'a different fee to accept, then back within what was accepted');
 }finally{await wallet.dispose();}
});

test('an auto-shield stopped by a raised fee reaches the sheet in the page\'s words, with the pause already in the wallet',async()=>{
 const wallet=await open({maxDepositFee:feeOf(100)}),input=coin('aa'.repeat(32),10_000),seen:[boolean,string|undefined][]=[],started=deferred<ShieldedPaymentHandle>();
 readyDeposit(wallet);clearTimeout((wallet as any).timer);wallet.api=feePool(feeOf(500),Infinity).api;wallet.coins=async()=>[input];
 const sheet=pageSheet(state=>seen.push([!!wallet.depositFeePaused,state?.error]));
 wallet.onAction(handle=>{sheet.watch(handle,handle.title);started.resolve(handle);});
 try{
  await (wallet as any).autoShield();
  await (await within(started.promise))!.settled().catch(()=>{});await flush();
  assert.deepEqual(seen.slice(-2),[[true,PAUSED_500],[true,PAUSED_ERROR]],'the handle\'s own failure with the banner already due, then the page\'s words');
 }finally{await wallet.dispose();}
});

test('accepting the fee a rebuild stopped on shields at once, without the retry wait',async()=>{
 const wallet=await open({maxDepositFee:feeOf(100)}),requests=readyDeposit(wallet),pool=feePool(feeOf(500),1),input=coin('aa'.repeat(32),10_000),resumed=deferred<ShieldedPaymentHandle>();
 clearTimeout((wallet as any).timer);wallet.api=pool.api;wallet.coins=async()=>[input];
 try{
  const stopped=(await wallet.shield([input]))!;
  await assert.rejects(stopped.settled(),/acceptDepositFee/);await flush();
  assert.ok((wallet as any).retryAt>Date.now(),'a failed shield holds auto-shield off for a while');
  wallet.onAction(h=>{if(h!==stopped)resumed.resolve(h);});
  await wallet.acceptDepositFee(feeOf(500));
  await (await within(resumed.promise))!.settled();
  assert.deepEqual(requests,[{deposit:10_000n},{deposit:10_000n,to:feeTo(500n)}]);
 }finally{await wallet.dispose();}
});

test('the accepted fee schedule survives a reopen and merges upward across tabs',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),fee=feeOf(500),a=await open({repository,depositFee:fee});
 try{
  await a.acceptDepositFee(fee);
  const b=await open({repository,depositFee:fee});
  try{
   assert.deepEqual([b.acceptedDepositFee,b.depositFeePaused],[{fixedSats:500,bps:0},undefined]);
   await repository.saveAccount(TOKEN,{...(await repository.getAccount(TOKEN))!,feeAccepted:{fixedSats:100,bps:30}});
   await b.save();await a.save();
   assert.deepEqual([b.acceptedDepositFee,a.acceptedDepositFee,(await repository.getAccount(TOKEN))!.feeAccepted],[{fixedSats:500,bps:30},{fixedSats:500,bps:30},{fixedSats:500,bps:30}],'neither tab lowers what the other accepted');
  }finally{await b.dispose();}
 }finally{await a.dispose();}
});

test('a stored or configured fee ceiling that is not a whole, in-range schedule is never trusted',async()=>{
 for(const bad of [{fixedSats:1.5,bps:0},{fixedSats:100,bps:10_001},{fixedSats:-1,bps:0}])await assert.rejects(open({maxDepositFee:bad}).then(wallet=>wallet.dispose()),/maxDepositFee/,JSON.stringify(bad));
 const zero=await open({maxDepositFee:{fixedSats:0,bps:0},depositFee:feeOf(100)});
 try{
  await assert.rejects(zero.acceptDepositFee({fixedSats:-1,bps:0}),/accepted schedule must be/);
  assert.deepEqual([zero.acceptedDepositFee,zero.depositFeePaused],[{fixedSats:0,bps:0},feeOf(100)]);
 }finally{await zero.dispose();}
 for(const bad of [{fixedSats:'500',bps:0},{fixedSats:null,bps:0},{fixedSats:100,bps:10_001},'all']){
  const repository=new InMemoryShieldedNoteRepository(),first=await open({repository});
  try{await first.save();}finally{await first.dispose();}
  await repository.saveAccount(TOKEN,{...(await repository.getAccount(TOKEN))!,feeAccepted:bad as never});
  const wallet=await open({repository,depositFee:feeOf(100)});
  try{
   assert.deepEqual([wallet.resumed,wallet.acceptedDepositFee,wallet.depositFeePaused],[true,undefined,feeOf(100)],JSON.stringify(bad));
   await wallet.save();assert.equal((await repository.getAccount(TOKEN))!.feeAccepted,undefined);
  }finally{await wallet.dispose();}
 }
});

test('merge can be asked to consolidate down to a single note, and never past it',async()=>{
 const wallet=await open(),lone=await open();
 try{
  await fundPrivate(wallet,[{amount:400n},{amount:500n}]);await fundPrivate(lone,[{amount:400n}]);
  wallet.prover={prove:async()=>{throw new Error('not proving here');}};
  assert.equal(await wallet.merge(BTC_ASSET),undefined,'two notes are under the default threshold');
  for(const above of [0,-1,Number.NaN])assert.equal(await lone.merge(BTC_ASSET,above),undefined,`one note has nothing to merge with (above ${above})`);
  const handle=await wallet.merge(BTC_ASSET,1);
  assert.equal(handle?.title,'Merging two notes');await assert.rejects(handle!.settled(),/not proving here/);
 }finally{await wallet.dispose();await lone.dispose();}
});

test('accepting a lower schedule never lowers the one already accepted',async()=>{
 const wallet=await open({depositFee:feeOf(500)});
 try{
  await wallet.acceptDepositFee(feeOf(500));await wallet.acceptDepositFee(feeOf(100));
  assert.deepEqual([wallet.acceptedDepositFee,wallet.depositFeePaused],[{fixedSats:500,bps:0},undefined]);
 }finally{await wallet.dispose();}
});

test('accepting a fee rejects when its own save fails, though the acceptance holds for the session',async()=>{
 const repository=new InMemoryShieldedNoteRepository(),fee=feeOf(500),wallet=await open({repository,depositFee:fee});let changes=0;
 try{
  repository.saveAccount=async()=>{throw new Error('disk full');};wallet.onShieldedChange(()=>{changes++;});
  await assert.rejects(wallet.acceptDepositFee(fee),/disk full/);
  assert.deepEqual([wallet.acceptedDepositFee,wallet.depositFeePaused,(await repository.getAccount(TOKEN))?.feeAccepted,changes],[{fixedSats:500,bps:0},undefined,undefined,1],'the page still hears of the acceptance it can use');
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
  const body=path==='/status'?status(0):path.startsWith('/batches')?{total:0,batches:[]}:path.startsWith('/spends/')?{status:'included',txid:'cc'.repeat(32)}:{};
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
  for(const outcome of ['proof','dropped','stale-anchor']){
   wallet.notes.inFlight.add(3n);
   wallet.prover={prove:async()=>{if(outcome==='proof')throw new Error('proof');return {pi_a:[],pi_b:[],pi_c:[]};}};
   wallet.api=(async(path:string)=>{
    if(path!=='/spends')return {status:'dropped',reason:'dropped'};
    if(outcome==='stale-anchor')throw Object.assign(new Error('stale-anchor'),{status:400,code:'stale-anchor'});
    return {};
   }) as never;
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
 (wallet as any)._buildAndSubmitOffchainTx=async()=>({arkTxid:output.txid,signedCheckpointTxs:[]}) as never;
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
 (wallet as any)._buildAndSubmitOffchainTx=async()=>{entered.resolve();return transport.promise;};
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
 for(const name of ['send','settle','sendSelectedVtxosToSelf'] as const)t.mock.method(Wallet.prototype,name,async()=>{submitted++;return 'native';});
 const attempts=(selected:typeof input)=>[
  ()=>wallet.send({recipients:[{address:POOL_ADDRESS,amount:330}],selectedVtxos:[selected] as never}),
  ()=>wallet.settle({inputs:[selected] as never,outputs:[]}),
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
 const cases:[keyof Wallet,unknown[],()=>Promise<string>][]=[
  ['send',[send],()=>wallet.send(send)],['settle',[settle],()=>wallet.settle(settle)],
  ['sendSelectedVtxosToSelf',[[input],now],()=>wallet.sendSelectedVtxosToSelf([input] as never,now)],
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

async function fundPrivate(wallet:ShieldedWallet,notes:{amount:bigint;asset?:bigint}[]){
 const deposits=await Promise.all(notes.map(n=>wallet.account.spend({deposit:n.amount,asset:n.asset},wallet.self))),pool=epochPool(hash,EPOCH_LEN);
 await wallet.account.apply(pool.land('spend',deposits.map(posted)));
 return pool;
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

test('the router sends a Bitcoin address out of the pool when one note covers it, and refuses without a fresh key',async()=>{
 const wallet=await open(),raw=bech32.encode('tb',[0,...bech32.toWords(new Uint8Array(20).fill(1))]);
 try{
  await fundPrivate(wallet,[{amount:500n}]);
  await assert.rejects(wallet.router().route({raw,amount:500}),/needs the recoverable companion wallet/,'no companion, no exit: never the funding address');
  wallet.swaps=exitPayouts().swaps;
  assert.equal((await wallet.router().route({raw,amount:500})).railId,'shielded-exit');
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
 const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository}),proof=deferred<void>(),started=deferred<EpochBuiltSpend>();
 let published:RollupEpochRecord|undefined;
 wallet.prover={joinReady:()=>true,prove:async(built,circuit)=>{assert.equal(circuit,'join');started.resolve(built);await proof.promise;return {pi_a:[],pi_b:[],pi_c:[]};}};
 wallet.api=(async(path:string)=>{
  if(path==='/spends')return {};
  if(path.startsWith('/spends/'))return {status:'included',txid:'ef'.repeat(32)};
  const batches=published?[published]:[];published=undefined;
  return {total:2,batches};
 }) as never;
 try{
  const pool=await fundPrivate(wallet,[{amount:400n},{amount:500n}]);
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
  published=pool.land('join',[posted(built)]);proof.resolve();await first.settled();await flush();
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
      assert.equal(body!.publics[4],action==='withdraw'?(posts===0?'40':'400'):'400');
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
  const barrier=epochCatchUp(wallet.account,(async()=>{await resume.promise;return {total:1,batches:[]};}) as never);
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

for(const failure of ['none','fetch','apply'] as const)test(`sync checkpoints complete pages with ${failure} failure`,async()=>{
 const repository=new InMemoryShieldedNoteRepository(),wallet=await open({repository});
 const batches=Array.from({length:123},(_,i)=>chainOnlyRecord(String(i+1)));
 if(failure==='apply'){batches[51]=chainOnlyRecord('malformed');batches[51].slots[0]!.nullifiers=['not a field'];}
 const save=repository.saveAccount.bind(repository),read=repository.getAccount.bind(repository),saved:number[]=[],requested:number[]=[];
 let reads=0,changed=0;
 repository.getAccount=async token=>{reads++;return read(token);};
 repository.saveAccount=async(token,snapshot)=>{saved.push(snapshot.account.batch);await save(token,snapshot);};
 wallet.onShieldedChange(()=>{changed++;});
 (wallet as any).api=async(path:string)=>{
  const from=Number(/from=(\d+)/.exec(path)![1]);requested.push(from);
  if(failure==='fetch'&&from===50)throw new Error('next page failed');
  return {total:batches.length,batches:batches.slice(from,from+50)};
 };
 try{
  if(failure==='none')await wallet.sync();else await assert.rejects(wallet.sync(),failure==='fetch'?/next page failed/:/BigInt/);
  assert.deepEqual(saved,failure==='none'?[50,100,123]:[50]);
  assert.equal(reads,saved.length,'one repository merge read per checkpoint');
  assert.equal(changed,failure==='none'?1:0);
  const stored=(await read(TOKEN))!.account;
  assert.equal(stored.batch,failure==='none'?123:50);
  assert.equal(wallet.batchCount(),failure==='none'?123:failure==='fetch'?50:51);
  if(failure==='apply'){
   assert.ok(wallet.account.txids.has('51')&&!wallet.account.txids.has('malformed'),'the live account is past the stored page, and the rejected record left nothing in it');
   assert.ok(!stored.txids.includes('malformed'));assert.ok(!stored.txids.includes('51'));
  }
  const root=EpochAccount.fromSnapshot(hash,shieldedKeysOf(hash,'11'.repeat(32)).keys,stored,EPOCH_LEN).latestRoot();
  const reopened=await open({repository,fetcher:poolFetcher(stored.batch,String(root)).fetcher});
  try{
   assert.equal(reopened.resumed,true);assert.deepEqual(reopened.account.snapshot(),stored);
   if(failure==='none')assert.deepEqual(reopened.account.snapshot(),wallet.account.snapshot());
  }finally{await reopened.dispose();}
  if(failure==='none'){
   const before=reads;await wallet.sync();assert.equal(reads,before);assert.deepEqual(saved,[50,100,123]);assert.equal(changed,1);
   assert.deepEqual(requested,[0,50,100,123]);
  }
 }finally{await wallet.dispose();}
});

/** One pool several wallets share: posted spends join the next batch, which the first poll closes; a reused nullifier is refused as the operator would. */
function sharedPool(){
 const pool=epochPool(hash,EPOCH_LEN);let queued:PoolSpend[]=[];
 const api=(async(path:string,body?:EpochSpendBody)=>{
  if(path==='/spends'){
   const used=new Set([...pool.records.flatMap(r=>r.slots.flatMap(s=>s.nullifiers)),...queued.flatMap(q=>q.slot.nullifiers.map(String))]);
   if(body!.slot.nullifiers.some(nf=>used.has(nf)))throw Object.assign(new Error('The note is already spent or pending.'),{status:400,code:'double-spend'});
   const {slot,publics,ciphertext}=fromBody(body!);queued.push({slot,publics,ciphertext});return {id:body!.id,status:'pending'};
  }
  if(path.startsWith('/spends/')){if(queued.length){pool.land(queued[0]!.slot.nullifiers.length===2?'join':'spend',queued);queued=[];}return {status:'included',txid:pool.records.at(-1)!.txid};}
  return pool.api(path);
 }) as PoolApi;
 return {api,records:pool.records,
  async fund(wallet:ShieldedWallet,notes:{amount:bigint;asset?:bigint}[]){
   const deposits=await Promise.all(notes.map(n=>wallet.account.spend({deposit:n.amount,asset:n.asset},wallet.self)));
   pool.land('spend',deposits.map(posted));await wallet.sync();
  }};
}
const listed=(wallet:ShieldedWallet)=>{wallet.pool={...wallet.pool,status:{...status(0),pool:{...status(0).pool!,reserves:{[TOKEN]:'100'}}}};};

test('a claim link goes to whoever claims it first, and its minter sees it claimed',async()=>{
 const pool=sharedPool(),alice=await open(),bob=await open({secret:'22'.repeat(32)}),carol=await open({secret:'33'.repeat(32)});
 for(const w of [alice,bob,carol])w.api=pool.api;
 try{
  await pool.fund(alice,[{amount:600n},{amount:500n}]);
  await (await alice.pay(bob.shieldedAddress(),50n)).settled();
  assert.deepEqual(alice.links(),[],'an ordinary private payment is not a link');
  await (await alice.mintLink(1000n)).settled();
  const [link]=alice.links();
  assert.deepEqual([link!.state,link!.amount,link!.asset,link!.batch,alice.links().length],['unclaimed','1000','0',2,1]);
  assert.match(link!.token,/^shnote21/);
  const seen=await bob.inspectLink(link!.token);
  assert.deepEqual([seen.mine,seen.notes.reduce((sum,n)=>sum+n.amount,0n)],[false,1000n]);
  assert.equal((await alice.inspectLink(link!.token)).mine,true);
  for(const code of ['double-spend','group-invalid']){
   carol.api=(async(path:string,body?:unknown)=>path==='/spends'?Promise.reject(Object.assign(new Error('Refused by the pool.'),{status:400,code})):pool.api(path,body)) as PoolApi;
   await assert.rejects((await carol.claimLink(link!.token)).settled(),/Someone claimed this link first/,code);
  }
  await (await bob.claimLink(link!.token)).settled();
  const [a,b,...pads]=pool.records.at(-1)!.slots;
  assert.ok(a!.groupSize===2&&b!.groupSize===2&&a!.groupId===b!.groupId&&a!.groupId!=='0'&&pads.every(s=>s.groupId==='0'&&!s.ciphertext),'bob\'s claim landed as one group, and the rest of the batch is padding');
  assert.equal(bob.shieldedBalance(),1050n);
  await alice.sync();
  assert.equal(alice.links()[0]!.state,'claimed');
  carol.api=pool.api;
  await assert.rejects((await carol.claimLink(link!.token)).settled(),/empty or already claimed/);
  await assert.rejects(bob.inspectLink('shnote21qqqq'),/Not a claim link/);
 }finally{for(const w of [alice,bob,carol])await w.dispose();}
});

test('a minter takes an asset link back, and the phrase alone rebuilds the link list',async()=>{
 const pool=sharedPool(),repository=new InMemoryShieldedNoteRepository(),alice=await open({repository});alice.api=pool.api;listed(alice);
 try{
  await pool.fund(alice,[{amount:40n,asset:assetFieldOfId(TOKEN)},{amount:500n}]);
  await (await alice.mintLink(9n,TOKEN)).settled();
  const [link]=alice.links();
  assert.deepEqual([link!.asset,link!.amount],[String(assetFieldOfId(TOKEN)),'9']);
  const handle=await alice.claimLink(link!.token);
  assert.equal(handle.title,'Taking back a link');
  await handle.settled();
  assert.deepEqual([alice.links()[0]!.state,alice.shieldedBalance(assetFieldOfId(TOKEN))],['taken-back',40n]);
  const resumed=await open({repository,fetcher:fetcherOf(pool.api)});
  try{assert.deepEqual([resumed.resumed,resumed.links().map(l=>[l.key,l.state])],[true,[[link!.key,'taken-back']]],'a resumed wallet keeps its links');}finally{await resumed.dispose();}
  const restored=await open();restored.api=pool.api;
  try{await restored.sync();assert.deepEqual(restored.links().map(l=>[l.key,l.state,l.token]),[[link!.key,'taken-back',link!.token]]);}finally{await restored.dispose();}
 }finally{await alice.dispose();}
});

test('saving keeps what another tab has already seen of a link',async()=>{
 const pool=sharedPool(),repository=new InMemoryShieldedNoteRepository(),alice=await open({repository});alice.api=pool.api;
 try{
  await pool.fund(alice,[{amount:500n}]);
  await (await alice.mintLink(100n)).settled();
  const stored=(await repository.getAccount(TOKEN))!;
  await repository.saveAccount(TOKEN,{...stored,links:stored.links!.map(l=>({...l,open:[],tookBack:true}))});
  await alice.save();
  assert.deepEqual([alice.links().map(l=>l.state),(await repository.getAccount(TOKEN))!.links!.map(l=>[l.open,l.tookBack])],[['taken-back'],[[[],true]]]);
 }finally{await alice.dispose();}
});

test('a link claimed while its minter was closed shows claimed once the reopened wallet is checked against the pool',async()=>{
 const pool=sharedPool(),repository=new InMemoryShieldedNoteRepository(),alice=await open({repository}),bob=await open({secret:'22'.repeat(32)});
 alice.api=pool.api;bob.api=pool.api;
 try{
  await pool.fund(alice,[{amount:500n}]);
  await (await alice.mintLink(100n)).settled();
  const [link]=alice.links();await alice.dispose();
  await (await bob.claimLink(link!.token)).settled();
  const reopened=await open({repository,fetcher:fetcherOf(pool.api)});
  try{assert.deepEqual([reopened.resumed,reopened.links().map(l=>l.state)],[true,['claimed']]);}finally{await reopened.dispose();}
 }finally{await alice.dispose();await bob.dispose();}
});

test('a snapshot an older client saved without links is replayed, so the link list comes back',async()=>{
 const pool=sharedPool(),repository=new InMemoryShieldedNoteRepository(),alice=await open({repository});alice.api=pool.api;
 try{
  await pool.fund(alice,[{amount:500n}]);
  await (await alice.mintLink(100n)).settled();
  const {links:_,...old}=(await repository.getAccount(TOKEN))!;
  await repository.saveAccount(TOKEN,old);
  const reopened=await open({repository});
  try{
   reopened.api=pool.api;await reopened.sync();
   assert.deepEqual([reopened.resumed,reopened.links().map(l=>l.key)],[false,alice.links().map(l=>l.key)]);
  }finally{await reopened.dispose();}
 }finally{await alice.dispose();}
});

test('saving never merges another key\'s links or sends',async()=>{
 const pool=sharedPool(),repository=new InMemoryShieldedNoteRepository(),alice=await open({repository});alice.api=pool.api;
 try{
  await pool.fund(alice,[{amount:500n}]);
  const stored=(await repository.getAccount(TOKEN))!;
  await repository.saveAccount(TOKEN,{...stored,account:{...stored.account,owner:'1'},sent:{'9':{to:'x'}},links:[{key:'5',batch:0,asset:'0',amount:'1',nullifiers:['6'],open:['6']}]});
  await alice.save();
  assert.deepEqual([alice.links(),alice.sentOf(9n),(await repository.getAccount(TOKEN))!.links],[[],undefined,[]]);
 }finally{await alice.dispose();}
});

test('a mint the pool drops lists no link and frees its notes',async()=>{
 const pool=sharedPool(),alice=await open();alice.api=pool.api;
 try{
  await assert.rejects((await alice.mintLink(0n)).settled(),/above zero/);
  await pool.fund(alice,[{amount:500n}]);
  alice.api=(async(path:string,body?:unknown)=>path.startsWith('/spends/')?{status:'dropped',reason:'The batch builder refused it.'}:pool.api(path,body)) as PoolApi;
  await assert.rejects((await alice.mintLink(100n)).settled(),/refused/);
  await flush();
  assert.deepEqual([alice.links(),alice.inFlight.size],[[],0]);
 }finally{await alice.dispose();}
});

test('a wallet started from a checkpoint watches for links in the batches it catches up while loading',async t=>{
 const world=epochLeafPool(hash,EPOCH_LEN,70);
 const fetcher=(async(url:string)=>{
  try{return new Response(JSON.stringify(await world.api(String(url).replace('/api/rollup',''))),{status:200});}
  catch{return new Response('{}',{status:404});}
 }) as unknown as typeof fetch;
 const watched:number[]=[],watch=(ShieldedWallet.prototype as any).watchLinks;
 t.mock.method(ShieldedWallet.prototype as any,'watchLinks',function(this:ShieldedWallet,number:number,...rest:unknown[]){watched.push(number);return watch.call(this,number,...rest);});
 const wallet=await open({fetcher,bornAt:66});
 try{assert.deepEqual([watched,world.asked.filter(p=>p.startsWith('/batches?from=0')),wallet.batchCount()],[[64,65,66,67,68,69],[],70]);}
 finally{await wallet.dispose();}
});

test('a pool that stops answering is reported after two missed refreshes, with the head expiry the indexer shows',async t=>{
 const wallet=await open(),expires=Date.parse('2026-10-20T12:00:00Z'),down=()=>wallet.operatorDown;let up=true,lookups=0;
 clearTimeout((wallet as any).timer);
 wallet.api=(async(path:string)=>{if(!up)throw new Error('fetch failed');return path==='/status'?status(0):{total:0,batches:[]};}) as never;
 (wallet as any).indexerProvider={...(indexer as object),getVtxos:async()=>{lookups++;return {vtxos:[{txid:'cd'.repeat(32),vout:0,value:330,assets:[{assetId:'ee'.repeat(34),amount:5n}]},{txid:'ab'.repeat(32),vout:0,value:1000,assets:[{assetId:TOKEN,amount:1n}],expiresAt:new Date(expires)}],page:undefined};}};
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 try{
  up=false;await (wallet as any).tick();
  assert.equal(down(),undefined,'one missed refresh is not an outage');
  t.mock.timers.tick(2*WATCHDOG_MS);await (wallet as any).tick();
  assert.equal(down()?.headExpiresAt,expires,'the token-carrying coin is the head');
  await (wallet as any).tick();
  assert.equal(lookups,1,'the expiry is looked up once per outage');
  up=true;await (wallet as any).tick();
  assert.equal(down(),undefined,'an answer clears it');
 }finally{t.mock.timers.reset();await wallet.dispose();}
});

test('an outage whose head expiry cannot be found is still looked up only once, and the banner falls back',async t=>{
 const wallet=await open(),down=()=>wallet.operatorDown;let lookups=0;
 clearTimeout((wallet as any).timer);
 wallet.api=(async()=>{throw new Error('fetch failed');}) as never;
 // The head is gone (expired and swept), so the indexer returns no token-carrying coin.
 (wallet as any).indexerProvider={...(indexer as object),getVtxos:async()=>{lookups++;return {vtxos:[{txid:'cd'.repeat(32),vout:0,value:330,assets:[{assetId:'ee'.repeat(34),amount:5n}]}],page:undefined};}};
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 try{
  t.mock.timers.tick(2*WATCHDOG_MS);await (wallet as any).tick();
  assert.equal(down()?.headExpiresAt,undefined,'no head coin means no deadline to show');
  await (wallet as any).tick();await (wallet as any).tick();
  assert.equal(lookups,1,'an unavailable expiry is not retried every tick');
 }finally{t.mock.timers.reset();await wallet.dispose();}
});

test('public status stays fresh while the watchdog waits for private catch-up',async t=>{
 const wallet=await open(),pending=deferred<number>();let reads=0,syncs=0,upkeep=0,notifications=0;
 assert.equal(await epochMatchesPool(wallet.account,wallet.api),true);
 clearTimeout((wallet as any).timer);clearTimeout((wallet as any).statusTimer);
 wallet.api=(async()=>{reads++;return status(0);}) as PoolApi;
 wallet.onShieldedChange(()=>{notifications++;});
 t.mock.method(wallet,'sync',()=>{syncs++;return pending.promise;});
 t.mock.method(wallet as any,'finishStart',async()=>{});
 for(const method of ['autoShield','merge','renewNotes','recoverNotes'])t.mock.method(wallet as any,method,async()=>{upkeep++;});
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 try{
  await wallet.start();
  for(let i=0;i<4;i++){t.mock.timers.tick(WATCHDOG_MS);await flush();}
  assert.equal(wallet.operatorDown,undefined,'a responsive pool is not reported stale');
  assert.ok(reads>=3,'public status checks continue during the same private sync');
  assert.ok(notifications>=3,'the page receives heartbeat updates before catch-up finishes');
  assert.equal(syncs,1,'history work does not accumulate behind the blocked sync');
  assert.equal(upkeep,0,'financial upkeep still waits for the existing sync');
 }finally{pending.resolve(0);await flush();await wallet.dispose();t.mock.timers.reset();}
});

test('maintenance and heartbeat share a status read whose late result cannot revive a disposed wallet',async t=>{
 const wallet=await open(),pending=deferred<RollupPoolStatus>(),before=wallet.pool.status,since=(wallet as any).statusAt;let reads=0,changes=0,upkeep=0;
 clearTimeout((wallet as any).timer);clearTimeout((wallet as any).statusTimer);
 (wallet as any).headExpiry=123;
 wallet.api=(async()=>{reads++;return pending.promise;}) as PoolApi;
 t.mock.method(wallet,'changed',()=>{changes++;});
 for(const method of ['autoShield','merge','renewNotes','recoverNotes'])t.mock.method(wallet as any,method,async()=>{upkeep++;});
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const maintenance=(wallet as any).tick(),heartbeat=(wallet as any).statusTick();
 try{
  await flush();assert.equal(reads,1);
  await wallet.dispose();pending.resolve(status(1));await Promise.all([maintenance,heartbeat]);
  assert.equal(wallet.pool.status,before);assert.equal((wallet as any).statusAt,since);
  assert.equal((wallet as any).headExpiry,123);assert.equal(changes,0);assert.equal(upkeep,0);
  assert.equal((wallet as any).timer,undefined);assert.equal((wallet as any).statusTimer,undefined);
  t.mock.timers.tick(4*WATCHDOG_MS);await flush();assert.equal(reads,1);
 }finally{pending.resolve(status(0));await Promise.allSettled([maintenance,heartbeat]);await wallet.dispose();t.mock.timers.reset();}
});

test('a fee refresh prevents a late expiry lookup from replacing newer status',async t=>{
 const wallet=await open(),pending=deferred<number>();let up=false,notifications=0;
 clearTimeout((wallet as any).timer);clearTimeout((wallet as any).statusTimer);
 wallet.api=(async(path:string)=>{if(!up)throw new Error('fetch failed');return path==='/status'?status(0):{total:0,batches:[]};}) as PoolApi;
 t.mock.method(wallet as any,'fetchHeadExpiry',()=>pending.promise);
 wallet.onShieldedChange(()=>{notifications++;});
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 try{
  t.mock.timers.tick(2*WATCHDOG_MS);
  const maintenance=(wallet as any).tick();await flush();
  up=true;await (wallet as any).refreshStatus();
  assert.equal(notifications,1,'recovering stale status notifies before the older lookup finishes');
  pending.resolve(123);await maintenance;
  assert.equal(wallet.operatorDown,undefined);assert.equal((wallet as any).headExpiry,undefined);
 }finally{pending.resolve(123);await wallet.dispose();t.mock.timers.reset();}
});

test('a fee refresh waits for an older heartbeat then reads the post-refusal status',async()=>{
 const wallet=await open(),older=deferred<RollupPoolStatus>(),fresh=deferred<RollupPoolStatus>();let reads=0,finished=false;
 clearTimeout((wallet as any).timer);clearTimeout((wallet as any).statusTimer);
 wallet.api=(async()=>++reads===1?older.promise:fresh.promise) as PoolApi;
 const heartbeat=(wallet as any).refreshPoolStatus(),fee=(wallet as any).refreshStatus().then(()=>{finished=true;});
 try{
  await flush();assert.equal(reads,1,'the fee refresh waits for the pre-refusal read');
  older.resolve(status(0,undefined,feeOf(100)));await heartbeat;await flush();
  assert.equal(reads,2);assert.equal(finished,false);assert.equal(wallet.depositFee?.fixedSats,100);
  fresh.resolve(status(0,undefined,feeOf(500)));await fee;
  assert.equal(wallet.depositFee?.fixedSats,500);
 }finally{older.resolve(status(0));fresh.resolve(status(0));await Promise.allSettled([heartbeat,fee]);await wallet.dispose();}
});

test('a fee refresh waiting for an older heartbeat rejects when the wallet closes',async()=>{
 const wallet=await open(),older=deferred<RollupPoolStatus>(),before=wallet.pool.status;let reads=0;
 clearTimeout((wallet as any).timer);clearTimeout((wallet as any).statusTimer);
 wallet.api=(async()=>{reads++;return older.promise;}) as PoolApi;
 const heartbeat=(wallet as any).refreshPoolStatus(),fee=(wallet as any).refreshStatus().then(()=>undefined,(error:Error)=>error);
 try{
  await flush();await wallet.dispose();older.resolve(status(0,undefined,feeOf(500)));await heartbeat;
  assert.match((await fee)?.message??'resolved',/wallet was closed/);
  assert.equal(reads,1);assert.equal(wallet.pool.status,before);
 }finally{older.resolve(status(0));await Promise.allSettled([heartbeat,fee]);await wallet.dispose();}
});
