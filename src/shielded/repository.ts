import type {AccountSnapshot} from '../../packages/protocol/src/rollup/account.ts';

export interface SentRecord {to:string;note?:{amount:string;asset:string;rho:string}}
/** The wallet's cache for one pool. The operator's published batches stay the source of truth. */
export interface ShieldedSnapshot {v:1;token:string;account:AccountSnapshot;sent:Record<string,SentRecord>;listings:string[]}
export interface ShieldedNoteRepository extends AsyncDisposable {
 readonly version:1;
 getAccount(poolToken:string):Promise<ShieldedSnapshot|undefined>;
 saveAccount(poolToken:string,snapshot:ShieldedSnapshot):Promise<void>;
 clear():Promise<void>;
}
export const SHIELDED_DB='shielded-rollup',SHIELDED_STORE='accounts';
const checked=(token:string,snapshot:ShieldedSnapshot|undefined)=>snapshot&&snapshot.v===1&&snapshot.token===token?snapshot:undefined;

export class InMemoryShieldedNoteRepository implements ShieldedNoteRepository {
 readonly version=1 as const;
 private readonly rows=new Map<string,string>();
 async getAccount(poolToken:string){const row=this.rows.get(poolToken);return row?checked(poolToken,JSON.parse(row) as ShieldedSnapshot):undefined;}
 async saveAccount(poolToken:string,snapshot:ShieldedSnapshot){this.rows.set(poolToken,JSON.stringify(snapshot));}
 async clear(){this.rows.clear();}
 // Process-lifetime cache: disposing it drops the rows. The IndexedDB one only closes its handle.
 async [Symbol.asyncDispose](){this.rows.clear();}
}

export class IndexedDBShieldedNoteRepository implements ShieldedNoteRepository {
 readonly version=1 as const;
 private db?:Promise<IDBDatabase>;
 constructor(private readonly dbName=SHIELDED_DB){}
 private open(){
  return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{
   const request=indexedDB.open(this.dbName,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(SHIELDED_STORE))request.result.createObjectStore(SHIELDED_STORE);};
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
 }
 private async run<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await this.open();
  return new Promise<T>((resolve,reject)=>{
   const tx=db.transaction(SHIELDED_STORE,mode),request=work(tx.objectStore(SHIELDED_STORE));
   tx.oncomplete=()=>resolve(request.result);request.onerror=()=>reject(request.error);tx.onabort=()=>reject(tx.error);
  });
 }
 // Stored as a JSON string: the snapshot is already JSON-safe, and a string needs nothing of structured clone.
 async getAccount(poolToken:string){const row=await this.run<string|undefined>('readonly',store=>store.get(poolToken));return row?checked(poolToken,JSON.parse(row) as ShieldedSnapshot):undefined;}
 async saveAccount(poolToken:string,snapshot:ShieldedSnapshot){await this.run('readwrite',store=>store.put(JSON.stringify(snapshot),poolToken));}
 async clear(){await this.run('readwrite',store=>store.clear());}
 async [Symbol.asyncDispose](){const db=this.db;this.db=undefined;if(db)(await db).close();}
}
