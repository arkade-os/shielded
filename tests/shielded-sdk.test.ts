import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestArkProvider,RestIndexerProvider,SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {shieldedWalletConfig} from '../packages/shielded/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';

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
