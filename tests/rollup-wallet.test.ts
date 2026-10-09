import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {noteOf} from '../packages/protocol/src/rollup/notes.ts';
import {ctDigestOf,openRollupNotes,parseRollupAddress,rollupAddressOf,rollupRecipientOf,sealRollupNotes,viewEcdh,ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const alice=deriveRollupKeys2('11'.repeat(32),'mutinynet'),bob=deriveRollupKeys2('22'.repeat(32),'mutinynet');
const aliceTo=rollupRecipientOf(hash,alice.ask,alice.nk,alice.viewSecret),bobTo=rollupRecipientOf(hash,bob.ask,bob.nk,bob.viewSecret);

test('rollup keys are stable per secret and network, and addresses round-trip',()=>{
 assert.deepEqual(deriveRollupKeys2('11'.repeat(32),'mutinynet'),alice);
 assert.notEqual(deriveRollupKeys2('11'.repeat(32),'signet').ask,alice.ask);
 const address=rollupAddressOf(bobTo);
 assert.match(address,/^shrol1/);
 const back=parseRollupAddress(address);
 assert.equal(back.owner,bobTo.owner);
 assert.deepEqual([...back.viewPublic],[...bobTo.viewPublic]);
 assert.throws(()=>parseRollupAddress(address.slice(0,-1)+(address.endsWith('q')?'p':'q')));
});

test('each recipient opens only its own output, and the commitment checks out',async()=>{
 const notes=[{amount:700n,asset:0n,rho:123n},{amount:300n,asset:5n,rho:456n}] as const;
 const record=await sealRollupNotes([bobTo,aliceTo],notes);
 assert.equal(record.length,ROLLUP_RECORD_BYTES);
 const [forBob,notForBob]=await openRollupNotes(record,bob.viewSecret);
 const [notForAlice,forAlice]=await openRollupNotes(record,alice.viewSecret);
 assert.deepEqual(forBob,notes[0]);
 assert.deepEqual(forAlice,notes[1]);
 assert.equal(notForBob,undefined);
 assert.equal(notForAlice,undefined);
 assert.equal(noteOf(hash,ROLLUP_DOMAIN,forBob!.amount,forBob!.asset,bobTo.owner,forBob!.rho),noteOf(hash,ROLLUP_DOMAIN,700n,0n,bobTo.owner,123n));
 const tampered=record.slice();tampered[40]!^=1;
 assert.deepEqual(await openRollupNotes(tampered,bob.viewSecret),[undefined,undefined]);
 assert.notEqual(ctDigestOf(record),ctDigestOf(tampered));
});

test('records open the same through WebCrypto X25519 as through the pure-JS curve, bad keys included',async()=>{
 const keys=deriveRollupKeys2('44'.repeat(32),'mutinynet'),poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
 const me=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret),record=await sealRollupNotes([me,me],[{amount:5n,asset:0n,rho:9n},{amount:0n,asset:0n,rho:10n}]);
 const fast=await viewEcdh(keys.viewSecret);
 assert.deepEqual(await openRollupNotes(record,keys.viewSecret,fast),await openRollupNotes(record,keys.viewSecret));
 assert.deepEqual((await openRollupNotes(record,keys.viewSecret,fast))[0],{amount:5n,asset:0n,rho:9n});
 const lowOrder=Uint8Array.from(record);lowOrder.fill(0,0,32);
 assert.deepEqual(await openRollupNotes(lowOrder,keys.viewSecret,fast),[undefined,undefined],'a low-order ephemeral key opens nothing');
});
