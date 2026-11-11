import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DefaultVtxo,SingleKey,Wallet} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import type {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {BATCH_SLOTS,ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import type {RollupEpochRecord,RollupEpochRecordSlot} from '../packages/protocol/src/rollup/epoch-record.ts';
import {ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {epochCatchUp} from '../src/shielded/epoch-sync.ts';
import {epochSyncAccount} from '../src/shielded/epoch-pool.ts';
import {SHIELD_FLOOR_MS,ShieldedWallet,loadAccount} from '../src/shielded/wallet.ts';
import {lightningRails} from '../src/shielded/lightning.ts';
import {waitForSpend,type ArkCoin,type PoolApi} from '../src/shielded/pool.ts';
import {markPrivateFetch,markPrivatePoolPage,markSealedFetch,privatePoolPage,isPrivateFetch,isPrivatePoolApi,isSealedFetch} from '../src/shielded/network-privacy.ts';
import {PRIVATE_PAGE,PRIVATE_SHIELD_COINS} from '../src/shielded/private-transport.ts';
import {ANSWER_BYTES} from '../src/rollup/nostr-carrier.ts';
import {epochLeafPool} from './fixtures/epoch-pool.ts';
import {makeNativeMutationJournal} from '../src/native/mutations.ts';
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
  stopped:false,offline:false,networkPrivacy,sealedTransport:isSealedFetch(fetcher),pool:{origin:'https://pool.test',status:{}},statusAt:0,statusRevision:0,headExpiry:undefined,account,api:networkPrivacy?markPrivatePoolPage(privateApi(plain),12):plain,
  watchLinks(){},async autoShield(){},async merge(){},async renewNotes(){ran.push('renew');},async recoverNotes(){ran.push('recover');},changed(){this.stopped=true;},
 });
 // changed() stops the wallet, or tick() would arm its 60 s timer.
 const tick=async()=>{wallet.stopped=false;await (ShieldedWallet.prototype as unknown as {tick(this:typeof wallet):Promise<void>}).tick.call(wallet);};
 return {asked,ran,pool,account,tick,pages:()=>asked.filter(path=>path.startsWith('/batches'))};
};

test('a private tick reads no batch page while the pool reports the count the account already holds',async()=>{
 const {asked,pages,ran,tick}=tickRig(140,140,sealedStub());
 await tick();
 assert.ok(asked.includes('/status'));assert.deepEqual(pages(),[]);
 assert.deepEqual(ran.toSorted(),['recover','renew']);
});

test('a private tick syncs as soon as the pool count moves, including across an epoch rotation',async()=>{
 const {asked,pages,pool,account,tick}=tickRig(127,127,sealedStub());
 // 128 closes epoch 0 (epochLen 128); 130 is two batches into epoch 1.
 pool.batches=128;await tick();
 assert.equal(account.batchCount,128);assert.equal(pages().at(-1),'/batches?from=120&limit=8');
 asked.length=0;pool.batches=130;await tick();
 assert.equal(account.batchCount,130);assert.deepEqual(pages(),['/batches?from=128&limit=12']);
});

test('a direct tick still syncs on every tick',async()=>{
 const {pages,tick}=tickRig(140,140,stub());
 await tick();await tick();
 assert.equal(pages().length,2);
});

test('a native tick, private but not sealed, still syncs at equal counts',async()=>{
 const {pages,tick}=tickRig(140,140,nativeStub());
 await tick();
 assert.deepEqual(pages(),['/batches?from=128&limit=12']);
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
