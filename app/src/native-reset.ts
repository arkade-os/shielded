type DatabaseFactory=Pick<IDBFactory,'deleteDatabase'> & Partial<Pick<IDBFactory,'databases'>>;

function deleteDatabase(factory:DatabaseFactory,name:string,blockedAfterMs:number,onBlocked?:()=>void){
 return new Promise<void>((resolve,reject)=>{
  const request=factory.deleteDatabase(name);
  let blockedTimer:ReturnType<typeof setTimeout>|undefined,blockedNotified=false;
  const finish=(error?:unknown)=>{
   if(blockedTimer)clearTimeout(blockedTimer);
   if(error)reject(error);else resolve();
  };
  request.onsuccess=()=>finish();
  request.onerror=()=>finish(request.error??new Error(`Could not clear ${name}.`));
  request.onblocked=()=>{blockedTimer??=setTimeout(()=>{if(!blockedNotified){blockedNotified=true;onBlocked?.();}},blockedAfterMs);};
 });
}

export async function clearNativeWalletData(
 deleteSecret:()=>Promise<void>,
 {storage=globalThis.localStorage,indexedDB=globalThis.indexedDB,blockedAfterMs=10_000,onBlocked}:{
  storage?:Storage;
  indexedDB?:DatabaseFactory;
  blockedAfterMs?:number;
  onBlocked?:()=>void;
 }={},
){
 const databases=typeof indexedDB?.databases==='function'?await indexedDB.databases():[];
 const names=[...new Set(databases.map(database=>database.name).filter((name):name is string=>!!name&&name.startsWith('shielded-')))].sort();
 if(indexedDB&&!names.length)names.push('shielded-rollup','shielded-lightning');
 // Keep the vault secret until every database delete settles, so a partial reset stays recoverable.
 for(const name of names)await deleteDatabase(indexedDB!,name,blockedAfterMs,onBlocked);
 storage.clear();
 await deleteSecret();
}
