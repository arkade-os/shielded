import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';

const SECRET='shielded-rollup-wallet-secret-v1',BORN='shielded-rollup-wallet-born-v1',CREATED='shielded-rollup-wallet-created-v1',SENT='shielded-rollup-sent-v1',RESTORE='shielded-native-restore-v1';
const valid=(value:string)=>/^[0-9a-f]{64}$/.test(value);
type Born={token:string;batches:number;at:number};
type Metadata=[string,string][];
type Restore={version:1;previous:string;next:string;before:Metadata;after:Metadata};
const stateKey=(key:string)=>key.startsWith(BORN)||key===CREATED||key===SENT;
const tag=(secret:string)=>bytesToHex(sha256(hexToBytes(secret)));
const restores=new WeakMap<object,(secret:string,born?:Born)=>Promise<void>>();
function metadata(base:Storage):Metadata{
 return Array.from({length:base.length},(_,i)=>base.key(i)).filter((key):key is string=>key!==null&&stateKey(key)).map(key=>[key,base.getItem(key)!]);
}
function applyMetadata(base:Storage,values:Metadata){
 for(const [key]of metadata(base))base.removeItem(key);
 for(const [key,value]of values)base.setItem(key,value);
}
function recoverRestore(base:Storage,secret:string){
 const raw=base.getItem(RESTORE);if(raw===null)return;
 const entry=JSON.parse(raw) as Restore;
 const snapshot=(value:unknown):value is Metadata=>Array.isArray(value)&&value.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&stateKey(row[0])&&typeof row[1]==='string')&&new Set(value.map(row=>row[0])).size===value.length;
 if(entry.version!==1||!valid(entry.previous)||!valid(entry.next)||!snapshot(entry.before)||!snapshot(entry.after))throw new Error('The native restore record is invalid. Keep the app data.');
 const current=tag(secret),values=current===entry.next?entry.after:current===entry.previous?entry.before:undefined;
 if(!values)throw new Error('The vault secret does not match the pending restore. Keep the app data.');
 applyMetadata(base,values);base.removeItem(RESTORE);
}
export const restoreNativeStorage=(storage:object,secret:string,born?:Born)=>restores.get(storage)?.(secret,born);

export function createNativeStorage(initial:string,base:Storage,persist:(secret:string)=>Promise<void>){
 if(!valid(initial))throw new Error('Invalid native wallet secret.');
 if(base.getItem(SECRET)!==null)throw new Error('Unexpected plaintext wallet secret in native storage. Keep the app data and resolve this before opening.');
 recoverRestore(base,initial);
 let secret:string|null=initial,locked=false,writes=Promise.resolve();
 const keys=()=>Array.from({length:base.length},(_,i)=>base.key(i)).filter((key):key is string=>key!==null).concat(secret===null?[]:[SECRET]);
 const storage:Storage={
  get length(){return keys().length;},key:i=>keys()[i]??null,
  getItem:key=>key===SECRET?secret:base.getItem(key),
  setItem(key,value){
   if(locked)throw new Error('The native wallet is locked.');
   if(key!==SECRET){base.setItem(key,value);return;}
   if(!valid(value))throw new Error('Invalid native wallet secret.');
   throw new Error('Change the wallet secret through native restore.');
  },
  removeItem(key){if(locked)throw new Error('The native wallet is locked.');if(key===SECRET)throw new Error('The wallet secret must be changed through the native vault.');base.removeItem(key);},
  clear(){throw new Error('A native wallet reset must preserve pending payment records.');},
 };
 restores.set(storage,(value,born)=>{
  if(locked)throw new Error('The native wallet is locked.');
  if(!valid(value))throw new Error('Invalid native wallet secret.');
  writes=writes.then(async()=>{
   if(locked||secret===null)throw new Error('The native wallet is locked.');
   const after:Metadata=born?[[`${BORN}:${born.token}`,String(born.batches)],[CREATED,String(born.at)]]:[];
   // Vault replies can be lost after a write; tags reconcile metadata without storing a seed.
   const pending:Restore={version:1,previous:tag(secret),next:tag(value),before:metadata(base),after};
   base.setItem(RESTORE,JSON.stringify(pending));
   if(value!==secret)await persist(value);applyMetadata(base,after);base.removeItem(RESTORE);if(!locked)secret=value;
  }).catch(error=>{locked=true;secret=null;throw error;});
  void writes.catch(()=>{});return writes;
 });
 return {storage,flush:()=>writes,clearMemory(){locked=true;secret=null;}};
}
