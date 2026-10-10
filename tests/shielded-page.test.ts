import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ActivityRegistry,makeHandle,TxType,Wallet,type Activity,type ArkTransaction,type RouteQuote} from '@arkade-os/sdk';
import {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {InMemoryShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';
import {catchUp,idle} from '../src/shielded/sync.ts';
import {BORN,SENT,SECRET,activityReceived,importLegacySent,openPageWallet,pageCache,pageQuotes,pageSheet,renewPageCoins,restorePageWallet} from '../app/src/shielded-page.ts';

const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const storageOf=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);}};
};
const snapshot={v:1,token:'pool',account:{},sent:{},listings:[]} as unknown as ShieldedSnapshot;

test('a cancelled asynchronous preparation never creates an auto-shielding wallet',async()=>{
 const prepared=deferred<number>();let creates=0;
 const session=openPageWallet(()=>prepared.promise,async()=>{creates++;return {dispose:async()=>{}};});
 const closed=session.close();prepared.resolve(1);
 assert.equal(await session.ready,undefined);await closed;assert.equal(creates,0);
});

test('a wallet returned after cancellation is disposed once and never published',async()=>{
 const created=deferred<{dispose:()=>Promise<void>}>();let disposals=0;
 const session=openPageWallet(async()=>1,()=>created.promise);
 await flush();const closed=session.close();created.resolve({dispose:async()=>{disposals++;}});
 assert.equal(await session.ready,undefined);await closed;await session.close();assert.equal(disposals,1);
});

test('restore drains an accepted cache write and rejects later action-finish writes',async()=>{
 const repo=new InMemoryShieldedNoteRepository(),entered=deferred(),release=deferred(),events:string[]=[];
 const save=repo.saveAccount.bind(repo);repo.saveAccount=async(...args)=>{entered.resolve();await release.promise;await save(...args);events.push('saved');};
 const clear=repo.clear.bind(repo);repo.clear=async()=>{events.push('clear');await clear();};
 const cache=pageCache(repo),storage=storageOf();storage.setItem(SECRET,'old');storage.setItem(SENT,'legacy');storage.setItem(BORN+':pool','10');
 const write=cache.repository.saveAccount('pool',snapshot);await entered.promise;
 const restored=restorePageWallet('11'.repeat(32),{cache,storage,stop:async()=>{events.push('stopped');},reload:()=>{events.push('reload');}});
 await flush();assert.deepEqual(events,['stopped']);assert.equal(storage.getItem(SECRET),'old');
 await assert.rejects(cache.repository.saveAccount('pool',snapshot),/closed/i);
 release.resolve();await write;await restored;
 assert.deepEqual(events,['stopped','saved','clear','reload']);assert.equal(await repo.getAccount('pool'),undefined);
 assert.equal(storage.getItem(SECRET),'11'.repeat(32));assert.equal(storage.getItem(SENT),null);assert.equal(storage.getItem(BORN+':pool'),null);
 await assert.rejects(cache.repository.saveAccount('pool',snapshot),/closed/i);assert.equal(await repo.getAccount('pool'),undefined);
});

test('restore parses before stopping and preserves the secret and sent log on a failed clear',async()=>{
 const storage=storageOf(),repo=new InMemoryShieldedNoteRepository(),cache=pageCache(repo);let stops=0,reloads=0;
 storage.setItem(SECRET,'old');storage.setItem(SENT,'legacy');
 const options={cache,storage,stop:async()=>{stops++;},reload:()=>{reloads++;}};
 await assert.rejects(restorePageWallet('invalid',options));assert.equal(stops,0);
 await cache.repository.saveAccount('pool',snapshot);
 repo.clear=async()=>{throw new Error('clear denied');};
 await assert.rejects(restorePageWallet('22'.repeat(32),options),/clear denied/);
 assert.equal(stops,1);assert.equal(reloads,0);assert.equal(storage.getItem(SECRET),'old');assert.equal(storage.getItem(SENT),'legacy');
 assert.ok(await repo.getAccount('pool'));await assert.rejects(cache.repository.saveAccount('pool',snapshot),/closed/i);
});

test('restore waits for pending creation, catch-up and legacy save before clearing',async()=>{
 const applying=deferred(),release=deferred(),created=deferred(),events:string[]=[];
 const store=storageOf(),repo=new InMemoryShieldedNoteRepository(),cache=pageCache(repo);
 store.setItem(SECRET,'old');store.setItem(SENT,JSON.stringify({'7':{to:'recipient'}}));
 const mutable={batchCount:0,apply:async()=>{applying.resolve();await release.promise;mutable.batchCount++;events.push('applied');}};
 const account=mutable as unknown as RollupAccount;
 const wallet={account,repositoryError:undefined as string|undefined,recordSent:()=>{},dispose:async()=>{events.push('disposed');},save:async()=>{
  try{await cache.repository.saveAccount('pool',snapshot);}catch{wallet.repositoryError='cache closed';}events.push('save returned');
 }};
 const syncing=catchUp(account,async()=>({total:1,batches:[{}]}) as never,()=>wallet.save());
 await applying.promise;let restoring=false;
 const legacy=importLegacySent(wallet,store,()=>!restoring);
 const session=openPageWallet(async()=>undefined,async()=>{await created.promise;return wallet;});await flush();
 const clear=repo.clear.bind(repo);repo.clear=async()=>{events.push('clear');await clear();};
 const restored=restorePageWallet('33'.repeat(32),{cache,storage:store,reload:()=>{events.push('reload');},stop:async()=>{
  restoring=true;const owned=await session.close();await legacy;if(owned)await idle(owned.account,()=>undefined);
 }});
 await flush();assert.deepEqual(events,[]);created.resolve();await flush();assert.deepEqual(events,['disposed']);
 assert.equal(store.getItem(SECRET),'old');release.resolve();await syncing;await restored;
 assert.deepEqual(events,['disposed','applied','save returned','save returned','clear','reload']);
 await wallet.save();assert.equal(await repo.getAccount('pool'),undefined);assert.equal(wallet.repositoryError,'cache closed');
});

test('legacy migration waits for catch-up and retains its log when saving fails or restore starts',async()=>{
 const applying=deferred(),release=deferred(),storage=storageOf(),events:string[]=[];
 const mutable={batchCount:0,apply:async()=>{applying.resolve();await release.promise;mutable.batchCount++;events.push('applied');}};
 const account=mutable as unknown as RollupAccount;
 const syncing=catchUp(account,async()=>({total:1,batches:[{}]}) as never);
 await applying.promise;storage.setItem(SENT,JSON.stringify({'7':{to:'recipient'}}));
 let restoring=false;
 const wallet={account,repositoryError:undefined as string|undefined,recordSent:()=>{events.push('recorded');},save:async()=>{events.push('saved');wallet.repositoryError='storage denied';}};
 const migrated=importLegacySent(wallet,storage,()=>!restoring);await flush();assert.deepEqual(events,['recorded']);
 release.resolve();await syncing;await migrated;assert.deepEqual(events,['recorded','applied','saved']);assert.ok(storage.getItem(SENT));
 wallet.save=async()=>{wallet.repositoryError=undefined;restoring=true;};await importLegacySent(wallet,storage,()=>!restoring);assert.ok(storage.getItem(SENT));
 restoring=false;wallet.save=async()=>{};await importLegacySent(wallet,storage,()=>!restoring);assert.equal(storage.getItem(SENT),null);
});

test('replacing and dismissing a sheet unsubscribes and ignores obsolete handle callbacks',()=>{
 const states:unknown[]=[],callbacks:((s:{status:'pending'|'sent'})=>void)[]=[];let off=0;
 const fake=()=>({subscribe:(cb:typeof callbacks[number])=>{callbacks.push(cb);cb({status:'pending'});return()=>{off++;};}}) as never;
 const sheet=pageSheet(s=>states.push(s)),first=fake();const a=sheet.watch(first,'A');sheet.watch(fake(),'B');
 assert.equal(off,1);callbacks[0]!({status:'sent'});a.fail('old failure');assert.equal(states.length,2);
 assert.equal((states.at(-1) as {title:string}).title,'B');assert.equal(sheet.watch(first,'A'),a);assert.equal(states.length,2);
 sheet.clear();callbacks[1]!({status:'sent'});assert.equal(off,2);assert.equal(states.at(-1),undefined);
});

test('a plain failed handle retains its string error when the page catches settlement',async()=>{
 const release=deferred();const states:unknown[]=[];
 const handle=makeHandle('plain',async emit=>{emit({status:'sent'});await release.promise;throw 'pool refused';});
 const owner=pageSheet(s=>states.push(s)).watch(handle,'Sending');
 release.resolve();try{await handle.settled();}catch(error){owner.fail(error);}
 assert.equal((states.at(-1) as {error:string}).error,'pool refused');assert.equal((states.at(-1) as {current:number}).current,1);
});

test('zero-sat asset activities preserve the actual SDK sent and received direction',async()=>{
 for(const type of [TxType.TxSent,TxType.TxReceived]){
  const tx:ArkTransaction={key:{arkTxid:'asset',boardingTxid:'',commitmentTxid:''},type,amount:0,settled:true,createdAt:1,assets:[{assetId:'aa'.repeat(34),amount:9007199254740993n}]};
  const wallet={getTransactionHistory:async()=>[tx],activity:new ActivityRegistry()};
  const rows=await Wallet.prototype.getActivityHistory.call(wallet as never) as Activity[];
  assert.equal(rows[0]!.amount,0);assert.equal(activityReceived(rows[0]!),type===TxType.TxReceived);
 }
});

const quoteOf=(railId:string,send:()=>Promise<unknown>=async()=>undefined)=>({railId,amount:500,fee:0,total:500,send}) as RouteQuote;

test('a pending quote cannot publish after the request, funds or wallet changes',async()=>{
 const quotes=pageQuotes(()=>{}),wallet={},context={wallet,revision:1,key:'alice:500'},first=deferred<RouteQuote>();
 const stop=quotes.load(context,()=>first.promise);
 assert.equal(quotes.read(context).quote,undefined);
 const next={...context,key:'bob:500'},second=quoteOf('shielded');
 stop();quotes.load(next,async()=>second);await flush();first.resolve(quoteOf('ark'));await flush();
 assert.equal(quotes.read(next).quote,second);assert.equal(quotes.read(context).quote,undefined);
 assert.equal(quotes.read({...next,revision:2}).quote,undefined);
 assert.equal(quotes.read({...next,wallet:{}}).quote,undefined);
 let reject!:(error:unknown)=>void;
 const old=quotes.load(context,()=>new Promise<RouteQuote>((_,fail)=>{reject=fail;}));await flush();old();
 quotes.load(next,async()=>second);await flush();reject('obsolete refusal');await flush();
 assert.equal(quotes.read(next).quote,second);assert.equal(quotes.read(next).error,undefined);
});

test('confirmation sends only the displayed quote and cannot reroute or reuse an invalidated quote',async()=>{
 let routes=0,privateSends=0,publicSends=0;
 const context={wallet:{},revision:1,key:'recipient:500'},quotes=pageQuotes(()=>{});
 const privateQuote=quoteOf('shielded-withdraw',async()=>{privateSends++;return 'private';});
 const route=async()=>{routes++;return routes===1?privateQuote:quoteOf('ark',async()=>{publicSends++;});};
 quotes.load(context,route);await flush();const displayed=quotes.read(context).quote!;
 await assert.rejects(quotes.send({...context,key:'different:500'},displayed),/changed/);
 await assert.rejects(quotes.send({...context,revision:2},displayed),/changed/);
 assert.equal(await quotes.send(context,displayed),'private');
 assert.deepEqual([routes,privateSends,publicSends],[1,1,0]);
 await assert.rejects(quotes.send(context,displayed),/changed/);
 quotes.load(context,route);await flush();quotes.clear();
 await assert.rejects(quotes.send(context,displayed),/changed/);
 assert.deepEqual([routes,privateSends,publicSends],[2,1,0]);
});

test('a funds notification clears the displayed quote before a replacement route resolves',async()=>{
 const context={wallet:{},revision:1,key:'recipient:500'},quotes=pageQuotes(()=>{}),replacement=deferred<RouteQuote>();
 const first=quoteOf('shielded-withdraw');quotes.load(context,async()=>first);await flush();
 quotes.clear();assert.equal(quotes.read(context).quote,undefined);
 const current={...context,revision:2};quotes.load(current,()=>replacement.promise);
 await assert.rejects(quotes.send(context,first),/changed/);
 replacement.resolve(quoteOf('ark'));await flush();assert.equal(quotes.read(current).quote?.railId,'ark');
});

test('late renewal success and failure leave a replacement action sheet untouched',async()=>{
 for(const failed of [false,true]){
  const states:any[]=[],sheet=pageSheet(s=>states.push(s)),release=deferred();
  const renewing=renewPageCoins(async()=>{await release.promise;if(failed)throw 'renew refused';return 'renewed';},sheet);
  assert.equal(states.at(-1).title,'Renewing your coins');assert.equal(states.at(-1).current,0);
  const replacement=sheet.begin('Shielding');replacement.update(s=>({...s,steps:['Prove','Done'],current:0}));
  release.resolve();if(failed)await assert.rejects(renewing,error=>error==='renew refused');else assert.equal(await renewing,'renewed');
  assert.equal(states.at(-1).title,'Shielding');assert.equal(states.at(-1).done,undefined);assert.equal(states.at(-1).error,undefined);
 }
});

test('renewal shows its own completed step or string error when it still owns the sheet',async()=>{
 const states:any[]=[],sheet=pageSheet(s=>states.push(s));
 assert.equal(await renewPageCoins(async()=>'tx',sheet),'tx');assert.equal(states.at(-1).done,true);assert.equal(states.at(-1).current,1);
 await assert.rejects(renewPageCoins(async()=>{throw 'renew refused';},sheet),error=>error==='renew refused');
 assert.equal(states.at(-1).error,'renew refused');assert.equal(states.at(-1).done,undefined);
});
