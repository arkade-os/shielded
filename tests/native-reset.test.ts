import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearNativeWalletData} from '../app/src/native-reset.ts';

const storageOf=(events:string[]) => ({
 clear(){events.push('storage');},
}) as unknown as Storage;

test('clearing a native wallet removes only its databases and storage before deleting the vault secret',async()=>{
 const events:string[]=[],names=['shielded-rollup','shielded-lightning-example','other-app'];
 const factory={
  async databases(){return names.map(name=>({name}));},
  deleteDatabase(name:string){
   events.push(`database:${name}`);
   const request:any={};queueMicrotask(()=>request.onsuccess?.({}));return request as IDBOpenDBRequest;
  },
 } as unknown as IDBFactory;
 await clearNativeWalletData(async()=>{events.push('vault');},{storage:storageOf(events),indexedDB:factory});
 assert.deepEqual(events,['database:shielded-lightning-example','database:shielded-rollup','storage','vault']);
});

test('a blocked database keeps the reset pending until deletion succeeds',async()=>{
 const events:string[]=[];let success:(()=>void)|undefined,blocked:(()=>void)|undefined;
 const factory={
  async databases(){return [{name:'shielded-rollup'}];},
  deleteDatabase(){
   const request={};
   Object.defineProperties(request,{
    onsuccess:{set(callback){(success=callback) as (()=>void)|undefined;}},
    onerror:{set(){}},
    onblocked:{set(callback){(blocked=callback) as (()=>void)|undefined;}},
   });
   return request as IDBOpenDBRequest;
  },
 } as unknown as IDBFactory;
 const clearing=clearNativeWalletData(async()=>{events.push('vault');},{storage:storageOf(events),indexedDB:factory});let settled=false;
 void clearing.finally(()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));blocked?.();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);assert.deepEqual(events,[]);
 success?.();await clearing;
 assert.deepEqual(events,['storage','vault']);
});
