import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeCleanup} from '../app/src/native-cleanup.ts';
import * as page from '../app/src/shielded-page.ts';

test('failed native cleanup is retried before reconnect and completed work is retained',async()=>{
 const cleanup=createNativeCleanup();let pause=0,shutdown=0,connected=false;
 const pauseNetwork=async()=>{if(++pause===1)throw new Error('pause unavailable');};
 const stop=async()=>{shutdown++;};
 await assert.rejects(cleanup.add(pauseNetwork,stop),/pause unavailable/);
 assert.equal(connected,false);await cleanup.drain();connected=true;
 assert.equal(connected,true);assert.equal(pause,2);assert.equal(shutdown,1);
});

test('cleanup waits for every task before reporting failure or retrying',async()=>{
 const cleanup=createNativeCleanup();let finish!:()=>void,shutdown=0,settled=false;
 const held=new Promise<void>(resolve=>{finish=resolve;});
 const closing=cleanup.add(async()=>{throw new Error('pause failed');},async()=>{shutdown++;await held;});
 void closing.catch(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);finish();await assert.rejects(closing,/pause failed/);assert.equal(shutdown,1);
});

test('native cleanup joins in-flight work and includes late queued cleanup',async()=>{
 const cleanup=createNativeCleanup(),events:string[]=[];let finish!:()=>void;
 const held=new Promise<void>(resolve=>{finish=resolve;});
 const closing=cleanup.add(async()=>{await held;events.push('first');});
 assert.equal(cleanup.drain(),closing);
 const joined=cleanup.add(async()=>{events.push('late');});assert.equal(joined,closing);
 finish();await joined;assert.deepEqual(events,['first','late']);
});

test('a failed shutdown remains a reconnect gate until its retry succeeds',async()=>{
 const cleanup=createNativeCleanup();let attempts=0;
 const stop=async()=>{if(++attempts<3)throw new Error('shutdown failed');};
 await assert.rejects(cleanup.add(stop),/shutdown failed/);await assert.rejects(cleanup.drain(),/shutdown failed/);
 await cleanup.drain();assert.equal(attempts,3);
});

test('a page wallet retries a failed disposal without creating another wallet',async()=>{
 let created=0,disposed=0;
 const session=page.openPageWallet(async()=>undefined,async()=>{created++;return {dispose:async()=>{if(++disposed===1)throw new Error('vault handle still closing');}};});
 await session.ready;await assert.rejects(session.close(),/still closing/);assert.equal(session.active(),false);
 await session.close();await session.close();assert.equal(created,1);assert.equal(disposed,2);
});

test('native reconnect retries through the page close layers and waits for confirmed disposal',async()=>{
 const cleanup=createNativeCleanup();let created=0,disposed=0,finished=0,release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const session=page.openPageWallet(async()=>undefined,async()=>{created++;return {dispose:async()=>{if(++disposed===1)throw new Error('wallet resources unavailable');await held;}};});
 await session.ready;
 const finish=page.pageClose(async(closed:ReturnType<typeof session.close>)=>{await closed;finished++;});
 const close=()=>finish(session.close());
 await assert.rejects(cleanup.add(close),/resources unavailable/);
 let replacement:ReturnType<typeof page.openPageWallet>|undefined;
 const reconnect=cleanup.drain().then(async()=>{replacement=page.openPageWallet(async()=>undefined,async()=>{created++;return {dispose:async()=>{}};});await replacement.ready;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(created,1);assert.equal(disposed,2);assert.equal(finished,0);assert.equal(replacement,undefined);
 release();await reconnect;assert.equal(created,2);assert.equal(finished,1);
 await close();assert.equal(disposed,2);assert.equal(finished,1);await replacement!.close();
});
