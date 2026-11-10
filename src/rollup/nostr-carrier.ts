import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import type {Filter} from 'nostr-tools/filter';
import type {SimplePool} from 'nostr-tools/pool';
import {finalizeEvent,getPublicKey,type Event} from 'nostr-tools/pure';
import {normalizeURL} from 'nostr-tools/utils';
import WebSocket from 'ws';
import {addressOf,answerEvents,idMatches,NOSTR_RELAYS,NOSTR_REQUEST_KIND,readRequest,roundedSeconds,statusEvent} from '../../packages/protocol/src/nostr-carrier.ts';
import type {OhttpOpen} from './ohttp-gateway.ts';

export type CarrierPool=Pick<SimplePool,'subscribeMany'|'publish'|'destroy'>;
// The listener works a relay at a time: subscribeMany remembers every event id it sees, and each id pins the whole relay message it was cut from.
type Relay={onnotice:(message:string)=>void;subscribe(filters:Filter[],params:{onevent:(event:Event)=>void;onclose:(reason:string)=>void}):{close(reason?:string):void};publish(event:Event):Promise<string>;close():void};
export type RelayPool={ensureRelay(url:string):Promise<Relay>;destroy():void};

// The most body whose sealed answer fits 8 chunks: 63 Padmé steps of 4 KiB (a 64th plus 32 bytes of nonce and tag passes 256 KiB), less 8 bytes of BHTTP framing and 16 396 for the copied headers at their largest, as Node's fetch refuses 16 KiB of header names and values.
// ponytail: a flat 30 s retry, so a relay that keeps refusing us is asked every 30 s; back off if an operator minds.
const ANSWER_BYTES=63*4096-8-16_396,REMEMBERED=10_000,STATUSES_PER_SECOND=5,RESUBSCRIBE_MS=30_000,PUBLICATIONS_PER_SECOND=64,REPUBLISH_MS=30_000,MAX_RELAYS=12,CANARY_MS=30_000,ECHO_MS=15_000;

// ponytail: ws's handshakeTimeout only fails an upgrade that stalls, so a relay trickling its reply holds the socket open; add a hard deadline if one does.
export class CappedSocket extends WebSocket {
 // nostr-tools clears onerror before it closes a socket, and ws throws an 'error' nobody hears, which a relay can provoke after we close it.
 constructor(url:string){super(url,{maxPayload:1<<20,handshakeTimeout:10_000});this.on('error',()=>{});}
 send(data:string){if(this.bufferedAmount<=4<<20)super.send(data);}
}

export function nostrRelaysFromEnv(value:string|undefined):readonly string[] {
 if(!value?.trim())return NOSTR_RELAYS;
 const relays=value.split(',').map(relay=>relay.trim());
 if(!relays.every(relay=>URL.canParse(relay)&&new URL(relay).protocol==='wss:'))throw new Error('SHIELDED_NOSTR_RELAYS is a comma-separated list of wss:// relay URLs.');
 const unique=[...new Set(relays.map(normalizeURL))];
 if(unique.length>MAX_RELAYS)throw new Error(`SHIELDED_NOSTR_RELAYS lists at most ${MAX_RELAYS} relays.`);
 return unique;
}

type Entry={targets:Set<string>;answers?:Event[];at?:number;bytes:number};
// The pool's own reconnect is left off: it reopens at since=lastEmitted+1, so one future-dated event deafens a relay, and it never retries a connection that failed first.
// The pool checks a request's id as readRequest does, never its signature, and refuses content longer than one request before hashing it.
export function startNostrCarrier({open,secret,relays,pool=new AbstractSimplePool({verifyEvent:event=>typeof event.content==='string'&&event.content.length<=43_692&&idMatches(event),maxWaitForConnection:3000,websocketImplementation:CappedSocket as never}),now=Date.now,maxAnswer=ANSWER_BYTES,cacheBytes=16<<20}:{open:OhttpOpen;secret:Uint8Array;relays:readonly string[];pool?:RelayPool;now?:()=>number;maxAnswer?:number;cacheBytes?:number}):{close():void} {
 const gateway=getPublicKey(secret),tally=new Map<string,number>(),handled=new Map<string,Entry>(),live=new Map<string,{close():void}>(),waiting=new Map<string,ReturnType<typeof setTimeout>>(),echoes=new Map<string,ReturnType<typeof setTimeout>>(),opened=new Map<string,Relay>();
 let since=now(),closed=false,statusAt=0,statuses=0,cached=0,tokens=PUBLICATIONS_PER_SECOND,filled=performance.now();
 // A throw into the library makes it print the event being handled, so neither counting nor a handler may throw.
 const note=(kind:string)=>{try{tally.set(kind,(tally.get(kind)??0)+1);if(now()-since<60_000)return;console.log(`[nostr] ${[...tally].map(([name,count])=>`${name} ${count}`).join(', ')}`);tally.clear();since=now();}catch{}};
 const safely=<A extends unknown[]>(fn:(...args:A)=>void)=>(...args:A)=>{try{fn(...args);}catch{note('failed');}};
 const relayOf=async(url:string)=>{const relay=await pool.ensureRelay(url);relay.onnotice=()=>{};opened.set(url,relay);return relay;};
 // A flood of shed requests would make the gateway sign and publish a status for each, so they are capped per second (a fixed window on the monotonic clock, like admit()).
 const statusRoom=()=>{const at=performance.now();if(at-statusAt>=1000){statusAt=at;statuses=0;}return ++statuses<=STATUSES_PER_SECOND;};
 const refill=()=>{const at=performance.now();tokens=Math.min(PUBLICATIONS_PER_SECOND,tokens+(at-filled)*PUBLICATIONS_PER_SECOND/1000);filled=at;};
 const room=()=>{refill();return tokens>0;};
 const charge=(count:number)=>{refill();tokens-=count;};
 const drop=(x:string)=>{cached-=handled.get(x)!.bytes;handled.delete(x);};
 const evict=()=>{for(const x of handled.keys()){if(handled.size<=REMEMBERED&&cached<=cacheBytes)return;drop(x);}};
 const publish=(answers:Event[],targets:Iterable<string>)=>Promise.all([...targets].map(async url=>{
  const relay=await relayOf(url).catch(()=>undefined);
  await Promise.all(answers.map(async answer=>{try{await (relay?.publish(answer)??Promise.reject());}catch{note('unpublished');}}));
 }));
 // A throw can follow the upstream call, so it never becomes a status: a client reads one as "never ran" and may resend a POST.
 const run=async(x:string,sealed:Uint8Array,entry:Entry)=>{
  const forget=()=>{if(handled.get(x)===entry)drop(x);};
  try{
   const outcome=await open(sealed,{maxAnswer,room});
   if(closed)return;
   if(outcome.kind==='refused'){forget();note('refused');return;}
   if(outcome.kind==='busy'){
    forget();if(!statusRoom()){note('status-capped');return;}
    note('busy');await publish([statusEvent(outcome.status,outcome.retryAfter,x,secret,now())],entry.targets);return;
   }
   const at=now(),answers=answerEvents(outcome.bytes,x,secret,at);
   if(handled.get(x)===entry){Object.assign(entry,{answers,at,bytes:answers.reduce((sum,answer)=>sum+answer.content.length+512,0)});cached+=entry.bytes;evict();}
   note('answered');charge(answers.length*entry.targets.size);await publish(answers,entry.targets);
  }catch{forget();note('failed');}
 };
 // Copies share one run by x, whoever wrapped the bytes: open() records an enc only once it has opened, so a copy that reached it before then would be admitted again and refused, with no answer.
 const receive=(url:string,event:Event)=>{
  if(closed)return;
  if(event.pubkey===gateway){clearTimeout(echoes.get(url));return;}
  const sealed=readRequest(event,gateway);
  if(!sealed){note('dropped');return;}
  const x=addressOf(sealed),entry=handled.get(x);
  if(!entry){const fresh={targets:new Set([url]),bytes:0};handled.set(x,fresh);evict();void run(x,sealed,fresh);return;}
  if(entry.targets.has(url)){note('duplicate');return;}
  entry.targets.add(url);
  if(entry.answers&&now()-entry.at!<REPUBLISH_MS){charge(entry.answers.length);void publish(entry.answers,[url]);note('republished');}
  else note('duplicate');
 };
 const lost=(url:string)=>{if(closed)return;note('lost');live.delete(url);clearTimeout(echoes.get(url));waiting.set(url,setTimeout(()=>void listen(url),RESUBSCRIBE_MS));};
 const listen=async(url:string)=>{
  waiting.delete(url);
  try{
   // No connect timeout on purpose: the pool's own leaves the half-open socket behind, and CappedSocket bounds a connect itself.
   const relay=await relayOf(url);
   // limit:0 asks for new events only, so a restart reruns none a relay stored (strfry keeps ephemeral events 300 s); since bounds a relay that ignores it.
   if(!closed)live.set(url,relay.subscribe([{kinds:[NOSTR_REQUEST_KIND],'#p':[gateway],limit:0,since:roundedSeconds(now())-60}],{onevent:safely(event=>receive(url,event)),onclose:safely(()=>lost(url))}));
  }catch{lost(url);}
 };
 // The canary's traffic also keeps open a relay that drops idle sockets, as one did after 60 s.
 const canary=()=>{
  const event=finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:'',created_at:Math.floor(now()/1000)},secret);
  for(const url of live.keys()){echoes.set(url,setTimeout(safely(()=>{note('deaf');opened.get(url)?.close();}),ECHO_MS));void opened.get(url)?.publish(event).catch(()=>{});}
 };
 for(const url of new Set(relays))void listen(url);
 const ticker=setInterval(safely(canary),CANARY_MS);
 return {close(){
  closed=true;clearInterval(ticker);
  for(const timer of [...waiting.values(),...echoes.values()])clearTimeout(timer);
  waiting.clear();
  for(const sub of live.values())sub.close();
  live.clear();
  for(const relay of opened.values())relay.close();
  pool.destroy();
 }};
}
