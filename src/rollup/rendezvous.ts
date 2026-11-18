import express from 'express';
import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import {matchFilter,type Filter} from 'nostr-tools/filter';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import {CARD_KIND,RENDEZVOUS_WAIT_MS,RFQ_KIND} from '../shielded/network-privacy.ts';
import {ANSWER_BYTES,CappedSocket} from './nostr-carrier.ts';

export {CARD_KIND,RENDEZVOUS_WAIT_MS,RFQ_KIND};
export const RFQ_RELAYS:readonly string[]=Object.freeze(['wss://nostr.arkade.sh']);
const MAX_EVENTS=16,EVENT_BYTES=64<<10,CONTENT_CHARS=16<<10,MAX_AUTHORS=8,ANSWER_LIMIT=ANSWER_BYTES-1024;
export type RendezvousPool=Pick<AbstractSimplePool,'subscribeMany'|'publish'|'destroy'>;
class Refused extends Error {}
const hex64=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const exactly=(filter:Record<string,unknown>,want:Record<string,unknown>)=>Object.keys(filter).length===Object.keys(want).length&&Object.entries(want).every(([key,value])=>JSON.stringify(filter[key])===JSON.stringify(value));
const accepted=(result:PromiseSettledResult<string>)=>result.status==='fulfilled'&&!String(result.value).startsWith('connection failure');

function requestOf(body:unknown,maxWaitMs:number):{event?:Event;filter:Filter;waitMs:number} {
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Refused('A rendezvous is a JSON object.');
 const {kind,event,filter,waitMs,...rest}=body as Record<string,unknown>;
 if(kind!==RFQ_KIND&&kind!==CARD_KIND)throw new Refused(`A rendezvous carries a solver RFQ (kind ${RFQ_KIND}) or reads solver cards (kind ${CARD_KIND}), nothing else.`);
 if(Object.keys(rest).length)throw new Refused('A rendezvous names only its kind, event, filter and wait; the pool picks the relays.');
 if(!Number.isSafeInteger(waitMs)||(waitMs as number)<1||(waitMs as number)>maxWaitMs)throw new Refused(`A rendezvous waits 1 to ${maxWaitMs} ms.`);
 if(!filter||typeof filter!=='object'||Array.isArray(filter))throw new Refused('A rendezvous needs a filter.');
 const f=filter as Record<string,unknown>;
 if(kind===CARD_KIND){
  const authors=f.authors,network=f['#d'];
  if(event!==undefined||!Array.isArray(authors)||!authors.length||authors.length>MAX_AUTHORS||!authors.every(hex64)||!Array.isArray(network)||network.length!==1||typeof network[0]!=='string'||network[0].length>64||!exactly(f,{kinds:[CARD_KIND],authors,'#d':network}))
   throw new Refused('A card rendezvous only reads the cards of named solvers on one network.');
  return {filter:f as Filter,waitMs:waitMs as number};
 }
 const e=event as Event|undefined;
 if(!e||typeof e!=='object'||typeof e.content!=='string'||e.content.length>CONTENT_CHARS||!Array.isArray(e.tags)||e.tags.length>4||JSON.stringify(e).length>EVENT_BYTES)throw new Refused('An RFQ rendezvous publishes one small signed event.');
 // verifyEvent throws on some malformed events, and a forged one must never reach a relay through the pool.
 let signed=false;try{signed=e.kind===RFQ_KIND&&verifyEvent(e);}catch{}
 if(!signed)throw new Refused(`The RFQ is not a validly signed kind ${RFQ_KIND} event.`);
 const solver=e.tags.find(tag=>Array.isArray(tag)&&tag[0]==='p')?.[1];
 if(!hex64(solver)||!exactly(f,{kinds:[RFQ_KIND],'#p':[e.pubkey],authors:[solver]}))throw new Refused('An RFQ rendezvous hears only the addressed solver\'s replies to its own key.');
 return {event:e,filter:f as Filter,waitMs:waitMs as number};
}

/** The pool's relay I/O for a sealed wallet's solver rendezvous: it never sees a socket, and the RFQ stays sealed to the solver. A fresh pool per request leaves no relay state to leak between callers. */
export function createRendezvousRouter({relays,fromGateway,rate=4,maxInFlight=8,maxWaitMs=RENDEZVOUS_WAIT_MS,pool=()=>new AbstractSimplePool({verifyEvent,maxWaitForConnection:5000,websocketImplementation:CappedSocket as never}),now=()=>performance.now()}:{relays:readonly string[];fromGateway:(req:express.Request)=>boolean;rate?:number;maxInFlight?:number;maxWaitMs?:number;pool?:()=>RendezvousPool;now?:()=>number}){
 if(!relays.length||![rate,maxInFlight].every(count=>Number.isSafeInteger(count)&&count>=1)||!(maxWaitMs>0&&maxWaitMs<=RENDEZVOUS_WAIT_MS))throw new Error(`The rendezvous needs a relay, whole limits of at least 1 and a wait of at most ${RENDEZVOUS_WAIT_MS} ms.`);
 const tally=new Map<string,number>();let since=now(),second=0,used=0,inFlight=0;
 const note=(kind:string)=>{tally.set(kind,(tally.get(kind)??0)+1);if(now()-since<60_000)return;console.log(`[rendezvous] ${[...tally].map(([name,count])=>`${name} ${count}`).join(', ')}`);tally.clear();since=now();};
 const admit=():429|503|undefined=>{if(inFlight>=maxInFlight)return 503;const at=now();if(at-second>=1000){second=at;used=0;}if(++used>rate)return 429;}; // ponytail: fixed window, as the gateway's
 // An RFQ ends at the solver's first reply, a card read at end of stored events; either ends at the wait.
 const meet=async({event,filter,waitMs}:{event?:Event;filter:Filter;waitMs:number})=>{
  const relay=pool(),heard:Event[]=[];let bytes=0,dropped=0,end=()=>{};
  const ended=new Promise<undefined>(resolve=>{end=()=>resolve(undefined);}),timer=setTimeout(end,waitMs);
  try{
   relay.subscribeMany([...relays],filter,{onclose:end,oneose:()=>{if(!event)end();},onevent:found=>{
    if(!matchFilter(filter,found))return;
    const size=JSON.stringify(found).length;
    if(heard.length>=MAX_EVENTS||size>EVENT_BYTES||bytes+size>ANSWER_LIMIT){dropped++;return;}
    heard.push(found);bytes+=size;if(event)end();
   }});
   if(event&&!(await Promise.race([Promise.allSettled(relay.publish([...relays],event)),ended]))?.some(accepted))return {published:false,heard,dropped};
   await ended;return {published:true,heard,dropped};
  }finally{clearTimeout(timer);relay.destroy();}
 };
 const router=express.Router();
 router.post('/rendezvous',(req,res,next)=>{if(fromGateway(req))return next();note('refused');res.status(403).json({error:'The rendezvous answers sealed requests only.'});},express.json({limit:'64kb',strict:true}),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  let request;try{request=requestOf(req.body,maxWaitMs);}catch(error){if(!(error instanceof Refused))throw error;note('refused');res.status(400).json({error:error.message});return;}
  const busy=admit();if(busy){note('busy');res.setHeader('Retry-After','1').status(busy).json({error:'The rendezvous is busy; try again in a moment.'});return;}
  inFlight++;
  try{
   const {published,heard,dropped}=await meet(request);
   if(dropped)note('dropped');
   if(!published){note('unpublished');res.status(502).json({error:'No rendezvous relay took the event.'});return;}
   note(heard.length?'answered':'empty');res.json({events:heard});
  }catch{note('failed');res.status(502).json({error:'The rendezvous failed.'});}
  finally{inFlight--;}
 });
 router.use((error:{type?:string;status?:number},_req:express.Request,res:express.Response,next:express.NextFunction)=>{
  if(error.type!=='entity.parse.failed'&&error.type!=='entity.too.large')return next(error);
  note('refused');res.status(error.status??400).json({error:'A rendezvous is JSON of at most 64 KiB.'});
 });
 return router;
}
