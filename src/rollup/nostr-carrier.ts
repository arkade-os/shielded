import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import type {Filter} from 'nostr-tools/filter';
import type {SimplePool} from 'nostr-tools/pool';
import {getPublicKey,type Event} from 'nostr-tools/pure';
import {normalizeURL} from 'nostr-tools/utils';
import {answerEvents,idMatches,NOSTR_RELAYS,NOSTR_REQUEST_KIND,readRequest,roundedSeconds,statusEvent} from '../../packages/protocol/src/nostr-carrier.ts';
import type {OhttpOpen} from './ohttp-gateway.ts';

export type CarrierPool=Pick<SimplePool,'subscribeMany'|'publish'|'destroy'>;
// The listener works a relay at a time: subscribeMany remembers every event id it sees, and each id pins the whole relay message it was cut from.
type Relay={onnotice:(message:string)=>void;subscribe(filters:Filter[],params:{onevent:(event:Event)=>void;onclose:(reason:string)=>void}):{close(reason?:string):void};publish(event:Event):Promise<string>};
export type RelayPool={ensureRelay(url:string):Promise<Relay>;destroy():void};

// The most body whose sealed answer fits 8 chunks: 63 Padmé steps of 4 KiB (a 64th plus 32 bytes of nonce and tag passes 256 KiB), less 8 bytes of BHTTP framing and 16 396 for the copied headers at their largest, as Node's fetch refuses 16 KiB of header names and values.
// ponytail: a flat 30 s retry, so a relay that keeps refusing us is asked every 30 s; back off if an operator minds.
const ANSWER_BYTES=63*4096-8-16_396,REMEMBERED=10_000,STATUSES_PER_SECOND=5,RESUBSCRIBE_MS=30_000;

export function nostrRelaysFromEnv(value:string|undefined):readonly string[] {
 if(!value?.trim())return NOSTR_RELAYS;
 const relays=value.split(',').map(relay=>relay.trim());
 if(!relays.every(relay=>URL.canParse(relay)&&new URL(relay).protocol==='wss:'))throw new Error('SHIELDED_NOSTR_RELAYS is a comma-separated list of wss:// relay URLs.');
 return [...new Set(relays.map(normalizeURL))];
}

// The pool's own reconnect is left off: it reopens at since=lastEmitted+1, so one future-dated event deafens a relay, and it never retries a connection that failed first.
// The pool checks a request's id as readRequest does, never its signature: receive() dedupes by id before readRequest runs.
export function startNostrCarrier({open,secret,relays,pool=new AbstractSimplePool({verifyEvent:idMatches,maxWaitForConnection:3000}),now=Date.now,maxAnswer=ANSWER_BYTES}:{open:OhttpOpen;secret:Uint8Array;relays:readonly string[];pool?:RelayPool;now?:()=>number;maxAnswer?:number}):{close():void} {
 const gateway=getPublicKey(secret),tally=new Map<string,number>(),handled=new Map<string,Set<string>>(),live=new Map<string,{close():void}>(),waiting=new Map<string,ReturnType<typeof setTimeout>>();
 let since=now(),closed=false,statusAt=0,statuses=0;
 // A throw into the library makes it print the event being handled, so neither counting nor a handler may throw.
 const note=(kind:string)=>{try{tally.set(kind,(tally.get(kind)??0)+1);if(now()-since<60_000)return;console.log(`[nostr] ${[...tally].map(([name,count])=>`${name} ${count}`).join(', ')}`);tally.clear();since=now();}catch{}};
 const safely=<A extends unknown[]>(fn:(...args:A)=>void)=>(...args:A)=>{try{fn(...args);}catch{note('failed');}};
 const relayOf=async(url:string)=>{const relay=await pool.ensureRelay(url);relay.onnotice=()=>{};return relay;};
 // A flood of shed requests would make the gateway sign and publish a status for each, so they are capped per second (a fixed window, like admit()).
 const statusRoom=()=>{const at=now();if(at-statusAt>=1000){statusAt=at;statuses=0;}return ++statuses<=STATUSES_PER_SECOND;};
 // A throw can follow the upstream call, so it never becomes a status: a client reads one as "never ran" and may resend a POST.
 const run=async(event:Event,sealed:Uint8Array,targets:Set<string>)=>{
  try{
   const outcome=await open(sealed,{maxAnswer});
   if(closed)return;
   if(outcome.kind==='refused'){note('refused');return;}
   if(outcome.kind==='busy'&&!statusRoom()){note('status-capped');return;}
   const request={id:event.id,pubkey:event.pubkey},at=now(),answers=outcome.kind==='sealed'?answerEvents(outcome.bytes,request,secret,at):[statusEvent(outcome.status,outcome.retryAfter,request,secret,at)];
   note(outcome.kind==='sealed'?'answered':'busy');
   await Promise.all([...targets].map(async url=>{
    const relay=await relayOf(url).catch(()=>undefined);
    await Promise.all(answers.map(answer=>(relay?.publish(answer)??Promise.reject()).catch(()=>note('unpublished'))));
   }));
  }catch{note('failed');}
 };
 // Copies are dropped before open(), which sheds at its cap before it looks for a replay: a copy of a running request would be told busy.
 const receive=(url:string,event:Event)=>{
  if(closed)return;
  if(handled.has(event.id)){handled.get(event.id)!.add(url);note('duplicate');return;}
  const sealed=readRequest(event,gateway);
  if(!sealed){note('dropped');return;}
  const targets=new Set([url]);handled.set(event.id,targets);
  if(handled.size>REMEMBERED)handled.delete(handled.keys().next().value!);
  void run(event,sealed,targets);
 };
 const lost=(url:string)=>{if(closed)return;note('lost');waiting.set(url,setTimeout(()=>void listen(url),RESUBSCRIBE_MS));};
 const listen=async(url:string)=>{
  waiting.delete(url);
  try{
   // No connect timeout on purpose: the pool's own leaves the half-open socket behind, and undici bounds a connect itself.
   const relay=await relayOf(url);
   // limit:0 asks for new events only, so a restart reruns none a relay stored (strfry keeps ephemeral events 300 s); since bounds a relay that ignores it.
   if(!closed)live.set(url,relay.subscribe([{kinds:[NOSTR_REQUEST_KIND],'#p':[gateway],limit:0,since:roundedSeconds(now())-60}],{onevent:safely(event=>receive(url,event)),onclose:safely(()=>lost(url))}));
  }catch{lost(url);}
 };
 for(const url of new Set(relays))void listen(url);
 return {close(){
  closed=true;
  for(const timer of waiting.values())clearTimeout(timer);
  waiting.clear();
  for(const sub of live.values())sub.close();
  live.clear();pool.destroy();
 }};
}
