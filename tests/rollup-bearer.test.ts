import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bech32m} from '@scure/base';
import {decodeClaimToken,encodeClaimToken} from '../packages/protocol/src/rollup/bearer.ts';

const secret=Uint8Array.from({length:32},(_,i)=>i+1);

test('a claim token carries the seed and the mint batch, however it was pasted',()=>{
 const token=encodeClaimToken({secret,batch:70_000});
 assert.match(token,/^shnote21/);
 for(const pasted of [token,` ${token}\n`,token.toUpperCase()])assert.deepEqual(decodeClaimToken(pasted),{secret,batch:70_000});
 assert.throws(()=>encodeClaimToken({secret:secret.slice(1),batch:1}),/32-byte seed/);
 assert.throws(()=>encodeClaimToken({secret,batch:-1}),/batch number/);
});

test('another prefix, version or length is refused before anything is fetched',()=>{
 const encode=(prefix:string,bytes:number[])=>bech32m.encode(prefix,bech32m.toWords(Uint8Array.from(bytes)),false),body=[0,...secret,0,0,0,9];
 assert.throws(()=>decodeClaimToken(encode('shrol2',body)),/Not a claim link/);
 assert.throws(()=>decodeClaimToken(encode('shnote2',[1,...body.slice(1)])),/version 1/);
 assert.throws(()=>decodeClaimToken(encode('shnote2',body.slice(0,-1))),/Not a claim link/);
 for(const junk of ['','shnote21qqqq','https://example.com'])assert.throws(()=>decodeClaimToken(junk),/Not a claim link/);
});
