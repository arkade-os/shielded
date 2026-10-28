import {isLnurl,type PaymentRail,type PaymentRequest,type RouterContext} from '@arkade-os/sdk';
import {LnurlError,LnurlTransportError,createLnurlClient,type LnurlClient,type PayRequest} from '@arkade-os/lnurl-client';
import {lnurlRails} from '@arkade-os/lnurl-client/arkade';
import {lightningRail,type SwapClient,type SwapRailClient} from '@arkade-os/swap';
import {shieldedRail,shieldedTargetOf,shieldedWithdrawRail} from './rails.ts';
import type {ShieldedWallet} from './wallet.ts';

export const LNURL_BASE='https://lnurl.mutinynet.arkade.sh';
const sats=(value:number)=>value.toLocaleString('en-US');
// A network blip is not a refusal: falling back on one would charge a swap fee for a payment the pool could make free.
const transient=(error:unknown)=>error instanceof LnurlTransportError||(error instanceof LnurlError&&(error.retryable||(error.httpStatus??0)>=500));

export function poolFunded(wallet:ShieldedWallet,rail:PaymentRail):PaymentRail{
 return {...rail,async quote(req,ctx){
  await wallet.restoreLightningSpends();
  if(req.amount!==undefined&&(!Number.isSafeInteger(req.amount)||req.amount<=0||!wallet.canWithdraw(BigInt(req.amount))))throw new Error('No single unreserved pool note covers this Lightning payment.');
  const quote=await rail.quote(req,ctx);
  const check=()=>{if(!Number.isSafeInteger(quote.total)||quote.total<=0||!wallet.canWithdraw(BigInt(quote.total)))throw new Error(`No single unreserved pool note covers the ${sats(quote.total)} sats this Lightning payment needs.`);};
  check();return {...quote,send:async()=>{await wallet.restoreLightningSpends();check();const expiresAt=(quote.meta as {expiresAt?:number}|undefined)?.expiresAt;if(expiresAt!==undefined&&expiresAt*1000<=Date.now())throw new Error('This Lightning quote expired. Request a new quote before paying.');return quote.send();}};
 }};
}

// ponytail: own resolve, no shared cache; thread it through lnurlRails' cache if the double GET ever matters
export function lnurlShieldedRail(wallet:ShieldedWallet,client:LnurlClient):PaymentRail{
 const id='lnurl-shielded',inner=shieldedRail(wallet);
 const payable=(req:PaymentRequest):req is PaymentRequest&{amount:number}=>typeof req.amount==='number'&&Number.isSafeInteger(req.amount)&&req.amount>0&&!req.assets?.length&&req.selectedVtxos===undefined;
 const optionOf=(pr:PayRequest)=>pr.paymentOptions?.find(o=>o.type==='shielded'&&o.available!==false);
 return {
  id,
  match:req=>isLnurl(req.raw.trim()),
  available:async req=>{
   try{
    if(!payable(req))return false;
    await wallet.restoreLightningSpends();
    if(BigInt(req.amount)>wallet.maxPrivatePayment())return false;
    const pr=await client.resolve(req.raw.trim()),option=optionOf(pr),msat=req.amount*1e3;
    return option!==undefined&&msat>=(option.minSendable??pr.minSendable)&&msat<=(option.maxSendable??pr.maxSendable);
   }catch{return false;}
  },
  quote:async(req,ctx)=>{
   if(!payable(req))throw new LnurlError(`${id} pays a whole number of sats from the pool, with no assets or chosen coins`);
   const pr=await client.resolve(req.raw.trim()),option=optionOf(pr);
   if(!option)throw new LnurlError(`${id}: this address advertises no shielded method`);
   const answer=await client.requestInvoice(pr,{amountSat:req.amount,paymentOption:option.id});
   if(answer.kind!=='destination'||answer.paymentOption!==option.id)throw new LnurlError(`${id}: the callback did not answer ${option.id} with a destination`);
   if(answer.paymentDestinationTag!==undefined)throw new LnurlError(`${id}: the callback requires a memo, which this wallet cannot attach`);
   const to=shieldedTargetOf(answer.paymentDestination??'');
   if(!to)throw new LnurlError(`${id}: the callback returned no shielded address to pay`);
   return {...await inner.quote({...req,raw:to},ctx),railId:id};
  },
 };
}

export function lightningRails(wallet:ShieldedWallet,swaps:SwapRailClient&Pick<SwapClient,'markets'>):PaymentRail[]{
 const base=lightningRail(swaps);
 // `available` resolves offline against the cached registry, which nothing has fetched on a fresh page.
 const lightning=poolFunded(wallet,{...base,available:async(req,ctx)=>{await swaps.markets().catch(()=>{});return base.available!(req,ctx);}});
 const client=createLnurlClient();
 const [arkade,viaLightning]=lnurlRails({client,arkade:shieldedWithdrawRail(wallet),lightning}) as [PaymentRail,PaymentRail];
 const handOver=async(error:unknown,req:PaymentRequest,ctx:RouterContext,...rails:PaymentRail[])=>{
  if(!transient(error))for(const rail of rails)if(await Promise.resolve().then(()=>rail.available!(req,ctx)).catch(()=>false))return rail.quote(req,ctx);
  throw error;
 };
 // The router quotes only its top option, and the Arkade destination is known only after the callback: one the pool
 // cannot pay in one note, or under another operator, hands over to the Lightning option here.
 const lnurlArkade:PaymentRail={...arkade,
  available:async(req,ctx)=>{await wallet.restoreLightningSpends();return Number.isSafeInteger(req.amount)&&wallet.canWithdraw(BigInt(req.amount!))&&await arkade.available!(req,ctx);},
  quote:async(req,ctx)=>{try{return await arkade.quote(req,ctx);}catch(error){return handOver(error,req,ctx,viaLightning);}}};
 const shielded=lnurlShieldedRail(wallet,client);
 // A hand-over from the private route lands on a public one, and the quote's copy says so before anything is sent.
 const lnurlShielded:PaymentRail={...shielded,quote:async(req,ctx)=>{try{return await shielded.quote(req,ctx);}catch(error){return handOver(error,req,ctx,lnurlArkade,viaLightning);}}};
 return [lightning,lnurlArkade,viaLightning,lnurlShielded];
}
