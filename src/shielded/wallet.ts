import {Wallet,type WalletConfig} from '@arkade-os/sdk';
import {RollupAccount,type BuiltSpend,type HistoryEntry,type OwnedNote} from '../../packages/protocol/src/rollup/account.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {fullViewKeyOf,viewKeyOf} from '../../packages/protocol/src/rollup/disclosure.ts';
import {akOf,assetFieldOfId,type Hash} from '../../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf,type RollupRecipient} from '../../packages/protocol/src/rollup/wallet.ts';
import {MUTINYNET_KEY_NETWORK,deriveRollupKeys2} from '../../packages/protocol/src/wallet-keys.ts';
import {poolApiOf,type Groth16Proof,type PoolApi,type RollupPoolStatus} from './pool.ts';
import type {SentRecord,ShieldedNoteRepository} from './repository.ts';

export interface ShieldedPoolConfig {origin:string;status:RollupPoolStatus}
export interface ShieldedProver {prove(built:BuiltSpend,circuit:'spend'|'join'):Promise<Groth16Proof>;joinReady?():boolean}
export type ShieldedWalletConfig=WalletConfig&{pool:ShieldedPoolConfig;secret:string;hash:Hash;prover:ShieldedProver;shieldedRepository?:ShieldedNoteRepository;bornAt?:number;fetcher?:typeof fetch};

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

export interface LoadedAccount {account:RollupAccount;sent:Record<string,SentRecord>;listings:string[];resumed:boolean;error?:string}
/** Never throws: a cache that cannot be read is a full sync, reported once, not a wallet that will not open. */
export async function loadAccount(hash:Hash,keys:{ask:bigint;nk:bigint;viewSecret:Uint8Array},o:{repository?:ShieldedNoteRepository;token:string;bornAt:number}):Promise<LoadedAccount>{
 const fresh=(error?:string):LoadedAccount=>({account:RollupAccount.owning(hash,keys,{frontier:true,bornAt:o.bornAt}),sent:{},listings:[],resumed:false,...(error?{error}:{})});
 if(!o.repository)return fresh();
 try{
  const stored=await o.repository.getAccount(o.token);
  if(!stored)return fresh();
  if(stored.v!==1)return fresh(`Ignoring a version ${String(stored.v)} shielded snapshot; syncing from the pool.`);
  if(stored.token!==o.token)return fresh('Ignoring a snapshot from another pool; syncing from the pool.');
  return {account:RollupAccount.fromSnapshot(hash,keys,stored.account),sent:{...stored.sent},listings:[...(stored.listings??[])],resumed:true};
 }catch(error){return fresh((error as Error).message);}
}

export class ShieldedWallet extends Wallet {
 pool!:ShieldedPoolConfig;
 api!:PoolApi;
 hash!:Hash;
 prover!:ShieldedProver;
 account!:RollupAccount;
 self!:RollupRecipient;
 readonly notes=new NoteReservation();
 repository?:ShieldedNoteRepository;
 resumed=false;
 repositoryError?:string;
 private derived!:ReturnType<typeof shieldedKeysOf>;
 private sent:Record<string,SentRecord>={};
 private readonly listings=new Set<string>();
 private readonly changeListeners=new Set<()=>void>();

 static override async create(config:ShieldedWalletConfig):Promise<ShieldedWallet>{
  const wallet=await super.create(config) as ShieldedWallet;
  try{
   wallet.pool=config.pool;wallet.api=poolApiOf(config.pool.origin,config.fetcher);wallet.hash=config.hash;wallet.prover=config.prover;
   wallet.derived=shieldedKeysOf(config.hash,config.secret);wallet.self=wallet.derived.self;wallet.repository=config.shieldedRepository;
   const loaded=await loadAccount(config.hash,wallet.derived.keys,{repository:config.shieldedRepository,token:config.pool.status.pool!.token,bornAt:config.bornAt??0});
   wallet.account=loaded.account;wallet.sent=loaded.sent;wallet.resumed=loaded.resumed;wallet.repositoryError=loaded.error;
   for(const txid of loaded.listings)wallet.listings.add(txid);
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
 async save():Promise<void>{
  if(!this.repository)return;
  const token=this.pool.status.pool!.token;
  try{await this.repository.saveAccount(token,{v:1,token,account:this.account.snapshot(),sent:this.sent,listings:[...this.listings]});}
  catch(error){this.repositoryError??=(error as Error).message;}
 }
 sentOf(nullifier:bigint):SentRecord|undefined{return this.sent[String(nullifier)];}
 recordSent(entries:[bigint,SentRecord][]){for(const [nullifier,record] of entries)this.sent[String(nullifier)]=record;}
 override async dispose():Promise<void>{this.changeListeners.clear();await super.dispose();}
}
