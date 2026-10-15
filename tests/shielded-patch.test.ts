import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadonlyWallet,Wallet} from '@arkade-os/sdk';

test('the installed SDK constructs wallets with new this, so a subclass can be created by the inherited factory',()=>{
 assert.match(String(Wallet.create),/new this\(/,'Wallet.create must construct with new this');
 assert.match(String(ReadonlyWallet.create),/new this\(/,'ReadonlyWallet.create must construct with new this');
 assert.doesNotMatch(String(Wallet.create),/new _Wallet\(/);
 assert.doesNotMatch(String(ReadonlyWallet.create),/new _ReadonlyWallet\(/);
});
