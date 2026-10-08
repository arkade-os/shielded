import assert from 'node:assert/strict';
import {test} from 'node:test';
import {schnorr} from '@noble/curves/secp256k1.js';
import {asset} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {renewedRollupPoolCoins,rollupRenewalDigest,rollupRenewalSignature} from '../src/rollup/renewal.ts';

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
