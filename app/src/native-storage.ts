const SECRET='shielded-rollup-wallet-secret-v1';
const valid=(value:string)=>/^[0-9a-f]{64}$/.test(value);

export function createNativeStorage(initial:string,base:Storage,persist:(secret:string)=>Promise<void>){
 if(!valid(initial))throw new Error('Invalid native wallet secret.');
 if(base.getItem(SECRET)!==null)throw new Error('Unexpected plaintext wallet secret in native storage. Keep the app data and resolve this before opening.');
 let secret:string|null=initial,locked=false,writes=Promise.resolve();
 const keys=()=>Array.from({length:base.length},(_,i)=>base.key(i)).filter((key):key is string=>key!==null).concat(secret===null?[]:[SECRET]);
 const storage:Storage={
  get length(){return keys().length;},key:i=>keys()[i]??null,
  getItem:key=>key===SECRET?secret:base.getItem(key),
  setItem(key,value){
   if(locked)throw new Error('The native wallet is locked.');
   if(key!==SECRET){base.setItem(key,value);return;}
   if(!valid(value))throw new Error('Invalid native wallet secret.');
   secret=value;writes=writes.then(()=>persist(value));void writes.catch(()=>{});
  },
  removeItem(key){if(key===SECRET)throw new Error('The wallet secret must be changed through the native vault.');base.removeItem(key);},
  clear(){throw new Error('A native wallet reset must preserve pending payment records.');},
 };
 return {storage,flush:()=>writes,clearMemory(){locked=true;secret=null;}};
}
