import {InMemoryContractRepository,InMemoryWalletRepository,RestArkProvider,RestIndexerProvider,SingleKey,type Identity} from '@arkade-os/sdk';
import type {DepositFeeSchedule} from '../../protocol/src/rollup/deposit-fee.ts';
import type {Hash} from '../../protocol/src/rollup/notes.ts';
import {MUTINYNET_KEY_NETWORK,deriveWalletKeyMaterial} from '../../protocol/src/wallet-keys.ts';
import {poolApiOf,type RollupPoolStatus} from '../../../src/shielded/pool.ts';
import {snarkjsProver} from '../../../src/shielded/prover.ts';
import {IndexedDBShieldedNoteRepository,InMemoryShieldedNoteRepository,type ShieldedNoteRepository} from '../../../src/shielded/repository.ts';
import {ShieldedWallet,type ShieldedProver,type ShieldedWalletConfig} from '../../../src/shielded/wallet.ts';
import type {SyncProgressObserver} from '../../../src/shielded/sync-progress.ts';

export {ShieldedWallet,type ShieldedPoolConfig,type ShieldedProver,type ShieldedWalletConfig} from '../../../src/shielded/wallet.ts';
export type {ShieldedSyncProgress,SyncProgressObserver} from '../../../src/shielded/sync-progress.ts';
export type {ShieldedPaymentHandle} from '../../../src/shielded/handle.ts';
export type {RollupPoolStatus} from '../../../src/shielded/pool.ts';
export {IndexedDBShieldedNoteRepository,InMemoryShieldedNoteRepository,type ShieldedNoteRepository} from '../../../src/shielded/repository.ts';
export {loadProvingFile,prefetchProvingKeys,releaseProver,snarkjsProver} from '../../../src/shielded/prover.ts';
export {parseMasterSecret,recoveryPhraseOf} from '../../protocol/src/wallet-keys.ts';
export type {Hash} from '../../protocol/src/rollup/notes.ts';
export {depositFeeOf,type DepositFee,type DepositFeeSchedule} from '../../protocol/src/rollup/deposit-fee.ts';

export interface CreateShieldedWalletOptions {
 /** The pool's origin, for example `https://shielded.mutinynet.arkade.sh`. */
 pool:string;
 /** 32 bytes as 64 hex characters, the same bytes as a 24-word recovery phrase, or a 12-word phrase stretched into those 32 bytes. */
 secret:string;
 identity?:Identity;
 bornAt?:number;
 repository?:ShieldedNoteRepository;
 prover?:ShieldedProver;
 hash?:Hash;
 fetch?:typeof fetch;
 onSyncProgress?:SyncProgressObserver;
 /** The most deposit fee to accept; `fixedSats` and `bps` are each compared. Without it a pool that charges a fee still opens, but deposits wait for `acceptDepositFee`. */
 maxDepositFee?:DepositFeeSchedule;
}

export async function loadPoseidon():Promise<Hash>{
 const circom=await import('circomlibjs').catch(error=>{throw new Error('circomlibjs did not load. In a browser bundle, alias circomlibjs to circomlibjs/src/poseidon_wasm.js (see the @arkade-os/shielded README), or pass `hash`.',{cause:error});});
 const poseidon=await circom.buildPoseidon();
 return v=>BigInt(poseidon.F.toObject(poseidon(v)));
}

export async function fetchPoolStatus(pool:string,fetcher:typeof fetch=fetch,onSyncProgress?:SyncProgressObserver):Promise<RollupPoolStatus>{
 const origin=new URL(pool).origin,status=await poolApiOf(origin,fetcher,undefined,onSyncProgress)<RollupPoolStatus>('/status');
 if(status.phase!=='ready'||!status.pool||!status.proving)throw new Error(`The shielded pool at ${origin} is not open: ${status.message||status.phase}`);
 if(status.network?.network!==MUTINYNET_KEY_NETWORK)throw new Error(`The shielded pool at ${origin} runs on ${status.network?.network??'an unknown network'}; this wallet derives Mutinynet keys only.`);
 return status;
}

export async function shieldedWalletConfig(o:CreateShieldedWalletOptions):Promise<ShieldedWalletConfig>{
 const origin=new URL(o.pool).origin,fetcher=o.fetch??fetch,status=await fetchPoolStatus(origin,fetcher,o.onSyncProgress),network=status.network;
 return {
  identity:o.identity??SingleKey.fromHex(deriveWalletKeyMaterial(o.secret,MUTINYNET_KEY_NETWORK).nativeSecret),
  arkProvider:new RestArkProvider(network.arkUrl),indexerProvider:new RestIndexerProvider(network.indexerUrl??network.arkUrl),
  storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
  settlementConfig:false,walletMode:'static',
  pool:{origin,status},secret:o.secret,hash:o.hash??await loadPoseidon(),
  // Proving files are pinned per pool token, and a new token needs a new wallet, so the status at create is enough.
  prover:o.prover??snarkjsProver({status:()=>status,origin}),
  shieldedRepository:o.repository??(typeof indexedDB==='undefined'?new InMemoryShieldedNoteRepository():new IndexedDBShieldedNoteRepository()),
  bornAt:o.bornAt??0,fetcher,maxDepositFee:o.maxDepositFee,onSyncProgress:o.onSyncProgress,
 };
}

/** A started `ShieldedWallet`, which is an `@arkade-os/sdk` `Wallet`, on the given pool. Call `dispose()` when done. */
export async function createShieldedWallet(o:CreateShieldedWalletOptions):Promise<ShieldedWallet>{
 const config=await shieldedWalletConfig(o),owned=o.repository?undefined:config.shieldedRepository;
 let wallet:ShieldedWallet;
 try{wallet=await ShieldedWallet.create(config);}catch(error){await owned?.[Symbol.asyncDispose]();throw error;}
 if(owned){const dispose=wallet.dispose.bind(wallet);wallet.dispose=async()=>{try{await dispose();}finally{await owned[Symbol.asyncDispose]();}};}
 return wallet;
}
