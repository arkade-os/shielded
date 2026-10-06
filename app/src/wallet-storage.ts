import type {EncryptedWallet} from './wallet-backup.ts';

const STORAGE='shielded-stock-wallet-v1';

export async function storeWalletBackup(value:EncryptedWallet,createOnly=false,storage:Pick<Storage,'getItem'|'setItem'>=localStorage,locks:Pick<LockManager,'request'>|undefined=(typeof navigator==='undefined'?undefined:navigator.locks)){
 if(!locks?.request)throw new Error('This browser cannot safely lock wallet storage. Use an up-to-date browser in a secure context.');
 await locks.request(STORAGE,async()=>{
  if(createOnly&&storage.getItem(STORAGE)!==null)throw new Error('An encrypted wallet already exists. Export it first, then use a fresh browser profile.');
  storage.setItem(STORAGE,JSON.stringify(value));
 });
}
