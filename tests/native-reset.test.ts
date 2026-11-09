import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearNativeWalletData} from '../app/src/native-reset.ts';

const storageOf=(events:string[]) => ({
 clear(){events.push('storage');},
 setItem(key:string){events.push(`set:${key}`);},
 removeItem(key:string){events.push(`remove:${key}`);},
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
 assert.deepEqual(events,['set:shielded-native-reset-pending-v1','database:shielded-lightning-example','database:shielded-rollup','storage','set:shielded-native-reset-pending-v1','vault','remove:shielded-native-reset-pending-v1']);
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
 assert.equal(settled,false);assert.deepEqual(events,['set:shielded-native-reset-pending-v1']);
 success?.();await clearing;
 assert.deepEqual(events,['set:shielded-native-reset-pending-v1','storage','set:shielded-native-reset-pending-v1','vault','remove:shielded-native-reset-pending-v1']);
});

test('a blocked database stays in the clearing state until deletion eventually settles',async()=>{
 const events:string[]=[];let notified=0,success:(()=>void)|undefined,factory={
  async databases(){return [{name:'shielded-rollup'}];},
  deleteDatabase(){
   const request={};
   Object.defineProperties(request,{
    onsuccess:{set(callback){success=callback as (()=>void)|undefined;}},
    onerror:{set(){}},
    onblocked:{set(callback){queueMicrotask(()=>callback?.({}));}},
   });
   return request as IDBOpenDBRequest;
  },
 } as unknown as IDBFactory;
 const clearing=clearNativeWalletData(async()=>{events.push('vault');},{storage:storageOf(events),indexedDB:factory,blockedAfterMs:20,onBlocked:()=>{notified++;}});
 let settled=false;void clearing.finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.deepEqual([settled,notified,events],[false,1,['set:shielded-native-reset-pending-v1']]);
 success?.();await clearing;
 assert.deepEqual(events,['set:shielded-native-reset-pending-v1','storage','set:shielded-native-reset-pending-v1','vault','remove:shielded-native-reset-pending-v1']);
});

test('a blocked deletion never removes storage or the vault after its notice deadline',async()=>{
 const events:string[]=[],factory={
  async databases(){return [{name:'shielded-rollup'}];},
  deleteDatabase(){const request:any={};queueMicrotask(()=>request.onblocked?.({}));return request as IDBOpenDBRequest;},
 } as unknown as IDBFactory;
 let settled=false,notified=0;
 const clearing=clearNativeWalletData(async()=>{events.push('vault');},{storage:storageOf(events),indexedDB:factory,blockedAfterMs:20,onBlocked:()=>{notified++;}});
 void clearing.finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.deepEqual(events,['set:shielded-native-reset-pending-v1']);
 assert.deepEqual([settled,notified],[false,1]);
});
