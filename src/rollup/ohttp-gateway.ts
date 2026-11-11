import express from 'express';
import type {OhttpGatewayKey} from './ohttp-keys.ts';

export interface OhttpUpstream{origin:string;prefix:string}
export type OhttpOutcome={kind:'sealed';bytes:Uint8Array}|{kind:'busy';status:429|503;retryAfter:number}|{kind:'refused'};
export type OhttpOpen=(sealed:Uint8Array,options?:{maxAnswer?:number;signal?:AbortSignal;room?:()=>boolean})=>Promise<OhttpOutcome>;

const MAX_RESPONSE=4<<20,REMEMBERED=100_000;
const STREAMS=['/v1/txs','/v1/batch/events','/v1/indexer/script/subscription','/v1/indexer/subscription'];
const copied=(from:Headers,names:string[])=>{const kept=new Headers();for(const name of names){const value=from.get(name);if(value!==null)kept.set(name,value);}return kept;};

export function createOhttpGateway({key,upstreams,poolOrigin,poolLoopback,gatewayToken,rate=20,maxInFlight=32,timeoutMs=30_000,http=true,fetch:send=fetch,now=()=>performance.now(),clock=()=>Date.now(),windowMs=90_000}:{key:OhttpGatewayKey;upstreams:OhttpUpstream[];poolOrigin:string;poolLoopback:string;gatewayToken:string;rate?:number;maxInFlight?:number;timeoutMs?:number;http?:boolean;fetch?:typeof fetch;now?:()=>number;clock?:()=>number;windowMs?:number}){
 if(![rate,maxInFlight].every(count=>Number.isSafeInteger(count)&&count>=1))throw new Error('The Oblivious HTTP rate and in-flight cap are whole numbers of at least 1.');
 const allowed=upstreams.map(({origin,prefix})=>{const url=new URL(origin);if(url.protocol!=='https:'||!prefix.startsWith('/')||!prefix.endsWith('/'))throw new Error(`An Oblivious HTTP upstream is https with a path prefix that starts and ends with /, not ${origin} ${prefix}.`);return {origin:url.origin,prefix};});
 const pool=new URL(poolOrigin).origin,loopback=new URL(poolLoopback).origin,tally=new Map<string,number>(),seen=new Set<string>();
 let since=now(),second=0,used=0,inFlight=0,startedAt=clock();
 const note=(kind:string)=>{tally.set(kind,(tally.get(kind)??0)+1);if(now()-since<60_000)return;console.log(`[ohttp] ${[...tally].map(([name,count])=>`${name} ${count}`).join(', ')}`);tally.clear();since=now();};
 const answer=(status:number,kind:string)=>{note(kind);return new Response(null,{status});};
 const forward=async(request:Request,gone:AbortSignal,cap:number)=>{
  const url=new URL(request.url),path=url.pathname;
  // The checks read the path decoded once, as the upstream routes it (arkd serves /v1/tx%73 as its stream); an encoded slash or an empty segment is refused raw.
  // Express routes ignore case and a trailing slash, so the pool route matches any case: /OHTTP/ or /api/ROLLUP/ohttp would reach this gateway again.
  let routed:string;try{routed=decodeURIComponent(path);}catch{return answer(403,'refused');}
  const lower=routed.toLowerCase(),toPool=url.origin===pool&&lower.startsWith('/api/rollup/'),listed=toPool?!lower.startsWith('/api/rollup/ohttp'):allowed.some(entry=>entry.origin===url.origin&&routed.startsWith(entry.prefix));
  if(!listed||!['GET','POST'].includes(request.method)||/%2f|%5c/i.test(path)||path.includes('//'))return answer(403,'refused');
  if(/text\/event-stream/i.test(request.headers.get('accept')??'')||STREAMS.some(stream=>lower.startsWith(stream)))return answer(400,'stream');
  const headers=copied(request.headers,['content-type','accept','x-digest']),timeout=AbortSignal.timeout(timeoutMs),signal=AbortSignal.any([timeout,gone]);
  if(toPool)headers.set('x-shielded-gateway',gatewayToken);
  try{
   const upstream=await send((toPool?loopback:url.origin)+path+url.search,{method:request.method,headers,redirect:'error',signal,...(request.method==='POST'?{body:await request.arrayBuffer()}:{})});
   const reader=upstream.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>cap){await reader.cancel();return answer(502,'oversize');}chunks.push(value);}
   const response=new Response(size?Buffer.concat(chunks):null,{status:upstream.status,headers:copied(upstream.headers,['content-type','cache-control','retry-after'])});
   note('forwarded');return response;
  }catch{return timeout.aborted?answer(504,'timeout'):answer(502,gone.aborted?'abandoned':'unreachable');}
 };
 // Shed before the rate check and before opening, so the retry is neither over the rate nor a replay.
 const admit=():{status:429|503;retryAfter:number}|undefined=>{
  if(inFlight>=maxInFlight){note('shed');return {status:503,retryAfter:1};}
  // One budget for everyone: every request arrives from a relay, so an address says nothing.
  const at=now();if(at-second>=1000){second=at;used=0;} // ponytail: fixed window, so a burst across a boundary reaches twice the rate; a token bucket if that matters
  if(++used>rate){note('busy');return {status:429,retryAfter:1};}
 };
 // ohttp-ts keeps no replay state (RFC 9458 section 6.5). Each sealing draws a fresh HPKE enc: the 32 bytes after the key id and suite.
 const encOf=(body:Uint8Array)=>Buffer.from(body.subarray(7,39)).toString('hex');
 const unseal=async(body:Uint8Array,type:string,gone:AbortSignal,cap:number)=>{
  const opened=await key.server.decapsulateRequest(new Request('http://gateway.invalid/',{method:'POST',headers:{'content-type':type},body:body as Uint8Array<ArrayBuffer>})).catch(()=>undefined);
  if(!opened){note('unopened');return;}
  // Checked before seen.add, so a stale copy records nothing. The 15 s is the client's rounding: a request sealed just after the start can round to before it.
  const at=Date.parse(opened.request.headers.get('x-date')??'');
  if(!Number.isFinite(at)||Math.abs(clock()-at)>windowMs||at<startedAt-15_000){note('stale');return;}
  const enc=encOf(body);
  if(seen.has(enc)){note('replayed');return;}
  seen.add(enc);if(seen.size>REMEMBERED)seen.delete(seen.values().next().value!); // ponytail: in memory, so a restart or 100 000 newer requests forget a value, which can then run once more inside its x-date window
  return new Uint8Array(await (await opened.context.encapsulateResponse(await forward(opened.request,gone,cap))).arrayBuffer());
 };
 // No upload and no late reader here, so the upstream deadline alone bounds the slot.
 const open:OhttpOpen=async(sealed,{maxAnswer=MAX_RESPONSE,signal=new AbortController().signal,room}={})=>{
  // seen holds only requests that opened, so nothing can plant a value: a copy is refused before a full gateway sheds it, which a client reads as "never ran".
  if(seen.has(encOf(sealed))){note('replayed');return {kind:'refused'};}
  if(room?.()===false){note('outbound');return {kind:'busy',status:503,retryAfter:1};}
  const busy=admit();if(busy)return {kind:'busy',...busy};
  inFlight++;
  try{const bytes=await unseal(sealed,'message/ohttp-req',signal,Number.isFinite(maxAnswer)&&maxAnswer>0&&maxAnswer<MAX_RESPONSE?maxAnswer:MAX_RESPONSE);return bytes?{kind:'sealed',bytes}:{kind:'refused'};}
  finally{inFlight--;}
 };
 const router=express.Router();
 router.get('/ohttp-keys',(_req,res)=>{res.setHeader('Content-Type','application/ohttp-keys').setHeader('Cache-Control','public, max-age=3600').end(key.config);});
 if(http)router.post('/ohttp',(req,res,next)=>{
  const busy=admit();if(busy){res.setHeader('Retry-After',String(busy.retryAfter));res.sendStatus(busy.status);return;}
  // A response closes exactly once, finished or dropped, so no exit path keeps its slot (one closed already takes none); closing also stops its upstream fetch.
  // No request holds a slot past three deadlines (upload, upstream, the client reading the answer): an unfinished upload is destroyed at the first, the response itself at the third.
  if(res.destroyed)return;
  const gone=new AbortController(),late=setTimeout(()=>{if(!req.complete)req.destroy();},timeoutMs),backstop=setTimeout(()=>res.destroy(),3*timeoutMs);
  inFlight++;res.once('close',()=>{inFlight--;gone.abort();clearTimeout(late);clearTimeout(backstop);});res.locals.gone=gone.signal;
  next();
 },express.raw({type:'message/ohttp-req',limit:'1mb'}),async(req,res)=>{
  const sealed=await unseal(req.body,req.get('content-type')??'',res.locals.gone,MAX_RESPONSE);
  if(!sealed){res.sendStatus(400);return;}
  res.status(200).setHeader('Content-Type','message/ohttp-res').setHeader('Cache-Control','no-store').end(sealed);
 });
 router.use((error:{status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{note(error.status===413?'too-large':'failed');res.sendStatus(error.status??500);});
 // Call as the carrier starts: a request dated before then may have run on the previous instance, whose replay register this one lacks.
 return Object.assign(router,{open,listen(){startedAt=clock();}});
}
