import {SimplePool,type SubCloser} from 'nostr-tools/pool';
import {getPublicKey,type Event} from 'nostr-tools/pure';
import {answerEvents,NOSTR_RELAYS,NOSTR_REQUEST_KIND,readRequest,statusEvent} from '../../packages/protocol/src/nostr-carrier.ts';
import type {OhttpOpen} from './ohttp-gateway.ts';

export type CarrierPool=Pick<SimplePool,'subscribeMany'|'publish'|'destroy'>;

// 960 KiB of answer plus the HTTP framing and the sealing overhead still fits 32 chunks of 32 KiB.
// ponytail: a flat 30 s retry, so a relay that keeps refusing us is asked every 30 s; back off if an operator minds.
const ANSWER_BYTES=960<<10,REMEMBERED=10_000,RESUBSCRIBE_MS=30_000;

export function nostrRelaysFromEnv(value:string|undefined):readonly string[] {
 if(!value?.trim())return NOSTR_RELAYS;
 const relays=value.split(',').map(relay=>relay.trim());
 if(!relays.every(relay=>URL.canParse(relay)&&new URL(relay).protocol==='wss:'))throw new Error('SHIELDED_NOSTR_RELAYS is a comma-separated list of wss:// relay URLs.');
 return relays;
}

// The pool's own reconnect is left off: it reopens at since=lastEmitted+1, so one future-dated event deafens a relay, and it never retries a connection that failed first.
export function startNostrCarrier({open,secret,relays,pool=new SimplePool(),now=Date.now,maxAnswer=ANSWER_BYTES}:{open:OhttpOpen;secret:Uint8Array;relays:readonly string[];pool?:CarrierPool;now?:()=>number;maxAnswer?:number}):{close():void} {
 const gateway=getPublicKey(secret),tally=new Map<string,number>(),handled=new Map<string,Set<string>>(),live=new Map<string,SubCloser>(),waiting=new Map<string,ReturnType<typeof setTimeout>>();
 let since=now(),closed=false;
 const note=(kind:string)=>{tally.set(kind,(tally.get(kind)??0)+1);if(now()-since<60_000)return;console.log(`[nostr] ${[...tally].map(([name,count])=>`${name} ${count}`).join(', ')}`);tally.clear();since=now();};
 // A throw can follow the upstream call, so it never becomes a status: a client reads one as "never ran" and may resend a POST.
 const run=async(event:Event,sealed:Uint8Array,targets:Set<string>)=>{
  try{
   const outcome=await open(sealed,{maxAnswer});
   if(closed)return;
   if(outcome.kind==='refused'){note('refused');return;}
   const request={id:event.id,pubkey:event.pubkey},at=now(),answers=outcome.kind==='sealed'?answerEvents(outcome.bytes,request,secret,at):[statusEvent(outcome.status,outcome.retryAfter,request,secret,at)];
   note(outcome.kind==='sealed'?'answered':'busy');
   await Promise.all(answers.flatMap(answer=>pool.publish([...targets],answer).map(sent=>sent.catch(()=>note('unpublished')))));
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
 // One subscription per relay, so each copy of a request says which relay carried it; a pool-wide one would hide the second relay's copy.
 const listen=(url:string)=>{
  waiting.delete(url);
  live.set(url,pool.subscribeMany([url],{kinds:[NOSTR_REQUEST_KIND],'#p':[gateway]},{
   onevent:event=>{try{receive(url,event);}catch{note('failed');}},
   onclose:()=>{if(closed)return;note('lost');waiting.set(url,setTimeout(()=>listen(url),RESUBSCRIBE_MS));},
  }));
 };
 for(const url of new Set(relays))listen(url);
 return {close(){
  closed=true;
  for(const timer of waiting.values())clearTimeout(timer);
  waiting.clear();
  for(const sub of live.values())sub.close();
  live.clear();pool.destroy();
 }};
}
