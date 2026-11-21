import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ASSET_DETAILS_PENDING,KIND_TEXT,NOT_HELD_ASSET,UNSHIELDED_ASSET_RECIPIENT,assetAmountError,assetLinkFill,assetMetadata,markedUnit,assetRecipientError,heldAssets,holdingKind,requestAssets,unshieldedLimitLine,assetMetaOf,assetText,assetTitle,assetUnit,formatAssetAmount,parseAssetAmount} from '../app/src/wallet-assets.ts';

const id='1e291e28'.padEnd(64,'0')+'0000';
const tether={name:'Tether USD',ticker:'USDT',decimals:6};
const meta=(over:Record<string,unknown>)=>assetMetaOf({decimals:6,...over});

test('decimals outside 0 to 18, or not a whole number, read as 0',()=>{
 for(const d of [6,0,18])assert.equal(assetMetaOf({decimals:d}).decimals,d);
 for(const d of [19,255,-1,2.5,NaN,'6','ff',undefined])assert.equal(assetMetaOf({decimals:d}).decimals,0);
 assert.equal(assetMetaOf(undefined).decimals,0);
});

test('a ticker shows only as letters, digits, dots and dashes, and a name loses control and direction characters',()=>{
 for(const t of ['USDT','cbETH','USD.e'])assert.equal(meta({ticker:t}).ticker,t);
 for(const t of ['$','US DT','USDT\u202e','ABCDEFGHIJKLM'])assert.equal(meta({ticker:t}).ticker,undefined);
 assert.equal(meta({name:'\u202eDSU rehteT'}).name,'DSU rehteT');
 assert.equal(meta({name:'a\u0000b'}).name,'ab');
 assert.equal(meta({name:'x'.repeat(40)}).name,'x'.repeat(32));
 assert.equal(meta({name:'  '}).name,undefined);
});

test('a ticker or name that passes for a bitcoin unit is dropped, so the id title and the mark show instead',()=>{
 for(const t of ['sat','sats','msat','msats','btc','xbt','mbtc','bit','bits','bitcoin','satoshi','satoshis','BTC','B.T.C','s.a.t.s','Sats-','uBTC','BTC1','btc-x','s.a.t','WBIT','cbBTC','8TC']){
  const m=assetMetaOf({ticker:t});
  assert.equal(m.ticker,undefined,t);
  assert.equal(assetTitle(id,m),'Asset 1e291e28…0000',t);
  assert.equal(assetText(500_000n,id,m),'500,000 units of asset 1e291e28…0000 · Unverified',t);
 }
 for(const t of ['USDT','TKN'])assert.equal(assetMetaOf({ticker:t}).ticker,t);
 for(const n of ['Bitcoin',' B i t c o i n ','BTC!','₿','Ｂｉｔｃｏｉｎ','Bitcoin'+' '.repeat(25)+'x','sat0shi','B\u0308TC','\u0412\u0422\u0421','\u0392itcoin','My Bitcoin Fund','bit coin','B\u00edtcoin','sat','msat','bit','bits','B i t s','SAT.','Bits'+' '.repeat(28)+'x'])assert.equal(meta({name:n}).name,undefined,JSON.stringify(n));
 for(const n of ['Tether USD','Saturn Token','Orbit','Habitat'])assert.equal(meta({name:n}).name,n);
 assert.equal(assetTitle(id,meta(tether)),'Tether USD (USDT)');
 assert.deepEqual(meta({name:'₿ Tether $USD',ticker:'USDT'}),{name:'Tether USD',ticker:'USDT',decimals:6},'a kept name loses its currency signs');
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

const KEY='shielded-asset-metadata-v1:';
const memoryStorage=(refuse=false)=>{const m=new Map<string,string>();return {m,getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{if(refuse)throw new Error('quota');m.set(k,v);}};};
const harness=(over:{refuse?:boolean;details?:(id:string)=>Promise<any>}={})=>{
 const storage=memoryStorage(over.refuse),calls:string[]=[];let t=1_000_000_000,changes=0;
 const cache=assetMetadata({storage,now:()=>t,onChange:()=>{changes++;},details:async id=>{calls.push(id);return over.details?over.details(id):{metadata:{...tether,icon:'https://x'}};}});
 return {storage,calls,cache,at:(n:number)=>{t=n;},now:()=>t,changes:()=>changes};
};
const settle=()=>new Promise(r=>setTimeout(r,0));

test('a cached entry serves without a lookup until it is a day old, then refreshes once',async()=>{
 const h=harness(),now=h.now();
 h.storage.m.set(KEY+id,JSON.stringify({name:'Old',decimals:2,at:now-1000}));
 h.cache.want([id]);await settle();assert.equal(h.calls.length,0);assert.equal(h.cache.get(id)?.name,'Old');
 h.storage.m.set(KEY+id,JSON.stringify({name:'Old',decimals:2,at:now-86_400_001}));
 const stale=harness();stale.storage.m.set(KEY+id,JSON.stringify({name:'Old',decimals:2,at:stale.now()-86_400_001}));
 stale.cache.want([id]);assert.equal(stale.cache.get(id)?.name,'Old');
 await settle();assert.equal(stale.calls.length,1);assert.equal(stale.cache.get(id)?.name,'Tether USD');
 assert.equal(JSON.parse(stale.storage.m.get(KEY+id)!).at,stale.now());assert.equal(stale.changes(),1);
});

for(const hang of [false,true])test(`a failed or unanswered lookup keeps the fallback and retries no sooner than a minute after it began (${hang?'hangs':'rejects'})`,async()=>{
 const h=harness({details:()=>hang?new Promise(()=>{}):Promise.reject(new Error('down'))}),start=h.now();
 h.cache.want([id]);await settle();assert.equal(h.cache.get(id),undefined);assert.equal(h.changes(),0);assert.equal(h.calls.length,1);
 h.at(start+59_999);h.cache.want([id]);await settle();assert.equal(h.calls.length,1);
 h.at(start+60_000);h.cache.want([id]);await settle();assert.equal(h.calls.length,2);assert.equal(h.changes(),0);
});

test('only valid asset ids are looked up, once each, at most 100 per call',async()=>{
 const h=harness();h.cache.want(['nothex',id,id,id.toUpperCase()]);await settle();assert.deepEqual(h.calls,[id]);
 const many=harness();many.cache.want(Array.from({length:150},(_,i)=>i.toString(16).padStart(68,'0')));await settle();assert.equal(many.calls.length,100);
});

test('the stored entry is the sanitized metadata, and is sanitized again on read',async()=>{
 const h=harness();h.cache.want([id]);await settle();
 assert.deepEqual(JSON.parse(h.storage.m.get(KEY+id)!),{name:'Tether USD',ticker:'USDT',decimals:6,at:h.now()});
 h.storage.m.set(KEY+id,JSON.stringify({decimals:99,ticker:'$',name:'\u202eX',at:h.now()}));
 assert.deepEqual(harness().cache.get(id),undefined);
 const t=memoryStorage();t.m.set(KEY+id,JSON.stringify({decimals:99,ticker:'$',name:'\u202eX',at:1}));
 assert.deepEqual(assetMetadata({storage:t,details:async()=>({}),onChange:()=>{}}).get(id),{decimals:0,name:'X'});
});

test('a storage that refuses writes keeps the metadata for this page',async()=>{
 const h=harness({refuse:true});h.cache.want([id]);await settle();
 assert.equal(h.cache.get(id)?.ticker,'USDT');assert.equal(h.changes(),1);
 h.cache.want([id]);await settle();assert.equal(h.calls.length,1);
});

const SHROL_ADDR='shrol21'+'q'.repeat(60);
const ARK='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const coin=(assets:{assetId:string;amount:bigint}[])=>({txid:'a'.repeat(64),vout:0,value:330,assets});
const held=(shielded:bigint,unshielded:bigint)=>({assetId:'a',shielded,unshielded});

test('the held list merges pool notes and Arkade coins per asset, payouts included, and names each kind',()=>{
 const list=heldAssets({reserves:['a','b'],shielded:x=>x==='a'?10n:0n,coins:[coin([{assetId:'a',amount:3n}]),coin([{assetId:'c',amount:5n}]),{txid:'b'.repeat(64),vout:1,value:900}]});
 assert.deepEqual(list,[{assetId:'a',shielded:10n,unshielded:3n},{assetId:'c',shielded:0n,unshielded:5n}]);
 assert.deepEqual(list.map(holdingKind),['both','unshielded']);
 assert.equal(holdingKind({assetId:'x',shielded:1n,unshielded:0n}),'shielded');
 assert.equal(KIND_TEXT.both,'Shielded and unshielded');
});

test('the receive picker offers held assets on Arkade and pool reserves on Shielded, only once their details are known, and nothing on Unified',()=>{
 const h=[held(1n,0n),{assetId:'c',shielded:0n,unshielded:5n}],known=(x:string)=>x!=='c';
 assert.deepEqual(requestAssets('arkade',h,['a','b'],known),['a']);
 assert.deepEqual(requestAssets('shielded',h,['a','b'],known),['a','b']);
 assert.deepEqual(requestAssets('shielded',h,['a','b'],x=>x==='b'),['b']);
 assert.deepEqual(requestAssets('unified',h,['a','b'],()=>true),[]);
});

test('an asset outside the pool can be sent only to an Arkade address',()=>{
 const out=held(0n,4n);
 for(const to of [SHROL_ADDR,'alice@lnurl.example','tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx','lnbc1500n1pj9abcdefghijklmnop'])assert.equal(assetRecipientError(out,to),UNSHIELDED_ASSET_RECIPIENT);
 for(const to of [ARK,`bitcoin:?ark=${ARK}`,'',' '])assert.equal(assetRecipientError(out,to),'');
 for(const a of [held(2n,4n),held(2n,0n),undefined])assert.equal(assetRecipientError(a,SHROL_ADDR),'');
});

test('the limit line for Arkade units says they are public',()=>{
 assert.equal(unshieldedLimitLine('12.5','USDT'),'Up to 12.5 USDT on Arkade, outside the pool. Sending it makes the amount public.');
});

test('a payment link fills an asset amount only at the decimals this wallet has read, and never for an asset it does not hold',()=>{
 const h=[held(0n,9n)],usdt={ticker:'USDT',decimals:2};
 assert.equal(NOT_HELD_ASSET,'This payment link asks for an asset this wallet does not hold.');
 assert.equal(ASSET_DETAILS_PENDING,"This wallet has not read this asset's details yet, so it cannot read the link's amount. Enter the amount, or open the link again in a moment.");
 assert.throws(()=>assetLinkFill({assetId:'b',amount:'1'},h,usdt),{message:NOT_HELD_ASSET});
 assert.deepEqual(assetLinkFill({assetId:'a',amount:'12.5'},h,usdt),{assetId:'a',amount:'12.5',error:''});
 assert.deepEqual(assetLinkFill({assetId:'a',amount:'12.555'},h,usdt),{assetId:'a',amount:'',error:'Enter an amount of USDT · Unverified above zero, with at most 2 decimal places.'});
 assert.deepEqual(assetLinkFill({assetId:'a',amount:'1.5'},h,{decimals:0}),{assetId:'a',amount:'',error:assetAmountError(0,'units · Unverified')});
 assert.deepEqual(assetLinkFill({assetId:'a'},h,undefined),{assetId:'a',amount:'',error:''},'a link without an amount has none to wait for');
});

test('an asset link waits for the first coin read and for its amount\'s decimals, then fills; an asset not held is refused at that read',()=>{
 const link={assetId:'a',amount:'1.5'},h=[held(0n,9n)],two={ticker:'USDT',decimals:2};
 assert.equal(assetLinkFill(link,undefined,undefined),undefined,'details arrive later: before the first coin read');
 assert.equal(assetLinkFill(link,h,undefined),undefined,'then held, its decimals still unread');
 const filled=assetLinkFill(link,h,two);
 assert.deepEqual(filled,{assetId:'a',amount:'1.5',error:''});
 assert.deepEqual([parseAssetAmount(filled!.amount,2),formatAssetAmount(150n,2)],[150n,'1.5']);
 assert.equal(assetLinkFill(link,undefined,two),undefined,'details cached: it still waits for the first coin read');
 assert.deepEqual(assetLinkFill(link,h,two),filled,'and fills on it');
 assert.equal(assetLinkFill({...link,assetId:'b'},undefined,undefined),undefined);
 assert.throws(()=>assetLinkFill({...link,assetId:'b'},h,undefined),{message:NOT_HELD_ASSET},'refused at the first read, without waiting for details');
});

test('the send form names an asset unit with the Unverified mark',()=>{
 assert.equal(markedUnit(tether),'USDT · Unverified');
 assert.equal(markedUnit(),'units · Unverified');
});
