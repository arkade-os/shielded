import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestArkProvider,RestIndexerProvider,SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import info from './fixtures/ark-info.json' with {type:'json'};
import {createShieldedWallet,depositFeeOf,shieldedWalletConfig,type DepositFee,type DepositFeeSchedule} from '../packages/shielded/src/index.ts';
import {rollupAddressOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository,type ShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,type ShieldedWalletConfig} from '../src/shielded/wallet.ts';
import type {ShieldedSyncProgress} from '../src/shielded/sync-progress.ts';

const secret='11'.repeat(32),origin='https://pool.example';
const ready={phase:'ready',message:'',network:{network:'mutinynet',arkUrl:'https://ark.example'},proving:{spend:{wasm:'w',zkey:'z'},join:{wasm:'w',zkey:'z'}},pool:{token:'t',script:'s',address:'a',batches:3}};
const serving=(status:unknown)=>{const urls:string[]=[];return {urls,fetch:(async(url:unknown)=>{urls.push(String(url));return Response.json(status);}) as typeof fetch};};

test('a pool that is not open, or not on Mutinynet, is refused before a wallet is built',async()=>{
 await assert.rejects(shieldedWalletConfig({pool:origin,secret,fetch:serving({...ready,phase:'funding',message:'Funding the pool'}).fetch}),/not open: Funding the pool/);
 await assert.rejects(shieldedWalletConfig({pool:origin,secret,fetch:serving({...ready,network:{...ready.network,network:'bitcoin'}}).fetch}),/runs on bitcoin.*Mutinynet/);
});

test('a ready Mutinynet pool yields the reference page wallet configuration',async()=>{
 const served=serving(ready),config=await shieldedWalletConfig({pool:origin+'/',secret,fetch:served.fetch});
 assert.deepEqual(served.urls,[`${origin}/api/rollup/status`]);
 assert.equal(config.pool.origin,origin);assert.deepEqual(config.pool.status,ready);assert.equal(config.fetcher,served.fetch);
 assert.equal(config.settlementConfig,false);assert.equal(config.walletMode,'static');assert.equal(config.bornAt,0);
 const page=SingleKey.fromHex(deriveWalletKeyMaterial(secret,'mutinynet').nativeSecret);
 assert.equal(hex.encode(await config.identity.xOnlyPublicKey()),hex.encode(await page.xOnlyPublicKey()));
 assert.ok(config.arkProvider instanceof RestArkProvider&&config.indexerProvider instanceof RestIndexerProvider);
 assert.equal(config.arkProvider.serverUrl,'https://ark.example');assert.equal(config.indexerProvider.serverUrl,'https://ark.example');
 assert.ok(config.shieldedRepository instanceof InMemoryShieldedNoteRepository);
 assert.equal(config.hash([1n,2n]),7853200120776062878684798364095072458815029376092732009249414926327459813530n);
 assert.equal(typeof config.prover.prove,'function');
});

test('the facade reports initial status work and forwards the same sync observer',async()=>{
 const progress:ShieldedSyncProgress[]=[],observer=(p:ShieldedSyncProgress)=>{progress.push(p);};
 const config=await shieldedWalletConfig({pool:origin,secret,fetch:serving(ready).fetch,onSyncProgress:observer});
 assert.equal(config.onSyncProgress,observer);
 assert.deepEqual(progress,[{stage:'request',request:'status',attempt:1}]);
});

test('reveal links name the pool, and fall back to the page only when the pool is the page',t=>{
 const originOf=(ShieldedWallet.prototype as unknown as {origin(this:{pool:{origin:string}}):string}).origin;
 Object.defineProperty(globalThis,'location',{value:{origin:'https://app.example'},configurable:true});t.after(()=>{delete (globalThis as {location?:unknown}).location;});
 assert.equal(originOf.call({pool:{origin}}),origin);
 assert.equal(originOf.call({pool:{origin:''}}),'https://app.example');
});

test('a note cache the facade made is closed with its wallet, or when the wallet cannot start',async t=>{
 const closes:string[]=[],watch=(config:ShieldedWalletConfig,name:string)=>{config.shieldedRepository![Symbol.asyncDispose]=async()=>{closes.push(name);};};
 const disposed:string[]=[],started=(name:string)=>({dispose:async()=>{disposed.push(name);}}) as unknown as ShieldedWallet;
 const create=t.mock.method(ShieldedWallet,'create',async(config:ShieldedWalletConfig)=>{watch(config,'started');return started('started');});
 const wallet=await createShieldedWallet({pool:origin,secret,fetch:serving(ready).fetch});
 assert.deepEqual([...closes],[]);await wallet.dispose();assert.deepEqual([disposed,closes],[['started'],['started']]);
 create.mock.mockImplementation(async(config:ShieldedWalletConfig)=>{watch(config,'refused');throw new Error('no Arkade server');});
 await assert.rejects(createShieldedWallet({pool:origin,secret,fetch:serving(ready).fetch}),/no Arkade server/);assert.deepEqual([...closes],['started','refused']);
 const mine:ShieldedNoteRepository=new InMemoryShieldedNoteRepository();mine[Symbol.asyncDispose]=async()=>{closes.push('mine');};
 create.mock.mockImplementation(async()=>started('mine'));
 await (await createShieldedWallet({pool:origin,secret,fetch:serving(ready).fetch,repository:mine})).dispose();assert.deepEqual(closes,['started','refused']);
});

const offline:Partial<ShieldedWalletConfig>={arkProvider:{serverUrl:'https://ark.example',getInfo:async()=>info} as never,
 indexerProvider:{getVtxos:async()=>({vtxos:[],page:undefined}),getVirtualTxs:async()=>({txs:[]}),subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never,
 onchainProvider:{getCoins:async()=>[],getTransactions:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never};
const fee:DepositFee={fixedSats:100,bps:0,address:rollupAddressOf({owner:1n,viewPublic:new Uint8Array(32).fill(7)})};
const charging={...ready,pool:{...ready.pool,script:'51'.repeat(34),batches:0,epoch:0,epochLen:128,depositFee:fee}};
const chargingPool=(async(url:unknown)=>Response.json(String(url).endsWith('/status')?charging:{total:0,batches:[]})) as typeof fetch;

test('a pool that charges a deposit fee needs a maximum the caller accepts, and says so when it is missing',async t=>{
 const created=ShieldedWallet.create;t.mock.method(ShieldedWallet,'create',(config:ShieldedWalletConfig)=>created.call(ShieldedWallet,{...config,...offline}));
 const wallet=await createShieldedWallet({pool:origin,secret,fetch:chargingPool});
 try{
  assert.deepEqual(wallet.depositFeePaused,fee);assert.equal(depositFeeOf(wallet.depositFeePaused,10_000n),100n);
  await assert.rejects(wallet.shield(),/100 sats.*maxDepositFee/);
 }finally{await wallet.dispose();}
 const accepting=await createShieldedWallet({pool:origin,secret,fetch:chargingPool,maxDepositFee:{fixedSats:100,bps:0}});
 try{assert.deepEqual([accepting.depositFee,accepting.depositFeePaused],[fee,undefined]);}finally{await accepting.dispose();}
});

test('a maximum the caller passes is carried into the wallet configuration',async()=>{
 const maxDepositFee:DepositFeeSchedule={fixedSats:100,bps:0};
 assert.deepEqual((await shieldedWalletConfig({pool:origin,secret,fetch:serving(ready).fetch,maxDepositFee})).maxDepositFee,maxDepositFee);
});
