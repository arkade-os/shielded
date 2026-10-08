/** Every reserve moves with the head in each renewal intent, so their number is bounded. */
export const MAX_RESERVES=8;
const DUST=330;

interface PoolScriptCoin {txid:string;vout:number;value:number;assets?:{assetId:string;amount:bigint}[]}

/**
 * Listings are pool-script coins that hold exactly one asset other than the pool token and at least the dust: anyone may
 * list an asset this way (spec model C). Of several listings of one asset the largest becomes its reserve; the rest stay
 * stranded, unbacked by any note.
 */
export function listingsOf<T extends PoolScriptCoin>(coins:readonly T[],token:string,reserved:ReadonlySet<string>){
 const best=new Map<string,{assetId:string;coin:T;amount:bigint}>();
 for(const coin of coins){
  const assets=coin.assets??[];
  if(assets.length!==1||coin.value<DUST)continue;
  const {assetId,amount}=assets[0]!;
  if(assetId===token||reserved.has(assetId)||amount<=0n)continue;
  const prior=best.get(assetId);
  if(!prior||amount>prior.amount)best.set(assetId,{assetId,coin,amount});
 }
 return [...best.values()].slice(0,Math.max(0,MAX_RESERVES-reserved.size));
}
