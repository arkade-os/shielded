import {concatBytes} from '@noble/hashes/utils.js';
import {base64} from '@scure/base';
import {finalizeEvent,generateSecretKey,verifyEvent,type Event,type VerifiedEvent} from 'nostr-tools/pure';

export const NOSTR_REQUEST_KIND=21470;
export const NOSTR_ANSWER_KIND=21471;
export const NOSTR_CHUNK_BYTES=32<<10;
export const NOSTR_MAX_CHUNKS=32;
/** Probed relays; none sits behind Cloudflare. */
export const NOSTR_RELAYS:readonly string[]=['wss://nos.lol','wss://relay.snort.social','wss://offchain.pub','wss://nostr.mom','wss://nostr.oxtr.dev','wss://nostr-pub.wellorder.net'];
type RequestRef={id:string;pubkey:string};

/** Rounded down to a 30 s bucket so created_at is not the exact send time. */
export const roundedSeconds=(nowMs:number)=>Math.floor(nowMs/30_000)*30;
const tag=(event:Event,name:string,value?:string)=>event.tags.find(t=>t[0]===name&&(value===undefined||t[1]===value));
const decode=(text:string)=>{try{const bytes=base64.decode(text);return bytes.length<=NOSTR_CHUNK_BYTES?bytes:undefined;}catch{return undefined;}};
const answerEvent=(request:RequestRef,last:string[],content:string,secret:Uint8Array,nowMs:number)=>finalizeEvent({kind:NOSTR_ANSWER_KIND,tags:[['e',request.id],['p',request.pubkey],last],content,created_at:roundedSeconds(nowMs)},secret);

export function requestEvent(sealed:Uint8Array,gateway:string,nowMs:number):VerifiedEvent {
 if(sealed.length>NOSTR_CHUNK_BYTES)throw new RangeError(`A sealed request is at most ${NOSTR_CHUNK_BYTES} bytes.`);
 return finalizeEvent({kind:NOSTR_REQUEST_KIND,tags:[['p',gateway]],content:base64.encode(sealed),created_at:roundedSeconds(nowMs)},generateSecretKey());
}
export function readRequest(event:Event,gateway:string):Uint8Array|undefined {
 // verifyEvent goes first: it returns false on a malformed shape rather than throwing, and nostr-tools caches its verdict on the event.
 if(!verifyEvent(event)||event.kind!==NOSTR_REQUEST_KIND||!tag(event,'p',gateway))return undefined;
 return decode(event.content);
}
export function answerEvents(sealed:Uint8Array,request:RequestRef,secret:Uint8Array,nowMs:number):VerifiedEvent[] {
 const count=Math.ceil(sealed.length/NOSTR_CHUNK_BYTES);
 if(count>NOSTR_MAX_CHUNKS)throw new RangeError(`A sealed answer is at most ${NOSTR_MAX_CHUNKS} chunks of ${NOSTR_CHUNK_BYTES} bytes.`);
 return Array.from({length:count},(_,i)=>answerEvent(request,['chunk',String(i),String(count)],base64.encode(sealed.subarray(i*NOSTR_CHUNK_BYTES,(i+1)*NOSTR_CHUNK_BYTES)),secret,nowMs));
}
export const statusEvent=(status:429|503,retryAfter:number,request:RequestRef,secret:Uint8Array,nowMs:number):VerifiedEvent=>answerEvent(request,['status',String(status),String(retryAfter)],'',secret,nowMs);

export function readAnswer(events:readonly Event[],requestId:string,gateway:string):{kind:'sealed';bytes:Uint8Array}|{kind:'status';status:number;retryAfter:number}|undefined {
 const mine=events.filter(event=>verifyEvent(event)&&event.kind===NOSTR_ANSWER_KIND&&event.pubkey===gateway&&tag(event,'e',requestId));
 for(const event of mine){
  const [,code,delay]=tag(event,'status')??[],status=Number(code),retryAfter=Number(delay);
  if((status===429||status===503)&&Number.isFinite(retryAfter)&&retryAfter>=0)return {kind:'status',status,retryAfter};
 }
 const parts=new Map<number,string>();let count=0;
 for(const event of mine){
  const [,i,n]=tag(event,'chunk')??[],index=Number(i),total=Number(n);
  if(!Number.isInteger(index)||!Number.isInteger(total)||index<0||index>=total||total>NOSTR_MAX_CHUNKS)continue;
  if(count&&count!==total||parts.has(index)&&parts.get(index)!==event.content)return undefined;
  count=total;parts.set(index,event.content);
 }
 if(!count||parts.size<count)return undefined;
 const chunks:Uint8Array[]=[];
 for(let at=0;at<count;at++){const chunk=decode(parts.get(at)!);if(!chunk)return undefined;chunks.push(chunk);}
 return {kind:'sealed',bytes:concatBytes(...chunks)};
}
