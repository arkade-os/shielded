import assert from 'node:assert/strict';
import {randomBytes as nodeRandomBytes} from 'node:crypto';
import {test} from 'node:test';
import {base64} from '@scure/base';
import {finalizeEvent,generateSecretKey,getPublicKey,verifyEvent,type Event} from 'nostr-tools/pure';
import {addressOf,answerEvents,NOSTR_RELAYS,readAnswer,readRequest,requestEvent,statusEvent} from '../packages/protocol/src/nostr-carrier.ts';

// A plain Uint8Array: strict deepEqual compares prototypes, and node's randomBytes returns a Buffer.
const randomBytes=(size:number)=>new Uint8Array(nodeRandomBytes(size));
const wire=(event:Event):Event=>JSON.parse(JSON.stringify(event));
const gwSecret=generateSecretKey(),GW=getPublicKey(gwSecret),other=getPublicKey(generateSecretKey()),x='ab'.repeat(32),elsewhere='cd'.repeat(32),shed='ef'.repeat(32);
const signed=(tags:string[][],content='',kind=21471)=>finalizeEvent({kind,tags:[['x',x],...tags],content,created_at:0},gwSecret);

test('a request event carries the sealed bytes, one p tag and a time rounded to the nearest 30 s',()=>{
 const sealed=randomBytes(1000),event=requestEvent(sealed,GW,Date.UTC(2026,10,6,8,0,59,500));
 assert.equal(event.kind,21470);assert.deepEqual(event.tags,[['p',GW]]);assert.equal(event.created_at,Date.UTC(2026,10,6,8,1,0)/1000);
 assert.equal(requestEvent(sealed,GW,Date.UTC(2026,10,6,8,0,44,900)).created_at,Date.UTC(2026,10,6,8,0,30)/1000);
 assert.ok(verifyEvent(event));assert.deepEqual(readRequest(event,GW),sealed);
 assert.notEqual(requestEvent(sealed,GW,0).pubkey,requestEvent(sealed,GW,0).pubkey,'a fresh key per event');
});
test('a request larger than one event is refused before it is signed',()=>{
 assert.throws(()=>requestEvent(new Uint8Array((32<<10)+1),GW,0),RangeError);assert.ok(requestEvent(new Uint8Array(32<<10),GW,0));
});
test('readRequest drops hostile events',()=>{
 const good=requestEvent(randomBytes(10),GW,0);
 for(const event of [{...good,kind:21471},{...good,tags:[['p',other]]},{...good,tags:[]},{...good,content:'not base64!'},{...good,content:base64.encode(new Uint8Array((32<<10)+1))}])assert.equal(readRequest(event,GW),undefined);
});
test('addressOf is the hex SHA-256 of the sealed request bytes',()=>assert.equal(addressOf(new Uint8Array([1,2,3])),'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'));
test('answers of one and of many chunks reassemble in index order',()=>{
 for(const [size,count] of [[1,1],[32<<10,1],[(32<<10)+1,2],[32*(32<<10),32]]){
  const bytes=randomBytes(size),events=answerEvents(bytes,x,gwSecret,0);assert.equal(events.length,count);
  events.forEach((event,i)=>assert.deepEqual(event.tags,[['x',x],['chunk',String(i),String(count)]]));
  assert.deepEqual(readAnswer([...events].reverse().concat(events[0]),x,GW),{kind:'sealed',bytes});
 }
 assert.throws(()=>answerEvents(new Uint8Array(32*(32<<10)+1),x,gwSecret,0),RangeError);
});
test('an answer carries x and its chunk and no e or p, and a status x, the e of the request it answers, its status and its delay',()=>{
 assert.deepEqual(answerEvents(new Uint8Array(40<<10),x,gwSecret,0).map(e=>e.tags),[[['x',x],['chunk','0','2']],[['x',x],['chunk','1','2']]]);
 assert.deepEqual(statusEvent(503,1,x,shed,gwSecret,0).tags,[['x',x],['e',shed],['status','503'],['retry-after','1']]);
});
test('a status is signed to the second, so a request shed twice within 30 s gets two ids, and an answer to the nearest 30 s',()=>{
 assert.equal(statusEvent(503,1,x,shed,gwSecret,61_500).created_at,61);assert.equal(answerEvents(randomBytes(10),x,gwSecret,61_500)[0]!.created_at,60);
 assert.notEqual(statusEvent(503,1,x,shed,gwSecret,61_500).id,statusEvent(503,1,x,shed,gwSecret,62_500).id);
});
test('readAnswer waits for every chunk and ignores strangers',()=>{
 const events=answerEvents(randomBytes(70_000),x,gwSecret,0),stranger=answerEvents(randomBytes(10),x,generateSecretKey(),0);
 assert.equal(readAnswer(events.slice(1),x,GW),undefined);
 assert.equal(readAnswer([...stranger],x,GW),undefined);
});
test('readAnswer reads only answers addressed to x',()=>{
 const bytes=randomBytes(70_000),events=answerEvents(bytes,x,gwSecret,0),status=statusEvent(503,1,x,shed,gwSecret,0),others=answerEvents(randomBytes(10),elsewhere,gwSecret,0);
 assert.equal(readAnswer(events,elsewhere,GW),undefined);assert.equal(readAnswer([status],elsewhere,GW),undefined);
 assert.deepEqual(readAnswer([...others,...events],x,GW),{kind:'sealed',bytes},'chunks addressed elsewhere neither complete nor spoil the answer');
});
test('a status event is read with its retry delay and the request it answers',()=>{
 const event=statusEvent(503,2,x,shed,gwSecret,0);assert.equal(event.content,'');
 assert.deepEqual(readAnswer([event],x,GW),{kind:'status',status:503,retryAfter:2,request:shed});
});
test('the default relays are the six probed relays without Cloudflare in front',()=>assert.deepEqual(NOSTR_RELAYS,['wss://relay.snort.social','wss://nostr.oxtr.dev','wss://nostr.data.haus','wss://nostr.sathoarder.com','wss://relay.mostro.network','wss://nostr-01.yakihonne.com']));
test('a request is checked by its id alone, and an answer by its signature',()=>{
 const bytes=randomBytes(10),sent=requestEvent(bytes,GW,0),[chunk]=answerEvents(bytes,x,gwSecret,0),[foreign]=answerEvents(bytes,x,generateSecretKey(),0);
 assert.deepEqual(readRequest(wire(sent),GW),bytes);assert.deepEqual(readAnswer([wire(chunk)],x,GW),{kind:'sealed',bytes});
 assert.deepEqual(readRequest({...wire(sent),sig:'00'.repeat(64)},GW),bytes,'a one-time key carries no authority');
 assert.equal(readRequest({...wire(sent),id:'00'.repeat(32)},GW),undefined);
 assert.equal(readAnswer([{...wire(chunk),sig:'00'.repeat(64)}],x,GW),undefined);
 assert.equal(readRequest({...wire(sent),content:base64.encode(randomBytes(10))},GW),undefined);
 assert.equal(readAnswer([{...wire(chunk),content:base64.encode(randomBytes(10))}],x,GW),undefined);
 assert.equal(readAnswer([{...wire(foreign),pubkey:GW}],x,GW),undefined);
});
test('a complete answer beats a status, and a status counts while chunks are missing',()=>{
 const bytes=randomBytes(40_000),[first,second]=answerEvents(bytes,x,gwSecret,0),status=statusEvent(503,1,x,shed,gwSecret,0);
 assert.deepEqual(readAnswer([status,first!],x,GW),{kind:'status',status:503,retryAfter:1,request:shed});
 assert.deepEqual(readAnswer([status,first!,second!],x,GW),{kind:'sealed',bytes});
 assert.deepEqual(readAnswer([second!,status,first!],x,GW),{kind:'sealed',bytes});
 const events=answerEvents(randomBytes(70_000),x,gwSecret,0),pair=answerEvents(randomBytes(40_000),x,gwSecret,0),single=()=>answerEvents(randomBytes(10),x,gwSecret,0);
 assert.equal(readAnswer([pair[0],events[1],events[2]],x,GW),undefined);
 assert.equal(readAnswer([...single(),...single()],x,GW),undefined);
 assert.deepEqual(readAnswer([...single(),...single(),status],x,GW),{kind:'status',status:503,retryAfter:1,request:shed},'conflicting chunks leave the status standing');
});
test('readAnswer ignores a gateway event that breaks the format, alone and beside a good answer',()=>{
 const bytes=randomBytes(10),good=signed([['chunk','0','1']],base64.encode(bytes)),body=base64.encode(randomBytes(10));
 const bad={
  'a request-kind event with answer tags':signed([['chunk','0','1']],body,21470),
  'a count over the cap':signed([['chunk','0','33']],body),
  'an index at the count':signed([['chunk','2','2']],body),
  'an empty index':signed([['chunk','','2']],body),
  'a hex index':signed([['chunk','0x0','2']],body),
  'a negative index':signed([['chunk','-1','2']],body),
  'a fractional count':signed([['chunk','0','1.5']],body),
  'status 500':signed([['e',shed],['status','500'],['retry-after','1']]),
  'a negative retry-after':signed([['e',shed],['status','503'],['retry-after','-1']]),
  'an empty retry-after':signed([['e',shed],['status','503'],['retry-after','']]),
  'no retry-after':signed([['e',shed],['status','503']]),
  'the old merged status layout':signed([['e',shed],['status','503','2']]),
  'a status with no e':signed([['status','503'],['retry-after','1']]),
  'a status whose e has no id':signed([['e'],['status','503'],['retry-after','1']]),
 };
 for(const [why,event] of Object.entries(bad)){
  assert.equal(readAnswer([event],x,GW),undefined,why);
  assert.deepEqual(readAnswer([event,good],x,GW),{kind:'sealed',bytes},why);
 }
});
test('an entry that makes verifyEvent throw is dropped, and the rest of the batch is still read',()=>{
 const bytes=randomBytes(10),[chunk]=answerEvents(bytes,x,gwSecret,0),hostile=[null,undefined,'text',5,Object.freeze({})] as never[];
 assert.deepEqual(readAnswer([...hostile,chunk],x,GW),{kind:'sealed',bytes});
 for(const entry of hostile)assert.equal(readRequest(entry,GW),undefined);
});
test('an empty payload is no request, no chunk and no answer',()=>{
 assert.throws(()=>answerEvents(new Uint8Array(0),x,gwSecret,0),RangeError);
 assert.equal(readRequest(requestEvent(new Uint8Array(0),GW,0),GW),undefined);
 assert.equal(readAnswer([signed([['chunk','0','1']])],x,GW),undefined);
});
test('the default relay list is frozen, so a caller cannot reorder it',()=>assert.ok(Object.isFrozen(NOSTR_RELAYS)));
