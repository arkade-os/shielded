// The fee wallet's keeper: merges the fee notes the pool mints for each deposit down to one per asset, so none misses its renewal epoch.
// Export SHIELDED_POOL_ORIGIN=<pool> and, from a secret store, SHIELDED_FEE_WALLET_PHRASE: never type it on a command line (shell history) or pass it as an argument.
// Then npm run fee:keeper; with `-- --derive` it prints the pool's fee address and view key instead.
import {setTimeout as sleep} from 'node:timers/promises';
import {createShieldedWallet,loadPoseidon,type Hash} from '../packages/shielded/src/index.ts';
import {shieldedKeysOf} from '../src/shielded/wallet.ts';

export interface FeeKeeperWallet {merge(asset?:bigint,above?:number):Promise<{settled():Promise<unknown>}|undefined>;shieldedNotes(asset?:bigint):{amount:bigint}[];batchCount():number}
const log=(...parts:unknown[])=>console.log(new Date().toISOString(),...parts),warn=(...parts:unknown[])=>console.error(new Date().toISOString(),...parts);
/** The message and each cause's, so an unreachable pool says why; a wrapper repeating its cause adds nothing, and an empty message (an AggregateError) gives its code. */
export const reasonOf=(error:unknown):string=>{
 if(!(error instanceof Error))return String(error);
 const parts:string[]=[];
 for(let e:unknown=error,depth=0;e!==undefined&&depth<8;e=(e as Error|null)?.cause,depth++){
  const part=e instanceof Error?e.message||(e as {code?:string}).code:String(e);
  if(part&&part!==parts.at(-1))parts.push(part);
 }
 return parts.join(': ');
};

/** Merges each asset down to one note, waiting for every merge to land. Above 1, not the wallet's own 8, which a busy pool outruns. */
export const feeKeeperTick=async(wallet:FeeKeeperWallet,assets:bigint[],onMerged:(merged:number)=>void=()=>{}):Promise<{merged:number;notes:number}>=>{
 let merged=0;
 for(const asset of assets)try{for(let handle=await wallet.merge(asset,1);handle;handle=await wallet.merge(asset,1)){await handle.settled();onMerged(++merged);}}
 catch(error){warn(`merging asset ${asset} failed, trying again next pass:`,reasonOf(error));}
 return {merged,notes:assets.reduce((sum,asset)=>sum+wallet.shieldedNotes(asset).length,0)};
};

/** A wrong phrase otherwise reads as "holds 0 sats" for good, while the real fee notes miss their renewal. */
export const feeAddressProblem=(wallet:{depositFee?:{address:string};shieldedAddress():string}):string|undefined=>{
 const fee=wallet.depositFee,own=wallet.shieldedAddress();
 return fee&&fee.address.toLowerCase()!==own.toLowerCase()?`The pool sends its deposit fee to ${fee.address}, not to this wallet ${own}; check SHIELDED_FEE_WALLET_PHRASE.`:undefined;
};

/** The two values the pool is configured with; the rest of shieldedKeysOf is spend and full-viewing material that stays here. */
export const feeWalletKeysOf=(hash:Hash,phrase:string)=>{const {address,viewKey}=shieldedKeysOf(hash,phrase);return {address,viewKey};};

async function main(){
 const args=process.argv.slice(2),derive=args.includes('--derive'),{SHIELDED_POOL_ORIGIN:pool,SHIELDED_FEE_WALLET_PHRASE:secret,SHIELDED_FEE_KEEPER_INTERVAL_MS:every}=process.env;
 if(args.some(arg=>arg!=='--derive'))throw new Error('Usage: npm run fee:keeper [-- --derive]; the phrase is read from SHIELDED_FEE_WALLET_PHRASE, never from an argument.');
 if(!secret)throw new Error('Set SHIELDED_FEE_WALLET_PHRASE to the fee wallet\'s 24-word recovery phrase.');
 if(derive){
  const {address,viewKey}=feeWalletKeysOf(await loadPoseidon(),secret);
  console.log(`SHIELDED_DEPOSIT_FEE_ADDRESS=${address}\nSHIELDED_DEPOSIT_FEE_VIEW_KEY=${viewKey}`);
  return;
 }
 if(!pool)throw new Error('Set SHIELDED_POOL_ORIGIN to the pool, for example https://shielded.mutinynet.arkade.sh.');
 const ms=every?(/^\d+$/.test(every)?Number(every):NaN):60_000;
 if(!(ms>=1000&&ms<2**31))throw new Error('SHIELDED_FEE_KEEPER_INTERVAL_MS wants a whole number of milliseconds from 1000 to 2147483647 (60000 is a minute); Node would fire a longer timer at once.');
 log(`syncing with ${new URL(pool).origin}`);
 const wallet=await createShieldedWallet({pool,secret});
 // snarkjs worker threads and the pool's event stream outlive the wallet, so once it exists every exit is explicit: a hang would keep a supervisor from restarting it.
 const end=(code:number)=>wallet.dispose().catch(()=>{}).then(()=>process.exit(code));
 process.once('SIGTERM',()=>void end(0)).once('SIGINT',()=>void end(0));
 try{
  const refused=feeAddressProblem(wallet);
  if(refused){console.error(refused);return await end(1);}
  log(`fee wallet ${wallet.shieldedAddress()} holds ${wallet.shieldedBalance()} sats; merging every ${ms} ms`);
  for(;;){
   const problem=feeAddressProblem(wallet);if(problem)warn(problem);
   await feeKeeperTick(wallet,wallet.mergeableAssets(),merged=>log(`merge ${merged} landed, batch ${wallet.batchCount()}`)).then(({merged,notes})=>log(`merged ${merged}, notes remaining ${notes}, batch ${wallet.batchCount()}`),error=>warn('pass failed:',reasonOf(error)));
   await sleep(ms);
  }
 }catch(error){console.error(reasonOf(error));await end(1);}
}

if(import.meta.main)await main().catch(error=>{console.error(reasonOf(error));process.exitCode=1;});
