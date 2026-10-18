import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ActivityRegistry,makeHandle,ProviderUnavailableError,TxType,Wallet,type Activity,type ArkTransaction,type RouteQuote} from '@arkade-os/sdk';
import {RollupAccount} from '../packages/protocol/src/rollup/account.ts';
import {InMemoryShieldedNoteRepository,type ShieldedSnapshot} from '../src/shielded/repository.ts';
import {catchUp,idle} from '../src/shielded/sync.ts';
import {BORN,SENT,SECRET,activityReceived,importLegacySent,openPageWallet,pageCache,pageQuotes,pageSheet,renewPageCoins,restorePageWallet} from '../app/src/shielded-page.ts';
import * as page from '../app/src/shielded-page.ts';

const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const storageOf=()=>{
 const rows=new Map<string,string>();
 return {get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);}};
};
const snapshot={v:1,token:'pool',account:{},sent:{},listings:[]} as unknown as ShieldedSnapshot;

test('startup retries transient creation without repeating preparation and closes the one successful wallet',async()=>{
 let prepares=0,creates=0,disposals=0;const errors:unknown[]=[],failure=new ProviderUnavailableError('Arkade server info is unavailable and no cached snapshot exists');
 const session=openPageWallet(async()=>++prepares,async value=>{
  assert.equal(value,1);if(++creates===1)throw failure;return {dispose:async()=>{disposals++;}};
 },undefined,{delayMs:1,onError:error=>errors.push(error)});
 assert.ok(await session.ready);assert.equal(prepares,1);assert.equal(creates,2);assert.deepEqual(errors,[failure]);
 await session.close();await session.close();assert.equal(disposals,1);
});

test('startup cancellation wakes retry backoff without another creation',async()=>{
 let creates=0;const failed=deferred();
 const session=openPageWallet(async()=>1,async()=>{creates++;throw Object.assign(new Error('limited'),{status:429});},undefined,{delayMs:60_000,onError:()=>failed.resolve()});
 await Promise.race([session.ready.catch(()=>{}),failed.promise]);await session.close();
 assert.equal(await session.ready,undefined);assert.equal(creates,1);
});

test('startup does not retry a definitive refusal or invalid wallet data',async()=>{
 for(const failure of [Object.assign(new Error('denied'),{status:403}),new Error('invalid secret')]){
  let creates=0;const session=openPageWallet(async()=>1,async()=>{creates++;throw failure;},undefined,{delayMs:1});
  await assert.rejects(session.ready,error=>error===failure);await session.close();assert.equal(creates,1);
 }
});

test('a transient setup failure cannot recreate a native wallet that already started payment work',async()=>{
 let creates=0;const failure=new ProviderUnavailableError('companion unavailable');
 const session=openPageWallet(async()=>1,async()=>{creates++;throw failure;},undefined,{delayMs:1,shouldRetry:()=>false});
 await assert.rejects(session.ready,error=>error===failure);await session.close();assert.equal(creates,1);
});

test('pool startup retries an outage and does not publish a read completed after cancellation',async()=>{
 const controller=new AbortController();let reads=0;
 assert.equal(await page.retryPageRead(async()=>{if(++reads===1)throw new Error('The pool did not answer (503).');return 'ready';},controller.signal,{delayMs:1}),'ready');
 const pending=deferred<string>(),read=page.retryPageRead(()=>pending.promise,controller.signal);
 controller.abort();pending.resolve('obsolete');assert.equal(await read,undefined);
});

test('refresh publishes independent successes and clears only recovered read errors',async()=>{
 let broken=true;const hang=deferred<number>(),seen:{values:Record<string,unknown>;errors:Record<string,string>}[]=[];
 const refresh=page.pageRefresh({balance:async()=>{if(broken)throw new Error('explorer down');return 12;},address:async()=>'ark',history:()=>hang.promise,lightning:async()=>['incoming']},(values,errors)=>seen.push({values:{...values},errors:{...errors}}));
 refresh.request();await flush();
 assert.equal(seen.at(-1)!.values.address,'ark');assert.deepEqual(seen.at(-1)!.values.lightning,['incoming']);assert.equal(seen.at(-1)!.errors.balance,'explorer down');
 hang.resolve(1);await flush();broken=false;refresh.request();await flush();
 assert.equal(seen.at(-1)!.values.balance,12);assert.deepEqual(seen.at(-1)!.errors,{});await refresh.close();
});

test('refresh coalesces notifications and drains an active read without publishing after close',async()=>{
 const first=deferred<number>(),second=deferred<number>();let reads=0,active=0,maximum=0,published=0;
 const refresh=page.pageRefresh({value:async()=>{maximum=Math.max(maximum,++active);const value=await (++reads===1?first:second).promise;active--;return value;}},()=>{published++;});
 refresh.request();await flush();refresh.request();refresh.request();assert.equal(reads,1);
 first.resolve(1);await flush();assert.equal(reads,2);assert.equal(maximum,1);assert.equal(published,1);
 refresh.request();let closed=false;const close=refresh.close().then(()=>{closed=true;});await flush();assert.equal(closed,false);
 second.resolve(2);await close;assert.equal(reads,2);assert.equal(published,1);refresh.request();await flush();assert.equal(reads,2);
});

test('a pending explorer read does not delay later Lightning refreshes or overlap itself',async()=>{
 const slow=deferred<number>();let explorerReads=0,lightningReads=0;const seen:number[]=[];
 const refresh=page.pageRefresh({explorer:async()=>{explorerReads++;return slow.promise;},lightning:async()=>++lightningReads},data=>{if(data.lightning!==undefined)seen.push(data.lightning);});
 refresh.request();await flush();refresh.request();await flush();
 assert.equal(explorerReads,1);assert.equal(lightningReads,2);assert.equal(seen.at(-1),2);
 const close=refresh.close();slow.resolve(1);await close;assert.equal(explorerReads,1);
});

test('wallet disposal drains its own readers before closing resources even when a replacement refresh starts',async()=>{
 const oldRead=deferred(),newRead=deferred(),events:string[]=[],wallet={},replacement={};let published=0;
 const refreshes=new WeakMap<object,{close:()=>Promise<void>}>();
 const old=page.pageRefresh({history:async()=>{events.push('read');await oldRead.promise;events.push('read done');return 1;}},()=>{published++;});
 refreshes.set(wallet,old);old.request();await flush();
 const closed=page.disposeAfterPageReads(wallet,refreshes,async()=>{events.push('wallet');events.push('companion');events.push('journal');});
 const next=page.pageRefresh({history:async()=>{await newRead.promise;return 2;}},()=>{published++;});
 refreshes.set(replacement,next);next.request();const parallel=old.close();await flush();
 assert.deepEqual(events,['read']);assert.equal(published,0);
 oldRead.resolve();await Promise.all([closed,parallel]);
 assert.deepEqual(events,['read','read done','wallet','companion','journal']);assert.equal(published,0);
 newRead.resolve();await flush();assert.equal(published,1);await next.close();
});

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

test('closing a wallet drains its private receive watcher before disposing its wallets and journal',async()=>{
 const events:string[]=[],release=deferred();
 const owned={dispose:async()=>{events.push('wallet');}};
 const session=openPageWallet(async()=>undefined,async()=>owned,async wallet=>{
  events.push('watcher');await release.promise;await wallet.dispose();events.push('companion');events.push('journal');
 });
 await session.ready;const closed=session.close();await flush();assert.deepEqual(events,['watcher']);
 release.resolve();await closed;await session.close();
 assert.deepEqual(events,['watcher','wallet','companion','journal']);
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

for(const perPage of [false,true])test(`restore waits for pending creation, ${perPage?'page':'batch'} checkpoint and legacy save before clearing`,async()=>{
 const applying=deferred(),release=deferred(),created=deferred(),events:string[]=[];
 const store=storageOf(),repo=new InMemoryShieldedNoteRepository(),cache=pageCache(repo);
 store.setItem(SECRET,'old');store.setItem(SENT,JSON.stringify({'7':{to:'recipient'}}));
 const mutable={batchCount:0,apply:async()=>{applying.resolve();await release.promise;mutable.batchCount++;events.push('applied');}};
 const account=mutable as unknown as RollupAccount;
 const wallet={account,repositoryError:undefined as string|undefined,recordSent:()=>{},dispose:async()=>{events.push('disposed');},save:async()=>{
  try{await cache.repository.saveAccount('pool',snapshot);}catch{wallet.repositoryError='cache closed';}events.push('save returned');
 }};
 const checkpoint=()=>wallet.save();
 const syncing=catchUp(account,async()=>({total:1,batches:[{}]}) as never,perPage?undefined:checkpoint,perPage?checkpoint:undefined);
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

test('same-funds pool, watchdog and quote-read notifications preserve one slow quote and its explicit confirmation',async()=>{
 let routes=0,sends=0;const quotes=pageQuotes(()=>{}),pending=deferred<RouteQuote>();
 const snapshot={token:'pool',batch:1,notes:[{nullifier:1n,asset:0n,amount:1000n}],inFlight:new Set<bigint>()};
 const funds=page.pageQuoteFunds(()=>snapshot,quotes.clear),coins=[{txid:'a',vout:0,value:100},{txid:'b',vout:1,value:200}];
 funds.update(coins);const context={wallet:{},revision:funds.revision,key:'invoice:500'};
 quotes.load(context,()=>{routes++;return pending.promise;});await flush();
 snapshot.batch++;funds.update([...coins].reverse());funds.update();funds.update(coins.map(coin=>({...coin})));
 assert.equal(funds.revision,context.revision);assert.equal(quotes.read(context).pending,true);assert.equal(routes,1);
 const displayed=quoteOf('lightning',async()=>{sends++;return 'paid';});pending.resolve(displayed);await flush();
 funds.update();assert.equal(quotes.read(context).quote,displayed);assert.equal(sends,0);
 assert.equal(await quotes.send({...context,revision:funds.revision},displayed),'paid');assert.equal(sends,1);assert.equal(routes,1);
});

for(const change of ['note','reservation','native-outpoint','native-asset','pool'] as const)test(`an actual ${change} change invalidates a quote even without a balance change`,async()=>{
 let sends=0;const quotes=pageQuotes(()=>{}),snapshot={token:'pool',notes:[{nullifier:1n,asset:0n,amount:1000n}],inFlight:new Set<bigint>()};
 const coins=[{txid:'a',vout:0,value:100,assets:[{assetId:'asset',amount:3n}]}],funds=page.pageQuoteFunds(()=>snapshot,quotes.clear);
 funds.update(coins);const context={wallet:{},revision:funds.revision,key:'recipient:500'},displayed=quoteOf('shielded',async()=>{sends++;});
 quotes.load(context,async()=>displayed);await flush();
 if(change==='note')snapshot.notes[0]!.nullifier=2n;
 if(change==='reservation')snapshot.inFlight.add(1n);
 if(change==='native-outpoint')coins[0]!.txid='replacement';
 if(change==='native-asset')coins[0]!.assets[0]!.amount=2n;
 if(change==='pool')snapshot.token='replacement-pool';
 const revision=funds.update(coins);assert.notEqual(revision,context.revision);assert.equal(quotes.read(context).quote,undefined);
 await assert.rejects(quotes.send({...context,revision},displayed),/changed/);assert.equal(sends,0);
});

test('fresh confirmation reads reject a changed native coin before sending the displayed quote',async()=>{
 let sends=0;const quotes=pageQuotes(()=>{}),funds=page.pageQuoteFunds(()=>({token:'pool',notes:[],inFlight:new Set<bigint>()}),quotes.clear);
 const coins=[{txid:'original',vout:0,value:500}],read=deferred<typeof coins>();funds.update(coins);
 const context={wallet:{},revision:funds.revision,key:'recipient:500'},displayed=quoteOf('ark',async()=>{sends++;});
 quotes.load(context,async()=>displayed);await flush();
 const sending=(async()=>quotes.send({...context,revision:funds.update(await read.promise)},displayed))();
 read.resolve([{txid:'replacement',vout:0,value:500}]);await assert.rejects(sending,/changed/);assert.equal(sends,0);
});

test('an actual reservation change suppresses a late quote result without another remote quote',async()=>{
 let routes=0;const pending=deferred<RouteQuote>(),quotes=pageQuotes(()=>{}),inFlight=new Set<bigint>();
 const funds=page.pageQuoteFunds(()=>({token:'pool',notes:[{nullifier:1n,asset:0n,amount:500n}],inFlight}),quotes.clear),context={wallet:{},revision:funds.revision,key:'invoice:500'};
 quotes.load(context,()=>{routes++;return pending.promise;});await flush();inFlight.add(1n);funds.update();
 pending.resolve(quoteOf('lightning'));await flush();assert.equal(routes,1);assert.equal(quotes.read({...context,revision:funds.revision}).quote,undefined);
});

test('editing a payment invalidates a pending quote without requesting another one',async()=>{
 let routes=0;const result=deferred<RouteQuote>(),quotes=pageQuotes(()=>{});
 const context={wallet:{},revision:1,key:'invoice:500'};
 quotes.invalidate(context);assert.equal(routes,0);
 quotes.load(context,()=>{routes++;return result.promise;});
 assert.equal(quotes.read(context).pending,true);await flush();assert.equal(routes,1);
 const edited={...context,key:'invoice:600'};quotes.invalidate(edited);
 assert.equal(quotes.read(edited).pending,undefined);assert.equal(quotes.read(context).pending,undefined);
 result.resolve(quoteOf('lightning'));await flush();
 assert.equal(routes,1);assert.equal(quotes.read(context).quote,undefined);assert.equal(quotes.read(edited).quote,undefined);
});

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
