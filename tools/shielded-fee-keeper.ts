// The fee wallet's keeper: merges the fee notes the pool mints for each deposit down to one per asset, so none misses its renewal epoch.
// SHIELDED_POOL_ORIGIN=<pool> SHIELDED_FEE_WALLET_PHRASE=<24 words> npm run fee:keeper; add `-- --derive` to print the pool's fee address and view key.
import {setTimeout as sleep} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {createShieldedWallet,loadPoseidon,type Hash} from '../packages/shielded/src/index.ts';
import {shieldedKeysOf} from '../src/shielded/wallet.ts';

export interface FeeKeeperWallet {merge(asset?:bigint,above?:number):Promise<{settled():Promise<unknown>}|undefined>;shieldedNotes(asset?:bigint):{amount:bigint}[];batchCount():number}
const log=(...parts:unknown[])=>console.log(new Date().toISOString(),...parts),warn=(...parts:unknown[])=>console.error(new Date().toISOString(),...parts);
const reasonOf=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Merges each asset down to one note, waiting for every merge to land. Above 1, not the wallet's own 8, which a busy pool outruns. */
export const feeKeeperTick=async(wallet:FeeKeeperWallet,assets:bigint[]):Promise<{merged:number;notes:number}>=>{
 let merged=0;
 for(const asset of assets)try{for(let handle=await wallet.merge(asset,1);handle;handle=await wallet.merge(asset,1)){await handle.settled();merged++;}}
 catch(error){warn(`merging asset ${asset} failed, trying again next pass:`,reasonOf(error));}
 return {merged,notes:assets.reduce((sum,asset)=>sum+wallet.shieldedNotes(asset).length,0)};
};

/** The two values the pool is configured with; the rest of shieldedKeysOf is spend and full-viewing material that stays here. */
export const feeWalletKeysOf=(hash:Hash,phrase:string)=>{const {address,viewKey}=shieldedKeysOf(hash,phrase);return {address,viewKey};};

async function main(){
 const {values:{derive}}=parseArgs({options:{derive:{type:'boolean'}}}),{SHIELDED_POOL_ORIGIN:pool,SHIELDED_FEE_WALLET_PHRASE:secret,SHIELDED_FEE_KEEPER_INTERVAL_MS:every}=process.env;
 if(!secret)throw new Error('Set SHIELDED_FEE_WALLET_PHRASE to the fee wallet\'s 24-word recovery phrase.');
 if(derive){
  const {address,viewKey}=feeWalletKeysOf(await loadPoseidon(),secret);
  console.log(`SHIELDED_DEPOSIT_FEE_ADDRESS=${address}\nSHIELDED_DEPOSIT_FEE_VIEW_KEY=${viewKey}`);
  return;
 }
 if(!pool)throw new Error('Set SHIELDED_POOL_ORIGIN to the pool, for example https://shielded.mutinynet.arkade.sh.');
 const ms=Number(every||60_000);
 if(!Number.isSafeInteger(ms)||ms<1)throw new Error('SHIELDED_FEE_KEEPER_INTERVAL_MS wants a positive whole number of milliseconds.');
 const wallet=await createShieldedWallet({pool,secret});
 log(`fee wallet ${wallet.shieldedAddress()} holds ${wallet.shieldedBalance()} sats; merging every ${ms} ms`);
 // snarkjs worker threads outlive the wallet, so the process is ended rather than waited on.
 const stop=()=>void wallet.dispose().catch(()=>{}).then(()=>process.exit(0));
 process.once('SIGTERM',stop).once('SIGINT',stop);
 for(;;){
  await feeKeeperTick(wallet,wallet.mergeableAssets()).then(({merged,notes})=>log(`merged ${merged}, notes remaining ${notes}, batch ${wallet.batchCount()}`),error=>warn('pass failed:',reasonOf(error)));
  await sleep(ms);
 }
}

if(import.meta.main)await main().catch(error=>{console.error(reasonOf(error));process.exitCode=1;});
