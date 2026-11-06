import {matchFilter,type Filter} from 'nostr-tools/filter';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import type {CarrierPool} from '../../src/rollup/nostr-carrier.ts';

/** An in-memory relay network: each URL is a channel. `unfiltered` makes a relay deliver everything, as a hostile one could. */
export function createNostrBus(){
 type Sub={url:string;filter:Filter;onevent:(event:Event)=>void;onclose:()=>void};
 const relays=new Map<string,{accept:boolean;deliver:boolean;delayMs:number;unfiltered:boolean}>(),live=new Set<Sub>(),published:Event[]=[];
 const relay=(url:string)=>{
  if(!relays.has(url))relays.set(url,{accept:true,deliver:true,delayMs:0,unfiltered:false});
  return relays.get(url)!;
 };
 /** Closes subscriptions the way a relay does when it restarts or refuses them: the owner hears of it. */
 const drop=(url?:string)=>{for(const sub of [...live])if(url===undefined||sub.url===url){live.delete(sub);sub.onclose();}};
 const pool:CarrierPool={
  subscribeMany:(urls,filter,params)=>{
   const mine=urls.map(url=>({url,filter,onevent:params.onevent??(()=>{}),onclose:()=>params.onclose?.([{url,reason:'closed'}])}));
   for(const sub of mine)live.add(sub);
   return {close:()=>{for(const sub of mine)if(live.delete(sub))sub.onclose();}};
  },
  publish:(urls,event)=>urls.map(async url=>{
   const {accept,deliver,delayMs,unfiltered}=relay(url);
   if(!accept)throw new Error('blocked: this relay takes nothing');
   if(!verifyEvent(event))throw new Error('invalid: bad signature');
   if(!published.some(sent=>sent.id===event.id))published.push(event);
   if(!deliver)return '';
   const to=[...live].filter(sub=>sub.url===url&&(unfiltered||matchFilter(sub.filter,event)));
   setTimeout(()=>{for(const sub of to)if(live.has(sub))sub.onevent(JSON.parse(JSON.stringify(event)));},delayMs);
   return '';
  }),
  destroy:()=>drop(),
 };
 return {pool,relay,drop,published,openSubscriptions:()=>live.size};
}
