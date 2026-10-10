import {ArkAddress,Wallet,type WalletConfig} from '@arkade-os/sdk';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {fullViewKeyOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import {akOf,assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2} from '../../packages/protocol/src/wallet-keys.ts';
import {DUST,poolApiOf,shieldPlan,type ArkCoin,type Groth16Proof,type PoolApi,type RollupPoolStatus,type ShieldPlan} from './pool.ts';

export interface ShieldedPoolConfig {origin:string;status:RollupPoolStatus}
export interface ShieldedProver {prove(built:BuiltSpend,circuit:'spend'|'join'):Promise<Groth16Proof>;joinReady?():boolean}
export type ShieldedWalletConfig=WalletConfig&{pool:ShieldedPoolConfig;secret:string;hash:Hash;prover:ShieldedProver;bornAt?:number;fetcher?:typeof fetch};

export const SHIELD_FLOOR_MS=25*3600_000,RETRY_MS=60_000,MERGE_WAIT_MS=10*60_000;
export const shieldedSteps={
 shield:['Prepare the deposit coin','Prove the deposit on this device','Submit to the pool','Wait for the next batch','Sign your deposit','Included'],
 send:['Pick notes','Prove the payment on this device','Submit to the pool','Wait for the next batch','Included'],
 withdraw:['Pick notes','Prove the withdrawal on this device','Submit to the pool','Wait for the next batch','Included'],
 merge:['Pick two notes','Prove the merge on this device','Submit to the pool','Wait for the next batch','Included'],
} as const;
const sats=(value:bigint|number)=>Number(value).toLocaleString('en-US'),short=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;
export const shieldTitle=(plan:ShieldPlan)=>plan.kind==='btc'?`Shielding ${sats(plan.amount)} sats`:`Shielding ${sats(plan.units)} units of asset ${short(plan.assetId)}`;
export const nextShieldPlan=(coins:readonly ArkCoin[],o:{skip:(c:ArkCoin)=>boolean;used:ReadonlySet<string>;listed:ReadonlySet<string>;now:number;floorMs:number})=>
 shieldPlan(coins.filter(c=>!o.skip(c)&&!o.used.has(`${c.txid}:${c.vout}`)),o.listed,o.now,o.floorMs);
export const needsRenewal=(coins:readonly ArkCoin[],now:number,floorMs:number)=>coins.some(c=>c.expiresAt!==undefined&&c.expiresAt-now<=floorMs);
export const programOf=(address:string)=>ArkAddress.decode(address).pkScript.subarray(2);
export const topThree=(notes:{amount:bigint}[])=>[...notes].sort((a,b)=>a.amount<b.amount?1:a.amount>b.amount?-1:0).slice(0,3).reduce((sum,n)=>sum+n.amount,0n);
/** The same single-note rule `withdrawAsset` and `pickNote` apply, asked as a question instead of attempted. */
export const coversWithdrawal=(notes:{amount:bigint;nullifier:bigint}[],carriers:{amount:bigint;nullifier:bigint}[],amount:bigint,inFlight:ReadonlySet<bigint>,asset:boolean,sats_:bigint)=>{
 const has=(list:{amount:bigint;nullifier:bigint}[],least:bigint)=>list.some(n=>!inFlight.has(n.nullifier)&&n.amount>=least);
 if(amount<=0n)return false;
 return asset?sats_>=BigInt(DUST)&&has(notes,amount)&&has(carriers,sats_):amount>=BigInt(DUST)&&has(notes,amount);
};
export const mergeAssetFields=(reserves:Record<string,string>|undefined)=>[BTC_ASSET,...Object.keys(reserves??{}).map(assetFieldOfId)];

export function shieldedKeysOf(hash:Hash,secret:string){
 const keys=deriveRollupKeys2(secret,MUTINYNET_KEY_NETWORK),self=rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret);
 return {keys,self,address:rollupAddressOf(self),viewKey:viewKeyOf(self.owner,keys.viewSecret),fullViewingKey:fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret)};
}

/**
 * Note selection and reservation in one critical section. `RollupAccount.pay`/`consolidate` read the unspent set
 * and resolve asynchronously, so without serialising the pick two actions choose the same note and the second
 * spend is a guaranteed double-spend the pool drops.
 */
export class NoteReservation {
 readonly inFlight=new Set<bigint>();
 private queue:Promise<unknown>=Promise.resolve();
 pick<T>(choose:()=>Promise<T>,nullifiersOf:(chosen:T)=>bigint[]):Promise<T>{
  const next=this.queue.then(async()=>{const chosen=await choose();for(const n of nullifiersOf(chosen))this.inFlight.add(n);return chosen;});
  this.queue=next.then(()=>undefined,()=>undefined);
  return next;
 }
 release(nullifiers:readonly bigint[]){for(const n of nullifiers)this.inFlight.delete(n);}
}

export class ShieldedWallet extends Wallet {
 pool!:ShieldedPoolConfig;
 api!:PoolApi;
 hash!:Hash;
 prover!:ShieldedProver;
 account!:RollupAccount;
 self!:RollupRecipient;
 readonly notes=new NoteReservation();
 private derived!:ReturnType<typeof shieldedKeysOf>;
 private readonly changeListeners=new Set<()=>void>();

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher);wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;
   wallet.account=RollupAccount.owning(config.hash,wallet.derived.keys,{frontier:true,bornAt:config.bornAt??0});
   return wallet;
  }catch(error){await wallet.dispose().catch(()=>{});throw error;}
 }

 get inFlight():ReadonlySet<bigint>{return this.notes.inFlight;}
 shieldedBalance(asset=BTC_ASSET):bigint{return this.account.balance(asset);}
 shieldedNotes(asset=BTC_ASSET):OwnedNote[]{return this.account.notes(asset);}
 shieldedHistory():readonly HistoryEntry[]{return this.account.history;}
 shieldedAddress():string{return this.derived.address;}
 viewKey():string{return this.derived.viewKey;}
 fullViewingKey():string{return this.derived.fullViewingKey;}
 batchCount():number{return this.account.batchCount;}
 assetIdOf(field:bigint):string|undefined{return Object.keys(this.pool.status.pool?.reserves??{}).find(id=>assetFieldOfId(id)===field);}
 onShieldedChange(cb:()=>void):()=>void{this.changeListeners.add(cb);return()=>{this.changeListeners.delete(cb);};}
 changed(){for(const cb of [...this.changeListeners])cb();}
 override async dispose():Promise<void>{this.changeListeners.clear();await super.dispose();}
}
