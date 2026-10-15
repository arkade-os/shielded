import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,PaymentRouter,SingleKey,makeHandle,type PaymentRail,type PaymentRequest,type RouteQuote} from '@arkade-os/sdk';
import type {SwapRailClient} from '@arkade-os/swap';
import {lightningRails,poolFunded} from '../src/shielded/lightning.ts';
import {SHIELDED_PRIORITY,shieldedRail,shieldedWithdrawRail} from '../src/shielded/rails.ts';
import type {ShieldedWallet} from '../src/shielded/wallet.ts';

const INVOICE='lntbs210n1p4dpvmxpp58d4nqkxz5htt4ctfhyvfqnx0947fyp4uvdyg3g9j6xhahn2dytrqdqqcqzzsxqyz5vqsp5nxkcjl99y7h0uyp34xwgw6cldflucq8r7ssk06vylsjld60lfzps9qxpqysgqrf3yfzavh34pu5t8ee9perqp35z6534k6q3m5v5xckdrm4l869yrxrm4pxslwvqtzql96m69hq7sxwptw5fry9u8h3twyrdenungqxcqafud53';
const POOL='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const decoded=ArkAddress.decode(POOL),PAYEE=new ArkAddress(decoded.serverPubKey,new Uint8Array(32).fill(7),decoded.hrp).encode();
const handle=()=>makeHandle('lightning',async emit=>{const result={railId:'lightning',txid:'ab'.repeat(32)};emit({status:'settled',result});return result;});

function fakeWallet(o:{arkade:number;canWithdraw?:boolean}){
 const topUps:{need:number;title:string}[]=[],checked:bigint[]=[];
 const wallet={
  poolAddress:POOL,
  arkadeSats:async()=>o.arkade,
  canWithdraw:(amount:bigint)=>{checked.push(amount);return o.canWithdraw??true;},
  topUp:(need:number,title:string,pay:()=>Promise<unknown>)=>{topUps.push({need,title});return pay();},
 } as unknown as ShieldedWallet;
 return {wallet,topUps,checked};
}
const later=()=>Math.floor(Date.now()/1000)+600;
function fakeRail(quotes:{total:number;send:()=>ReturnType<typeof handle>;expiresAt?:number}[]){
 let quoted=0;const sent:number[]=[];
 const rail:PaymentRail={id:'lightning',match:()=>true,available:async()=>true,
  quote:async()=>{const i=Math.min(quoted++,quotes.length-1),q=quotes[i]!;
   return {railId:'lightning',amount:q.total-3,fee:3,total:q.total,meta:{expiresAt:q.expiresAt??later()},send:async()=>{sent.push(i);return q.send();}} as RouteQuote;}};
 return {rail,quoted:()=>quoted,sent};
}
const req=(raw:string,amount?:number):PaymentRequest=>({raw,...(amount!==undefined?{amount}:{})});

test('a payment the Arkade balance covers goes straight to the swap, with no withdrawal',async()=>{
 const {wallet,topUps}=fakeWallet({arkade:5000}),inner=fakeRail([{total:1003,send:handle}]);
 await (await (await poolFunded(wallet,inner.rail).quote(req(INVOICE),{} as never)).send()).settled();
 assert.deepEqual([topUps,inner.sent],[[],[0]]);
});

test('a short balance tops up the whole need, refusing at quote time when no single note covers the dust-floored shortfall',async()=>{
 const rich=fakeWallet({arkade:900}),quote=await poolFunded(rich.wallet,fakeRail([{total:1003,send:handle}]).rail).quote(req(INVOICE),{} as never);
 assert.deepEqual(rich.checked,[330n],'103 sats short withdraws the 330-sat minimum');
 await (await quote.send()).settled();
 assert.deepEqual(rich.topUps,[{need:1003,title:'Paying 1,000 sats over Lightning'}]);
 const poor=fakeWallet({arkade:0,canWithdraw:false});
 await assert.rejects(poolFunded(poor.wallet,fakeRail([{total:5003,send:handle}]).rail).quote(req(INVOICE),{} as never),/holds 0, and no single note in the pool covers the other 5,003/);
});

test('a quote the withdrawal outlived is replaced before sending, and refused if the total rose',async()=>{
 const {wallet}=fakeWallet({arkade:0}),past=Math.floor(Date.now()/1000)-1;
 const fresh=fakeRail([{total:1003,send:handle},{total:1003,send:handle}]);
 await (await (await poolFunded(wallet,fresh.rail).quote(req(INVOICE),{} as never)).send()).settled();
 assert.deepEqual([fresh.quoted(),fresh.sent],[1,[0]],'a live quote is sent as it is');
 const stale=fakeRail([{total:1003,send:handle,expiresAt:past},{total:1003,send:handle}]);
 await (await (await poolFunded(wallet,stale.rail).quote(req(INVOICE),{} as never)).send()).settled();
 assert.deepEqual([stale.quoted(),stale.sent],[2,[1]],'the expired one never reaches accept');
 const dearer=fakeRail([{total:1003,send:handle,expiresAt:past},{total:1010,send:handle}]);
 await assert.rejects((await poolFunded(wallet,dearer.rail).quote(req(INVOICE),{} as never)).send(),/now costs 1,010 sats, not 1,003/);
 assert.deepEqual(dearer.sent,[]);
 const rich=fakeWallet({arkade:5000}),covered=fakeRail([{total:1003,send:handle,expiresAt:past},{total:1003,send:handle}]);
 await (await (await poolFunded(rich.wallet,covered.rail).quote(req(INVOICE),{} as never)).send()).settled();
 assert.deepEqual([covered.quoted(),covered.sent,rich.topUps],[2,[1],[]],'a covered payment refreshes too, without a withdrawal');
});

test('a Lightning address whose Arkade destination the pool cannot pay hands over to its Lightning option',async t=>{
 const foreign=new ArkAddress(await SingleKey.fromPrivateKey(new Uint8Array(32).fill(5)).xOnlyPublicKey(),new Uint8Array(32).fill(7),decoded.hrp).encode();
 t.mock.method(globalThis,'fetch',async(url:string|URL)=>{
  const u=new URL(String(url));
  const body=u.pathname.endsWith('/alice')?{tag:'payRequest',callback:'https://pay.example/cb',minSendable:1000,maxSendable:100_000_000,metadata:'[["text/plain","alice"]]',
   paymentOptions:[{id:'arkade',type:'arkade'},{id:'lightning',type:'lightning'}]}
   :u.searchParams.get('paymentOption')==='arkade'?{status:'OK',paymentOption:'arkade',paymentDestination:foreign}:{pr:INVOICE,routes:[]};
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 });
 const swaps={resolve:async()=>({eligible:1}) as never,markets:async()=>[],accept:async()=>{throw new Error('not accepted here');},onUpdate:()=>()=>{},
  quote:async()=>({id:'q',expiresAt:Math.floor(Date.now()/1000)+600,market:{kind:'card',key:'k'},take:{amount:21n},fee:{amount:1n},give:{amount:22n}}) as never};
 const {wallet}=fakeWallet({arkade:0}),router=new PaymentRouter({wallet,prefs:{priority:SHIELDED_PRIORITY}} as never);
 for(const rail of lightningRails(wallet,swaps))router.use(rail);
 const quote=await router.route(req('alice@pay.example',21));
 assert.deepEqual([quote.railId,quote.total],['lnurl-lightning',22],'another operator\'s Arkade address is never paid from the pool');
});

test('the wallet router sends an invoice to lightning, and a Lightning address to its Arkade option before Lightning',async t=>{
 let warmed=0;
 const swaps={resolve:async()=>{if(!warmed)throw new Error('nothing is cached');return {eligible:1} as never;},markets:async()=>{warmed++;return [];},
  quote:async()=>{throw new Error('not quoted here');},accept:async()=>{throw new Error('not accepted here');},onUpdate:()=>()=>{}} satisfies SwapRailClient&{markets:unknown};
 t.mock.method(globalThis,'fetch',async(url:string|URL)=>{
  assert.equal(String(url),'https://pay.example/.well-known/lnurlp/alice');
  return new Response(JSON.stringify({tag:'payRequest',callback:'https://pay.example/cb',minSendable:1000,maxSendable:100_000_000,metadata:'[["text/plain","alice"]]',
   paymentOptions:[{id:'arkade',type:'arkade'},{id:'lightning',type:'lightning'}]}),{headers:{'content-type':'application/json'}});
 });
 const routerOf=(canWithdraw:boolean)=>{
  const {wallet}=fakeWallet({arkade:0,canWithdraw}),router=new PaymentRouter({wallet,prefs:{priority:SHIELDED_PRIORITY}} as never)
   .use(shieldedRail(wallet)).use(shieldedWithdrawRail(wallet));
  for(const rail of lightningRails(wallet,swaps))router.use(rail);
  return router;
 };
 const router=routerOf(true);
 assert.deepEqual((await router.options(req(INVOICE))).map(o=>o.railId),['lightning'],'the registry is fetched before the offline resolve');
 assert.deepEqual((await router.options(req('alice@pay.example',2000))).map(o=>o.railId),['lnurl-arkade','lnurl-lightning']);
 assert.deepEqual((await router.options(req(PAYEE,2000))).map(o=>o.railId),['shielded-withdraw'],'an Arkade address still leaves the pool directly');
 assert.deepEqual((await routerOf(false).options(req('alice@pay.example',2000))).map(o=>o.railId),['lnurl-lightning'],'a pool that cannot pay it whole leaves the Lightning option first');
});
