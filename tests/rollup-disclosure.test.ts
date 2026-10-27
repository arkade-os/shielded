import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bech32m} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {fullViewKeyOf,parseFullViewKey,parseViewKey,viewKeyOf} from '../packages/protocol/src/rollup/disclosure.ts';
import {akOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeys2(byte.repeat(32),'mutinynet');
const [aliceKeys,bobKeys]=[keys('11'),keys('22')];
const [aliceTo,bobTo]=[aliceKeys,bobKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));

test('a view key refuses an address, a genesis-1 view key and a full viewing key, and a full viewing key refuses a view key',()=>{
 const key=fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret);
 assert.throws(()=>parseViewKey(rollupAddressOf(bobTo)),/view key/);
 assert.throws(()=>parseViewKey(bech32m.encode('shview',bech32m.toWords(new Uint8Array(64)),false)),/genesis.1/i);
 assert.throws(()=>parseFullViewKey(hash,viewKeyOf(aliceTo.owner,aliceKeys.viewSecret)),/full viewing key/);
 assert.throws(()=>parseViewKey(key),/view key/);
});

test('a full viewing key binds its nullifier key: a swapped nk derives another owner, so a watcher can tell',()=>{
 const ak=akOf(hash,aliceKeys.ask);
 assert.equal(parseFullViewKey(hash,fullViewKeyOf(ak,aliceKeys.nk,aliceKeys.viewSecret)).owner,aliceTo.owner);
 assert.notEqual(parseFullViewKey(hash,fullViewKeyOf(ak,aliceKeys.nk+1n,aliceKeys.viewSecret)).owner,aliceTo.owner);
});
