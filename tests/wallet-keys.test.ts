import test from 'node:test';
import assert from 'node:assert/strict';
import {schnorr} from '@noble/curves/secp256k1.js';
import {deriveWalletKeyMaterial,parseMasterSecret,recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';

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
 assert.throws(()=>deriveWalletKeyMaterial(new Uint8Array(31),'mutinynet'),/32 bytes/);
 assert.throws(()=>deriveWalletKeyMaterial('00'.repeat(32),'../mutinynet'),/network label/);
});

test('the recovery phrase is the same 32-byte secret in 24 words, so existing wallets keep their keys',()=>{
 const secret='0000000000000000000000000000000000000000000000000000000000000001',phrase=recoveryPhraseOf(secret);
 assert.equal(phrase.split(' ').length,24);
 assert.deepEqual(parseMasterSecret(phrase),parseMasterSecret(secret));
 assert.deepEqual(deriveWalletKeyMaterial(` ${phrase.toUpperCase().replaceAll(' ','\n  ')} `,'mutinynet'),deriveWalletKeyMaterial(secret,'mutinynet'));
 assert.throws(()=>parseMasterSecret('abandon '.repeat(24).trim()),/not valid/,'a phrase with a bad checksum');
 assert.throws(()=>parseMasterSecret('abandon '.repeat(12).trim()),/24 words/,'a 12-word phrase holds too little');
});
