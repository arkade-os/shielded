import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,PaymentRouter,SingleKey,arkAssetRail,arkRail,isValidArkAddress,onchainRail,type PaymentRequest} from '@arkade-os/sdk';
import {createLnurlClient,type PaymentOption} from '@arkade-os/lnurl-client';
import {buildPoseidon} from 'circomlibjs';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {lightningRails,lnurlShieldedRail} from '../src/shielded/lightning.ts';
import {SHIELDED_PRIORITY,poolFundedExit,shieldedRail,shieldedTargetOf,shieldedWithdrawRail} from '../src/shielded/rails.ts';
import type {ShieldedWallet} from '../src/shielded/wallet.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet');
const SHROL=rollupAddressOf(rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret));
const POOL='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
// A second real address under the same operator key, so the checksum holds where a hand-edited one would not.
const decoded=ArkAddress.decode(POOL);
const ELSEWHERE=new ArkAddress(decoded.serverPubKey,new Uint8Array(32).fill(7),decoded.hrp).encode();
const ASSET='ee'.repeat(34);

const paid:{to:string;amount:bigint;asset?:string}[]=[],exited:{to:string;amount:bigint;opts:unknown}[]=[];
const fake=(o:{canWithdraw?:boolean|(()=>never);max?:bigint|(()=>bigint);restore?:()=>Promise<void>}={})=>({
 pool:{status:{pool:{address:POOL}}},
 poolAddress:POOL,
 canWithdraw:typeof o.canWithdraw==='function'?o.canWithdraw:()=>o.canWithdraw??true,
 restoreLightningSpends:o.restore??(async()=>{}),
 maxPrivatePayment:typeof o.max==='function'?o.max:()=>o.max??1_000_000n,
 pay:async(to:string,amount:bigint,asset?:string)=>{paid.push({to,amount,...(asset?{asset}:{})});return {id:'h',status:'pending'};},
 withdraw:async(to:string,amount:bigint,opts:unknown)=>{exited.push({to,amount,opts});return {id:'h',status:'pending'};},
} as unknown as ShieldedWallet);
const ctx=(wallet:ShieldedWallet)=>({wallet,prefs:{priority:SHIELDED_PRIORITY}} as never);
const req=(raw:string,amount?:number):PaymentRequest=>({raw,...(amount!==undefined?{amount}:{})});

test('a real second Arkade address and the shielded address are both well formed, and differ from the pool',()=>{
 assert.equal(isValidArkAddress(ELSEWHERE),true);
 assert.notEqual(ELSEWHERE,POOL);
 assert.equal(isValidArkAddress(SHROL),false,'ArkAddress rejects a 64-byte shielded payload, so the rails cannot clash');
 assert.match(SHROL,/^shrol21/);
});

// Review Focus 1: PaymentRouter.options calls match() with no try/catch, so a throwing match kills every route.
test('the shielded rail matches only a parseable shrol2 address, and never throws on anything else',()=>{
 const rail=shieldedRail(fake()),c=ctx(fake());
 assert.equal(rail.id,'shielded');
 assert.equal(rail.match(req(SHROL),c),true);
 assert.equal(rail.match(req(`bitcoin:?shielded=${SHROL}&amount=500`),c),true,'BIP21 carries it too');
 for(const raw of ['','shrol2','shrol21','shrol1qqqq',SHROL.slice(0,-6),SHROL.toUpperCase()+'x',POOL,'tark1qqqq','lnbc2500u1x','bitcoin:bc1qxy','not an address at all','shrol21!!!!'])
  assert.doesNotThrow(()=>rail.match(req(raw),c),`match must not throw on ${JSON.stringify(raw)}`);
 assert.equal(rail.match(req('shrol1qqqq'),c),false,'a genesis-1 address is not this pool’s');
 assert.equal(rail.match(req(SHROL.slice(0,-6)),c),false,'a truncated address fails its checksum');
 assert.equal(rail.match(req(POOL),c),false);
});

test('shieldedTargetOf finds a bare address or one inside a BIP21 URI, and nothing else',()=>{
 assert.equal(shieldedTargetOf(SHROL),SHROL);
 assert.equal(shieldedTargetOf(`  ${SHROL}  `),SHROL);
 assert.equal(shieldedTargetOf(`bitcoin:bc1qxy?amount=0.001&shielded=${SHROL}`),SHROL);
 assert.equal(shieldedTargetOf('shrol1qqqq'),undefined);
 assert.equal(shieldedTargetOf(POOL),undefined);
 assert.equal(shieldedTargetOf(''),undefined);
});

test('the shielded rail quotes a zero fee and sends through wallet.pay',async()=>{
 paid.length=0;
 const wallet=fake(),rail=shieldedRail(wallet),c=ctx(wallet);
 const quote=await rail.quote(req(SHROL,500),c);
 assert.deepEqual([quote.railId,quote.amount,quote.fee,quote.total],['shielded',500,0,500]);
 await quote.send();
 assert.deepEqual(paid,[{to:SHROL,amount:500n}]);
 await assert.rejects(rail.quote(req(SHROL),c),/whole number of sats/,'an amountless request is refused at quote time');
 assert.equal(await rail.available!(req(SHROL),c),false,'and is unavailable before that');
});

// Review Focus 3: a throwing available() is swallowed and the rail vanishes, leaving `ark` to spend public funds.
test('the withdraw rail is available only when the shielded balance covers the amount, and never throws',async()=>{
 const rich=shieldedWithdrawRail(fake({canWithdraw:true})),poor=shieldedWithdrawRail(fake({canWithdraw:false}));
 assert.equal(rich.id,'shielded-withdraw');
 assert.equal(await rich.available!(req(ELSEWHERE,500),ctx(fake())),true);
 assert.equal(await poor.available!(req(ELSEWHERE,500),ctx(fake())),false);
 const broken=shieldedWithdrawRail(fake({canWithdraw:()=>{throw new Error('boom');}}));
 assert.equal(await broken.available!(req(ELSEWHERE,500),ctx(fake())),false,'a thrown answer is a false answer, not a dropped rail');
 assert.equal(await rich.available!(req(ELSEWHERE),ctx(fake())),false,'no amount, no availability');
 assert.equal(await rich.available!(req(POOL,500),ctx(fake())),false,'and never for the pool itself');
});

test('the withdraw rail refuses an Arkade address on another network or under another operator',async()=>{
 const rail=shieldedWithdrawRail(fake()),c=ctx(fake());
 const operator=await SingleKey.fromPrivateKey(new Uint8Array(32).fill(5)).xOnlyPublicKey();
 const elsewhere=[new ArkAddress(operator,new Uint8Array(32).fill(7),decoded.hrp).encode(),new ArkAddress(decoded.serverPubKey,new Uint8Array(32).fill(7),'ark').encode()];
 for(const raw of elsewhere){
  assert.equal(isValidArkAddress(raw),true,'well formed, so only the operator check stops it');
  assert.equal(rail.match(req(raw),c),false,raw);
 }
});

// Review Focus 5: sending to the pool is listing, not withdrawing.
test('the withdraw rail matches an Arkade address, bare or in a BIP21 URI, but never the pool',()=>{
 const rail=shieldedWithdrawRail(fake()),c=ctx(fake());
 assert.equal(rail.match(req(ELSEWHERE),c),true);
 assert.equal(rail.match(req(`bitcoin:bc1qxy?ark=${ELSEWHERE}`),c),true,'a unified URI routes to the pool exit too');
 assert.equal(rail.match(req(POOL),c),false,'the pool address is listing, which stays listAsset');
 assert.equal(rail.match(req(`bitcoin:bc1qxy?ark=${POOL}`),c),false);
 assert.equal(rail.match(req(SHROL),c),false);
 for(const raw of ['','tark1','not an address',POOL.slice(0,-4)])assert.doesNotThrow(()=>rail.match(req(raw),c));
});

test('the wallet router ranks shielded first, withdraw second, and falls through to ark when the pool is short',async()=>{
 const routerOf=(wallet:ShieldedWallet)=>new PaymentRouter({wallet,prefs:{priority:SHIELDED_PRIORITY}} as never)
  .use(shieldedRail(wallet)).use(shieldedWithdrawRail(wallet)).use(arkRail()).use(arkAssetRail());
 const rich=routerOf(fake({canWithdraw:true})),poor=routerOf(fake({canWithdraw:false}));
 assert.deepEqual((await rich.options(req(SHROL,500))).map(o=>o.railId),['shielded']);
 assert.deepEqual((await rich.options(req(ELSEWHERE,500))).map(o=>o.railId),['shielded-withdraw','ark']);
 assert.equal((await rich.route(req(ELSEWHERE,500))).railId,'shielded-withdraw');
 assert.deepEqual((await poor.options(req(ELSEWHERE,500))).map(o=>o.railId),['ark'],'a short pool leaves the public rail');
 assert.equal((await poor.route(req(ELSEWHERE,500))).railId,'ark');
 await assert.rejects(rich.route(req('shrol1qqqq',500)),/no rail for/,'a genesis-1 address routes nowhere rather than paying publicly');
});

test('an asset request carries its units in assets and its carrier in amount, on both shielded rails',async()=>{
 paid.length=0;exited.length=0;
 const wallet=fake(),asset={assetId:ASSET,amount:9n};
 const privately=await shieldedRail(wallet).quote({raw:SHROL,assets:[asset]},ctx(wallet));
 assert.deepEqual([privately.amount,privately.fee,privately.total],[0,0,0]);
 assert.deepEqual(privately.assets,{delivered:asset,spent:asset});
 await privately.send();
 assert.deepEqual(paid,[{to:SHROL,amount:9n,asset:ASSET}],'a private asset payment moves units, with no carrier');
 const out=shieldedWithdrawRail(wallet);
 assert.equal(await out.available!({raw:ELSEWHERE,amount:500,assets:[asset]},ctx(wallet)),true);
 assert.equal(await out.available!({raw:ELSEWHERE,amount:500,assets:[asset,{assetId:'ff'.repeat(34),amount:1n}]},ctx(wallet)),false,'one asset per payment');
 assert.equal(await out.available!({raw:ELSEWHERE,amount:500,assets:[{...asset,amount:0n}]},ctx(wallet)),false);
 await (await out.quote({raw:ELSEWHERE,amount:400,assets:[asset]},ctx(wallet))).send();
 assert.deepEqual(exited,[{to:ELSEWHERE,amount:9n,opts:{asset:ASSET,sats:400n}}],'the carrier size rides the request amount');
});

test('shielded targets require the whole bare address or exactly one bitcoin shielded parameter',()=>{
 const rail=shieldedRail(fake()),c=ctx(fake());
 for(const raw of [`prefix${SHROL}`,`${SHROL}x`,`pay ${SHROL}`,`bitcoin:?label=${SHROL}`,`https://example.com/?shielded=${SHROL}`,`bitcoin:?shielded=${SHROL}&shielded=${SHROL}`,`bitcoin:?shielded=${SHROL}&shielded=`,`bitcoin:?shielded=${SHROL}x`]){
  assert.equal(shieldedTargetOf(raw),undefined,raw);
  assert.doesNotThrow(()=>rail.match(req(raw),c));
  assert.equal(rail.match(req(raw),c),false,raw);
 }
 const encoded=`bitcoin:bc1qxy?shielded=${encodeURIComponent(SHROL)}&label=Private`;
 assert.equal(shieldedTargetOf(encoded),SHROL);
 assert.equal(rail.match(req(encoded),c),true);
});

test('both private rails refuse caller-selected public inputs, including an empty selection',async()=>{
 const wallet=fake(),c=ctx(wallet);
 for(const [rail,raw] of [[shieldedRail(wallet),SHROL],[shieldedWithdrawRail(wallet),ELSEWHERE]] as const)
  for(const selectedVtxos of [[],[{txid:'ab'.repeat(32),vout:0}]] as never[]){
   const request={raw,amount:500,selectedVtxos};
   assert.equal(await rail.available!(request,c),false);
   await assert.rejects(rail.quote(request,c),/selectedVtxos/);
  }
});

test('invalid and unsafe sats never become private amounts or default asset carriers',async()=>{
 const wallet=fake(),c=ctx(wallet),asset={assetId:ASSET,amount:9n};
 for(const [rail,raw] of [[shieldedRail(wallet),SHROL],[shieldedWithdrawRail(wallet),ELSEWHERE]] as const)
  for(const amount of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
   for(const assets of [undefined,[asset]]){
    const request={raw,amount,...(assets?{assets}:{})};
    assert.equal(await rail.available!(request,c),false,`${rail.id}: ${amount}`);
    await assert.rejects(rail.quote(request,c),/whole number of sats/);
   }
 const quote=await shieldedRail(wallet).quote(req(SHROL,Number.MAX_SAFE_INTEGER),c);
 assert.equal(quote.amount,Number.MAX_SAFE_INTEGER);
});

test('asset IDs and units must be valid unsigned 64-bit values before either rail is available',async()=>{
 const wallet=fake(),c=ctx(wallet);
 for(const [rail,raw] of [[shieldedRail(wallet),SHROL],[shieldedWithdrawRail(wallet),ELSEWHERE]] as const)
  for(const asset of [{assetId:ASSET,amount:0n},{assetId:ASSET,amount:-1n},{assetId:ASSET,amount:1n<<64n},{assetId:ASSET,amount:9 as unknown as bigint},{assetId:'not-an-asset',amount:9n},{assetId:'',amount:9n}]){
   const request={raw,amount:500,assets:[asset]};
   assert.equal(await rail.available!(request,c),false);
   await assert.rejects(rail.quote(request,c),/whole number of sats/);
  }
});

test('a private asset quote keeps exact uint64 units in assets and reports zero sats',async()=>{
 paid.length=0;
 const wallet=fake(),asset={assetId:ASSET,amount:(1n<<64n)-1n},request={raw:SHROL,assets:[asset]},rail=shieldedRail(wallet),c=ctx(wallet);
 assert.equal(await rail.available!(request,c),true);
 const quote=await rail.quote(request,c);
 assert.deepEqual([quote.amount,quote.fee,quote.total],[0,0,0]);
 assert.deepEqual(quote.assets,{delivered:asset,spent:asset});
 await quote.send();
 assert.deepEqual(paid,[{to:SHROL,amount:18446744073709551615n,asset:ASSET}]);
});

test('an asset withdrawal defaults to a 330-sat carrier while preserving exact units',async()=>{
 exited.length=0;
 const wallet=fake(),asset={assetId:ASSET,amount:9007199254740993n},request={raw:ELSEWHERE,assets:[asset]},rail=shieldedWithdrawRail(wallet),c=ctx(wallet);
 assert.equal(await rail.available!(request,c),true);
 const quote=await rail.quote(request,c);
 assert.deepEqual([quote.amount,quote.fee,quote.total],[330,0,330]);
 assert.deepEqual(quote.assets,{delivered:asset,spent:asset});
 await quote.send();
 assert.deepEqual(exited,[{to:ELSEWHERE,amount:9007199254740993n,opts:{asset:ASSET,sats:330n}}]);
});

test('explicit invalid URI carriers are rejected unless a valid request amount overrides them',async()=>{
 const wallet=fake(),c=ctx(wallet),assets=[{assetId:ASSET,amount:9n}];
 for(const [rail,target] of [[shieldedRail(wallet),`shielded=${SHROL}`],[shieldedWithdrawRail(wallet),`ark=${ELSEWHERE}`]] as const){
  for(const amount of ['bad','-1','0','','90071992.54740992','0.000000001']){
   const raw=`bitcoin:?${target}&amount=${amount}`,request={raw,assets};
   assert.equal(await rail.available!(request,c),false,`${rail.id}: encoded ${JSON.stringify(amount)}`);
   await assert.rejects(rail.quote(request,c),/whole number of sats/);
   const override={...request,amount:500};
   assert.equal(await rail.available!(override,c),true);
   const quote=await rail.quote(override,c);
   assert.equal(quote.amount,rail.id==='shielded'?0:500);
  }
  const encoded={raw:`bitcoin:?${target}&amount=0.000005`,assets};
  assert.equal(await rail.available!(encoded,c),true);
  assert.equal((await rail.quote(encoded,c)).amount,rail.id==='shielded'?0:500);
 }
});

const lnurlJson=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const INVOICE='lntbs210n1p4dpvmxpp58d4nqkxz5htt4ctfhyvfqnx0947fyp4uvdyg3g9j6xhahn2dytrqdqqcqzzsxqyz5vqsp5nxkcjl99y7h0uyp34xwgw6cldflucq8r7ssk06vylsjld60lfzps9qxpqysgqrf3yfzavh34pu5t8ee9perqp35z6534k6q3m5v5xckdrm4l869yrxrm4pxslwvqtzql96m69hq7sxwptw5fry9u8h3twyrdenungqxcqafud53';
const ALICE='alice@lnurl.example';
const SHIELDED_OPTION:PaymentOption={id:'registered:shielded',type:'shielded',verifiable:false};
const ARKADE_OPTION:PaymentOption={id:'arkade',type:'arkade'},LIGHTNING_OPTION:PaymentOption={id:'lightning',type:'lightning'};
const ANSWERS:Record<string,unknown>={
 'registered:shielded':{status:'OK',paymentOption:'registered:shielded',paymentDestination:SHROL},
 arkade:{status:'OK',paymentOption:'arkade',paymentDestination:ELSEWHERE},
 lightning:{pr:INVOICE,routes:[]},
};
function lnurlService(options?:PaymentOption[]){
 const service={
  options,urls:[] as string[],
  answer:(option:string|null):Response|Promise<Response>=>lnurlJson(ANSWERS[option!]),
  fetchImpl:async(input:string|URL):Promise<Response>=>{
   const url=new URL(String(input));service.urls.push(url.href);
   return url.pathname.endsWith('/alice')
    ?lnurlJson({tag:'payRequest',callback:'https://lnurl.example/cb',minSendable:1000,maxSendable:100_000_000,metadata:'[["text/plain","alice"]]',...(service.options?{paymentOptions:service.options}:{})})
    :service.answer(url.searchParams.get('paymentOption'));
  },
 };
 return service;
}
type LnurlService=ReturnType<typeof lnurlService>;
const shieldedRailOf=(wallet:ShieldedWallet,service:LnurlService)=>lnurlShieldedRail(wallet,createLnurlClient({fetchImpl:service.fetchImpl}));
const callbacks=(service:LnurlService)=>service.urls.filter(u=>u.startsWith('https://lnurl.example/cb')).map(u=>new URL(u));

test('the lnurl-shielded rail is available only when the address advertises a shielded method',async()=>{
 const wallet=fake(),c=ctx(wallet);
 const ask=(options?:PaymentOption[],amount=1000)=>shieldedRailOf(wallet,lnurlService(options)).available!(req(ALICE,amount),c);
 assert.equal(await ask([ARKADE_OPTION,LIGHTNING_OPTION,SHIELDED_OPTION]),true);
 assert.equal(await ask([ARKADE_OPTION,LIGHTNING_OPTION]),false,'arkade and lightning only');
 assert.equal(await ask(undefined),false,'no paymentOptions at all');
 assert.equal(await ask([{...SHIELDED_OPTION,available:false}]),false);
 assert.equal(await ask([{...SHIELDED_OPTION,type:'arkade'}]),false,'the type decides, not the id');
 assert.equal(await ask([{...SHIELDED_OPTION,minSendable:5_000_000}]),false,'below the option\'s own minimum');
 assert.equal(await ask([{...SHIELDED_OPTION,maxSendable:500_000}]),false,'above the option\'s own maximum');
 assert.equal(await ask([SHIELDED_OPTION],100_001),false,'above the payRequest maximum when the option names none');
 assert.equal(await ask([{...SHIELDED_OPTION,maxSendable:200_000_000}],150_000),true,'the option\'s own bounds win over the payRequest\'s');
 const service=lnurlService([SHIELDED_OPTION]),rail=shieldedRailOf(wallet,service);
 for(const raw of [ALICE,'LNURL1DP68GURN8GHJ7'])assert.equal(rail.match(req(raw),c),true,raw);
 for(const raw of [SHROL,POOL,'lnbc2500u1x','not an address',''])assert.equal(rail.match(req(raw),c),false,raw);
 assert.deepEqual(service.urls,[],'classification is format-only');
});

test('it pays the advertised destination through the shielded rail, reporting its own railId',async()=>{
 paid.length=0;
 const wallet=fake(),rail=shieldedRailOf(wallet,lnurlService([SHIELDED_OPTION]));
 assert.equal(rail.id,'lnurl-shielded');
 const quote=await rail.quote(req(ALICE,1000),ctx(wallet));
 assert.deepEqual([quote.railId,quote.amount,quote.fee,quote.total],['lnurl-shielded',1000,0,1000]);
 assert.deepEqual(paid,[],'a quote pays nothing');
 await quote.send();
 assert.deepEqual(paid,[{to:SHROL,amount:1000n}]);
});

test('it sends paymentOption=registered:shielded and nothing else on the callback',async()=>{
 const wallet=fake(),service=lnurlService([SHIELDED_OPTION]);
 await shieldedRailOf(wallet,service).quote(req(ALICE,1000),ctx(wallet));
 const [callback,...more]=callbacks(service);
 assert.equal(more.length,0);
 assert.match(callback!.href,/paymentOption=registered%3Ashielded/);
 assert.deepEqual([...callback!.searchParams],[['amount','1000000'],['paymentOption','registered:shielded']]);
});

test('it refuses a destination that is not a parseable shielded address, or that asks for a memo, without paying',async()=>{
 paid.length=0;
 const wallet=fake(),c=ctx(wallet),NO_ADDRESS=/callback returned no shielded address/,NO_MEMO=/callback requires a memo/;
 const answers:Record<string,[object,RegExp]>={
  'an Arkade address':[{paymentDestination:ELSEWHERE},NO_ADDRESS],
  'the pool address':[{paymentDestination:POOL},NO_ADDRESS],
  'a bitcoin URI with no shielded parameter':[{paymentDestination:`bitcoin:${POOL}`},NO_ADDRESS],
  'nonsense':[{paymentDestination:'nonsense'},NO_ADDRESS],
  'an empty destination':[{paymentDestination:''},NO_ADDRESS],
  'trailing characters':[{paymentDestination:`${SHROL}x`},NO_ADDRESS],
  'no destination':[{},NO_ADDRESS],
  'a memo to attach':[{paymentDestination:SHROL,paymentDestinationTag:'order-17'},NO_MEMO],
  'an empty memo':[{paymentDestination:SHROL,paymentDestinationTag:''},NO_MEMO],
 };
 for(const [label,[fields,message]] of Object.entries(answers)){
  const service=lnurlService([SHIELDED_OPTION]);
  service.answer=()=>lnurlJson({status:'OK',paymentOption:'registered:shielded',...fields});
  const outcome=await shieldedRailOf(wallet,service).quote(req(ALICE,1000),c).catch((error:Error)=>error);
  if(!(outcome instanceof Error))await outcome.send();
  assert.deepEqual(paid,[],`${label}: nothing may reach wallet.pay`);
  assert.match(String(outcome),message,label);
 }
});

test('it refuses an answer for a different paymentOption than the one requested',async()=>{
 const wallet=fake(),c=ctx(wallet);
 const answers:[number,unknown][]=[
  [1000,{status:'OK',paymentOption:'arkade',paymentDestination:SHROL}],
  [1000,{status:'OK',paymentOption:'registered:other',paymentDestination:SHROL}],
  [21,{pr:INVOICE,paymentOption:'registered:shielded'}],
 ];
 for(const [amount,answer] of answers){
  const service=lnurlService([SHIELDED_OPTION]);
  service.answer=()=>lnurlJson(answer);
  await assert.rejects(shieldedRailOf(wallet,service).quote(req(ALICE,amount),c),/did not answer registered:shielded with a destination/,JSON.stringify(answer).slice(0,60));
 }
});

test('the router ranks lnurl-shielded above lnurl-arkade and the Lightning rails',()=>{
 const at=(id:string)=>SHIELDED_PRIORITY.indexOf(id);
 assert.ok(at('lnurl-shielded')>at('shielded-withdraw'),'listed, and after the bare-address rails');
 for(const lower of ['ark','ark-asset','lnurl-arkade','lightning','lnurl-lightning','onchain'])assert.ok(at('lnurl-shielded')<at(lower),lower);
});

test('available answers false, and never throws, when the address or the wallet fails',async()=>{
 const wallet=fake(),c=ctx(wallet),broken=fake({restore:async()=>{throw new Error('journal unreadable');}});
 const failures=[async()=>{throw new TypeError('network down');},async()=>lnurlJson({error:'Bad gateway'},502),async()=>lnurlJson({status:'ERROR',reason:'Unknown LN address'}),async()=>lnurlJson({tag:'withdrawRequest'}),async()=>new Response('<html>')];
 for(const fetchImpl of failures)assert.equal(await lnurlShieldedRail(wallet,createLnurlClient({fetchImpl})).available!(req(ALICE,1000),c),false);
 assert.equal(await shieldedRailOf(broken,lnurlService([SHIELDED_OPTION])).available!(req(ALICE,1000),ctx(broken)),false);
});

test('it is unavailable for assets, chosen coins and any amount that is not whole sats, and asks the service nothing',async()=>{
 const wallet=fake(),c=ctx(wallet),service=lnurlService([SHIELDED_OPTION]),rail=shieldedRailOf(wallet,service);
 const cases:Record<string,PaymentRequest>={
  'an asset request':{raw:ALICE,amount:1000,assets:[{assetId:ASSET,amount:9n}]},
  'a fractional amount':req(ALICE,1.5),
  'a sub-sat amount':req(ALICE,0.5),
  'no amount':req(ALICE),
  'a zero amount':req(ALICE,0),
  'a negative amount':req(ALICE,-1000),
  'an unsafe amount':req(ALICE,Number.MAX_SAFE_INTEGER+1),
  'chosen coins':{...req(ALICE,1000),selectedVtxos:[]} as never,
 };
 for(const [label,request] of Object.entries(cases)){
  assert.equal(await rail.available!(request,c),false,label);
  await assert.rejects(rail.quote(request,c),/whole number of sats/,label);
 }
 assert.deepEqual(service.urls,[]);
});

test('it is unavailable when the wallet cannot pay the amount privately, and available at exactly the limit',async()=>{
 const order:string[]=[],service=lnurlService([SHIELDED_OPTION]);
 const ask=(max:bigint)=>{
  const wallet=fake({max:()=>{order.push('max');return max;},restore:async()=>{order.push('restore');}});
  return shieldedRailOf(wallet,service).available!(req(ALICE,1000),ctx(wallet));
 };
 assert.equal(await ask(1000n),true,'exactly the limit');
 assert.deepEqual(order,['restore','max'],'recorded Lightning spends are restored before the limit is read');
 const asked=service.urls.length;
 assert.equal(await ask(999n),false);
 assert.equal(await ask(0n),false,'nothing spendable');
 assert.equal(service.urls.length,asked,'a payment the wallet cannot make is not asked about');
});

test('a failure of the shielded method hands over to Arkade, then Lightning, and a transient one does not',async t=>{
 const swaps={resolve:async()=>({eligible:1}) as never,markets:async()=>[],accept:async()=>{throw new Error('not accepted here');},onUpdate:()=>()=>{},
  quote:async()=>({id:'q',expiresAt:Math.floor(Date.now()/1000)+600,market:{kind:'card',key:'k'},take:{amount:21n},fee:{amount:1n},give:{amount:22n}}) as never};
 const service=lnurlService([SHIELDED_OPTION,ARKADE_OPTION,LIGHTNING_OPTION]);
 t.mock.method(globalThis,'fetch',service.fetchImpl);
 const wallet=fake(),routerOf=()=>{
  const router=new PaymentRouter({wallet,prefs:{priority:SHIELDED_PRIORITY}} as never);
  for(const rail of lightningRails(wallet,swaps))router.use(rail);
  return router;
 };
 const shielded=(reply:()=>Response)=>{service.answer=option=>option==='registered:shielded'?reply():lnurlJson(ANSWERS[option!]);};
 const route=(router:PaymentRouter,amount=1000)=>{service.urls.length=0;return router.route(req(ALICE,amount));};
 const asked=()=>callbacks(service).map(u=>u.searchParams.get('paymentOption'));

 const router=routerOf();
 assert.deepEqual((await router.options(req(ALICE,1000))).map(o=>o.railId),['lnurl-shielded','lnurl-arkade','lnurl-lightning']);
 assert.equal((await route(router)).railId,'lnurl-shielded');
 assert.deepEqual(asked(),['registered:shielded']);

 const refusals=[()=>lnurlJson({status:'ERROR',reason:'The shielded method is disabled'}),()=>lnurlJson({error:'Not found'},404),()=>lnurlJson({status:'OK',paymentOption:'registered:shielded',paymentDestination:'nonsense'}),
  ()=>lnurlJson({status:'OK',paymentOption:'registered:shielded',paymentDestination:SHROL,paymentDestinationTag:'order-17'})];
 for(const reply of refusals){
  shielded(reply);
  assert.equal((await route(router)).railId,'lnurl-arkade',String(reply));
  assert.deepEqual(asked(),['registered:shielded','arkade']);
 }
 service.options=[SHIELDED_OPTION,LIGHTNING_OPTION];
 shielded(refusals[0]!);
 assert.equal((await route(routerOf(),21)).railId,'lnurl-lightning','with no Arkade option, Lightning is next');
 assert.deepEqual(asked(),['registered:shielded','lightning']);

 service.options=[SHIELDED_OPTION,ARKADE_OPTION,LIGHTNING_OPTION];
 const transient:[()=>Response,RegExp][]=[
  [()=>{throw new TypeError('network down');},/Request failed/],
  [()=>lnurlJson({error:'Too many requests'},429),/Too many requests/],
  [()=>lnurlJson({error:'Bad gateway'},502),/Bad gateway/],
 ];
 for(const [reply,message] of transient){
  shielded(reply);
  await assert.rejects(route(routerOf()),message);
  assert.deepEqual(asked(),['registered:shielded'],'a blip or a rate limit is reported, not paid around');
 }
});

const BTC='tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l';
const YOUNG_FEE={intentFee:{offchainInput:"inputType == 'vtxo' && now() - birth < 86400.0 ? amount * 0.002 : 0.0"},txFeeRate:'0'};
const exitWallet=(o:{covers:boolean;arkade?:number[]})=>{
 const exits:{sats:number;title:string}[]=[],filters:unknown[]=[],payout={txid:'cd'.repeat(32),vout:1,value:20_041,createdAt:new Date(),isSwept:false};
 const wallet={canWithdraw:()=>o.covers,getSpendableVtxos:async(filter:unknown)=>{filters.push(filter);return (o.arkade??[]).map(value=>({value}));},
  exitFromPool:(sats:number,title:string,exit:(coin:unknown)=>Promise<unknown>)=>{exits.push({sats,title});return exit(payout);}} as unknown as ShieldedWallet;
 return {wallet,exits,filters,payout};
};

test('an on-chain send one pool note covers leaves the pool as a coin that nets the exit exactly, and only that coin exits',async()=>{
 const {wallet,exits,payout}=exitWallet({covers:true}),settled:unknown[]=[];
 const ark={wallet:{getAddress:async()=>POOL,settle:async(params:unknown)=>{settled.push(params);return 'ef'.repeat(32);}}} as never;
 const quote=await poolFundedExit(wallet,onchainRail({feeInfo:async()=>YOUNG_FEE}),async()=>YOUNG_FEE).quote(req(BTC,20_000),ark);
 assert.deepEqual([quote.railId,quote.amount,quote.fee,quote.total],['shielded-exit',20_000,41,20_041]);
 assert.equal((await (await quote.send()).settled()).txid,'ef'.repeat(32));
 assert.deepEqual(exits,[{sats:20_041,title:'Sending 20,000 sats on-chain'}]);
 assert.deepEqual(settled,[{inputs:[payout],outputs:[{address:BTC,amount:20_000n}]}],'no change output returns to the Arkade address');
 const free={intentFee:{},txFeeRate:'0'},plain=await poolFundedExit(wallet,onchainRail({feeInfo:async()=>free}),async()=>free).quote(req(BTC,20_000),ark);
 assert.deepEqual([plain.fee,plain.total],[0,20_000]);
});

test('an on-chain send no single pool note covers falls back to the Arkade balance, and is refused at quote when that cannot pay it',async()=>{
 const base=onchainRail({feeInfo:async()=>YOUNG_FEE}),ark={wallet:{}} as never;
 const rich=exitWallet({covers:false,arkade:[15_000,6_000]}),quote=await poolFundedExit(rich.wallet,base,async()=>YOUNG_FEE).quote(req(BTC,20_000),ark);
 assert.deepEqual([quote.railId,quote.total,rich.exits],['onchain',20_000,[]]);
 assert.deepEqual(rich.filters,[{withRecoverable:true,withUnrolled:false,genericallySpendableOnly:true}],'the coins the SDK exit itself would spend');
 const poor=exitWallet({covers:false,arkade:[500]});
 await assert.rejects(poolFundedExit(poor.wallet,base,async()=>YOUNG_FEE).quote(req(BTC,20_000),ark),/No single unreserved pool note covers the 20,041 sats this exit needs, and your Arkade balance holds only 500 sats/);
});
