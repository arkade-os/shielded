import type {PaymentRail} from '@arkade-os/sdk';
import {createLnurlClient} from '@arkade-os/lnurl-client';
import {lnurlRails} from '@arkade-os/lnurl-client/arkade';
import {QuoteExpired,lightningRail,type SwapClient,type SwapRailClient} from '@arkade-os/swap';
import {DUST} from './pool.ts';
import {shieldedWithdrawRail} from './rails.ts';
import type {ShieldedWallet} from './wallet.ts';

export const LNURL_BASE='https://lnurl.mutinynet.arkade.sh';
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
  const pay=async()=>{
   try{return await quote.send();}
   catch(error){
    if(!(error instanceof QuoteExpired))throw error;
    const fresh=await rail.quote(req,ctx);
    if(fresh.total>quote.total)throw new Error(`The swap now costs ${sats(fresh.total)} sats, not ${sats(quote.total)}. Review the payment again.`);
    return fresh.send();
   }
  };
  return {...quote,send:async()=>wallet.topUp(quote.total,`Paying ${sats(quote.amount)} sats over Lightning`,pay)};
 }};
}

export function lightningRails(wallet:ShieldedWallet,swaps:SwapRailClient&Pick<SwapClient,'markets'>):PaymentRail[]{
 const base=lightningRail(swaps);
 // `available` resolves offline against the cached registry, which nothing has fetched on a fresh page.
 const lightning=poolFunded(wallet,{...base,available:async(req,ctx)=>{await swaps.markets().catch(()=>{});return base.available!(req,ctx);}});
 return [lightning,...lnurlRails({client:createLnurlClient(),arkade:shieldedWithdrawRail(wallet),lightning})];
}
