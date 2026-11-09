type DatabaseFactory=Pick<IDBFactory,'deleteDatabase'> & Partial<Pick<IDBFactory,'databases'>>;

function deleteDatabase(factory:DatabaseFactory,name:string,blockedAfterMs:number){
 return new Promise<void>((resolve,reject)=>{
  const request=factory.deleteDatabase(name);
  let blockedTimer:ReturnType<typeof setTimeout>|undefined;
  const finish=(error?:unknown)=>{
   if(blockedTimer)clearTimeout(blockedTimer);
   if(error)reject(error);else resolve();
  };
  request.onsuccess=()=>finish();
  request.onerror=()=>finish(request.error??new Error(`Could not clear ${name}.`));
  request.onblocked=()=>{blockedTimer??=setTimeout(()=>finish(new Error('Wallet data is still in use. Close other Shielded windows and try again.')),blockedAfterMs);};
 });
}

export async function clearNativeWalletData(
 deleteSecret:()=>Promise<void>,
 {storage=globalThis.localStorage,indexedDB=globalThis.indexedDB,blockedAfterMs=10_000}:{
  storage?:Storage;
  indexedDB?:DatabaseFactory;
  blockedAfterMs?:number;
 }={},
){
 const databases=typeof indexedDB?.databases==='function'?await indexedDB.databases():[];
 const names=[...new Set(databases.map(database=>database.name).filter((name):name is string=>!!name&&name.startsWith('shielded-')))].sort();
 if(indexedDB&&!names.length)names.push('shielded-rollup','shielded-lightning');
 for(const name of names)await deleteDatabase(indexedDB!,name,blockedAfterMs);
 storage.clear();
 await deleteSecret();
}
