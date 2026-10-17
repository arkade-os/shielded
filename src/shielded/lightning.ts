import type {PaymentRail} from '@arkade-os/sdk';
import {LnurlError,LnurlTransportError,createLnurlClient} from '@arkade-os/lnurl-client';
import {lnurlRails} from '@arkade-os/lnurl-client/arkade';
import {lightningRail,type SwapClient,type SwapRailClient} from '@arkade-os/swap';
import {shieldedWithdrawRail} from './rails.ts';
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

export function lightningRails(wallet:ShieldedWallet,swaps:SwapRailClient&Pick<SwapClient,'markets'>):PaymentRail[]{
 const base=lightningRail(swaps);
 // `available` resolves offline against the cached registry, which nothing has fetched on a fresh page.
 const lightning=poolFunded(wallet,{...base,available:async(req,ctx)=>{await swaps.markets().catch(()=>{});return base.available!(req,ctx);}});
 const [arkade,viaLightning]=lnurlRails({client:createLnurlClient(),arkade:shieldedWithdrawRail(wallet),lightning}) as [PaymentRail,PaymentRail];
 // The router quotes only its top option, and the Arkade destination is known only after the callback: one the pool
 // cannot pay in one note, or under another operator, hands over to the Lightning option here.
 const lnurlArkade:PaymentRail={...arkade,
  available:async(req,ctx)=>{await wallet.restoreLightningSpends();return Number.isSafeInteger(req.amount)&&wallet.canWithdraw(BigInt(req.amount!))&&await arkade.available!(req,ctx);},
  quote:async(req,ctx)=>{try{return await arkade.quote(req,ctx);}catch(error){if(!transient(error)&&await Promise.resolve().then(()=>viaLightning.available!(req,ctx)).catch(()=>false))return viaLightning.quote(req,ctx);throw error;}}};
 return [lightning,lnurlArkade,viaLightning];
}
