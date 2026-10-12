import {arkTarget,assertNoSelection,isValidArkAddress,tryResolveSendAmount,type PaymentRail,type PaymentRequest,type RouteQuote} from '@arkade-os/sdk';
import {assetFieldOfId} from '../../packages/protocol/src/rollup/notes.ts';
import {parseRollupAddress} from '../../packages/protocol/src/rollup/wallet.ts';
import {DUST} from './pool.ts';
import type {ShieldedWallet} from './wallet.ts';

export const SHIELDED_PRIORITY=['shielded','shielded-withdraw','ark','ark-asset','onchain'];
export function shieldedTargetOf(raw:string):string|undefined{
 try{
  let target=raw.trim();
  if(/^bitcoin:/i.test(target)){
   const query=target.indexOf('?');
   if(query<0)return undefined;
   const targets=new URLSearchParams(target.slice(query+1)).getAll('shielded');
   if(targets.length!==1)return undefined;
   target=targets[0]!;
  }
  parseRollupAddress(target);return target;
 }catch{return undefined;}
}
const requestOf=(req:PaymentRequest)=>{
 try{
  if(req.selectedVtxos!==undefined)return undefined;
  const assets=req.assets??[],raw=req.raw.trim(),sats=tryResolveSendAmount(raw,req.amount);
  const hasAmount=req.amount!==undefined||(/^bitcoin:/i.test(raw)&&new URLSearchParams(raw.split('?')[1]??'').has('amount'));
  if(assets.length>1||(hasAmount&&sats===undefined)||(sats!==undefined&&!Number.isSafeInteger(sats)))return undefined;
  const asset=assets[0];
  if(asset){
   if(typeof asset.amount!=='bigint'||asset.amount<=0n||asset.amount>=(1n<<64n))return undefined;
   assetFieldOfId(asset.assetId);
   return {units:asset.amount,assetId:asset.assetId,sats};
  }
  return sats===undefined?undefined:{units:BigInt(sats),sats,assetId:undefined as string|undefined};
 }catch{return undefined;}
};
type Resolved=NonNullable<ReturnType<typeof requestOf>>;
const withdrawOpts=(r:Resolved)=>r.assetId?{asset:r.assetId,sats:BigInt(r.sats??DUST)}:{};
const assetView=(r:Resolved)=>r.assetId?{assets:{delivered:{assetId:r.assetId,amount:r.units},spent:{assetId:r.assetId,amount:r.units}}}:{};

export function shieldedRail(wallet:ShieldedWallet):PaymentRail{
 return {
  id:'shielded',
  match:req=>shieldedTargetOf(req.raw)!==undefined,
  available:req=>shieldedTargetOf(req.raw)!==undefined&&requestOf(req)!==undefined,
  quote:async(req):Promise<RouteQuote>=>{
   assertNoSelection('shielded',req);
   const to=shieldedTargetOf(req.raw),r=requestOf(req);
   if(!to)throw new Error('Not a shielded address.');
   if(!r)throw new Error('A private payment needs a whole number of sats, or one asset and its units.');
   const amount=r.assetId?0:r.sats!;
   return {railId:'shielded',amount,fee:0,total:amount,...assetView(r),send:()=>wallet.pay(to,r.units,r.assetId)};
  },
 };
}
export function shieldedWithdrawRail(wallet:ShieldedWallet):PaymentRail{
 const target=(raw:string)=>{try{const found=arkTarget(raw.trim());return found&&isValidArkAddress(found)&&found.toLowerCase()!==wallet.poolAddress.toLowerCase()?found:undefined;}catch{return undefined;}};
 return {
  id:'shielded-withdraw',
  match:req=>target(req.raw)!==undefined,
  available:req=>{
   const r=requestOf(req);
   if(!r||!target(req.raw))return false;
   try{return wallet.canWithdraw(r.units,withdrawOpts(r));}catch{return false;}
  },
  quote:async(req):Promise<RouteQuote>=>{
   assertNoSelection('shielded-withdraw',req);
   const to=target(req.raw),r=requestOf(req);
   if(!to)throw new Error('Not an Arkade address this pool can pay out to.');
   if(!r)throw new Error('A withdrawal needs a whole number of sats, or one asset and its units.');
   const amount=r.sats??DUST;
   return {railId:'shielded-withdraw',amount,fee:0,total:amount,...assetView(r),send:()=>wallet.withdraw(to,r.units,withdrawOpts(r))};
  },
 };
}
