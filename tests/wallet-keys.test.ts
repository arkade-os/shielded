import test from 'node:test';
import assert from 'node:assert/strict';
import {schnorr} from '@noble/curves/secp256k1.js';
import {bearerSecretOf,deriveRollupKeyMaterial,deriveRollupKeys2,deriveWalletKeyMaterial,parseMasterSecret,recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';

test('genesis-2 rollup keys are independent of the genesis-1 key from the same secret, and stable',()=>{
 const secret='ab'.repeat(32),v1=deriveRollupKeyMaterial(secret,'mutinynet'),v2=deriveRollupKeys2(secret,'mutinynet');
 assert.equal(new Set([v2.ask,v2.nk,v1.spendSecret]).size,3);
 assert.notEqual(Buffer.from(v2.viewSecret).toString('hex'),Buffer.from(v1.viewSecret).toString('hex'));
 assert.deepEqual(deriveRollupKeys2(parseMasterSecret(secret),'mutinynet'),v2);
 assert.notDeepEqual(deriveRollupKeys2(secret,'signet'),v2);
});

test('master-secret derivation is stable, domain separated and produces valid key material',()=>{
 const secret='0000000000000000000000000000000000000000000000000000000000000001';
 const material=deriveWalletKeyMaterial(secret,'mutinynet');
 assert.deepEqual(material,{keys:{spend:'513803635212994453358358723491177903567916858435270850580685111886628348606',view:'2153221168254187307337924938533221029359191276438221693156445411826072735601'},nativeSecret:'20fba54c41f97bfd25e7e898cbeed1906311085697dd661427732d2bccb1d6d4'});
 assert.deepEqual(deriveWalletKeyMaterial(parseMasterSecret(secret),'mutinynet'),material);
 assert.notDeepEqual(deriveWalletKeyMaterial(secret,'local-emulator'),material);
 assert.notEqual(material.keys.spend,material.keys.view);
 assert.equal(schnorr.getPublicKey(Buffer.from(material.nativeSecret,'hex')).length,32);
});

test('master-secret parsing rejects malformed or wrong-sized values',()=>{
 for(const value of ['', '01', 'gg'.repeat(32), '00'.repeat(33)])assert.throws(()=>parseMasterSecret(value),/64 hexadecimal/);
 for(const count of [11,15,18,21,23])assert.throws(()=>parseMasterSecret('abandon '.repeat(count).trim()),/12 or 24 words/,`${count} words is not a phrase length we accept`);
 assert.throws(()=>deriveWalletKeyMaterial(new Uint8Array(31),'mutinynet'),/32 bytes/);
 assert.throws(()=>deriveWalletKeyMaterial('00'.repeat(32),'../mutinynet'),/network label/);
});

test('the recovery phrase is the same 32-byte secret in 24 words, so existing wallets keep their keys',()=>{
 const secret='0000000000000000000000000000000000000000000000000000000000000001',phrase=recoveryPhraseOf(secret);
 assert.equal(phrase.split(' ').length,24);
 assert.deepEqual(parseMasterSecret(phrase),parseMasterSecret(secret));
 assert.deepEqual(deriveWalletKeyMaterial(` ${phrase.toUpperCase().replaceAll(' ','\n  ')} `,'mutinynet'),deriveWalletKeyMaterial(secret,'mutinynet'));
 assert.throws(()=>parseMasterSecret('abandon '.repeat(24).trim()),/not valid/,'a phrase with a bad checksum');
 assert.throws(()=>parseMasterSecret('abandon '.repeat(12).trim()),/not valid/,'a 12-word phrase with a bad checksum');
});

test('a 24-word phrase stays the master secret itself, byte for byte',()=>{
 const phrase='abandon '.repeat(23)+'art';
 assert.equal(Buffer.from(parseMasterSecret(phrase)).toString('hex'),'00'.repeat(32));
 assert.equal(recoveryPhraseOf(phrase),phrase);
});

test('a 12-word phrase stretches into a fixed master secret and is shown back as its own 12 words',()=>{
 const phrase='abandon '.repeat(11)+'about',master=parseMasterSecret(phrase);
 assert.equal(Buffer.from(master).toString('hex'),'cb1cefe7831aa41962a88919be1ead420c16d082284e72a0a89117224af85629');
 assert.equal(recoveryPhraseOf(phrase),phrase);
 assert.deepEqual(parseMasterSecret(` ${phrase.toUpperCase().replaceAll(' ','\n  ')} `),master);
 assert.deepEqual(parseMasterSecret(recoveryPhraseOf(master)),master);
 assert.notDeepEqual(parseMasterSecret('abandon '.repeat(23)+'art'),master);
});

test('a claim link seed is stable, distinct per nullifier and network, and unlike the wallet\'s own keys',()=>{
 const secret='ab'.repeat(32),hexOf=(b:Uint8Array)=>Buffer.from(b).toString('hex'),seed=hexOf(bearerSecretOf(secret,'mutinynet',7n));
 assert.equal(seed.length,64);
 assert.equal(hexOf(bearerSecretOf(parseMasterSecret(secret),'mutinynet',7n)),seed);
 assert.notEqual(hexOf(bearerSecretOf(secret,'mutinynet',8n)),seed);
 assert.notEqual(hexOf(bearerSecretOf(secret,'signet',7n)),seed);
 assert.notEqual(hexOf(deriveRollupKeys2(secret,'mutinynet').viewSecret),seed);
 assert.throws(()=>bearerSecretOf(secret,'../x',7n),/network label/);
});
