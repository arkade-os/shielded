type DatabaseFactory=Pick<IDBFactory,'deleteDatabase'> & Partial<Pick<IDBFactory,'databases'>>;

function deleteDatabase(factory:DatabaseFactory,name:string){
 return new Promise<void>((resolve,reject)=>{
  const request=factory.deleteDatabase(name);
  const timer=setTimeout(()=>reject(new Error('Wallet data is still in use. Restart Shielded and try again.')),5000);
  const finish=(error?:unknown)=>{
   clearTimeout(timer);
   if(error)reject(error);else resolve();
  };
  request.onsuccess=()=>finish();
  request.onerror=()=>finish(request.error??new Error(`Could not clear ${name}.`));
  request.onblocked=()=>finish(new Error('Wallet data is still in use. Restart Shielded and try again.'));
 });
}

export async function clearNativeWalletData(
 deleteSecret:()=>Promise<void>,
 {storage=globalThis.localStorage,indexedDB=globalThis.indexedDB}:{
  storage?:Storage;
  indexedDB?:DatabaseFactory;
 }={},
){
 const databases=typeof indexedDB?.databases==='function'?await indexedDB.databases():[];
 const names=[...new Set(databases.map(database=>database.name).filter((name):name is string=>!!name&&name.startsWith('shielded-')))].sort();
 if(indexedDB&&!names.length)names.push('shielded-rollup','shielded-lightning');
 for(const name of names)await deleteDatabase(indexedDB!,name);
 storage.clear();
 await deleteSecret();
}
