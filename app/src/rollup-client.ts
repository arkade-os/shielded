import {DUST,type ArkCoin,type RollupPoolStatus} from '../../src/shielded/pool.ts';
import {decodeClaimToken} from '../../packages/protocol/src/rollup/bearer.ts';

export * from '../../src/shielded/pool.ts';
export * from '../../src/shielded/epoch-pool.ts';

/** Why the pool will not take another listing: past its cap a listing is ignored, and its sats and unit are lost. */
export const listingBlocked=(pool:RollupPoolStatus['pool'])=>
 pool?.maxReserves!==undefined&&Object.keys(pool.reserves??{}).length>=pool.maxReserves
  ?`The pool already lists ${pool.maxReserves} assets, the most one renewal batch swap can carry. Listing another would lose the ${DUST} sats and the unit it sends.`:undefined;

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
/** Upper case keeps the whole payload in QR's alphanumeric mode, which is denser than byte mode. */
export const invoiceQr=(bolt11:string)=>'LIGHTNING:'+bolt11.toUpperCase();
/** A scanned or pasted payment code as the send form takes it: the destination, and the amount in sats when the code names one. */
export function payTarget(raw:string):{to:string;amount?:number}{
 // QR codes often carry bech32 in capitals (alphanumeric mode is denser); bech32 is case-insensitive.
 const text=raw.trim(),plain=(s:string)=>/^[A-Z0-9]+$/.test(s)?s.toLowerCase():s,unescape=(s:string)=>{try{return decodeURIComponent(s);}catch{return s;}};
 if(/^lightning:/i.test(text))return {to:plain(text.slice(10))};
 if(!/^bitcoin:/i.test(text))return {to:plain(text)};
 const [path='',query='']=text.slice(8).split('?'),legs=new Map(query.split('&').map(pair=>{const at=pair.indexOf('=');return [(at<0?pair:pair.slice(0,at)).toLowerCase(),unescape(at<0?'':pair.slice(at+1))];}));
 const required=[...legs.keys()].filter(key=>key.startsWith('req-'));
 if(required.length)throw new Error(`This payment link requires ${required.join(', ')}, which this wallet does not support.`);
 const to=legs.get('ark')||legs.get('lightning')||path;
 if(!to)throw new Error('This payment link names no destination.');
 const btc=legs.get('amount'),[whole='0',fraction='']=btc?.split('.')??[];
 return {to:plain(to),...(btc&&/^\d+(\.\d{1,8})?$/.test(btc)?{amount:Number(whole)*1e8+Number(fraction.padEnd(8,'0'))}:{})};
}

export const routeCopy=(railId:string)=>railId==='shielded'?{title:'Private payment',detail:'The amount and both parties stay private.'}
 :railId==='shielded-withdraw'?{title:'Withdraw from the pool',detail:'The amount and the destination become public.'}
 :railId==='onchain'?{title:'On-chain exit',detail:'From your unshielded Arkade funds, to the Bitcoin chain.'}
 :railId==='ark'||railId==='ark-asset'?{title:'Arkade payment',detail:'From your unshielded Arkade funds; the amount is public.'}
 :railId==='lightning'||railId==='lnurl-lightning'?{title:'Pay over Lightning',detail:'Through a swap, from your Arkade balance; whatever it lacks first leaves the pool, publicly.'}
 :railId==='lnurl-arkade'?{title:'Pay the Lightning address on Arkade',detail:'Straight from the pool to the Arkade address its owner gave; the amount and destination become public.'}
 :{title:'Payment',detail:`Routed over ${railId}; treat the amount as public.`};

/** Why a token cannot be a claim link, read before any network call; '' when it can be. */
export const claimTokenError=(token:string)=>{try{decodeClaimToken(token);return '';}catch(error){return error instanceof Error?error.message:'Not a claim link.';}};
export const claimUrl=(origin:string,token:string)=>`${origin}/claim#${token}`;
export function holdingsText(notes:readonly {asset:bigint;amount:bigint}[],assetIdOf:(field:bigint)=>string|undefined){
 const totals=new Map<bigint,bigint>();
 for(const n of notes)totals.set(n.asset,(totals.get(n.asset)??0n)+n.amount);
 return [...totals].map(([asset,amount])=>{
  const count=amount.toLocaleString('en-US'),id=asset===0n?undefined:assetIdOf(asset);
  return asset===0n?`${count} sats`:`${count} units of ${id?`asset ${id.slice(0,8)}…${id.slice(-4)}`:'an unlisted asset'}`;
 }).join(' and ');
}
