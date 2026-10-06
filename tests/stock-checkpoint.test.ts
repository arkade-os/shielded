import test from 'node:test';
import assert from 'node:assert/strict';
import {CSVMultisigTapscript} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';

const forfeit='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const server='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const script=(timelock:{type:'seconds'|'blocks';value:bigint},pubkeys=[hex.decode(forfeit.slice(2))])=>hex.encode(CSVMultisigTapscript.encode({timelock,pubkeys}).script);

test('stock checkpoint validates its distinct advertised forfeit key and 4096-second delay',()=>{
 const decoded=validateStockCheckpoint(script({type:'seconds',value:4096n}),forfeit);
 assert.equal(decoded.params.timelock.type,'seconds');
 assert.equal(BigInt(decoded.params.timelock.value),4096n);
 assert.equal(hex.encode(decoded.params.pubkeys[0]!),forfeit.slice(2));
 assert.notEqual(forfeit.slice(2),server.slice(2));
});

test('stock checkpoint rejects a forfeit key that does not match the script',()=>{
 assert.throws(()=>validateStockCheckpoint(script({type:'seconds',value:4096n}),server),/checkpoint policy is invalid/i);
});

test('stock checkpoint rejects short delays, block delays, and multiple keys',()=>{
 assert.throws(()=>validateStockCheckpoint(script({type:'seconds',value:2048n}),forfeit),/checkpoint policy is invalid/i);
 assert.throws(()=>validateStockCheckpoint(script({type:'blocks',value:144n}),forfeit),/checkpoint policy is invalid/i);
 assert.throws(()=>validateStockCheckpoint(script({type:'seconds',value:4096n},[hex.decode(forfeit.slice(2)),hex.decode(server.slice(2))]),forfeit),/checkpoint policy is invalid/i);
});

test('stock checkpoint rejects missing, malformed, and invalid compressed forfeit points',()=>{
 const valid=script({type:'seconds',value:4096n});
 assert.throws(()=>validateStockCheckpoint(valid,''),/missing or malformed/i);
 assert.throws(()=>validateStockCheckpoint(valid,'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),/missing or malformed/i);
 assert.throws(()=>validateStockCheckpoint(valid,'02'+'ff'.repeat(32)),/valid secp256k1 point/i);
});
