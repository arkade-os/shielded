import assert from 'node:assert/strict';
import {randomBytes as nodeRandomBytes} from 'node:crypto';
import {test} from 'node:test';
import {base64} from '@scure/base';
import {generateSecretKey,getPublicKey,verifyEvent,type Event} from 'nostr-tools/pure';
import {answerEvents,NOSTR_RELAYS,readAnswer,readRequest,requestEvent,statusEvent} from '../packages/protocol/src/nostr-carrier.ts';

// A plain Uint8Array: strict deepEqual compares prototypes, and node's randomBytes returns a Buffer.
const randomBytes=(size:number)=>new Uint8Array(nodeRandomBytes(size));
const wire=(event:Event):Event=>JSON.parse(JSON.stringify(event));
const gwSecret=generateSecretKey(),GW=getPublicKey(gwSecret),other=getPublicKey(generateSecretKey()),request={id:'ab'.repeat(32),pubkey:other};

test('a request event carries the sealed bytes, one p tag and a time rounded down to 30 s',()=>{
 const sealed=randomBytes(1000),event=requestEvent(sealed,GW,Date.UTC(2026,10,6,8,0,59,500));
 assert.equal(event.kind,21470);assert.deepEqual(event.tags,[['p',GW]]);assert.equal(event.created_at,Date.UTC(2026,10,6,8,0,30)/1000);
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
test('answers of one and of many chunks reassemble in index order',()=>{
 for(const [size,count] of [[1,1],[32<<10,1],[(32<<10)+1,2],[32*(32<<10),32]]){
  const bytes=randomBytes(size),events=answerEvents(bytes,request,gwSecret,0);assert.equal(events.length,count);
  events.forEach((event,i)=>assert.deepEqual(event.tags,[['e',request.id],['p',request.pubkey],['chunk',String(i),String(count)]]));
  assert.deepEqual(readAnswer([...events].reverse().concat(events[0]),request.id,GW),{kind:'sealed',bytes});
 }
 assert.throws(()=>answerEvents(new Uint8Array(32*(32<<10)+1),request,gwSecret,0),RangeError);
});
test('readAnswer waits for every chunk and ignores strangers',()=>{
 const events=answerEvents(randomBytes(70_000),request,gwSecret,0),stranger=answerEvents(randomBytes(10),request,generateSecretKey(),0);
 assert.equal(readAnswer(events.slice(1),request.id,GW),undefined);
 assert.equal(readAnswer([...stranger],request.id,GW),undefined);
 assert.equal(readAnswer(events,'cd'.repeat(32),GW),undefined);
});
test('a status event is read with its retry delay',()=>{
 const event=statusEvent(503,2,request,gwSecret,0);assert.equal(event.content,'');
 assert.deepEqual(readAnswer([event],request.id,GW),{kind:'status',status:503,retryAfter:2});
});
test('the default relays are the six probed relays without Cloudflare in front',()=>assert.deepEqual(NOSTR_RELAYS,['wss://nos.lol','wss://relay.snort.social','wss://offchain.pub','wss://nostr.mom','wss://nostr.oxtr.dev','wss://nostr-pub.wellorder.net']));
test('readers check the signature, which a spread copy of an event would hide',()=>{
 const bytes=randomBytes(10),sent=requestEvent(bytes,GW,0),[chunk]=answerEvents(bytes,request,gwSecret,0),[foreign]=answerEvents(bytes,request,generateSecretKey(),0);
 assert.deepEqual(readRequest(wire(sent),GW),bytes);assert.deepEqual(readAnswer([wire(chunk)],request.id,GW),{kind:'sealed',bytes});
 assert.equal(readRequest({...wire(sent),content:base64.encode(randomBytes(10))},GW),undefined);
 assert.equal(readAnswer([{...wire(chunk),content:base64.encode(randomBytes(10))}],request.id,GW),undefined);
 assert.equal(readAnswer([{...wire(foreign),pubkey:GW}],request.id,GW),undefined);
});
test('a status event beats the chunks, and answers that disagree never complete',()=>{
 const events=answerEvents(randomBytes(70_000),request,gwSecret,0),pair=answerEvents(randomBytes(40_000),request,gwSecret,0),single=()=>answerEvents(randomBytes(10),request,gwSecret,0);
 assert.deepEqual(readAnswer([...events,statusEvent(429,0,request,gwSecret,0)],request.id,GW),{kind:'status',status:429,retryAfter:0});
 assert.equal(readAnswer([pair[0],events[1],events[2]],request.id,GW),undefined);
 assert.equal(readAnswer([...single(),...single()],request.id,GW),undefined);
});
