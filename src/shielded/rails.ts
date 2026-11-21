import {ArkAddress,Estimator,arkAssetRail,arkTarget,assertNoSelection,btcTarget,isValidArkAddress,tryResolveSendAmount,type FeeInfo,type PaymentRail,type PaymentRequest,type RouteQuote} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {assetFieldOfId} from '../../packages/protocol/src/rollup/notes.ts';
import {parseRollupAddress} from '../../packages/protocol/src/rollup/wallet.ts';
import {DUST} from './pool.ts';
import type {ShieldedWallet} from './wallet.ts';

export const SHIELDED_PRIORITY=['shielded','shielded-withdraw','lnurl-shielded','ark','ark-asset','lnurl-arkade','lightning','lnurl-lightning','onchain'];
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
 // A payout pays only the address's program, so another network's or operator's address would get sats it never sees.
 const sameOperator=(found:string)=>{const to=ArkAddress.decode(found),pool=ArkAddress.decode(wallet.poolAddress);return to.hrp===pool.hrp&&hex.encode(to.serverPubKey)===hex.encode(pool.serverPubKey);};
 const target=(raw:string)=>{try{const found=arkTarget(raw.trim());return found&&isValidArkAddress(found)&&found.toLowerCase()!==wallet.poolAddress.toLowerCase()&&sameOperator(found)?found:undefined;}catch{return undefined;}};
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
   if(!wallet.canWithdraw(r.units,withdrawOpts(r)))throw new Error('No single note in the pool covers this amount.');
   const amount=r.sats??DUST;
   return {railId:'shielded-withdraw',amount,fee:0,total:amount,...assetView(r),meta:{to},send:()=>wallet.withdraw(to,r.units,withdrawOpts(r))};
  },
 };
}
// The SDK exit refuses change below the dust, so the payout nets the exit exactly: the least gross = total + fee(gross).
function freshPayoutFor(total:number,fees:FeeInfo):number{
 const estimator=new Estimator(fees.intentFee??{}),fee=(gross:number)=>estimator.evalOffchainInput({amount:BigInt(gross),type:'vtxo',weight:0,birth:new Date()}).satoshis;
 for(let gross=total,i=0;i<16;i++){const next=total+fee(gross);if(next===gross)return gross;gross=next;}
 throw new Error('No payout covers this exit after the Arkade input fee.');
}
/** An on-chain exit spends Arkade coins, which auto-shield keeps near empty, so one pool note pays a fresh single-use key a coin that exits alone. */
export function poolFundedExit(wallet:ShieldedWallet,rail:PaymentRail,feeInfo:()=>Promise<FeeInfo>):PaymentRail{
 const sats=(value:number)=>value.toLocaleString('en-US');
 return {...rail,async quote(req,ctx){
  wallet.assertBatchSwaps();
  const quote=await rail.quote(req,ctx);
  if(req.selectedVtxos)return quote;
  const gross=freshPayoutFor(quote.total,await feeInfo());
  if(!wallet.canWithdraw(BigInt(gross))){
   const have=(await wallet.getSpendableVtxos({withRecoverable:true,withUnrolled:false,genericallySpendableOnly:true})).reduce((sum,v)=>sum+v.value,0);
   if(have<quote.total)throw new Error(`No single unreserved pool note covers the ${sats(gross)} sats this exit needs, and your Arkade balance holds only ${sats(have)} sats.`);
   return quote;
  }
  if(!wallet.canExitPrivately())throw new Error('A private on-chain exit needs the recoverable companion wallet, which is not open. Reload and try again.');
  return {...quote,railId:'shielded-exit',fee:gross-quote.amount,total:gross,
   send:async()=>wallet.exitFromPool(gross,`Sending ${sats(quote.amount)} sats on-chain`,async(coin,payout)=>(await rail.quote({...req,selectedVtxos:[coin]},{...ctx,wallet:payout})).send(),{to:btcTarget(req.raw)??req.raw,sats:quote.amount})};
 }};
}
export const ASSET_CARRIER_SHORT_BARE='Sending this asset needs more sats on Arkade than this wallet keeps there, because it moves its Arkade sats into the pool.';
export const ASSET_CARRIER_SHORT=`${ASSET_CARRIER_SHORT_BARE} Send all of it, with the default 330-sat carrier.`;
const unitsOf=(coin:{assets?:readonly {assetId:string;amount:bigint}[]},assetId:string)=>coin.assets?.find(a=>a.assetId===assetId)?.amount??0n;
/** The sats an Arkade asset send lacks when it picks coins as the SDK send does: that asset's smallest-first, then any coin's sats. */
export function assetCarrierShortfall(coins:readonly {value:number;assets?:readonly {assetId:string;amount:bigint}[]}[],assetId:string,units:bigint,carrier:number):number{
 let picked=0n,otherAssets=false;
 for(const coin of coins.filter(c=>c.assets?.some(a=>a.assetId===assetId)).sort((a,b)=>Number(unitsOf(a,assetId)-unitsOf(b,assetId)))){
  if(picked>=units)break;
  picked+=unitsOf(coin,assetId);otherAssets||=coin.assets!.some(a=>a.assetId!==assetId);
 }
 if(picked<units)return 0;
 // ponytail: a pulled-in coin's own asset change can need another 330 sats. The SDK refuses that at send time, before building.
 const need=picked>units||otherAssets?carrier+DUST:Math.max(carrier,DUST);
 return Math.max(0,need-coins.reduce((sum,c)=>sum+c.value,0));
}
export function unshieldedAssetRail(wallet:Pick<ShieldedWallet,'getSpendableVtxos'>,rail:PaymentRail=arkAssetRail()):PaymentRail{
 return {...rail,async quote(req,ctx){
  const quote=await rail.quote(req,ctx),spent=quote.assets?.spent;
  if(req.selectedVtxos||!spent)return quote;
  const coins=await wallet.getSpendableVtxos({withRecoverable:false,genericallySpendableOnly:true}),{assetId}=spent;
  if(assetCarrierShortfall(coins,assetId,spent.amount,quote.amount)===0)return quote;
  const all=coins.reduce((sum,c)=>sum+unitsOf(c,assetId),0n);
  throw new Error(assetCarrierShortfall(coins,assetId,all,DUST)===0?ASSET_CARRIER_SHORT:ASSET_CARRIER_SHORT_BARE);
 }};
}
