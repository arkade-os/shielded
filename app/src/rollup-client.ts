import {DUST,planFeeOf,rejected,shieldPlan,shieldableWithFee,type ArkCoin,type RollupPoolStatus,type ShieldPlan} from '../../src/shielded/pool.ts';
import type {PrivateReceiveState} from '../../src/shielded/lnurl-receive.ts';
import {decodeClaimToken} from '../../packages/protocol/src/rollup/bearer.ts';
import {CARRIER_FREE_SATS,acceptsDepositFee,type DepositFeeSchedule} from '../../packages/protocol/src/rollup/deposit-fee.ts';
import type {EpochHistoryEntry} from '../../packages/protocol/src/rollup/epoch-account.ts';
import type {Market} from '@arkade-os/swap';

export * from '../../src/shielded/pool.ts';
export * from '../../src/shielded/epoch-pool.ts';

/** Why the pool will not take another listing: past its cap a listing is ignored, and its sats and unit are lost. */
export const listingBlocked=(pool:RollupPoolStatus['pool'])=>
 pool?.maxReserves!==undefined&&Object.keys(pool.reserves??{}).length>=pool.maxReserves
  ?`The pool already lists ${pool.maxReserves} assets, the most it accepts. Listing another would lose the ${DUST} sats and the unit it sends.`:undefined;

/** One line for the mobile status sheet: the step in progress, or how the action ended. */
export const sheetLine=(a:{steps:readonly string[];current:number;done?:boolean;error?:string})=>a.error??(a.done?'Done':`Step ${a.current+1} of ${a.steps.length}: ${a.steps[a.current]}`);
/** Arkade asset units by asset, with the coins the pool paid out kept apart, since auto-shield leaves those alone. */
export function arkAssetHoldings(coins:readonly ArkCoin[],payout:(coin:ArkCoin)=>boolean){
 const rows=new Map<string,{assetId:string;payout:boolean;units:bigint;coins:ArkCoin[]}>();
 for(const coin of coins)for(const {assetId,amount} of coin.assets??[]){
  const paid=payout(coin),key=assetId+':'+paid,row=rows.get(key)??{assetId,payout:paid,units:0n,coins:[]};
  row.units+=amount;row.coins.push(coin);rows.set(key,row);
 }
 return [...rows.values()];
}

export const isInvoice=(raw:string)=>/^(lightning:)?ln(bc|tb|bcrt)/i.test(raw.trim());
/** An invoice that pins its amount refuses a second one, even an equal one; the amount sits before bech32's last `1`. */
export const invoiceCarriesAmount=(raw:string)=>{const t=raw.trim().replace(/^lightning:/i,'');return isInvoice(t)&&/\d/.test(t.slice(0,t.lastIndexOf('1')));};
/** Open Send before filling, so selecting its view cannot clear the destination on the way in. */
export function openPaymentRequest({docked,openPanel,selectTab,fill}:{docked:boolean;openPanel:()=>void;selectTab:()=>void;fill:()=>void}){
 if(docked)openPanel();else selectTab();fill();
}
/** Upper case keeps the whole payload in QR's alphanumeric mode, which is denser than byte mode. */
export const invoiceQr=(bolt11:string)=>'LIGHTNING:'+bolt11.toUpperCase();
/** A scanned or pasted payment code as the send form takes it: the destination, and the amount in sats when the code names one. */
export function payTarget(raw:string):{to:string;amount?:number}{
 // QR codes often carry bech32 in capitals (alphanumeric mode is denser); bech32 is case-insensitive.
 const text=raw.trim(),plain=(s:string)=>/^[A-Z0-9]+$/.test(s)?s.toLowerCase():s,unescape=(s:string)=>{try{return decodeURIComponent(s);}catch{return s;}};
 if(/^lightning:/i.test(text))return {to:plain(text.slice(10))};
 const scheme=/^(bitcoin|arkade):/i.exec(text)?.[1]?.toLowerCase();
 if(!scheme)return {to:plain(text)};
 const [rawPath='',query='']=text.slice(scheme.length+1).split('?'),path=scheme==='arkade'?rawPath.replace(/^\/+/,''):rawPath;
 const legs=new Map(query.split('&').map(pair=>{const at=pair.indexOf('=');return [(at<0?pair:pair.slice(0,at)).toLowerCase(),unescape(at<0?'':pair.slice(at+1))];}));
 const required=[...legs.keys()].filter(key=>key.startsWith('req-'));
 if(required.length)throw new Error(`This payment link requires ${required.join(', ')}, which this wallet does not support.`);
 const to=legs.get('ark')||(scheme==='arkade'?legs.get('address'):undefined)||legs.get('shielded')||legs.get('lightning')||path;
 if(!to)throw new Error('This payment link names no destination.');
 const btc=legs.get('amount'),[whole='0',fraction='']=btc?.split('.')??[];
 return {to:plain(to),...(btc&&/^\d+(\.\d{1,8})?$/.test(btc)?{amount:Number(whole)*1e8+Number(fraction.padEnd(8,'0'))}:{})};
}

export const routeCopy=(railId:string)=>railId==='shielded'?{title:'Private payment',detail:'The amount and both parties stay private.'}
 :railId==='shielded-withdraw'?{title:'Withdraw from the pool',detail:'The amount and the destination become public.'}
 :railId==='shielded-exit'?{title:'Withdraw on-chain',detail:'Leaves the pool to a fresh key used only for this exit, then a batch swap sends it on-chain; the amount and the destination become public, but not linked to your deposit address.'}
 :railId==='onchain'?{title:'On-chain exit',detail:'From your unshielded Arkade funds, to the Bitcoin chain.'}
 :railId==='ark'||railId==='ark-asset'?{title:'Arkade payment',detail:'From your unshielded Arkade funds; the amount is public.'}
 :railId==='lightning'||railId==='lnurl-lightning'?{title:'Pay over Lightning',detail:'One pool note pays a swap, which pays the invoice; the amount becomes public.'}
 :railId==='lnurl-shielded'?{title:'Pay the Lightning address privately',detail:'Private inside the pool, to the shielded address its owner registered; the address service sees the amount you request, and also learns that you pay from the pool.'}
 :railId==='lnurl-arkade'?{title:'Pay the Lightning address on Arkade',detail:'Straight from the pool to the Arkade address its owner gave; the amount and destination become public.'}
 :{title:'Payment',detail:`Routed over ${railId}; treat the amount as public.`};

const grouped=(n:number|bigint)=>n.toLocaleString('en-US');
export const satsText=(n:number|bigint)=>`${grouped(n)} ${Number(n)===1?'sat':'sats'}`;
const charges=(fee:DepositFeeSchedule|undefined):fee is DepositFeeSchedule=>!!(fee&&(fee.fixedSats||fee.bps));
const feeTerms=({fixedSats,bps}:DepositFeeSchedule)=>{
 const fixed=satsText(fixedSats),share=`${bps/100}% of each deposit`;
 return fixedSats&&bps?`${fixed} or ${share}, whichever is more`:fixedSats?fixed:share;
};
const feeCharged=(fee:DepositFeeSchedule)=>fee.bps?`a deposit fee of ${feeTerms(fee)}`:`a ${grouped(fee.fixedSats)}-sat deposit fee`;
export const depositFeeLine=(fee:DepositFeeSchedule|undefined)=>charges(fee)?`This pool charges ${feeCharged(fee)}.`:'';
export const depositFeeAmountLine=(feeSats:bigint,sats:number)=>feeSats?`Your next deposit of ${grouped(sats)} sats pays a ${grouped(feeSats)}-sat fee, so ${grouped(BigInt(sats)-feeSats)} sats reach the pool.`:'';
export const depositFeeBanner=(advertised:DepositFeeSchedule,accepted:DepositFeeSchedule|undefined)=>!charges(advertised)?'':
 `${charges(accepted)?`This pool ${acceptsDepositFee(accepted,advertised)?'raised':'changed'} its deposit fee to ${feeTerms(advertised)}`:`This pool now charges ${feeCharged(advertised)}`}. Nothing new moves into the pool until you accept it.`;
export const PAUSED_LINE='Nothing new moves into the pool until you accept the new fee.',PAUSED_TITLE='Shielding is paused',ACCEPT_FEE='Accept the new fee';
export const PAUSED_ERROR=`The pool changed its deposit fee, so this deposit did not go through. ${PAUSED_LINE} Press ${ACCEPT_FEE} in the ${PAUSED_TITLE} notice.`;
/** The wallet's fee-paused refusal is worded for SDK users; the sheet says this instead. */
export const pausedErrorText=(error:unknown)=>rejected(error,'fee-paused')?PAUSED_ERROR:undefined;
const btcOf=(items:readonly {asset:bigint;amount:bigint}[])=>items.reduce((sum,i)=>i.asset===0n?sum+i.amount:sum,0n);
/** A shield row lists only this wallet's notes, so the BTC it deposited less the BTC it kept is the fee; an asset group's is its carrier's. */
export const shieldFeeOf=(entry:EpochHistoryEntry):bigint|undefined=>entry.kind==='shield'?btcOf(entry.amounts)-btcOf(entry.created):undefined;
/** A shield row is one per batch transaction, so its fee is that of every deposit this wallet made in it. */
export const shieldFeeOfTx=(entries:readonly EpochHistoryEntry[],txid:unknown):bigint|undefined=>{
 let total:bigint|undefined;
 if(typeof txid==='string')for(const entry of entries){const fee=entry.txid===txid?shieldFeeOf(entry):undefined;if(fee!==undefined)total=(total??0n)+fee;}
 return total;
};
/** A payout is deposited whole, so its deposit is the one shield entry of its batch transaction that took its sats; with none or several, nothing is guessed. */
export const lightningShieldFeeOf=(entries:readonly EpochHistoryEntry[],txid:unknown,sats:number):bigint|undefined=>{
 const found=typeof txid==='string'?entries.filter(entry=>entry.kind==='shield'&&entry.txid===txid&&Number(btcOf(entry.amounts))===sats):[];
 return found.length===1?shieldFeeOf(found[0]!):undefined;
};
/** Plain coins only the fee keeps out: asked without it, the planner would deposit them. */
export function depositFeeOutsideLine(coins:readonly ArkCoin[],fee:DepositFeeSchedule|undefined,now:number,floorMs:number){
 const plan=shieldPlan(coins,new Set(),now,floorMs);
 return plan?.kind==='btc'&&!shieldableWithFee(plan,fee)?`${grouped(plan.amount)} sats stay outside the pool: after the ${grouped(planFeeOf(plan,fee))}-sat deposit fee they would be below the ${DUST}-sat minimum.`:'';
}
/** A listed asset's coins, each judged alone as the planner takes them: those only the fee keeps out, and while paused, those it lets in. */
export function listedAssetLine(coins:readonly ArkCoin[],fee:DepositFeeSchedule|undefined,listed:ReadonlySet<string>,now:number,floorMs:number,paused:boolean){
 const plans=coins.map(coin=>shieldPlan([coin],listed,now,floorMs)).filter((plan):plan is Extract<ShieldPlan,{kind:'asset'}>=>plan?.kind==='asset');
 const kept=plans.filter(plan=>!shieldableWithFee(plan,fee)).map(plan=>`This coin stays outside the pool: after the ${grouped(planFeeOf(plan,fee))}-sat deposit fee, its ${satsText(plan.coin.value)} would be below the ${CARRIER_FREE_SATS}-sat minimum.`);
 return [...kept,paused&&kept.length<plans.length?PAUSED_LINE:''].filter(Boolean).join(' ');
}
export const invoiceFeeClause=(fee:DepositFeeSchedule|undefined,pays:bigint,swapFee:bigint)=>{
 const payout:ShieldPlan={kind:'btc',coins:[],amount:Number(pays-swapFee)},owed=planFeeOf(payout,fee);
 return owed&&shieldableWithFee(payout,fee)?` and the deposit fee takes ${grouped(owed)}`:'';
};
const LIGHTNING_REST='move into the pool while this page is open; smaller payouts stay outside and are never combined automatically.';
/** The deposit rule only grows with the amount, so bisection finds the least payout it lets in, exactly. */
export function lightningMinimumLine(fee:DepositFeeSchedule|undefined){
 if(!charges(fee))return `Payouts of at least ${DUST} sats ${LIGHTNING_REST}`;
 const enters=(amount:number)=>shieldableWithFee({kind:'btc',coins:[],amount},fee);
 if(!enters(Number.MAX_SAFE_INTEGER))return `Payouts stay outside the pool: the deposit fee would leave each one below the ${DUST}-sat minimum.`;
 let low=DUST,high=Number.MAX_SAFE_INTEGER;
 while(low<high){const mid=low+Math.floor((high-low)/2);if(enters(mid))high=mid;else low=mid+1;}
 return `Payouts of at least ${grouped(low)} sats, the ${DUST}-sat minimum plus the deposit fee, ${LIGHTNING_REST}`;
}

export type InvoiceBounds={min:bigint;max:bigint};
/** The take leg's limits, the only ones swap's route resolution applies to a receive; the solver quoted past the give leg's advertised max. Several markets: the widest min and max. */
export function invoiceBounds(markets:readonly Market[],{give,take}:{give:{asset:string};take:{asset:string}}):InvoiceBounds|undefined{
 let found:InvoiceBounds|undefined;
 for(const {legs} of markets){
  const gets=legs.some(leg=>leg.asset===give.asset)?legs.find(leg=>leg.asset===take.asset)?.limits:undefined;
  if(gets)found={min:found&&found.min<gets.min?found.min:gets.min,max:found&&found.max>gets.max?found.max:gets.max};
 }
 return found;
}
export const invoiceLimitsLine=({min,max}:InvoiceBounds)=>`Invoices from ${grouped(min)} to ${satsText(max)}.`;
export const invoiceInRange=(bounds:InvoiceBounds|undefined,amount:bigint)=>!bounds||amount>=bounds.min&&amount<=bounds.max;
export const NO_SWAP_LINE='No Lightning swap is taking this amount right now.';
/** A receive no market serves reads in the page's words, not the SDK's route text; swap names the class, as its own isSwapError does. */
export const noSwapErrorText=(error:unknown)=>error instanceof Error&&error.name==='UnsupportedRoute'?NO_SWAP_LINE:undefined;

/** Why a token cannot be a claim link, read before any network call; '' when it can be. */
export const claimTokenError=(token:string)=>{try{decodeClaimToken(token);return '';}catch(error){return error instanceof Error?error.message:'Not a claim link.';}};
export const claimUrl=(origin:string,token:string)=>`${origin}/claim#${token}`;
/** The box shows the user's choice; the notice shows what the service lists, one at a time, most pressing first. */
export const privateReceiveView=({on,pending,refused,withdrawing,listed}:PrivateReceiveState):{checked:boolean;notice:'pending'|'foreign'|'confirming'|'own'|'refused'|''}=>({
 checked:on||pending,
 notice:withdrawing&&listed!==null?'pending':listed==='foreign'?'foreign':pending?'confirming':listed==='own'&&!on?'own':refused?'refused':'',
});
/** A long value as its first 20 and last 12 characters; copy, QR and share always take the whole value. */
export const shortValue=(value:string)=>value.length>48?`${value.slice(0,20)}…${value.slice(-12)}`:value;
export function holdingsText(notes:readonly {asset:bigint;amount:bigint}[],assetIdOf:(field:bigint)=>string|undefined){
 const totals=new Map<bigint,bigint>();
 for(const n of notes)totals.set(n.asset,(totals.get(n.asset)??0n)+n.amount);
 return [...totals].map(([asset,amount])=>{
  const count=amount.toLocaleString('en-US'),id=asset===0n?undefined:assetIdOf(asset);
  return asset===0n?satsText(amount):`${count} units of ${id?`asset ${id.slice(0,8)}…${id.slice(-4)}`:'an unlisted asset'}`;
 }).join(' and ');
}
