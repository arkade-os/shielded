import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {schnorr} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {asset,SingleKey,UnknownPacket} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {offlineNativeFixture} from './fixtures/native.ts';
import type {StockNetworkInfo} from '../src/stock/network.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET} from '../src/rollup/covenant.ts';
import {flushRollupIntent,leftoverRenewal,renewedRollupPoolCoins,renewRollupPool,rollupRenewalDigest,rollupRenewalSignature} from '../src/rollup/renewal.ts';

// tools/vm/rollup_renewal_test.go pins the same digest for the covenant's gate.
test('the renewal gate signs the digest the covenant rebuilds',()=>{
 const head={txid:'11'.repeat(31)+'22',vout:1},digest=rollupRenewalDigest(['02aa'],head);
 assert.equal(hex.encode(digest),'6944d7770653359361fe902a84dbbc6c04215166753f1e9001da525711c4906e');
 const secret=new Uint8Array(32).fill(0x42);
 assert.equal(schnorr.verify(rollupRenewalSignature(secret,['02aa'],head),digest,schnorr.getPublicKey(secret)),true);
});

// L3 observed the renewed head and its reserve at one txid, vouts 0 and 1, in the intent's output order.
test('the renewed coins are the token head and the reserves that follow it, not whatever holds the asset',()=>{
 const token=asset.AssetId.create('cc'.repeat(32),0).toString(),x=asset.AssetId.create('dd'.repeat(32),0).toString();
 const head={txid:'ab'.repeat(32),vout:0,value:3000,assets:[{assetId:token,amount:1n}]};
 const reserve={txid:head.txid,vout:1,value:330,assets:[{assetId:x,amount:10_000n}]};
 const stranger={txid:'cd'.repeat(32),vout:0,value:330,assets:[{assetId:x,amount:1n}]};
 const renewed=renewedRollupPoolCoins(token,[[x,'10000']],[stranger,head,reserve]);
 assert.equal(renewed.head,head);
 assert.deepEqual(renewed.reserves,[{assetId:x,coin:reserve,amount:'10000'}]);
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,stranger]),/not indexed yet/,'a stranger at another outpoint is not the reserve');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,{...reserve,assets:[{assetId:x,amount:9000n}]}]),/does not hold/,'a reserve short of the amount it tracked');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,{...reserve,assets:[...reserve.assets,{assetId:token,amount:1n}]}]),/does not hold/,'a reserve carrying something else too');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[{...head,assets:[{assetId:token,amount:2n}]},reserve]),/head is not indexed/,'a token that is not the supply-1 pool token');
});

test('a renewal hands out its intent id before the round, and names it when the round fails',async()=>{
 const token=asset.AssetId.create('cc'.repeat(32),0).toString();
 const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const leaves={batch:Uint8Array.of(0x51),batchJoin:Uint8Array.of(0x54),reserve:Uint8Array.of(0x52),renew:Uint8Array.of(0x53)};
 const pool=rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:3000n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,new Uint8Array(64))]);
 const head={txid:parent.id,vout:0,value:3000,sourceTxHex:hex.encode(parent.toBytes())};
 const vtxo={txid:head.txid,vout:0,value:3000,script:hex.encode(pool.tree.pkScript),isSpent:false,prevTx:parent.toBytes()};
 const seen:string[]=[];
 const providers={
  ark:{registerIntent:async()=>'intent-42',getEventStream:async function*(){throw new Error('the round was dropped');}},
  emulator:{submitIntent:async({proof}:{proof:string})=>proof},
  indexer:{getVtxos:async()=>({vtxos:[vtxo]}),getVirtualTxs:async()=>({txs:[]})},
 };
 const network={network:'mutinynet',arkUrl:'https://ark.invalid',emulatorUrl:'https://emulator.invalid'} as unknown as StockNetworkInfo;
 await assert.rejects(renewRollupPool({network,identity:SingleKey.fromHex('04'.repeat(32)),operatorSecret:randomBytes(32),pool:pool.tree,renewLeaf:pool.renew,
  leaves,token,archive:{version:1,head,reserves:{},batches:0},onIntent:id=>{seen.push(id);},providers:providers as never}),/intent-42/);
 assert.deepEqual(seen,['intent-42'],'the id reaches the caller before the round, so a stranded intent can be cleared');
});

test('a stranded renewal intent is confirmed in its round and cleared when that round fails',async()=>{
 const hash=hex.encode(sha256(new TextEncoder().encode('intent-42'))),confirmed:string[]=[],topics:string[][]=[];
 const ark={confirmRegistration:async(id:string)=>{confirmed.push(id);},getEventStream:async function*(_signal:AbortSignal,t:string[]){
  topics.push(t);
  yield {type:'batch_failed',id:'earlier',reason:'not enough intent confirmations received'};
  yield {type:'batch_started',id:'other',intentIdHashes:['ff'.repeat(32)]};
  yield {type:'batch_started',id:'ours',intentIdHashes:[hash]};
  yield {type:'batch_failed',id:'ours',reason:'musig2 signing session timed out (nonce collection), collected 0/1 nonces'};
 }};
 assert.equal(await flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:['ab:0'],ark:ark as never}),'flushed');
 assert.deepEqual(confirmed,['intent-42']);
 assert.deepEqual(topics,[['ab:0']]);
});

test('an intent no round picks up is reported absent, without confirming anything',async()=>{
 const ark={confirmRegistration:async()=>{throw new Error('nothing to confirm');},getEventStream:async function*(signal:AbortSignal){
  yield {type:'batch_started',id:'other',intentIdHashes:[]};
  await new Promise(resolve=>signal.addEventListener('abort',resolve));
 }};
 assert.equal(await flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:[],waitMs:50,ark:ark as never}),'absent');
});

test('a renewal left behind by a dead process is adopted, cleared or flushed according to the head',()=>{
 const pending={intentId:'intent-42',head:{txid:'aa'.repeat(32),vout:0}};
 assert.equal(leftoverRenewal(pending,{txid:'bb'.repeat(32),vout:0},undefined),'done','the head was relocated before the process died');
 assert.equal(leftoverRenewal(pending,pending.head,{settledBy:'cc'.repeat(32)}),'adopt','the round settled the head, so its new coins exist');
 assert.equal(leftoverRenewal(pending,pending.head,{isSpent:true}),'moved','an offchain spend is not a renewal');
 assert.equal(leftoverRenewal(pending,pending.head,{isSpent:false}),'flush');
});

test('an event stream that closes before the wait ends proves nothing about the intent',async()=>{
 const ark={confirmRegistration:async()=>{},getEventStream:async function*(){yield {type:'batch_started',id:'other',intentIdHashes:[]};}};
 await assert.rejects(flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:[],waitMs:5000,ark:ark as never}),/closed/);
});
