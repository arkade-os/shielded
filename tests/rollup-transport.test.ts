import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {StockNetworkInfo} from '../src/stock/network.ts';
import {createRollupTransport,emulatorRefused,landedOrAnswered} from '../src/rollup/transport.ts';

const network:StockNetworkInfo={network:'mutinynet',arkUrl:'https://ark.invalid',emulatorUrl:'https://emulator.invalid',serverKey:'11'.repeat(32),emulatorKey:'22'.repeat(32),
 operatorMaxWeight:40_000,weightLimit:4_000,dust:330,exitDelay:{type:'seconds',value:2048},emulatorVersion:'test',nativeAdmission:'unverified'};
const asset='55'.repeat(34),script='5120'+'33'.repeat(32);
const claimed={txid:'44'.repeat(32),vout:1,value:2500,script,assets:[{assetId:asset,amount:1000n}]};
const vtxo=(overrides:Record<string,unknown>={})=>({...claimed,assets:[{assetId:asset,amount:1000n}],isSpent:false,isSwept:false,isUnrolled:false,expiresAt:new Date(Date.now()+86_400_000),...overrides});
const fresh=(found:unknown)=>createRollupTransport(network,{emulator:{submitTx:async()=>{throw new Error('offline');}} as never,
 indexer:{getVtxos:async()=>({vtxos:found?[found]:[]}),getVirtualTxs:async()=>({txs:[]})} as never}).fresh(claimed,3600_000);

test('a deposit coin is fresh only when the indexer still holds the exact facts the client claimed',async()=>{
 assert.equal(await fresh(vtxo()),true);
 assert.equal(await fresh(undefined),false,'a coin the indexer does not know');
 assert.equal(await fresh(vtxo({isSpent:true})),false,'already spent');
 assert.equal(await fresh(vtxo({expiresAt:new Date(Date.now()+60_000)})),false,'inside the expiry floor');
 assert.equal(await fresh(vtxo({value:2499})),false,'a value the client overstated');
 assert.equal(await fresh(vtxo({script:'5120'+'99'.repeat(32)})),false,'a script the client does not control');
 assert.equal(await fresh(vtxo({assets:[{assetId:asset,amount:999n}]})),false,'an asset amount the client overstated');
 assert.equal(await fresh(vtxo({assets:[]})),false,'no asset at all');
 assert.equal(await fresh(vtxo({assets:[{assetId:asset,amount:1000n},{assetId:'66'.repeat(34),amount:1n}]})),false,'an undeclared extra asset');
});

test('a batch settles as soon as it is seen landed, without waiting on an emulator that is still finalizing',async()=>{
 const later=<T>(ms:number,value:T|Error)=>new Promise<T>((resolve,reject)=>setTimeout(()=>value instanceof Error?reject(value):resolve(value),ms));
 let looks=0;
 const t0=Date.now();
 assert.equal(await landedOrAnswered(later<string>(2000,new Error('internal error')),async()=>++looks>=2?'landed':undefined,10),'landed');
 assert.ok(Date.now()-t0<1000,'the slow refusal is not waited for');
 assert.equal(await landedOrAnswered(later<string>(5,'answered'),async()=>'landed',1000),'answered','a prompt answer wins');
 looks=0;
 await assert.rejects(landedOrAnswered(later<string>(30,new Error('internal error')),async()=>{looks++;return undefined;},10),/internal error/,'an answered refusal stands when the batch never shows');
 const after=looks;await later(40,undefined);
 assert.equal(looks,after,'looking stops once the answer is in');
});

test('only the emulator answering with its own error body is a refusal; a dead link or a proxy page is not',()=>{
 assert.equal(emulatorRefused(new Error('Failed to submit tx to emulator: {"code":13, "message":"internal error", "details":[]}')),true);
 assert.equal(emulatorRefused(new Error('Failed to submit tx to emulator: <html><body><h1>502 Bad Gateway</h1></body></html>')),false);
 assert.equal(emulatorRefused(new TypeError('fetch failed')),false);
});
