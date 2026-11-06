import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeStorage} from '../app/src/native-storage.ts';

const KEY='shielded-rollup-wallet-secret-v1';
const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};
test('native secret stays in memory and vault writes finish before reload',async()=>{
 const base=memory(),saved:string[]=[],view=createNativeStorage('11'.repeat(32),base,async value=>{saved.push(value);});
 assert.equal(view.storage.getItem(KEY),'11'.repeat(32));
 view.storage.setItem('journal','pending');view.storage.setItem(KEY,'22'.repeat(32));
 assert.equal(base.getItem(KEY),null);assert.equal(base.getItem('journal'),'pending');
 await view.flush();assert.deepEqual(saved,['22'.repeat(32)]);
 view.clearMemory();assert.equal(view.storage.getItem(KEY),null);assert.throws(()=>view.storage.setItem(KEY,'33'.repeat(32)),/locked/);
});
test('failed vault writes cannot be ignored by a subsequent restore',async()=>{
 const view=createNativeStorage('11'.repeat(32),memory(),async()=>{throw new Error('vault locked');});
 view.storage.setItem(KEY,'22'.repeat(32));await assert.rejects(view.flush(),/vault locked/);
 view.storage.setItem(KEY,'33'.repeat(32));await assert.rejects(view.flush(),/vault locked/);
});
test('native storage rejects plaintext seed copies, invalid seeds and destructive resets',()=>{
 const base=memory();base.setItem(KEY,'11'.repeat(32));
 assert.throws(()=>createNativeStorage('11'.repeat(32),base,async()=>{}),/plaintext/);
 const view=createNativeStorage('11'.repeat(32),memory(),async()=>{});
 assert.throws(()=>view.storage.setItem(KEY,'bad'),/secret/);
 assert.throws(()=>view.storage.removeItem(KEY),/secret/);assert.throws(()=>view.storage.clear(),/reset/);
});
