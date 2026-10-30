import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestArkProvider,RestIndexerProvider,SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {createShieldedWallet,shieldedWalletConfig} from '../packages/shielded/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository,type ShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,type ShieldedWalletConfig} from '../src/shielded/wallet.ts';

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
