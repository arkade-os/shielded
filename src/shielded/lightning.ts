import type {PaymentRail} from '@arkade-os/sdk';
import {LnurlError,LnurlTransportError,createLnurlClient} from '@arkade-os/lnurl-client';
import {lnurlRails} from '@arkade-os/lnurl-client/arkade';
import {lightningRail,type SwapClient,type SwapRailClient} from '@arkade-os/swap';
import {DUST} from './pool.ts';
import {shieldedWithdrawRail} from './rails.ts';
import type {ShieldedWallet} from './wallet.ts';

export const LNURL_BASE='https://lnurl.mutinynet.arkade.sh';
const QUOTE_MARGIN_MS=10_000;
const sats=(value:number)=>value.toLocaleString('en-US');
// A network blip is not a refusal: falling back on one would charge a swap fee for a payment the pool could make free.
const transient=(error:unknown)=>error instanceof LnurlTransportError||(error instanceof LnurlError&&(error.retryable||(error.httpStatus??0)>=500));

/**
 * A swap rail funds from the Arkade balance, which auto-shield keeps near empty, so the shortfall leaves the pool first.
 * Refused at quote time when no single note covers it, rather than after the user confirms.
 */
export function poolFunded(wallet:ShieldedWallet,rail:PaymentRail):PaymentRail{
 return {...rail,async quote(req,ctx){
  const quote=await rail.quote(req,ctx),have=await wallet.arkadeSats(),lacking=quote.total-have;
  // An expired quote is refused inside the handle, after send() has returned, so the check has to come first.
  const live=async()=>{
   const expiresAt=(quote.meta as {expiresAt?:number}|undefined)?.expiresAt;
   if(expiresAt===undefined||expiresAt*1000>Date.now()+QUOTE_MARGIN_MS)return quote;
   const fresh=await rail.quote(req,ctx);
   if(fresh.total>quote.total)throw new Error(`The swap now costs ${sats(fresh.total)} sats, not ${sats(quote.total)}. Review the payment again; any sats withdrawn for it stay on your Arkade balance.`);
   return fresh;
  };
  if(lacking<=0)return {...quote,send:async()=>(await live()).send()};
  const withdrawn=Math.max(lacking,DUST);
  if(!wallet.canWithdraw(BigInt(withdrawn)))throw new Error(`This payment needs ${sats(quote.total)} sats on your Arkade balance, which holds ${sats(have)}, and no single note in the pool covers the other ${sats(withdrawn)}.`);
  return {...quote,send:async()=>wallet.topUp(quote.total,`Paying ${sats(quote.amount)} sats over Lightning`,async()=>(await live()).send())};
 }};
}

export function lightningRails(wallet:ShieldedWallet,swaps:SwapRailClient&Pick<SwapClient,'markets'>):PaymentRail[]{
 const base=lightningRail(swaps);
 // `available` resolves offline against the cached registry, which nothing has fetched on a fresh page.
 const lightning=poolFunded(wallet,{...base,available:async(req,ctx)=>{await swaps.markets().catch(()=>{});return base.available!(req,ctx);}});
 const [arkade,viaLightning]=lnurlRails({client:createLnurlClient(),arkade:shieldedWithdrawRail(wallet),lightning}) as [PaymentRail,PaymentRail];
 // The router quotes only its top option, and the Arkade destination is known only after the callback: one the pool
 // cannot pay in one note, or under another operator, hands over to the Lightning option here.
 const lnurlArkade:PaymentRail={...arkade,
  available:async(req,ctx)=>Number.isSafeInteger(req.amount)&&wallet.canWithdraw(BigInt(req.amount!))&&await arkade.available!(req,ctx),
  quote:async(req,ctx)=>{try{return await arkade.quote(req,ctx);}catch(error){if(!transient(error)&&await Promise.resolve().then(()=>viaLightning.available!(req,ctx)).catch(()=>false))return viaLightning.quote(req,ctx);throw error;}}};
 return [lightning,lnurlArkade,viaLightning];
}
