import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStockWeightBudget, parseStockNetworkInfo, preflightStockMutinynet } from '../src/stock/network.ts';
const ark={network:'mutinynet',signerPubkey:'03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a',maxTxWeight:'40000',dust:'330',unilateralExitDelay:'2048'};
const emulator={signerPubkey:'03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a',version:'v0.0.9-rc.0'};
test('stock network preflight retains the experimental cap and refuses incompatible network or signer changes',()=>{
 const info=parseStockNetworkInfo(ark,emulator);
 assert.equal(info.weightLimit,4000);assert.equal(info.nativeAdmission,'unverified');
 assertStockWeightBudget(info,{ark:3992,checkpoints:[696]});
 assert.throws(()=>assertStockWeightBudget(info,{ark:4001,checkpoints:[696]}),/exceeds/);
 const lower=parseStockNetworkInfo({...ark,maxTxWeight:'2000'},emulator);
 assert.throws(()=>assertStockWeightBudget(lower,{ark:2001,checkpoints:[696]}),/exceeds/);
 assert.throws(()=>parseStockNetworkInfo({...ark,network:'mainnet'},emulator),/different network/);
 assert.throws(()=>parseStockNetworkInfo({...ark,signerPubkey:emulator.signerPubkey},emulator),/must be distinct/);
 assert.throws(()=>parseStockNetworkInfo({...ark,dust:'331'},emulator),/carrier/);
 assert.throws(()=>parseStockNetworkInfo(ark,emulator,{serverKey:'00'.repeat(32),emulatorKey:info.emulatorKey}),/signer keys changed/);
 assert.throws(()=>parseStockNetworkInfo({...ark,maxTxWeight:'04000'},emulator),/canonical/);
});
test('stock public preflight only fetches bounded public info and leaves native admission unverified',async()=>{
 const visited:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input);visited.push(url);assert.equal(init?.redirect,'error');assert.equal(init?.method,undefined);return new Response(JSON.stringify(url.includes('emulator.')?emulator:ark));};
 const defaultNetwork=await preflightStockMutinynet({fetcher});
 assert.equal(defaultNetwork.nativeAdmission,'unverified');assert.equal(Object.hasOwn(defaultNetwork,'indexerUrl'),false);
 assert.deepEqual(visited.sort(),['https://emulator.mutinynet.arkade.sh/v1/info','https://mutinynet.arkade.sh/v1/info']);
 await assert.rejects(preflightStockMutinynet({fetcher:async()=>new Response(' '.repeat(65537))}),/exceeds the limit/);
 await assert.rejects(preflightStockMutinynet({fetcher:async()=>new Response('{}',{status:503})}),/HTTP 503/);
});
test('stock preflight accepts explicit Mutinynet provider origins while retaining its operator identity and weight cap',async()=>{
 const visited:string[]=[],arkUrl='https://ark.example',emulatorUrl='https://emulator.example',indexerUrl='https://indexer.example';
 const fetcher:typeof fetch=async(input)=>{const url=String(input);visited.push(url);return new Response(JSON.stringify(url.startsWith(emulatorUrl)?emulator:ark));};
 const network=await preflightStockMutinynet({fetcher,arkUrl,emulatorUrl,indexerUrl});
 assert.deepEqual(visited.sort(),[arkUrl+'/v1/info',emulatorUrl+'/v1/info']);
 assert.equal(network.arkUrl,arkUrl);assert.equal(network.emulatorUrl,emulatorUrl);assert.equal(network.indexerUrl,indexerUrl);assert.equal(network.weightLimit,4000);
 await assert.rejects(preflightStockMutinynet({fetcher,arkUrl:'https://user:secret@ark.example'}),/Arkade URL/);
});
