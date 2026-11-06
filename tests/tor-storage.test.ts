import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {createNativeStorage,restoreNativeStorage} from '../app/src/native-storage.ts';
import {BORN,CREATED,SENT,restorePageWallet} from '../app/src/shielded-page.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {loadAccount} from '../src/shielded/wallet.ts';

const KEY='shielded-rollup-wallet-secret-v1';
const memory=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},clear:()=>rows.clear()} as Storage;
};
test('native secret stays in memory and vault writes finish before reload',async()=>{
 const base=memory(),saved:string[]=[],view=createNativeStorage('11'.repeat(32),base,async value=>{saved.push(value);});
 assert.equal(view.storage.getItem(KEY),'11'.repeat(32));
 view.storage.setItem('journal','pending');const writing=restoreNativeStorage(view.storage,'22'.repeat(32));
 assert.equal(base.getItem(KEY),null);assert.equal(base.getItem('journal'),'pending');
 await writing;await view.flush();assert.deepEqual(saved,['22'.repeat(32)]);
 view.clearMemory();assert.equal(view.storage.getItem(KEY),null);assert.throws(()=>view.storage.setItem(KEY,'33'.repeat(32)),/locked/);
});
test('failed vault writes cannot be ignored by a subsequent restore',async()=>{
 const view=createNativeStorage('11'.repeat(32),memory(),async()=>{throw new Error('vault locked');});
 await assert.rejects(restoreNativeStorage(view.storage,'22'.repeat(32))!,/vault locked/);
 assert.throws(()=>restoreNativeStorage(view.storage,'33'.repeat(32)),/locked/);await assert.rejects(view.flush(),/vault locked/);
});
test('native storage rejects plaintext seed copies, invalid seeds and destructive resets',()=>{
 const base=memory();base.setItem(KEY,'11'.repeat(32));
 assert.throws(()=>createNativeStorage('11'.repeat(32),base,async()=>{}),/plaintext/);
 const view=createNativeStorage('11'.repeat(32),memory(),async()=>{});
 assert.throws(()=>view.storage.setItem(KEY,'bad'),/secret/);
 assert.throws(()=>view.storage.setItem(KEY,'22'.repeat(32)),/native restore/);
 assert.throws(()=>view.storage.removeItem(KEY),/secret/);assert.throws(()=>view.storage.clear(),/reset/);
});

const restoreCache=(clear:()=>Promise<void>)=>({close(){},async drain(){},repository:{clear}}) as Parameters<typeof restorePageWallet>[1]['cache'];
test('rejected native restore preserves account data and birth metadata',async()=>{
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32);let cleared=false,reloaded=false;
 base.setItem(`${BORN}:old`,'12');base.setItem(CREATED,'100');base.setItem(SENT,'old receipts');
 const view=createNativeStorage(old,base,async()=>{throw new Error('vault locked');});
 await assert.rejects(restorePageWallet(next,{cache:restoreCache(async()=>{cleared=true;}),storage:view.storage,stop:async()=>{},reload:()=>{reloaded=true;},born:{token:'new',batches:90,at:900}}),/vault locked/);
 assert.equal(cleared,false);assert.equal(reloaded,false);assert.equal(base.getItem(`${BORN}:old`),'12');assert.equal(base.getItem(`${BORN}:new`),null);assert.equal(base.getItem(CREATED),'100');assert.equal(base.getItem(SENT),'old receipts');
 for(let i=0;i<base.length;i++)assert.ok(!base.getItem(base.key(i)!)!.includes(old)&&!base.getItem(base.key(i)!)!.includes(next));
 const reopened=createNativeStorage(old,base,async()=>{});
 assert.equal(reopened.storage.getItem(KEY),old);assert.equal(base.getItem(`${BORN}:old`),'12');assert.equal(base.getItem(CREATED),'100');
 for(let i=0;i<base.length;i++)assert.ok(!base.getItem(base.key(i)!)!.includes(old)&&!base.getItem(base.key(i)!)!.includes(next));
});

test('unknown vault write outcome recovers the metadata matching the vault secret',async()=>{
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32);let vault=old,cleared=false;
 base.setItem(`${BORN}:old`,'12');base.setItem(CREATED,'100');base.setItem(SENT,'old receipts');
 const view=createNativeStorage(old,base,async value=>{vault=value;throw new Error('write acknowledgement lost');});
 await assert.rejects(restorePageWallet(next,{cache:restoreCache(async()=>{cleared=true;}),storage:view.storage,stop:async()=>{},reload(){},born:{token:'new',batches:90,at:900}}),/acknowledgement lost/);
 assert.equal(cleared,false);assert.equal(base.getItem(CREATED),'100');
 assert.throws(()=>view.storage.setItem('late write','blocked'),/locked/);
 const reopened=createNativeStorage(vault,base,async()=>{});
 assert.equal(reopened.storage.getItem(KEY),next);assert.equal(base.getItem(`${BORN}:old`),null);assert.equal(base.getItem(`${BORN}:new`),'90');assert.equal(base.getItem(CREATED),'900');assert.equal(base.getItem(SENT),null);
});

test('native restore commits the vault before clearing the old account',async()=>{
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32),events:string[]=[];
 base.setItem(`${BORN}:old`,'12');base.setItem(CREATED,'100');
 const view=createNativeStorage(old,base,async value=>{assert.equal(value,next);assert.equal(base.getItem(CREATED),'100');events.push('vault');});
 await restorePageWallet(next,{cache:restoreCache(async()=>{assert.equal(view.storage.getItem(KEY),next);assert.equal(base.getItem(CREATED),'900');events.push('clear');}),storage:view.storage,stop:async()=>{events.push('stop');},reload(){events.push('reload');},born:{token:'new',batches:90,at:900}});
 assert.deepEqual(events,['stop','vault','clear','reload']);assert.equal(base.getItem(KEY),null);
});

test('an interrupted metadata commit recovers after opening the committed vault',async()=>{
 const source=memory(),old='11'.repeat(32),next='22'.repeat(32);let vault=old,fail=true,cleared=false;
 source.setItem(`${BORN}:old`,'12');source.setItem(CREATED,'100');
 const base:Storage={get length(){return source.length;},key:i=>source.key(i),getItem:key=>source.getItem(key),removeItem:key=>source.removeItem(key),clear:()=>source.clear(),setItem(key,value){if(key===CREATED&&value==='900'&&fail){fail=false;throw new Error('metadata unavailable');}source.setItem(key,value);}};
 const view=createNativeStorage(old,base,async value=>{vault=value;});
 await assert.rejects(restorePageWallet(next,{cache:restoreCache(async()=>{cleared=true;}),storage:view.storage,stop:async()=>{},reload(){},born:{token:'new',batches:90,at:900}}),/metadata unavailable/);
 assert.equal(cleared,false);const reopened=createNativeStorage(vault,base,async()=>{});
 assert.equal(reopened.storage.getItem(KEY),next);assert.equal(base.getItem(`${BORN}:old`),null);assert.equal(base.getItem(`${BORN}:new`),'90');assert.equal(base.getItem(CREATED),'900');
});

test('an unrelated vault secret cannot consume a pending restore record',async()=>{
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32);base.setItem(CREATED,'100');
 const view=createNativeStorage(old,base,async()=>{throw new Error('vault unavailable');});
 await assert.rejects(restoreNativeStorage(view.storage,next)!,/vault unavailable/);
 assert.throws(()=>createNativeStorage('33'.repeat(32),base,async()=>{}),/does not match/);
 const reopened=createNativeStorage(old,base,async()=>{});assert.equal(reopened.storage.getItem(CREATED),'100');
});

test('locking during a pending vault write waits for its outcome without restoring memory access',async()=>{
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32);let vault=old,finish!:()=>void,started!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{finish=resolve;});
 const view=createNativeStorage(old,base,async value=>{started();await held;vault=value;});
 const changing=restoreNativeStorage(view.storage,next);await entered;view.clearMemory();let settled=false;
 const writing=view.flush().finally(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);assert.equal(view.storage.getItem(KEY),null);finish();await changing;await writing;
 assert.equal(view.storage.getItem(KEY),null);assert.equal(createNativeStorage(vault,base,async()=>{}).storage.getItem(KEY),next);
});

for(const interruption of ['process stops before account clear','account clear rejects'])test(`committed restore cannot load the old account when ${interruption}`,async()=>{
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
 const base=memory(),old='11'.repeat(32),next='22'.repeat(32),token='pool',epochLen=128;
 const oldKeys=deriveRollupKeys2(old,'mutinynet'),nextKeys=deriveRollupKeys2(next,'mutinynet'),before=EpochAccount.owning(hash,oldKeys,{epochLen,bornAt:12});
 const repository=new InMemoryShieldedNoteRepository();
 await repository.saveAccount(token,{v:2,token,account:before.snapshot(),sent:{'1':{to:'old payment'}},listings:['old listing'],links:[]});
 let vault=old;const view=createNativeStorage(old,base,async value=>{vault=value;}),born={token,batches:90,at:900};
 if(interruption==='account clear rejects')await assert.rejects(restorePageWallet(next,{cache:restoreCache(async()=>{throw new Error('account store unavailable');}),storage:view.storage,stop:async()=>{},reload(){},born}),/account store unavailable/);
 else await restoreNativeStorage(view.storage,next,born);
 const reopened=createNativeStorage(vault,base,async()=>{});
 const loaded=await loadAccount(hash,nextKeys,{repository,token,epochLen,bornAt:Number(reopened.storage.getItem(`${BORN}:${token}`))});
 assert.equal(loaded.resumed,false);assert.match(loaded.error!,/another key/);
 assert.equal(loaded.account.owner,EpochAccount.owning(hash,nextKeys,{epochLen,bornAt:90}).owner);assert.equal(loaded.account.snapshot().bornAt,90);
 assert.deepEqual(loaded.sent,{});assert.deepEqual(loaded.listings,[]);assert.deepEqual(loaded.links,[]);
 assert.equal((await repository.getAccount(token))!.account.owner,String(before.owner));
 assert.equal((await repository.getAccount(token))!.sent['1']!.to,'old payment');
});
