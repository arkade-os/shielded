import test from 'node:test';
import assert from 'node:assert/strict';
import {base64,hex} from '@scure/base';
import {offlineNativeFixture} from '../src/sdk/adapter.ts';
import {decodeStockIndexerTransaction} from '../src/stock/indexer.ts';

test('stock indexer reads the SDK base64 PSBT format and preserves transaction identity',()=>{
 const tx=offlineNativeFixture([{script:Uint8Array.of(0x51),amount:5000n}]);
 const decoded=decodeStockIndexerTransaction(base64.encode(tx.toPSBT()));
 assert.equal(decoded.id,tx.id);
 assert.deepEqual(decoded.unsignedTx,tx.unsignedTx);
 assert.equal(decoded.getOutput(0).amount,5000n);
 assert.throws(()=>decodeStockIndexerTransaction(hex.encode(tx.toBytes(true,true))),/malformed base64 PSBT/);
 assert.throws(()=>decodeStockIndexerTransaction('not-a-psbt'),/malformed base64 PSBT/);
});
