import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {finalizeEvent,generateSecretKey,type Event} from 'nostr-tools/pure';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const A='wss://a.example',B='wss://b.example',fresh=()=>finalizeEvent({kind:1,tags:[],content:'x',created_at:0},generateSecretKey());
const ids=(events:Event[])=>events.map(event=>event.id);

test('subscribeMany reports its close once, after every relay has closed, with each reason',()=>{
 const bus=createNostrBus(),closes:unknown[]=[],sub=bus.pool.subscribeMany([A,B],{kinds:[1]},{onclose:reasons=>closes.push(reasons)});
 bus.drop(A);assert.equal(closes.length,0);
 bus.drop(B);assert.deepEqual(closes,[[{url:A,reason:'relay connection closed'},{url:B,reason:'relay connection closed'}]]);
 sub.close();assert.equal(closes.length,1,'closing a closed subscription says nothing more');
 bus.pool.subscribeMany([A,B],{kinds:[1]},{onclose:reasons=>closes.push(reasons)}).close();
 assert.deepEqual(closes[1],[{url:A,reason:'closed by caller'},{url:B,reason:'closed by caller'}]);
});

test('an event two relays carry reaches a subscribeMany once, and a relay-level subscription on each twice',async()=>{
 const bus=createNostrBus(),many:Event[]=[],apart:Event[]=[];
 bus.pool.subscribeMany([A,B],{kinds:[1]},{onevent:event=>many.push(event)});
 for(const url of [A,B])(await bus.pool.ensureRelay(url)).subscribe([{kinds:[1]}],{onevent:event=>apart.push(event),onclose:()=>{}});
 await Promise.all(bus.pool.publish([A,B],fresh()));await sleep(10);
 assert.equal(many.length,1);assert.equal(apart.length,2);
});

test('a relay dies with its connection, ensureRelay opens a fresh one, and an unreachable relay rejects with a string',async()=>{
 const bus=createNostrBus(),old=await bus.pool.ensureRelay(A),closes:string[]=[];
 old.subscribe([{kinds:[1]}],{onevent:()=>{},onclose:reason=>closes.push(reason)});
 bus.drop(A);assert.deepEqual(closes,['relay connection closed']);
 await assert.rejects(old.publish(fresh()),/closed connection/);
 old.subscribe([{kinds:[1]}],{onevent:()=>{},onclose:reason=>closes.push(reason)});
 assert.deepEqual([closes.length,bus.unhandled.map(error=>error.message)],[1,[`Tried to send message on a closed connection to ${A}.`]],'a subscribe on a dead link returns, never closes, and leaves an unhandled rejection');
 assert.equal(await (await bus.pool.ensureRelay(A)).publish(fresh()),'');
 bus.pool.destroy();bus.relay(A).unreachable=true;
 await assert.rejects(bus.pool.ensureRelay(A),(reason:unknown)=>reason==='connection failed');
});

test('an unreachable relay fulfils a publish with a connection failure, takes nothing and closes its slot',async()=>{
 const bus=createNostrBus(),closes:unknown[]=[],event=fresh();bus.relay(A).unreachable=true;
 assert.deepEqual(await Promise.allSettled(bus.pool.publish([A,B],event)),[{status:'fulfilled',value:'connection failure: connection failed'},{status:'fulfilled',value:''}]);
 assert.deepEqual(ids(bus.published),[event.id],'only the reachable relay took it');
 bus.pool.subscribeMany([A,B],{kinds:[1]},{onclose:reasons=>closes.push(reasons)});await sleep(0);
 assert.equal(closes.length,0,'the other relay is still open');assert.equal(bus.openSubscriptions(),1);
 bus.drop(B);assert.deepEqual(closes,[[{url:A,reason:'connection failed'},{url:B,reason:'relay connection closed'}]]);
});

test('a relay that times out the OK still delivers and records the event, but the publish rejects',async()=>{
 const bus=createNostrBus(),heard:Event[]=[],event=fresh();bus.relay(A).timesOut=true;
 bus.pool.subscribeMany([A],{kinds:[1]},{onevent:heard.push.bind(heard)});
 const [result]=await Promise.allSettled(bus.pool.publish([A],event));await sleep(10);
 assert.equal(result!.status,'rejected');assert.equal((result as PromiseRejectedResult).reason.message,'publish timed out');
 assert.deepEqual(ids(heard),[event.id]);assert.deepEqual(ids(bus.published),[event.id]);
});

test('a relay that refuses rejects, and one that does not deliver takes the event and says nothing',async()=>{
 const bus=createNostrBus(),heard:Event[]=[],event=fresh();bus.relay(A).accept=false;bus.relay(B).deliver=false;
 bus.pool.subscribeMany([A,B],{kinds:[1]},{onevent:heard.push.bind(heard)});
 const [refused,silent]=await Promise.allSettled(bus.pool.publish([A,B],event));await sleep(10);
 assert.equal(refused!.status,'rejected');assert.equal(silent!.status,'fulfilled');
 assert.deepEqual(heard,[]);assert.deepEqual(ids(bus.published),[event.id]);
});
