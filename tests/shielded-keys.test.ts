import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {akOf} from '../packages/protocol/src/rollup/notes.ts';
import {fullViewKeyOf,viewKeyOf} from '../packages/protocol/src/rollup/disclosure.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {shieldedKeysOf} from '../src/shielded/wallet.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));

// A derivation drift here makes every existing tester's notes invisible, so it is pinned against the page's own calls.
test('the shielded wallet derives exactly the keys, address and view keys the page derives today',()=>{
 const secret='11'.repeat(32),keys=deriveRollupKeys2(secret,'mutinynet');
 const self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 const derived=shieldedKeysOf(hash,secret);
 assert.equal(MUTINYNET_KEY_NETWORK,'mutinynet');
 assert.equal(derived.keys.ask,keys.ask);
 assert.equal(derived.keys.nk,keys.nk);
 assert.deepEqual(derived.keys.viewSecret,keys.viewSecret);
 assert.equal(derived.self.owner,self.owner);
 assert.equal(derived.address,rollupAddressOf(self));
 assert.equal(derived.viewKey,viewKeyOf(self.owner,keys.viewSecret));
 assert.equal(derived.fullViewingKey,fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret));
 assert.match(derived.address,/^shrol21/);
});

test('a different secret derives a different owner and address',()=>{
 const a=shieldedKeysOf(hash,'11'.repeat(32)),b=shieldedKeysOf(hash,'22'.repeat(32));
 assert.notEqual(a.self.owner,b.self.owner);
 assert.notEqual(a.address,b.address);
});
