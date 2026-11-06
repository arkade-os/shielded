import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {NOSTR_ANSWER_KIND,NOSTR_CHUNK_BYTES,NOSTR_RELAYS,readAnswer,requestEvent} from '../../packages/protocol/src/nostr-carrier.ts';
import type {CarrierPool} from '../rollup/nostr-carrier.ts';

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
// nostr-tools fulfils "connection failure: …" for a relay it never reached, and otherwise with the relay's own OK text, which may be absent. It rejects an OK false with NIP-01's reason; a timeout or a dropped connection rejects though the event may be out, and "duplicate:" means the relay has it.
const REFUSED=/^(pow|blocked|rate-limited|invalid|restricted|mute|error|auth-required):/;
const accepted=(result:PromiseSettledResult<string>)=>result.status==='fulfilled'?!String(result.value).startsWith('connection failure'):!(result.reason instanceof Error&&REFUSED.test(result.reason.message));

export class SealedFetchError extends Error {
 constructor(readonly code:'unavailable'|'outcome-unknown'|'too-large',message:string){super(message);}
}
type Ending={kind:'refused'|'timeout'}|{kind:'status';wait:number};

// No enableReconnect: it resubscribes at since=lastEmitted+1, and the next attempt covers a dropped relay. Pure's verifyEvent caches the verdict readAnswer reads.
export function createSealedFetch({config,gateway,origin,relays=NOSTR_RELAYS,pick=2,timeoutMs=40_000,attempts=3,pool=new AbstractSimplePool({verifyEvent,maxWaitForConnection:3000}),random=Math.random}:{config:Uint8Array;gateway:string;origin:string;relays?:readonly string[];pick?:number;timeoutMs?:number;attempts?:number;pool?:CarrierPool;random?:()=>number}):((input:string|URL|Request,init?:RequestInit)=>Promise<Response>)&{close():void} {
 const client=new OHTTPClient(SUITE,KeyConfig.select(SUITE,KeyConfig.parseMultiple(config)),{maxMessageSize:5<<20}),urls=[...new Set(relays)];
 const sealedFetch=async(input:string|URL|Request,init?:RequestInit):Promise<Response>=>{
  const signal=init?.signal??(input instanceof Request?input.signal:undefined),source=new Request(input instanceof Request?input:new URL(input,origin),init),headers=new Headers();
  for(const name of ['content-type','accept']){const value=source.headers.get(name);if(value!==null)headers.set(name,value);}
  const {url,method}=source,body=source.body?await source.arrayBuffer():undefined,tried=new Set<string>(),cleanup:(()=>void)[]=[];
  signal?.throwIfAborted();
  let done=false,found:(open:()=>Promise<Response>)=>void=()=>{};
  const answered=new Promise<{kind:'sealed';open:()=>Promise<Response>}>(resolve=>{found=open=>resolve({kind:'sealed',open});});
  const aborted=new Promise<never>((_,reject)=>{const stop=()=>reject(signal!.reason);signal?.addEventListener('abort',stop);cleanup.push(()=>signal?.removeEventListener('abort',stop));});
  const after=<T>(ms:number,value:T)=>new Promise<T>(resolve=>{const timer=setTimeout(resolve,ms,value);cleanup.push(()=>clearTimeout(timer));});
  const choose=()=>{
   const chosen:string[]=[];
   while(chosen.length<Math.min(pick,urls.length)){
    const fresh=urls.filter(relay=>!tried.has(relay)),from=fresh.length?fresh:urls.filter(relay=>!chosen.includes(relay)),next=from[Math.floor(random()*from.length)]!;
    chosen.push(next);tried.add(next);
   }
   return chosen;
  };
  const attempt=async():Promise<Ending>=>{
   const {init:sealed,context}=await client.encapsulateRequest(new Request(url,{method,headers,body})),bytes=sealed.body as Uint8Array;
   if(bytes.length>NOSTR_CHUNK_BYTES)throw new SealedFetchError('too-large','The sealed request is larger than one Nostr event carries.');
   // An answer or an abort can end the fetch while this attempt seals; it must not publish after that.
   if(done)return {kind:'refused'};
   const event=requestEvent(bytes,gateway,Date.now()),to=choose(),events:Event[]=[],deadline=Date.now()+timeoutMs;
   return new Promise(resolve=>{
    const sub=pool.subscribeMany(to,{kinds:[NOSTR_ANSWER_KIND],authors:[gateway],'#e':[event.id]},{onevent:answer=>{
     events.push(answer);const read=readAnswer(events,event.id,gateway);
     if(read?.kind==='sealed')found(()=>context.decapsulateResponse(new Response(read.bytes as Uint8Array<ArrayBuffer>,{headers:{'content-type':'message/ohttp-res'}})));
     else if(read)resolve({kind:'status',wait:Math.min(read.retryAfter*1000,deadline-Date.now())});
    }});
    cleanup.push(()=>sub.close());
    void after(timeoutMs,{kind:'timeout'} as const).then(resolve);
    void Promise.allSettled(pool.publish(to,event)).then(results=>{if(!results.some(accepted))resolve({kind:'refused'});});
   });
  };
  try{
   for(let n=1;n<=attempts;n++){
    const end=await Promise.race([answered,aborted,attempt()]);
    if(end.kind==='sealed')return end.open();
    if(end.kind==='timeout'&&method!=='GET')throw new SealedFetchError('outcome-unknown','The request went out and no answer came in time, so it may have run.');
    if(end.kind==='status'&&n<attempts){const slept=await Promise.race([answered,aborted,after(end.wait,undefined)]);if(slept)return slept.open();}
   }
   throw new SealedFetchError('unavailable','No relay brought an answer in time.');
  }finally{done=true;for(const clean of cleanup)clean();}
 };
 return Object.assign(sealedFetch,{close:()=>pool.destroy()});
}
