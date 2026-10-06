import test from 'node:test';
import assert from 'node:assert/strict';
import {storeWalletBackup} from '../app/src/wallet-storage.ts';

test('concurrent first wallet writes serialize and preserve the winner',async()=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 let tail=Promise.resolve();
 const locks={request:async(_name:string,callback:()=>Promise<void>)=>{let release!:()=>void;const turn=new Promise<void>(resolve=>release=resolve),previous=tail;tail=previous.then(()=>turn);await previous;try{return await callback();}finally{release();}}} as unknown as Pick<LockManager,'request'>;
 const first={version:1 as const,salt:'00'.repeat(16),iv:'11'.repeat(12),ciphertext:'22'},second={...first,ciphertext:'33'};
 const results=await Promise.allSettled([storeWalletBackup(first,true,storage,locks),storeWalletBackup(second,true,storage,locks)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(results.filter(result=>result.status==='rejected').length,1);
 const saved=values.get('shielded-stock-wallet-v1');assert.ok(saved);assert.ok([first,second].some(value=>JSON.stringify(value)===saved));
 const before=saved;await assert.rejects(storeWalletBackup({...first,ciphertext:'44'},true,storage,locks),/already exists/);assert.equal(values.get('shielded-stock-wallet-v1'),before);
});

test('wallet writes fail closed without the origin lock',async()=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}},value={version:1 as const,salt:'00'.repeat(16),iv:'11'.repeat(12),ciphertext:'22'};
 await assert.rejects(storeWalletBackup(value,true,storage,{} as Pick<LockManager,'request'>),/cannot safely lock/);assert.equal(values.size,0);
});
