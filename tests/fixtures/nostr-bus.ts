import {matchFilters,type Filter} from 'nostr-tools/filter';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import type {CarrierPool} from '../../src/rollup/nostr-carrier.ts';

/** An in-memory relay network shaped like nostr-tools' pool: each URL is a channel, and a relay misbehaves as its options say. `unfiltered` makes it deliver everything. */
export function createNostrBus(){
 type Sub={url:string;filters:Filter[];onevent:(event:Event)=>void;onclose:(reason:string)=>void};
 const relays=new Map<string,{accept:boolean;deliver:boolean;delayMs:number;unfiltered:boolean;unreachable:boolean;timesOut:boolean}>(),live=new Set<Sub>(),published:Event[]=[];
 const relay=(url:string)=>{
  if(!relays.has(url))relays.set(url,{accept:true,deliver:true,delayMs:0,unfiltered:false,unreachable:false,timesOut:false});
  return relays.get(url)!;
 };
 /** Closes subscriptions the way a relay does when it restarts or refuses them: the owner hears of it. */
 const drop=(url?:string,reason='relay connection closed')=>{for(const sub of [...live])if(url===undefined||sub.url===url){live.delete(sub);sub.onclose(reason);}};
 /** A relay taking an event: it throws where the library's publish rejects, and a timed-out OK still delivers. */
 const take=(url:string,event:Event)=>{
  const {accept,deliver,delayMs,unfiltered,timesOut}=relay(url);
  if(!accept)throw new Error('blocked: this relay takes nothing');
  if(!verifyEvent(event))throw new Error('invalid: bad signature');
  if(!published.some(sent=>sent.id===event.id))published.push(event);
  if(deliver){
   const to=[...live].filter(sub=>sub.url===url&&(unfiltered||matchFilters(sub.filters,event)));
   setTimeout(()=>{for(const sub of to)if(live.has(sub))sub.onevent(JSON.parse(JSON.stringify(event)));},delayMs);
  }
  if(timesOut)throw new Error('publish timed out');
 };
 const pool:CarrierPool={
  subscribeMany:(urls,filter,params)=>{
   const slots=[...new Set(urls)],reasons:{url:string;reason:string}[]=[];let closed=0;
   const subs:Sub[]=slots.map((url,i)=>({url,filters:[filter],
    onevent:event=>params.onevent?.(event),
    onclose:reason=>{if(reasons[i])return;reasons[i]={url,reason};if(++closed===slots.length)params.onclose?.(reasons);}}));
   for(const sub of subs){if(relay(sub.url).unreachable)queueMicrotask(()=>sub.onclose('connection failed'));else live.add(sub);}
   return {close:()=>{for(const sub of subs)if(live.delete(sub))sub.onclose('closed by caller');}};
  },
  publish:(urls,event)=>urls.map(async url=>{
   if(relay(url).unreachable)return 'connection failure: connection failed';
   take(url,event);return '';
  }),
  destroy:()=>drop(undefined,'relay connection closed by us'),
 };
 return {pool,relay,drop,published,openSubscriptions:()=>live.size};
}
