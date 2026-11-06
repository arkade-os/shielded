import {matchFilters,type Filter} from 'nostr-tools/filter';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import type {CarrierPool,RelayPool} from '../../src/rollup/nostr-carrier.ts';

/** An in-memory relay network shaped like nostr-tools' pool: each URL is a channel, and a relay misbehaves as its options say. `unfiltered` makes it deliver everything. */
export function createNostrBus(){
 type Sub={url:string;filters:Filter[];onevent:(event:Event)=>void;onclose:(reason:string)=>void};
 const relays=new Map<string,{accept:boolean;deliver:boolean;delayMs:number;unfiltered:boolean;unreachable:boolean;timesOut:boolean;refusesButDelivers:boolean;claimsUnreachable:boolean}>(),live=new Set<Sub>(),links=new Map<string,{alive:boolean}>(),published:Event[]=[];
 const relay=(url:string)=>{
  if(!relays.has(url))relays.set(url,{accept:true,deliver:true,delayMs:0,unfiltered:false,unreachable:false,timesOut:false,refusesButDelivers:false,claimsUnreachable:false});
  return relays.get(url)!;
 };
 /** Closes subscriptions and the connection the way a relay does when it restarts or refuses them: the owners hear of it. */
 const drop=(url?:string,reason='relay connection closed')=>{
  for(const [at,link] of [...links])if(url===undefined||at===url){link.alive=false;links.delete(at);}
  for(const sub of [...live])if(url===undefined||sub.url===url){live.delete(sub);sub.onclose(reason);}
 };
 /** A relay taking an event: it throws where the library's publish rejects, a timed-out OK still delivers, and a lying relay delivers what it refuses or calls unreachable. */
 const take=(url:string,event:Event)=>{
  const {accept,deliver,delayMs,unfiltered,timesOut,refusesButDelivers,claimsUnreachable}=relay(url);
  if(!accept)throw new Error('blocked: this relay takes nothing');
  if(!verifyEvent(event))throw new Error('invalid: bad signature');
  if(!published.some(sent=>sent.id===event.id))published.push(event);
  if(deliver){
   const to=[...live].filter(sub=>sub.url===url&&(unfiltered||matchFilters(sub.filters,event)));
   setTimeout(()=>{for(const sub of to)if(live.has(sub))sub.onevent(JSON.parse(JSON.stringify(event)));},delayMs);
  }
  if(timesOut)throw new Error('publish timed out');
  if(refusesButDelivers)throw new Error('blocked: but delivered anyway');
  return claimsUnreachable?'connection failure: but delivered anyway':'';
 };
 const pool:CarrierPool&RelayPool={
  subscribeMany:(urls,filter,params)=>{
   const slots=[...new Set(urls)],reasons:{url:string;reason:string}[]=[],seen=new Set<string>();let closed=0;
   const subs:Sub[]=slots.map((url,i)=>({url,filters:[filter],
    onevent:event=>{if(!seen.has(event.id)){seen.add(event.id);params.onevent?.(event);}},
    onclose:reason=>{if(reasons[i])return;reasons[i]={url,reason};if(++closed===slots.length)params.onclose?.(reasons);}}));
   for(const sub of subs){if(relay(sub.url).unreachable)queueMicrotask(()=>sub.onclose('connection failed'));else live.add(sub);}
   return {close:()=>{for(const sub of subs)if(live.delete(sub))sub.onclose('closed by caller');}};
  },
  publish:(urls,event)=>urls.map(async url=>{
   if(relay(url).unreachable)return 'connection failure: connection failed';
   return take(url,event);
  }),
  ensureRelay:async url=>{
   if(!links.has(url)){if(relay(url).unreachable)throw 'connection failed';links.set(url,{alive:true});}
   const link=links.get(url)!,stale=()=>new Error(`Tried to send message on a closed connection to ${url}.`);
   return {
    onnotice:()=>{},
    subscribe:(filters,params)=>{
     if(!link.alive)throw stale();
     const sub:Sub={url,filters,onevent:params.onevent,onclose:params.onclose};live.add(sub);
     return {close:(reason='closed by caller')=>{if(live.delete(sub))sub.onclose(reason);}};
    },
    publish:async event=>{if(!link.alive)throw stale();return take(url,event);},
   };
  },
  destroy:()=>drop(undefined,'relay connection closed by us'),
 };
 return {pool,relay,drop,published,openSubscriptions:()=>live.size};
}
