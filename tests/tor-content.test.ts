import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {DefaultVtxo,SingleKey,Wallet} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import type {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {BATCH_SLOTS,ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import type {RollupEpochRecord,RollupEpochRecordSlot} from '../packages/protocol/src/rollup/epoch-record.ts';
import {ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {EVENT_RETRY_MS,WATCHDOG_MS,epochCatchUp,type EpochBatchPage} from '../src/shielded/epoch-sync.ts';
import type {ShieldedSyncProgress} from '../src/shielded/sync-progress.ts';
import {epochSyncAccount} from '../src/shielded/epoch-pool.ts';
import {walletSyncProgressLabel} from '../app/src/wallet-opening-progress.ts';
import {SHIELD_FLOOR_MS,ShieldedWallet,loadAccount} from '../src/shielded/wallet.ts';
import {lightningRails} from '../src/shielded/lightning.ts';
import {waitForSpend,type ArkCoin,type PoolApi,type RollupPoolStatus} from '../src/shielded/pool.ts';
import {PRIVATE_SUBMIT_JITTER_MS,markPrivateFetch,markPrivatePoolPage,markSealedFetch,privatePoolPage,isPrivateFetch,isPrivatePoolApi,isSealedFetch} from '../src/shielded/network-privacy.ts';
import type {SubmitDeps} from '../src/shielded/submit.ts';
import {PRIVATE_PAGE,PRIVATE_SHIELD_COINS} from '../src/shielded/private-transport.ts';
import {ANSWER_BYTES} from '../src/rollup/nostr-carrier.ts';
import {epochLeafPool} from './fixtures/epoch-pool.ts';
import {NATIVE_GRACE_MS,makeNativeMutationJournal,reconcileJournal} from '../src/native/mutations.ts';
import {decodeClaimToken,encodeClaimToken} from '../packages/protocol/src/rollup/bearer.ts';

const privateApi=(api:PoolApi)=>Object.assign(api,{[Symbol.for('shielded.private.pool-api')]:true});
const fakeHistory=(cursor:number,total:number,epochLen=128,page?:number)=>{
 const asked:string[]=[],applied:number[]=[],records=Array.from({length:total},(_,n)=>n as unknown as RollupEpochRecord);
 let batchCount=cursor;
 const account={get batchCount(){return batchCount;},epochLen,canSkip:true,async apply(batch:RollupEpochRecord){assert.equal(batch as unknown as number,batchCount);applied.push(batchCount++);}} as unknown as EpochAccount;
 const api=privateApi((async(path:string)=>{
  asked.push(path);const url=new URL(path,'https://pool.test');assert.equal(url.pathname,'/batches');
  const from=Number(url.searchParams.get('from')),limit=Number(url.searchParams.get('limit'));
  return {total,batches:records.slice(from,from+limit)};
 }) as PoolApi);
 return {account,api:page===undefined?api:markPrivatePoolPage(api,page),asked,applied};
};

test('private catch-up reads complete aligned pages and applies unseen batches with their true cursors',async()=>{
 const {account,api,asked,applied}=fakeHistory(83,135),callbacks:number[]=[];
 assert.equal(await epochCatchUp(account,api,cursor=>{callbacks.push(cursor);}),52);
 assert.deepEqual(asked,['/batches?from=0&limit=50','/batches?from=50&limit=50','/batches?from=100&limit=28','/batches?from=128&limit=50']);
 assert.deepEqual(applied,Array.from({length:52},(_,n)=>83+n));
 assert.deepEqual(callbacks,applied.map(n=>n+1));
});

test('private catch-up never uses scan or matching-batch fetches when far behind',async()=>{
 const {account,api,asked}=fakeHistory(7,600);
 assert.equal(await epochCatchUp(account,api),593);
 assert.ok(asked.every(path=>path.startsWith('/batches?')));
 assert.ok(asked.every(path=>!path.endsWith('limit=1')));
 assert.equal(asked[0],'/batches?from=0&limit=50');
 assert.equal(account.batchCount,600);
});

test('private history progress still downloads complete pages for a caught-up account, and counts none of them as work',async()=>{
 const {account,api,asked,applied}=fakeHistory(127,127),progress:ShieldedSyncProgress[]=[];
 await epochCatchUp(account,api,undefined,undefined,undefined,p=>{progress.push(p);});
 assert.deepEqual(progress.filter(p=>p.stage==='history'),[
  {stage:'history',from:127,through:127},
  {stage:'history',from:127,through:127,total:127},
  {stage:'history',from:127,through:127,total:127},
  {stage:'history',from:127,through:127,total:127},
 ]);
 assert.deepEqual(asked,['/batches?from=0&limit=50','/batches?from=50&limit=50','/batches?from=100&limit=28']);
 assert.deepEqual(applied,[]);
 assert.ok(!progress.some(p=>p.stage==='verified'));
});

test('private history progress follows advancing public totals without skipping aligned reads',async()=>{
 const {account,api,asked}=fakeHistory(90,101),progress:ShieldedSyncProgress[]=[];let page=0;
 const advancing=privateApi((async(path:string)=>({...await api<EpochBatchPage>(path),total:++page===1?80:101})) as PoolApi);
 await epochCatchUp(account,advancing,undefined,undefined,undefined,p=>{progress.push(p);});
 assert.deepEqual(progress.filter(p=>p.stage==='history'),[
  {stage:'history',from:90,through:90},
  {stage:'history',from:90,through:90,total:80},
  {stage:'history',from:90,through:100,total:101},
  {stage:'history',from:90,through:101,total:101},
 ]);
 assert.equal(account.batchCount,101);
 assert.deepEqual(asked,['/batches?from=0&limit=50','/batches?from=50&limit=50','/batches?from=100&limit=28']);
});

test('the opening label counts only what a resumed account still has to apply, and all of it for a fresh one',async()=>{
 const label=(o:ReturnType<typeof fakeHistory>)=>{const lines:string[]=[];return {lines,run:epochCatchUp(o.account,o.api,undefined,undefined,undefined,p=>{lines.push(walletSyncProgressLabel(p));})};};
 const resumed=label(fakeHistory(90,101));await resumed.run;
 assert.equal(resumed.lines.at(-1),'Reading private pool history · 99% · 11 of 11 updates');
 assert.ok(!resumed.lines.some(line=>line.includes('of 101 updates')),`never the batches it already holds: ${resumed.lines.join(' | ')}`);
 const fresh=label(fakeHistory(0,101));await fresh.run;
 assert.equal(fresh.lines.at(-1),'Reading private pool history · 99% · 101 of 101 updates');
});

test('a failing history observer cannot stop or change private batch replay',async()=>{
 const {account,api,applied}=fakeHistory(125,127);
 assert.equal(await epochCatchUp(account,api,undefined,undefined,undefined,()=>{throw new Error('view closed');}),2);
 assert.equal(account.batchCount,127);assert.deepEqual(applied,[125,126]);
});

test('private epochSyncAccount follows the same aligned history path',async()=>{
 const {account,api,asked,applied}=fakeHistory(129,135);
 await epochSyncAccount(account,api);
 assert.deepEqual(asked,['/batches?from=128&limit=50']);
 assert.deepEqual(applied,[129,130,131,132,133,134]);
});

test('a truncated private page cannot force a tagged follow-up cursor',async()=>{
 const {account}=fakeHistory(83,135),asked:string[]=[];
 const api=privateApi((async(path:string)=>{asked.push(path);return {total:135,batches:[0 as unknown as RollupEpochRecord]};}) as PoolApi);
 await assert.rejects(epochCatchUp(account,api),/incomplete page/);
 assert.deepEqual(asked,['/batches?from=0&limit=50']);
 assert.equal(account.batchCount,83);
});

test('a private catch-up pages at the size its pool api carries, and the default stays 50',async()=>{
 const sized=fakeHistory(0,40,128,12),plain=fakeHistory(0,40,128);
 assert.equal(await epochCatchUp(sized.account,sized.api),40);
 assert.deepEqual(sized.asked,[0,12,24,36].map(from=>`/batches?from=${from}&limit=12`));
 await epochCatchUp(plain.account,plain.api);
 assert.deepEqual(plain.asked,['/batches?from=0&limit=50']);
});

test('a private page never crosses an epoch boundary',async()=>{
 const {account,api,asked}=fakeHistory(120,135,128,12);
 await epochCatchUp(account,api);
 assert.deepEqual(asked.slice(-3),['/batches?from=108&limit=12','/batches?from=120&limit=8','/batches?from=128&limit=12']);
});

test('a size outside 1 to 100 reads back as 50, and a branded one as itself',()=>{
 for(const size of [0,-1,1.5,101,NaN,Infinity,2**53])assert.equal(privatePoolPage(markPrivatePoolPage(()=>{},size)),50,String(size));
 assert.deepEqual([1,12,100].map(size=>privatePoolPage(markPrivatePoolPage(()=>{},size))),[1,12,100]);
 assert.equal(privatePoolPage(()=>{}),50);assert.equal(privatePoolPage(undefined),50);
});

test('a re-wrapped private pool api keeps its page size, and create keeps the shield cap',async t=>{
 const sizes:(number|undefined)[]=[],sentinel=new Error('creation inspected'),wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  stopped:false,unwatch:[],changeListeners:new Set(),actionListeners:new Set(),getContractManager:async()=>({}),getAddress:async()=>'unused',
  async load(this:{api:PoolApi;claimApi:PoolApi;maxShieldCoins?:number}){sizes.push(privatePoolPage(this.api),privatePoolPage(this.claimApi),this.maxShieldCoins);throw sentinel;},
 }) as ShieldedWallet;
 t.mock.method(Wallet,'create',async()=>wallet as never);t.mock.method(Wallet.prototype,'dispose',async()=>{});
 const fetcher=markPrivateFetch((async()=>Response.json({})) as typeof fetch);
 await assert.rejects(ShieldedWallet.create({identity:undefined as never,pool:{origin:'https://pool.test',status:{pool:{token:'pool',script:'5120',address:'unused'}} as never},secret:'11'.repeat(32),hash:()=>1n,prover:undefined as never,fetcher,claimFetch:fetcher,networkPrivacy:true,poolPage:12,maxShieldCoins:PRIVATE_SHIELD_COINS}),error=>error===sentinel);
 assert.deepEqual(sizes,[12,12,PRIVATE_SHIELD_COINS]);
});

test('a worst-case page of 12 batches stays inside the gateway answer cap',()=>{
 const f='9'.repeat(String(ROLLUP_FIELD).length),slot:RollupEpochRecordSlot={anchor:f,rCur:{epoch:99_999,root:f},nullifiers:[f,f],commitments:[f,f],ctDigest:f,groupId:f,groupSize:10,publics:Array(7).fill(f),ciphertext:'f'.repeat(2*ROLLUP_RECORD_BYTES)};
 const record:RollupEpochRecord={kind:'spend',slots:Array(BATCH_SLOTS).fill(slot),noteBlockRoot:f,txid:'f'.repeat(64),at:1_700_000_000_000};
 const page=(n:number)=>JSON.stringify({from:0,total:n,batches:Array(n).fill(record)}).length,cap=ANSWER_BYTES;
 assert.ok(page(PRIVATE_PAGE)<=cap,String(page(PRIVATE_PAGE)));assert.ok(page(16)>cap,String(page(16)));
});

test('private fresh account avoids a birthday checkpoint and verifies the same final root',async()=>{
 const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),{api,asked}=epochLeafPool(hash,256,140);
 const loaded=await loadAccount(hash,keys,{token:'g2',epochLen:256,bornAt:130,api:privateApi(api)});
 assert.equal(loaded.account.batchCount,140);
 assert.equal(loaded.offline,undefined);
 assert.ok(!asked.some(path=>path.startsWith('/checkpoints/')));
 assert.ok(asked.includes('/batches?from=0&limit=50'));
 assert.ok(!asked.some(path=>path.includes('from=130')));
});


test('a fresh private account can reuse initial status while replaying and verifying every public page',async()=>{
 const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),{api,asked}=epochLeafPool(hash,256,140),status=await api<RollupPoolStatus>('/status');
 status.pool!.token='g2';asked.length=0;
 const progress:ShieldedSyncProgress[]=[],loaded=await loadAccount(hash,keys,{token:'g2',epochLen:256,bornAt:130,api:privateApi(api),status,onSyncProgress:p=>{progress.push(p);}});
 assert.equal(loaded.account.batchCount,140);assert.equal(loaded.offline,undefined);
 assert.deepEqual(asked,['/batches?from=0&limit=50','/batches?from=50&limit=50','/batches?from=100&limit=50']);
 assert.deepEqual(progress.at(-1),{stage:'verified',through:140,total:140});
});

test('native bearer inspection and claim use a separate private history capability',async()=>{
 const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const {api,asked}=epochLeafPool(hash,256,140),token=encodeClaimToken({secret:new Uint8Array(32).fill(7),batch:130});
 const wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  hash,claimApi:privateApi(api),api:async()=>{throw new Error('ordinary wallet history must not be used');},
  mine:()=>({decoded:decodeClaimToken(token),mine:false}),mergeableAssets:()=>[0n],assertOpen:()=>{},announce:(handle:unknown)=>handle,
 }) as ShieldedWallet;
 assert.deepEqual(await wallet.inspectLink(token),{notes:[],mine:false});
 await assert.rejects((await wallet.claimLink(token)).settled(),/empty or already claimed/);
 assert.ok(asked.some(path=>path.startsWith('/batches?from=0')));
 assert.ok(!asked.some(path=>path.startsWith('/checkpoints/')));
});

test('private wallet startup keeps the public pool script out of the wallet watch',async()=>{
 const watched:string[]=[],events:string[]=[],wallet={
  networkPrivacy:true,poolScript:'public-pool-script',stopped:false,unwatch:[] as (()=>void)[],
  async getContractManager(){return {watchScript:async(script:string)=>{watched.push(script);},onContractEvent:()=>()=>{}};},
  async notifyIncomingFunds(){events.push('own-funds');return ()=>{};},async autoShield(){events.push('shield');},
 };
 await (ShieldedWallet.prototype as unknown as {finishStart(this:typeof wallet):Promise<void>}).finishStart.call(wallet);
 assert.deepEqual(watched,[]);
 assert.deepEqual(events,['own-funds','shield']);
});

test('private wallet watchdog reads public status independently of private item watches',async()=>{
 const asked:string[]=[],wallet=Object.assign(Object.create(ShieldedWallet.prototype),{stopped:false,offline:false,pool:{origin:'https://pool.test',status:{}},statusAt:0,statusRevision:0,headExpiry:undefined,
  api:async(path:string)=>{asked.push(path);return {phase:'ready'};},async sync(){return 0;},async autoShield(){},async merge(){},async renewNotes(){},async recoverNotes(){},changed(){this.stopped=true;},
 });
 await (ShieldedWallet.prototype as unknown as {tick(this:typeof wallet):Promise<void>}).tick.call(wallet);
 assert.deepEqual(asked,['/status']);
});

const stub=()=>(async()=>Response.json({})) as typeof fetch,sealedStub=()=>markSealedFetch(markPrivateFetch(stub())),nativeStub=()=>markPrivateFetch(stub());
const tickRig=(held:number,reported:number,fetcher:typeof fetch)=>{
 const asked:string[]=[],ran:string[]=[],pool={batches:reported},networkPrivacy=isPrivateFetch(fetcher);let batchCount=held;
 const account={get batchCount(){return batchCount;},epochLen:128,async apply(batch:number){assert.equal(batch,batchCount++);}};
 const plain=(async(path:string)=>{
  asked.push(path);const url=new URL(path,'https://pool.test');
  if(url.pathname==='/status')return {phase:'ready',pool:{batches:pool.batches}};
  const from=Number(url.searchParams.get('from')),limit=Number(url.searchParams.get('limit'));
  return {total:pool.batches,batches:Array.from({length:Math.max(0,Math.min(limit,pool.batches-from))},(_,n)=>from+n)};
 }) as PoolApi;
 const wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  stopped:false,offline:false,networkPrivacy,sealedTransport:isSealedFetch(fetcher),pool:{origin:'https://pool.test',status:{}},statusAt:0,statusReadAt:0,statusRevision:0,headExpiry:undefined,account,api:networkPrivacy?markPrivatePoolPage(privateApi(plain),12):plain,
  watchLinks(){},async shield(){ran.push('shield');},async merge(){},async renewNotes(){ran.push('renew');},async recoverNotes(){ran.push('recover');},changed(){this.stopped=true;},
 });
 // changed() stops the wallet, or tick() would arm its 60 s timer.
 const tick=async()=>{wallet.stopped=false;await (ShieldedWallet.prototype as unknown as {tick(this:typeof wallet):Promise<void>}).tick.call(wallet);await flush();};
 return {asked,ran,pool,account,wallet,tick,pages:()=>asked.filter(path=>path.startsWith('/batches'))};
};
const timers=(t:TestContext)=>{const armed:{ms:number;run:()=>void}[]=[];t.mock.method(globalThis,'setTimeout',((run:()=>void,ms:number)=>armed.push({ms,run})) as never);return armed;};
const spread=(t:TestContext)=>{let n=0;t.mock.method(Math,'random',()=>(++n%9+1)/10);};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('a sealed tick reads no batch page while the pool reports the count the account already holds, nor does its auto-shield',async()=>{
 const {asked,pages,ran,tick}=tickRig(140,140,sealedStub());
 await tick();
 assert.ok(asked.includes('/status'));assert.deepEqual(pages(),[]);
 assert.deepEqual(ran.toSorted(),['recover','renew','shield']);
});

test('a sealed tick syncs as soon as the pool count moves, including across an epoch rotation',async()=>{
 const {asked,pages,pool,account,tick}=tickRig(127,127,sealedStub());
 // 128 closes epoch 0 (epochLen 128); 130 is two batches into epoch 1.
 pool.batches=128;await tick();
 assert.equal(account.batchCount,128);assert.equal(pages().at(-1),'/batches?from=120&limit=8');
 asked.length=0;pool.batches=130;await tick();
 assert.equal(account.batchCount,130);assert.deepEqual(pages(),['/batches?from=128&limit=12']);
});

test('a direct tick still syncs on every tick, and so does its auto-shield',async()=>{
 const {pages,tick}=tickRig(140,140,stub());
 await tick();await tick();
 assert.deepEqual(pages(),Array(4).fill('/batches?from=140&limit=50'));
});

test('a native tick, private but not sealed, still syncs at equal counts, and so does its auto-shield',async()=>{
 const {pages,tick}=tickRig(140,140,nativeStub());
 await tick();
 assert.deepEqual(pages(),Array(2).fill('/batches?from=128&limit=12'));
});

test('create marks only a sealed pool fetcher as a sealed transport',async t=>{
 const seen:unknown[]=[],sentinel=new Error('creation inspected'),wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  stopped:false,unwatch:[],changeListeners:new Set(),actionListeners:new Set(),getContractManager:async()=>({}),getAddress:async()=>'unused',
  async load(this:{sealedTransport:boolean}){seen.push(this.sealedTransport);throw sentinel;},
 }) as ShieldedWallet;
 t.mock.method(Wallet,'create',async()=>wallet as never);t.mock.method(Wallet.prototype,'dispose',async()=>{});
 for(const fetcher of [sealedStub(),nativeStub(),stub()])await assert.rejects(ShieldedWallet.create({identity:undefined as never,pool:{origin:'https://pool.test',status:{pool:{token:'pool',script:'5120',address:'unused'}} as never},secret:'11'.repeat(32),hash:()=>1n,prover:undefined as never,fetcher,networkPrivacy:isPrivateFetch(fetcher)}),error=>error===sentinel);
 assert.deepEqual(seen,[true,false,false]);
});

test('a sealed wallet re-draws its watchdog and status intervals every round, and a direct or native one keeps them at 60 s',async t=>{
 spread(t);const armed=timers(t),proto=ShieldedWallet.prototype as unknown as {start(this:unknown):Promise<void>;statusTick(this:unknown):Promise<void>};
 const delays=async(fetcher:typeof fetch)=>{
  const {wallet,tick}=tickRig(140,140,fetcher);Object.assign(wallet,{changed(){},finishStart:async()=>{}});armed.length=0;
  await proto.start.call(wallet);
  for(let round=0;round<5;round++){await tick();await proto.statusTick.call(wallet);}
  return armed.map(timer=>timer.ms);
 };
 const sealed=await delays(sealedStub());
 assert.equal(sealed.length,12);
 assert.ok(sealed.every(ms=>ms>WATCHDOG_MS&&ms<=1.25*WATCHDOG_MS)&&new Set(sealed).size>1,sealed.join());
 for(const fetcher of [stub(),nativeStub()])assert.deepEqual(await delays(fetcher),Array(12).fill(WATCHDOG_MS));
});

test('a sealed catch-up after an indexer event re-draws its retry delays, and a direct or native one keeps them',async t=>{
 spread(t);const armed=timers(t);
 const retries=async(fetcher:typeof fetch)=>{
  let notify:(event:{type:string})=>void=()=>{},syncs=0;armed.length=0;
  const wallet=Object.assign(Object.create(ShieldedWallet.prototype),{networkPrivacy:isPrivateFetch(fetcher),sealedTransport:isSealedFetch(fetcher),stopped:false,unwatch:[],poolScript:'script',
   getContractManager:async()=>({watchScript:async()=>{},onContractEvent:(listener:typeof notify)=>{notify=listener;return ()=>{};}}),notifyIncomingFunds:async()=>()=>{},autoShield:async()=>{},sync:async()=>{syncs++;return 0;}});
  await (ShieldedWallet.prototype as unknown as {finishStart(this:unknown):Promise<void>}).finishStart.call(wallet);
  notify({type:'vtxo_received'});
  for(let i=0;i<EVENT_RETRY_MS.length-1;i++){await flush();armed[i]!.run();}
  await flush();
  return {syncs,delays:armed.map(timer=>timer.ms)};
 };
 const sealed=await retries(sealedStub());
 assert.deepEqual([sealed.syncs,sealed.delays.length],[EVENT_RETRY_MS.length,EVENT_RETRY_MS.length-1],'a zero delay stays zero and arms no timer');
 assert.ok(sealed.delays.every((ms,i)=>ms>EVENT_RETRY_MS[i+1]!&&ms<=1.25*EVENT_RETRY_MS[i+1]!),sealed.delays.join());
 for(const fetcher of [stub(),nativeStub()])assert.deepEqual(await retries(fetcher),{syncs:EVENT_RETRY_MS.length,delays:EVENT_RETRY_MS.slice(1)});
});

const depsOf=(wallet:object)=>(wallet as {deps():SubmitDeps}).deps();
test('only a sealed wallet delays its submit and watches a spend off the account; a native or direct one keeps the id poll',()=>{
 const sealed=depsOf(tickRig(140,140,sealedStub()).wallet);
 assert.equal(sealed.jitterMs,PRIVATE_SUBMIT_JITTER_MS);assert.equal(typeof sealed.landedBy,'function');
 for(const fetcher of [nativeStub(),stub()]){const {jitterMs,landedBy}=depsOf(tickRig(140,140,fetcher).wallet);assert.deepEqual([jitterMs,landedBy],[undefined,undefined]);}
});

test('a sealed spend round reads only /status while the pool count holds, and pages to find the spend once the head moves',async()=>{
 const {asked,pool,account,wallet}=tickRig(140,140,sealedStub()),history:{batch:number;spent:bigint[];txid:string}[]=[],apply=account.apply.bind(account);
 Object.assign(account,{history,async apply(batch:number){await apply(batch);history.push({batch,spent:[7n,8n],txid:'ab'.repeat(32)});}});Object.assign(wallet,{changed(){}});
 const {landedBy}=depsOf(wallet);
 assert.equal(await landedBy!([7n,8n]),undefined);assert.deepEqual(asked,['/status']);
 pool.batches=141;
 assert.deepEqual(await landedBy!([7n,8n]),{status:'included',batch:140,txid:'ab'.repeat(32)});
 assert.deepEqual(asked.slice(1),['/status','/batches?from=128&limit=12','/batches?from=140&limit=12']);
 assert.equal(await landedBy!([7n,9n]),undefined);
});

test('a sealed spend round whose catch-up fails keeps waiting, and a closed wallet ends it',async()=>{
 const {account,wallet}=tickRig(140,141,sealedStub());
 Object.assign(account,{history:[],async apply(){throw new Error('No relay brought an answer in time.');}});Object.assign(wallet,{changed(){}});
 const {landedBy}=depsOf(wallet);
 assert.equal(await landedBy!([7n]),undefined);
 wallet.stopped=true;await assert.rejects(landedBy!([7n]),/wallet was closed/);
});

const included=(batch:number)=>({status:'included',batch,txid:'ab'.repeat(32)});
test('a sealed finish at the pool\'s count reads no page for a spend the account already holds, and a direct or native finish still syncs',async()=>{
 for(const [fetcher,read] of [[sealedStub(),[]],[stub(),['/batches?from=140&limit=50']],[nativeStub(),['/batches?from=128&limit=12']]] as const){
  const {wallet,pages}=tickRig(140,140,fetcher);await wallet.refreshPoolStatus();
  await wallet.finish(included(139));assert.deepEqual(pages(),read);
 }
});
test('a sealed finish still syncs when the pool count it last read predates the spend\'s own batch, as after a deposit\'s id poll',async()=>{
 const {wallet,pool,account}=tickRig(140,140,sealedStub());await wallet.refreshPoolStatus();
 pool.batches=141;await wallet.finish(included(140));
 assert.equal(account.batchCount,141);
});

const statusRig=()=>{
 const rig=tickRig(140,140,sealedStub());Object.assign(rig.account,{history:[{batch:139,spent:[7n,8n]}]});
 return {...rig,read:()=>(rig.wallet as {refreshPoolStatus():Promise<boolean>}).refreshPoolStatus(),verdict:(nullifiers:bigint[])=>(rig.wallet as ShieldedWallet).settledNullifiers(nullifiers)};
};
test('after a fresh status read, a wallet gives the journal a verdict only at the pool\'s published count',async()=>{
 const {pool,read,verdict}=statusRig();
 await read();assert.deepEqual([verdict([7n,8n]),verdict([7n,9n])],[true,false]);
 pool.batches=141;await read();assert.equal(verdict([7n,8n]),undefined);
});

test('a wallet whose last status read is two watchdog rounds old gives no verdict, though the counts match',async t=>{
 let at=1_000_000;t.mock.method(Date,'now',()=>at);
 const {read,verdict}=statusRig();await read();
 at+=2*WATCHDOG_MS-1;assert.equal(verdict([7n,9n]),false);
 at+=1;assert.equal(verdict([7n,9n]),undefined);
});

test('a wallet opened offline on a cached status gives no verdict, though the counts match and the operator reads as up',()=>{
 const {wallet,verdict}=statusRig();Object.assign(wallet,{statusAt:Date.now(),pool:{origin:'https://pool.test',status:{pool:{batches:140}}}});
 assert.equal(wallet.operatorDown,undefined);assert.equal(verdict([7n,9n]),undefined);
});

test('a wallet still offline gives no verdict after a fresh status read, though the counts match, and gives it once it is checked',async()=>{
 const {wallet,read,verdict}=statusRig();Object.assign(wallet,{offline:true});
 await read();assert.equal(verdict([7n,9n]),undefined);
 Object.assign(wallet,{offline:false});assert.deepEqual([verdict([7n,8n]),verdict([7n,9n])],[true,false]);
});

const HEAD='ee'.repeat(32),EXPIRES=Date.parse('2026-11-20T00:00:00Z');
const headOf=(expiresAt?:number)=>({vtxos:[{assets:[{assetId:HEAD,amount:1n}],...(expiresAt===undefined?{}:{expiresAt:new Date(expiresAt)})}]});
const refused=():never=>{throw new Error('gateway down');};
// A sealed wallet reaches the indexer through the pool server's gateway, so `answer` is told whether the pool still answers.
const headRig=(t:TestContext,fetcher:typeof fetch,answer:(ask:number,poolUp:boolean)=>unknown=()=>headOf(EXPIRES))=>{
 let at=1_700_000_000_000,asks=0,poolUp=true;t.mock.method(Date,'now',()=>at);timers(t);
 const {wallet,tick}=tickRig(140,140,fetcher);Object.assign(wallet,{token:HEAD,poolScript:'5120',changed(){},indexerProvider:{getVtxos:async()=>answer(++asks,poolUp)}});
 return {wallet,asks:()=>asks,later:(ms:number)=>{at+=ms;},
  refresh:async()=>{await wallet.refreshPoolStatus();await flush();},
  ticks:async(rounds:number)=>{for(let round=0;round<rounds;round++){at+=WATCHDOG_MS;await tick();await flush();}},
  // Already past operatorDown's fixed 2*WATCHDOG_MS before the outage's first hand-driven tick; the 1.25 is margin, not a jitter bound.
  stop:()=>{poolUp=false;wallet.api=()=>Promise.reject(new Error('fetch failed'));at+=2*1.25*WATCHDOG_MS;}};
};
test('a sealed wallet reads the pool head expiry once while the pool answers, and shows it when the pool stops',async t=>{
 const {wallet,asks,refresh,ticks,stop}=headRig(t,sealedStub(),(_ask,poolUp)=>poolUp?headOf(EXPIRES):refused());
 await refresh();await ticks(3);const whileUp=asks();
 stop();await ticks(3);
 assert.deepEqual([whileUp,asks()-whileUp,wallet.operatorDown!.headExpiresAt],[1,1,EXPIRES]);
});
const unusable=[['rejects',refused],['finds no head coin',()=>({vtxos:[]})],['finds an invalid expiry',()=>headOf(NaN)]] as const;
for(const [what,whileUp] of unusable)test(`a sealed wallet whose head expiry read ${what} reports no deadline rather than a wrong one`,async t=>{
 const {wallet,refresh,ticks,stop}=headRig(t,sealedStub(),(_ask,poolUp)=>poolUp?whileUp():refused());
 await refresh();stop();await ticks(1);
 assert.equal(wallet.operatorDown!.headExpiresAt,undefined);
});
for(const [kind,fetcher] of [['direct',stub],['native',nativeStub]] as const)test(`a ${kind} wallet still looks the head expiry up during its outage, and reads nothing before one`,async t=>{
 const {wallet,asks,refresh,ticks,stop}=headRig(t,fetcher());
 await refresh();await ticks(3);const whileUp=asks();
 stop();await ticks(3);
 assert.deepEqual([whileUp,asks()-whileUp,wallet.operatorDown!.headExpiresAt],[0,1,EXPIRES]);
});
test('a sealed wallet shows the outage read over the deadline it remembered, when that read answers',async t=>{
 const {wallet,refresh,ticks,stop}=headRig(t,sealedStub(),ask=>headOf(ask===1?EXPIRES:EXPIRES+86_400_000));
 await refresh();stop();await ticks(1);
 assert.equal(wallet.operatorDown!.headExpiresAt,EXPIRES+86_400_000);
});
test('a sealed wallet never has two head expiry reads in flight, even past its back-off, and retries a failed one after it',async t=>{
 let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});
 const {wallet,asks,refresh,later}=headRig(t,sealedStub(),ask=>ask===1?gate.then(refused):headOf(EXPIRES));
 for(let i=0;i<4;i++)await refresh();
 later(10*WATCHDOG_MS);await refresh();
 const inFlight=asks();open();await flush();
 await refresh();await refresh();
 assert.deepEqual([inFlight,asks(),wallet.lastHeadExpiry],[1,2,EXPIRES]);
});
test('a head expiry that arrives after the wallet closed is not kept',async t=>{
 let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});
 const {wallet,asks,refresh}=headRig(t,sealedStub(),()=>gate.then(()=>headOf(EXPIRES)));
 await refresh();wallet.stopped=true;open();await flush();
 assert.deepEqual([asks(),wallet.lastHeadExpiry],[1,undefined]);
});
test('a sealed wallet re-reads the head expiry once the one it remembered has passed, and shows the renewed one when the pool stops',async t=>{
 const renewed=EXPIRES+7*86_400_000,{wallet,asks,refresh,ticks,later,stop}=headRig(t,sealedStub(),(ask,poolUp)=>poolUp?headOf(ask===1?EXPIRES:renewed):refused());
 await refresh();await ticks(3);const before=asks();
 later(EXPIRES+1-Date.now());await refresh();await ticks(3);const whileUp=asks();
 stop();await ticks(1);
 assert.deepEqual([before,whileUp,wallet.operatorDown!.headExpiresAt],[1,2,renewed]);
});
for(const [what,answer] of [...unusable,['finds a deadline that has already passed',()=>headOf(Date.now()-1)]] as const)test(`a sealed wallet whose head expiry read ${what} waits ten watchdog rounds before reading again`,async t=>{
 const {asks,refresh,later}=headRig(t,sealedStub(),answer);
 await refresh();later(WATCHDOG_MS);await refresh();later(9*WATCHDOG_MS-1);await refresh();
 const inside=asks();
 later(1);await refresh();await refresh();
 assert.deepEqual([inside,asks()],[1,2]);
});
test('a head expiry read that finds a deadline ahead clears the back-off, so one passing within ten rounds is re-read at once',async t=>{
 const {asks,refresh,later}=headRig(t,sealedStub(),ask=>headOf(Date.now()+(ask===1?5*60_000:7*86_400_000)));
 await refresh();later(6*60_000);await refresh();
 assert.equal(asks(),2);
});
const MOVED=EXPIRES-86_400_000,named=(wallet:{api:unknown})=>{const pool={batches:140,head:{txid:'aa'.repeat(32),vout:0}};wallet.api=async()=>({phase:'ready',pool});return (txid:string)=>{pool.head={txid,vout:0};};};
test('a sealed wallet re-reads the head expiry once the pool names a new head, and shows that head\'s deadline when the pool stops',async t=>{
 const {wallet,asks,refresh,ticks,stop}=headRig(t,sealedStub(),(ask,poolUp)=>poolUp?headOf(ask===1?EXPIRES:MOVED):refused()),rename=named(wallet);
 await refresh();await ticks(3);const same=asks();
 rename('bb'.repeat(32));await refresh();await ticks(3);const whileUp=asks();
 stop();await ticks(1);
 assert.deepEqual([same,whileUp,wallet.operatorDown!.headExpiresAt],[1,2,MOVED]);
});
test('a head expiry read that answers after the pool named a new head is not kept, and the next refresh reads the new one at once',async t=>{
 let open!:()=>void;const gate=new Promise<void>(resolve=>{open=resolve;});
 const {wallet,asks,refresh}=headRig(t,sealedStub(),ask=>ask===1?gate.then(()=>headOf(EXPIRES)):headOf(MOVED)),rename=named(wallet);
 await refresh();rename('bb'.repeat(32));await refresh();
 open();await flush();const kept=wallet.lastHeadExpiry;
 await refresh();
 assert.deepEqual([kept,asks(),wallet.lastHeadExpiry],[undefined,2,MOVED]);
});
test('a sealed wallet keeps the head deadline it remembered, with no read, through a status that names no pool, as while the server restarts, and when the same head is named again',async t=>{
 const {wallet,asks,refresh}=headRig(t,sealedStub(),ask=>ask===1?headOf(EXPIRES):refused());named(wallet);const live=wallet.api;
 await refresh();wallet.api=async()=>({phase:'starting',message:'Starting the rollup pool.'});await refresh();const restarting=[asks(),wallet.lastHeadExpiry];
 wallet.api=live;await refresh();
 assert.deepEqual([restarting,asks(),wallet.lastHeadExpiry],[[1,EXPIRES],1,EXPIRES]);
});
for(const [what,answer] of [...unusable,['finds a deadline that has already passed',()=>headOf(Date.now()-1)]] as const)test(`a sealed wallet whose head expiry read ${what} keeps backing off that head, and reads the next head the pool names at once`,async t=>{
 const {wallet,asks,refresh,later}=headRig(t,sealedStub(),ask=>ask===1?answer():headOf(MOVED)),rename=named(wallet);
 await refresh();later(WATCHDOG_MS);await refresh();
 rename('bb'.repeat(32));later(WATCHDOG_MS);await refresh();
 assert.deepEqual([asks(),wallet.lastHeadExpiry],[2,MOVED]);
});

test('external uncertain reservations remain visible after local holds release',()=>{
 const external=new Set([2n]),wallet={notes:{inFlight:new Set([1n])},pendingNullifiers:()=>external};
 const read=()=>Object.getOwnPropertyDescriptor(ShieldedWallet.prototype,'inFlight')!.get!.call(wallet) as ReadonlySet<bigint>;
 assert.deepEqual([...read()],[1n,2n]);
 wallet.notes.inFlight.clear();assert.deepEqual([...read()],[2n]);
 external.clear();assert.deepEqual([...read()],[]);
});

test('a restarted native wallet reserves uncertain deposit outpoints for every spending entrypoint',async t=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
 const origin='https://pool.test',id='a'.repeat(32),input={txid:'c'.repeat(64),vout:1,value:2000},other={...input,txid:'d'.repeat(64)};
 makeNativeMutationJournal(storage).beforeNativeMutation({url:origin+'/api/rollup/spends',method:'POST',body:JSON.stringify({id,slot:{nullifiers:['17']},coin:input})});
 const journal=makeNativeMutationJournal(storage),wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  used:new Set<string>(),usedTxids:new Set<string>(),pendingOutpoints:()=>new Set(journal.pendingPoolOutpoints(origin)),
  stopped:false,selfSending:false,nativeOperations:0,pool:{status:{pool:{reserves:{}}}},
  restoreLightningSpends:async()=>{},isPoolPayout:()=>false,
 }) as ShieldedWallet;
 let submitted=0;
 for(const name of ['send','settle','sendSelectedVtxosToSelf'] as const)t.mock.method(Wallet.prototype,name,async()=>{submitted++;return 'sent';});
 t.mock.method(Wallet.prototype,'getSpendableVtxos',async()=>[input,other] as never);
 assert.deepEqual(await wallet.getSpendableVtxos({genericallySpendableOnly:true}),[other]);
 assert.deepEqual(wallet.planFor([input,other],false),{kind:'btc',coins:[other],amount:2000});
 for(const spend of [()=>wallet.send({recipients:[{address:'unused',amount:330}],selectedVtxos:[input] as never}),()=>wallet.settle({inputs:[input] as never,outputs:[]}),()=>wallet.sendSelectedVtxosToSelf([input] as never)])await assert.rejects(spend(),/reserved/i);
 wallet.coins=async()=>[{...input,expiresAt:Date.now()}];assert.equal(await wallet.renew(),undefined);
 assert.equal(submitted,0);
 journal.observeNativeResponse({url:origin+'/api/rollup/spends/'+id,method:'GET',status:200,body:JSON.stringify({status:'included',txid:'ab'.repeat(32)})});
 assert.deepEqual(await wallet.getSpendableVtxos({genericallySpendableOnly:true}),[input,other]);
 assert.equal(await wallet.send({recipients:[{address:'unused',amount:330}],selectedVtxos:[input] as never}),'sent');
});

const depositRig=(vtxo:Record<string,unknown>|undefined,txids:string[],coin={txid:'c'.repeat(64),vout:1,value:2000},pendingOutpoints?:()=>ReadonlySet<string>)=>Object.assign(Object.create(ShieldedWallet.prototype),{
 used:new Set<string>(),usedTxids:new Set<string>(),pool:{status:{pool:{reserves:{}}}},isPoolPayout:()=>false,
 account:{txids:new Set(txids),batchCount:7},
 indexerProvider:{getVtxos:async()=>({vtxos:vtxo?[{txid:coin.txid,vout:coin.vout,...vtxo}]:[]})},
 settledNullifiers:()=>{throw new Error('a deposit has no history row');},
 ...(pendingOutpoints?{pendingOutpoints}:{}),
}) as ShieldedWallet;

test('a shield is settled by its coin: unspent landed nothing, our own batch landed it, anything else cannot say',async()=>{
 const outpoint='c'.repeat(64)+':1',batch='ab'.repeat(32);
 assert.equal(await depositRig({},[]).settledDeposit(outpoint),false);
 assert.equal(await depositRig({spentBy:batch,arkTxId:batch},[batch]).settledDeposit(outpoint),true);
 for(const [vtxo,txids] of [[undefined,[]],[{isSwept:true},[]],[{isUnrolled:true},[]],[{spentBy:batch,arkTxId:batch},[]],[{spentBy:batch},[batch]]] as const)
  assert.equal(await depositRig(vtxo,[...txids]).settledDeposit(outpoint),undefined,JSON.stringify(vtxo));
 for(const bad of ['','c'.repeat(64),'c'.repeat(64)+':x','C'.repeat(64)+':1','c'.repeat(64)+':1:1'])assert.equal(await depositRig({},[]).settledDeposit(bad),undefined,bad);
});

test('a shield whose coin proves it dead clears without a reload, and auto-shield plans that coin again',async()=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
 const origin='https://pool.test',id='a'.repeat(32),input={txid:'c'.repeat(64),vout:1,value:2000};
 let at=1_000_000;const journal=makeNativeMutationJournal(storage,{graceMs:NATIVE_GRACE_MS,now:()=>at});
 journal.beforeNativeMutation({url:origin+'/api/rollup/spends',method:'POST',body:JSON.stringify({id,slot:{nullifiers:['17']},coin:input})});
 const wallet=depositRig({},[],input,()=>new Set(journal.pendingPoolOutpoints(origin)));
 const unknown=(async()=>new Response('',{status:404})) as typeof fetch;
 assert.equal(wallet.planFor([input],false),undefined,'the reserved coin is left out while the outcome is unresolved');
 assert.equal(await reconcileJournal(journal,unknown,origin,wallet),true,'inside the hour the pool could still admit it');
 at+=8*3_600_000;
 assert.equal(await reconcileJournal(journal,unknown,origin,wallet),false);
 assert.deepEqual(wallet.planFor([input],false),{kind:'btc',coins:[input],amount:2000});
});

test('a 30-coin plan in private mode takes at most the cap, the soonest to expire first and coins without expiry last, and a direct plan takes all',()=>{
 const now=Date.now(),coins:ArkCoin[]=Array.from({length:30},(_,i)=>({txid:i.toString(16).padStart(64,'0'),vout:0,value:1000,...(i%2?{}:{expiresAt:now+SHIELD_FLOOR_MS+(100-i)*60_000})}));
 const plan=(cap?:number)=>(Object.assign(Object.create(ShieldedWallet.prototype),{used:new Set(),usedTxids:new Set(),pool:{status:{pool:{reserves:{}}}},isPoolPayout:()=>false,maxShieldCoins:cap}) as ShieldedWallet).planFor(coins,false);
 const soonest=[...coins.filter(coin=>coin.expiresAt).reverse(),...coins.filter(coin=>!coin.expiresAt).slice(0,PRIVATE_SHIELD_COINS-15)];
 assert.deepEqual(plan(PRIVATE_SHIELD_COINS),{kind:'btc',coins:soonest,amount:1000*PRIVATE_SHIELD_COINS});
 assert.deepEqual(plan(),{kind:'btc',coins,amount:30_000});
});

test('real SDK automatic send and settlement exclude restarted uncertain deposits',async t=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
 const origin='https://pool.test',id='a'.repeat(32),identity=SingleKey.fromHex('11'.repeat(32)),server=await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey();
 const tree=new DefaultVtxo.Script({pubKey:await identity.xOnlyPublicKey(),serverPubKey:server,csvTimelock:{type:'seconds',value:1024n}}),address=tree.address('tark',server).encode();
 const input={txid:'c'.repeat(64),vout:1,value:2000,script:Buffer.from(tree.pkScript).toString('hex'),createdAt:new Date(),status:{confirmed:true}},other={...input,txid:'d'.repeat(64),value:330};
 makeNativeMutationJournal(storage).beforeNativeMutation({url:origin+'/api/rollup/spends',method:'POST',body:JSON.stringify({id,slot:{nullifiers:['17']},coin:input})});
 const journal=makeNativeMutationJournal(storage),sent:string[][]=[],settled:string[][]=[],selected=new Error('selection inspected');let available=[input];
 const wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  used:new Set<string>(),usedTxids:new Set<string>(),pendingOutpoints:()=>new Set(journal.pendingPoolOutpoints(origin)),stopped:false,selfSending:false,nativeOperations:0,
  restoreLightningSpends:async()=>{},identity,network:{hrp:'tark'},dustAmount:330n,_txLock:Promise.resolve(),_offchainTapscript:tree,_boardingTapscript:tree,_arkServerPublicKey:server,_deprecatedSigners:[],
  getAddress:async()=>address,getSelectableBoardingUtxos:async()=>[],
  arkProvider:{getInfo:async()=>({vtxoMinAmount:330n,vtxoMaxAmount:-1n,fees:{intentFee:{offchainInput:'0.0',offchainOutput:'0.0',onchainInput:'0.0',onchainOutput:'0.0'}}})},
  _submitOffchainSpend:async(inputs:typeof available)=>{sent.push(inputs.map(coin=>coin.txid));return 'sent';},
  makeRegisterIntentSignature:async(inputs:typeof available)=>{settled.push(inputs.map(coin=>coin.txid));throw selected;},makeDeleteIntentSignature:async()=>({}),
 }) as ShieldedWallet;
 t.mock.method(Wallet.prototype,'getSpendableVtxos',async()=>available as never);
 await assert.rejects(wallet.send({recipients:[{address,amount:330}]}),/Insufficient funds/);
 await assert.rejects(wallet.settle(),/No inputs found/);assert.deepEqual(sent,[]);assert.deepEqual(settled,[]);
 available=[input,other];assert.equal(await wallet.send({recipients:[{address,amount:330}]}),'sent');
 await assert.rejects(wallet.settle(),error=>error===selected);
 assert.deepEqual(sent,[[other.txid]]);assert.deepEqual(settled,[[other.txid]]);
});

test('native Lightning-address resolution uses its explicit fetch capability',async()=>{
 const asked:string[]=[],fetcher=(async(input:RequestInfo|URL)=>{
  asked.push(String(input));return new Response(JSON.stringify({tag:'payRequest',callback:'https://pay.example/cb',minSendable:1000,maxSendable:100_000_000,metadata:'[["text/plain","alice"]]',paymentOptions:[{id:'shielded',type:'shielded'}]}),{headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 const wallet={restoreLightningSpends:async()=>{},maxPrivatePayment:()=>100_000n} as unknown as ShieldedWallet;
 const rails=lightningRails(wallet,{} as Parameters<typeof lightningRails>[1],fetcher);
 assert.equal(await rails.at(-1)!.available!({raw:'alice@pay.example',amount:2000},{} as never),true);
 assert.deepEqual(asked,['https://pay.example/.well-known/lnurlp/alice']);
});

for(const delayed of ['error','signing'] as const)test(`retired private wallets reject delayed ${delayed} before polling or signing on a resumed transport`,async t=>{
 let release!:()=>void,entered!:()=>void,generation=1,reads=0,signed=0;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),firstRead=new Promise<void>(resolve=>{entered=resolve;});
 const dispatched:{generation:number;method:string}[]=[],held=new Set([17n]),sentinel=new Error('creation inspected');
 const wallet=Object.assign(Object.create(ShieldedWallet.prototype),{
  stopped:false,unwatch:[],changeListeners:new Set(),actionListeners:new Set(),notes:{inFlight:new Set()},pendingNullifiers:()=>held,
  getContractManager:async()=>({}),getAddress:async()=>'unused',
  async load(this:{api:PoolApi;claimApi:PoolApi;dispose():Promise<void>;readonly inFlight:ReadonlySet<bigint>}){
   assert.ok(isPrivatePoolApi(this.api));assert.ok(isPrivatePoolApi(this.claimApi));
   const waiting=waitForSpend('aa'.repeat(16),async()=>{signed++;await this.api('/spends/'+ 'aa'.repeat(16)+'/sign',{signature:'old'});},this.api,1,5000);
   await firstRead;await this.dispose();generation=2;release();
   await assert.rejects(waiting,/wallet was closed/);
   await assert.rejects(this.api('/spends/'+ 'aa'.repeat(16)+'/sign',{signature:'old'}),/wallet was closed/);
   await assert.rejects(this.claimApi('/status'),/wallet was closed/);
   assert.deepEqual(dispatched,[{generation:1,method:'GET'}]);assert.equal(signed,0);
   assert.deepEqual([...this.inFlight],[17n]);throw sentinel;
  },
 }) as ShieldedWallet;
 t.mock.method(Wallet,'create',async()=>wallet as never);t.mock.method(Wallet.prototype,'dispose',async()=>{});
 const fetcher=markPrivateFetch((async(_input:RequestInfo|URL,init?:RequestInit)=>{
  const method=init?.method??'GET';dispatched.push({generation,method});
  if(method==='GET'&&++reads===1){entered();await blocked;if(delayed==='error')throw new Error('private connection paused');}
  return new Response(JSON.stringify(method==='GET'?{status:reads===2?'signing':'included',arkTx:'old-request'}:{}),{status:200});
 }) as typeof fetch);
 await assert.rejects(ShieldedWallet.create({identity:undefined as never,pool:{origin:'https://pool.test',status:{pool:{token:'pool',script:'5120',address:'unused'}} as never},secret:'11'.repeat(32),hash:()=>1n,prover:undefined as never,fetcher,claimFetch:fetcher,networkPrivacy:true,pendingNullifiers:()=>held}),error=>error===sentinel);
});
