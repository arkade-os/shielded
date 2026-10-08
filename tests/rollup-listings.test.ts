import assert from 'node:assert/strict';
import {test} from 'node:test';
import {listingsOf,MAX_RESERVES} from '../src/rollup/listings.ts';

const token='aa'.repeat(34),x='bb'.repeat(34),y='cc'.repeat(34);
const coin=(txid:string,value:number,assets:{assetId:string;amount:bigint}[])=>({txid:txid.repeat(64),vout:0,value,assets});

test('a pool-script coin holding one new asset and the dust lists that asset once',()=>{
 const found=listingsOf([
  coin('1',1000,[{assetId:token,amount:1n}]),
  coin('2',330,[{assetId:x,amount:1n}]),
  coin('3',330,[{assetId:x,amount:5n}]),
  coin('4',329,[{assetId:y,amount:1n}]),
  coin('5',330,[{assetId:y,amount:1n},{assetId:x,amount:1n}]),
  coin('6',330,[]),
 ],token,new Set());
 assert.deepEqual(found.map(f=>[f.assetId,f.coin.txid[0],f.amount]),[[x,'3',5n]],'the larger listing of an asset wins');
 assert.deepEqual(listingsOf([coin('2',330,[{assetId:x,amount:1n}])],token,new Set([x])),[],'an asset with a reserve is not listed again');
});

test('listings stop at the reserve cap, since every reserve rides along in each renewal',()=>{
 const many=Array.from({length:MAX_RESERVES+2},(_,i)=>coin(String(i%10),330,[{assetId:i.toString(16).padStart(2,'0').repeat(34),amount:1n}]));
 assert.equal(listingsOf(many,token,new Set(['dd'.repeat(34)])).length,MAX_RESERVES-1);
});
