import assert from 'node:assert/strict';
import {test} from 'node:test';
import {schnorr} from '@noble/curves/secp256k1.js';
import {hex} from '@scure/base';
import {rollupRenewalDigest,rollupRenewalSignature} from '../src/rollup/renewal.ts';

// tools/vm/rollup_renewal_test.go pins the same digest for the covenant's gate.
test('the renewal gate signs the digest the covenant rebuilds',()=>{
 const head={txid:'11'.repeat(31)+'22',vout:1},digest=rollupRenewalDigest(['02aa'],head);
 assert.equal(hex.encode(digest),'6944d7770653359361fe902a84dbbc6c04215166753f1e9001da525711c4906e');
 const secret=new Uint8Array(32).fill(0x42);
 assert.equal(schnorr.verify(rollupRenewalSignature(secret,['02aa'],head),digest,schnorr.getPublicKey(secret)),true);
});
