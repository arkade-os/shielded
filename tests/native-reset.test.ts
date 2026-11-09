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

test('a database still in use stops the reset before secrets or account metadata are removed',async()=>{
 const events:string[]=[],factory={
  async databases(){return [{name:'shielded-rollup'}];},
  deleteDatabase(){
   return Object.defineProperties({},{
    onsuccess:{set(){}},
    onerror:{set(){}},
    onblocked:{set(callback){(callback as (()=>void)|undefined)?.();}},
   }) as IDBOpenDBRequest;
  },
 } as unknown as IDBFactory;
 await assert.rejects(clearNativeWalletData(async()=>{events.push('vault');},{storage:storageOf(events),indexedDB:factory}),/still in use/);
 assert.deepEqual(events,[]);
});
