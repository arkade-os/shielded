import type {ArkCoin} from '../../src/shielded/pool.ts';

export * from '../../src/shielded/pool.ts';

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
