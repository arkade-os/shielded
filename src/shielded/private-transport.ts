import {ESPLORA_URL,RestArkProvider,type NetworkName,type OnchainProvider} from '@arkade-os/sdk';
import {AbstractSimplePool} from 'nostr-tools/abstract-pool';
import type {Filter} from 'nostr-tools/filter';
import {verifyEvent,type Event} from 'nostr-tools/pure';
import {normalizeURL} from 'nostr-tools/utils';
import {NOSTR_RELAYS} from '../../packages/protocol/src/nostr-carrier.ts';
import {NATIVE_RELEASE_ENDPOINT} from '../native-release.ts';
import {journalledRoute,makeNativeMutationJournal,reconcileJournal,type JournalWallet} from '../native/mutations.ts';
import {NativePolicy} from '../native/policy.ts';
import {IsolatedIndexerProvider,IsolatedOnchainProvider} from '../native/providers.ts';
import type {CarrierPool} from '../rollup/nostr-carrier.ts';
import {CARD_KIND,LNURL_BASE,PRIVATE_ONCHAIN_POLL_MS,RENDEZVOUS_WAIT_MS,markPrivateFetch,markPrivatePoolPage,markSealedFetch} from './network-privacy.ts';
import {createSealedFetch,SealedFetchError} from './sealed-fetch.ts';

export const PRIVATE_PAGE=12;
export const PRIVATE_GRACE_MS=900_000;
export const PRIVATE_SHIELD_COINS=20;
export interface PrivateTransportConfig {config:Uint8Array;gateway:string;poolOrigin:string;pageOrigin:string;relays?:readonly string[];lnurl?:string;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;socket?:typeof WebSocket;globals?:Record<string,unknown>}
export interface PrivateTransport {fetch:typeof fetch;poolOrigin:string;pageSize:number;journal:ReturnType<typeof makeNativeMutationJournal>;reconcile(wallet?:JournalWallet):Promise<boolean>;providers(arkUrl:string,indexerUrl:string):{arkProvider:RestArkProvider;indexerProvider:IsolatedIndexerProvider;onchainProvider:(network:NetworkName)=>OnchainProvider};rfqPool():CarrierPool;close():void}

let installed:PrivateTransport|undefined;
const refused=(what:string)=>class {constructor(){throw new Error('Private networking does not permit '+what);}};
export function privateTransport():PrivateTransport|undefined {return installed;}
type Listener={onevent?:(event:Event)=>void;oneose?:()=>void;onclose?:(reasons:{url:string;reason:string}[])=>void};
/** The swap package's relay pool, as one round trip each to the pool's rendezvous: a card read on subscribing, an RFQ on publishing, whose answer feeds the RFQ's reply subscription. */
export function rendezvousPool(fetcher:typeof fetch,poolOrigin:string):CarrierPool {
 let replies:{filter:Filter;on:Listener;closed:boolean}|undefined;
 const meet=async(body:Record<string,unknown>)=>{
  const response=await fetcher(poolOrigin+'/api/rollup/rendezvous',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const answer=await response.json().catch(()=>undefined) as {events?:unknown;error?:unknown}|undefined;
  if(!response.ok||!Array.isArray(answer?.events))throw new Error(`the pool's solver rendezvous answered ${response.status}${typeof answer?.error==='string'?`: ${answer.error}`:''}`);
  return answer.events as Event[];
 };
 return {
  subscribeMany(_relays:string[],filter:Filter,on:Listener){
   const sub={filter,on,closed:false};
   if(filter.kinds?.length===1&&filter.kinds[0]===CARD_KIND)void meet({kind:CARD_KIND,filter,waitMs:10_000}).then(events=>{if(sub.closed)return;for(const event of events)on.onevent?.(event);on.oneose?.();},error=>{if(!sub.closed)on.onclose?.([{url:poolOrigin,reason:String(error)}]);});
   else{const previous=replies;if(previous&&!previous.closed){previous.closed=true;previous.on.onclose?.([{url:poolOrigin,reason:'a newer RFQ reply subscription replaced this one'}]);}replies=sub;}
   return {close(){sub.closed=true;}};
  },
  // The pool is the one relay here, so one outcome answers for any relays the card lists.
  publish(_relays:string[],event:Event){
   const sub=replies;
   // Without its reply subscription an RFQ's answer has nowhere to go, so nothing is sent.
   if(!sub||sub.closed)return [Promise.reject(new Error('the RFQ has no open reply subscription, so it was not sent to the pool\'s solver rendezvous'))];
   return [meet({kind:event.kind,event,filter:sub.filter,waitMs:RENDEZVOUS_WAIT_MS}).then(events=>{if(!sub.closed)for(const reply of events)sub.on.onevent?.(reply);return '';})];
  },
  destroy(){},
 } as unknown as CarrierPool;
}
export function installPrivateTransport(config:PrivateTransportConfig):PrivateTransport {
 if(installed)return installed;
 const target=(config.globals??globalThis) as Record<string,unknown>,direct=target.fetch as typeof fetch,Original=config.socket??(target.WebSocket as typeof WebSocket);
 const relays=config.relays??NOSTR_RELAYS,pinned=new Set(relays.map(normalizeURL)),policy=new NativePolicy(config.poolOrigin),{poolOrigin}=policy,pageOrigin=new URL(config.pageOrigin).origin;
 const journal=makeNativeMutationJournal(config.storage??globalThis.localStorage,{graceMs:PRIVATE_GRACE_MS});
 policy.registerLnurl(config.lnurl??LNURL_BASE);
 const sealedFetch=createSealedFetch({config:config.config,gateway:config.gateway,origin:poolOrigin,relays,authorized:url=>policy.authorizes(url),pool:new AbstractSimplePool({verifyEvent,maxWaitForConnection:3000,websocketImplementation:Original})});
 const Guarded=class extends Original {constructor(url:string|URL,protocols?:string|string[]){const u=normalizeURL(String(url));if(!pinned.has(u))throw new Error('Private networking does not permit a WebSocket to '+url);super(u,protocols);}};
 // Express routes ignore case, so these checks do; the release list matches exactly, as its handler does. Order matters: a pool API path is sealed at the pinned origin even when the page is served from it, and a proving path on the page origin goes direct even when it is not.
 const route=(url:URL,method:string)=>{
  const path=url.pathname,lower=path.toLowerCase(),proving=/^\/api\/rollup\/proving\//.test(lower),poolApi=/^\/api\/rollup\//.test(lower)&&!proving;
  if(url.origin===pageOrigin){if(proving||!lower.startsWith('/api/')||method==='GET'&&path===NATIVE_RELEASE_ENDPOINT)return undefined;if(poolApi)return poolOrigin+path+url.search;}
  else if(url.origin!==poolOrigin||poolApi)return url.href;
  throw new Error('Private networking does not permit '+url.origin+path);
 };
 const privateFetch:typeof fetch=markPrivatePoolPage(markSealedFetch(markPrivateFetch(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input),pageOrigin),href=route(url,(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase());
  if(href===undefined)return direct(input instanceof Request?input:url.href,init);
  const source=new Request(input instanceof Request?input:url,init),method=source.method,body=method==='GET'?undefined:await source.text();
  policy.classify(href,method,body);
  const journalled=journalledRoute(href,method);
  const mutation=journalled&&method!=='GET'?{url:href,method,body}:undefined;
  if(mutation)journal.beforeNativeMutation(mutation);
  let response:Response;
  try{response=await sealedFetch(href,{method,headers:source.headers,body,signal:source.signal});}
  catch(error){if(mutation&&error instanceof SealedFetchError&&(error.code==='too-large'||error.code==='unavailable'))journal.cancelNativeMutation(mutation);throw error;}
  if(journalled)journal.observeNativeResponse({url:href,method,status:response.status,body:await response.clone().text(),requestBody:body});
  return response;
 })),PRIVATE_PAGE);
 let reconciling:Promise<boolean>|undefined;
 const transport:PrivateTransport={fetch:privateFetch,poolOrigin,pageSize:PRIVATE_PAGE,journal,
  reconcile(wallet){
   reconciling??=reconcileJournal(journal,privateFetch,poolOrigin,wallet).finally(()=>{reconciling=undefined;});
   return reconciling;
  },
  providers(arkUrl,indexerUrl){
   policy.registerArk(arkUrl,indexerUrl);
   return {arkProvider:new RestArkProvider(arkUrl),indexerProvider:new IsolatedIndexerProvider(indexerUrl,undefined,undefined,undefined,0),onchainProvider:network=>{const url=ESPLORA_URL[network];policy.registerEsplora(url);return new IsolatedOnchainProvider(url,PRIVATE_ONCHAIN_POLL_MS);}};
  },
  rfqPool:()=>rendezvousPool(privateFetch,poolOrigin),
  close(){sealedFetch.close();if(installed===transport)installed=undefined;},
 };
 const define=(name:string,value:unknown)=>Object.defineProperty(target,name,{value,writable:false,configurable:false});
 define('fetch',privateFetch);define('EventSource',refused('EventSource'));define('WebSocket',Guarded);define('XMLHttpRequest',refused('XMLHttpRequest'));
 define('RTCPeerConnection',refused('WebRTC'));if('webkitRTCPeerConnection' in target)define('webkitRTCPeerConnection',refused('WebRTC'));
 installed=transport;return transport;
}
