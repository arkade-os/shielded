import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assetAmountError,assetMetaOf,assetText,assetTitle,assetUnit,formatAssetAmount,parseAssetAmount} from '../app/src/wallet-assets.ts';

const id='1e291e28'.padEnd(64,'0')+'0000';
const tether={name:'Tether USD',ticker:'USDT',decimals:6};
const meta=(over:Record<string,unknown>)=>assetMetaOf({decimals:6,...over});

test('decimals outside 0 to 18, or not a whole number, read as 0',()=>{
 for(const d of [6,0,18])assert.equal(assetMetaOf({decimals:d}).decimals,d);
 for(const d of [19,255,-1,2.5,NaN,'6','ff',undefined])assert.equal(assetMetaOf({decimals:d}).decimals,0);
 assert.equal(assetMetaOf(undefined).decimals,0);
});

test('a ticker shows only as letters, digits, dots and dashes, and a name loses control and direction characters',()=>{
 for(const t of ['USDT','cbBTC','USD.e'])assert.equal(meta({ticker:t}).ticker,t);
 for(const t of ['$','US DT','USDT\u202e','ABCDEFGHIJKLM'])assert.equal(meta({ticker:t}).ticker,undefined);
 assert.equal(meta({name:'\u202eDSU rehteT'}).name,'DSU rehteT');
 assert.equal(meta({name:'a\u0000b'}).name,'ab');
 assert.equal(meta({name:'x'.repeat(40)}).name,'x'.repeat(32));
 assert.equal(meta({name:'  '}).name,undefined);
});

test('amounts format with their decimals, grouped for display and plain for links',()=>{
 assert.equal(formatAssetAmount(1_250_000n,6),'1.25');
 assert.equal(formatAssetAmount(1_000_000n,6),'1');
 assert.equal(formatAssetAmount(5n,6),'0.000005');
 assert.equal(formatAssetAmount(1_234_567_890n,2),'12,345,678.9');
 assert.equal(formatAssetAmount(1_234_567n,0),'1,234,567');
 assert.equal(formatAssetAmount(1_234_567n,0,false),'1234567');
 assert.equal(formatAssetAmount(2n**64n-1n,18),'18.446744073709551615');
 assert.equal(formatAssetAmount(1_234_567n,255),'1,234,567');
});

test('typed amounts parse to atomic units only when exact, positive and under 2^64',()=>{
 assert.equal(parseAssetAmount('1.25',6),1_250_000n);
 assert.equal(parseAssetAmount('18446744073709551615',0),2n**64n-1n);
 const bad:[string,number][]=[['1.5',0],['0',2],['01',2],['.5',2],['5.',2],['1,000',0],['1.234',2],['1e3',0],[' 5',0],['',0],['18446744073709551616',0],['18.446744073709551616',18],['9'.repeat(30),0]];
 for(const [t,d] of bad)assert.equal(parseAssetAmount(t,d),undefined,`${t}/${d}`);
 for(const [x,d] of [[1n,6],[1_250_000n,6],[2n**64n-1n,18],[7n,0]] as [bigint,number][])assert.equal(parseAssetAmount(formatAssetAmount(x,d,false),d),x);
});

test('every asset text carries the Unverified mark, whatever its metadata claims',()=>{
 assert.equal(assetText(1_250_000n,id,tether),'1.25 USDT · Unverified');
 assert.equal(assetText(9n,id),'9 units of asset 1e291e28…0000 · Unverified');
 assert.ok(assetText(1n,id,{name:'Bitcoin',ticker:'BTC',decimals:8}).endsWith(' · Unverified'));
 assert.equal(assetTitle(id),'Asset 1e291e28\u20260000');
 assert.equal(assetTitle(id,tether),'Tether USD (USDT)');
 assert.equal(assetTitle(id,{ticker:'BTC',decimals:8}),'Asset 1e291e28\u20260000 (BTC)');
 assert.equal(assetUnit(tether),'USDT');
 assert.equal(assetUnit(),'units');
});

test('amount errors name the unit and the decimal places',()=>{
 assert.equal(assetAmountError(0,'units'),'Enter a whole number of units above zero, without leading zeros.');
 assert.equal(assetAmountError(6,'USDT'),'Enter an amount of USDT above zero, with at most 6 decimal places.');
});
