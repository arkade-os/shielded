import type {PaymentRail} from '@arkade-os/sdk';
import {createLnurlClient} from '@arkade-os/lnurl-client';
import {lnurlRails} from '@arkade-os/lnurl-client/arkade';
import {lightningRail,type SwapClient,type SwapRailClient} from '@arkade-os/swap';
import {DUST} from './pool.ts';
import {shieldedWithdrawRail} from './rails.ts';
import type {ShieldedWallet} from './wallet.ts';

export const LNURL_BASE='https://lnurl.mutinynet.arkade.sh';
const QUOTE_MARGIN_MS=10_000;
const sats=(value:number)=>value.toLocaleString('en-US');

/**
 * A swap rail funds from the Arkade balance, which auto-shield keeps near empty, so the shortfall leaves the pool first.
 * Refused at quote time when no single note covers it, rather than after the user confirms.
 */
export function poolFunded(wallet:ShieldedWallet,rail:PaymentRail):PaymentRail{
 return {...rail,async quote(req,ctx){
  const quote=await rail.quote(req,ctx),have=await wallet.arkadeSats(),lacking=quote.total-have;
  if(lacking<=0)return quote;
  const withdrawn=Math.max(lacking,DUST);
  if(!wallet.canWithdraw(BigInt(withdrawn)))throw new Error(`This payment needs ${sats(quote.total)} sats on your Arkade balance, which holds ${sats(have)}, and no single note in the pool covers the other ${sats(withdrawn)}.`);
  // An expired quote is refused inside the handle, after send() has returned, so the check has to come first.
  const live=async()=>{
   const expiresAt=(quote.meta as {expiresAt?:number}|undefined)?.expiresAt;
   if(expiresAt===undefined||expiresAt*1000>Date.now()+QUOTE_MARGIN_MS)return quote;
   const fresh=await rail.quote(req,ctx);
   if(fresh.total>quote.total)throw new Error(`The swap now costs ${sats(fresh.total)} sats, not ${sats(quote.total)}. Review the payment again.`);
   return fresh;
  };
  return {...quote,send:async()=>wallet.topUp(quote.total,`Paying ${sats(quote.amount)} sats over Lightning`,async()=>(await live()).send())};
 }};
}

export function lightningRails(wallet:ShieldedWallet,swaps:SwapRailClient&Pick<SwapClient,'markets'>):PaymentRail[]{
 const base=lightningRail(swaps);
 // `available` resolves offline against the cached registry, which nothing has fetched on a fresh page.
 const lightning=poolFunded(wallet,{...base,available:async(req,ctx)=>{await swaps.markets().catch(()=>{});return base.available!(req,ctx);}});
 // The router quotes only its top option and lnurl's `available` never asks the inner rail, so the pool check goes here.
 return [lightning,...lnurlRails({client:createLnurlClient(),arkade:shieldedWithdrawRail(wallet),lightning}).map((rail):PaymentRail=>rail.id!=='lnurl-arkade'?rail:{...rail,
  available:async(req,ctx)=>Number.isSafeInteger(req.amount)&&wallet.canWithdraw(BigInt(req.amount!))&&await rail.available!(req,ctx)})];
}
