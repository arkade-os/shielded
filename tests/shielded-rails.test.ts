import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,PaymentRouter,arkAssetRail,arkRail,isValidArkAddress,type PaymentRequest} from '@arkade-os/sdk';
import {buildPoseidon} from 'circomlibjs';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {SHIELDED_PRIORITY,shieldedRail,shieldedTargetOf,shieldedWithdrawRail} from '../src/shielded/rails.ts';
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
const fake=(o:{canWithdraw?:boolean|(()=>never)}={})=>({
 pool:{status:{pool:{address:POOL}}},
 poolAddress:POOL,
 canWithdraw:typeof o.canWithdraw==='function'?o.canWithdraw:()=>o.canWithdraw??true,
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
