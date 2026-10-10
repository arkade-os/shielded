import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadonlyWallet,Wallet} from '@arkade-os/sdk';
import {assertBundleSites,patchConstruction} from '../tools/patch-sdk.mjs';

const bundle=(wallet:number,readonly_:number)=>'  static async create(config) {\n'
 +Array.from({length:wallet},()=>'    const wallet = new _Wallet(\n      config.identity\n    );\n').join('')
 +Array.from({length:readonly_},()=>'    const other = new _ReadonlyWallet(\n      config.identity\n    );\n').join('')+'  }\n';

test('the installed SDK constructs wallets with new this, so a subclass can be created by the inherited factory',()=>{
 assert.match(String(Wallet.create),/new this\(/,'Wallet.create must construct with new this');
 assert.match(String(ReadonlyWallet.create),/new this\(/,'ReadonlyWallet.create must construct with new this');
 assert.doesNotMatch(String(Wallet.create),/new _Wallet\(/);
 assert.doesNotMatch(String(ReadonlyWallet.create),/new _ReadonlyWallet\(/);
});

test('the construction patch rewrites both factories, is idempotent, and finds nothing in unrelated source',()=>{
 const once=patchConstruction(bundle(1,1));
 assert.deepEqual(once.hits,{_Wallet:1,_ReadonlyWallet:1});
 assert.equal(once.already,0);
 assert.match(once.text,/const wallet = new this\(/);
 assert.doesNotMatch(once.text,/new _Wallet\(|new _ReadonlyWallet\(/);
 const twice=patchConstruction(once.text);
 assert.deepEqual(twice.hits,{_Wallet:0,_ReadonlyWallet:0});
 assert.equal(twice.already,1,'the second factory keeps its own local name, so only one line reads `const wallet =`');
 assert.deepEqual(patchConstruction('var x = new Wallet();').hits,{_Wallet:0,_ReadonlyWallet:0});
});

// A count across the whole bundle set would let a duplicate `_Wallet` site hide a missing `_ReadonlyWallet` one.
test('a bundle missing one factory is refused by name, not excused by the other factory being found twice',()=>{
 assert.equal(assertBundleSites('chunk.js',patchConstruction(bundle(1,1))),'patched');
 assert.throws(()=>assertBundleSites('chunk.js',patchConstruction(bundle(2,0))),/0x new _ReadonlyWallet\(/);
 assert.throws(()=>assertBundleSites('chunk.js',patchConstruction(bundle(0,1))),/0x new _Wallet\(/);
 assert.throws(()=>assertBundleSites('chunk.js',patchConstruction(bundle(1,2))),/2x new _ReadonlyWallet\(/);
 assert.equal(assertBundleSites('chunk.js',{text:'',hits:{_Wallet:0,_ReadonlyWallet:0},already:2}),'already');
});
