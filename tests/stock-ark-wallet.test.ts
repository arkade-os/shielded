import test from 'node:test';
import assert from 'node:assert/strict';
import {hex} from '@scure/base';
import {MultisigTapscript,Transaction,VtxoScript} from '@arkade-os/sdk';
import {offlineNativeFixture} from './fixtures/native.ts';
import {assertUniqueCustomerVtxos,customerVtxoSourceMatches,withArkWallet} from '../src/stock/ark-wallet.ts';

const txid='12'.repeat(32);
function fixture(){
 const tree=new VtxoScript([MultisigTapscript.encode({pubkeys:[new Uint8Array(32).fill(1),new Uint8Array(32).fill(2)]}).script]);
 const source=offlineNativeFixture([{script:tree.pkScript,amount:500n}]);
 const coin={txid:source.id,vout:0,value:500,script:hex.encode(tree.pkScript)};
 return {tree,source,coin};
}

test('customer VTXO funding is promoted only when source amount and expected wallet script match',()=>{
 const {tree,source,coin}=fixture();
 assert.equal(customerVtxoSourceMatches(coin,source,tree,tree.pkScript),true);
 assert.equal(customerVtxoSourceMatches({...coin,value:501},source,tree,tree.pkScript),false);
 assert.equal(customerVtxoSourceMatches({...coin,script:'51'},source,tree,tree.pkScript),false);
 assert.equal(customerVtxoSourceMatches(coin,source,tree,new Uint8Array(34).fill(3)),false);
 assert.equal(customerVtxoSourceMatches({...coin,txid},source,tree,tree.pkScript),false);
 assert.equal(customerVtxoSourceMatches({...coin,vout:1},source,tree,tree.pkScript),false);
});

test('duplicate or malformed wallet outpoints fail closed before funding selection',()=>{
 assertUniqueCustomerVtxos([{txid,vout:0},{txid:'34'.repeat(32),vout:1}]);
 assert.throws(()=>assertUniqueCustomerVtxos([{txid,vout:0},{txid:txid.toUpperCase(),vout:0}]),/duplicate/);
 assert.throws(()=>assertUniqueCustomerVtxos([{txid:'not-a-txid',vout:0}]),/invalid/);
 assert.throws(()=>assertUniqueCustomerVtxos([{txid,vout:-1}]),/invalid/);
});

test('an Arkade wallet opened for one call is disposed after it, even when the call fails',async()=>{
 let disposed=0;
 const open=async()=>({address:'tark1x',wallet:{dispose:async()=>{disposed++;}}});
 assert.equal(await withArkWallet(open,async w=>w.address),'tark1x');
 await assert.rejects(withArkWallet(open,async()=>{throw new Error('send refused');}),/send refused/);
 assert.equal(disposed,2);
});
