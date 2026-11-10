import {Channel,invoke} from '@tauri-apps/api/core';
import {ESPLORA_URL,RestArkProvider,RestIndexerProvider,type EventSourceFactory,type NetworkName,type OnchainProvider} from '@arkade-os/sdk';
import type {SwapClientConfig} from '@arkade-os/swap';
import {attesting} from '@arkade-os/swap/advanced';
import {nostrCardFetcher,nostrRfqTransport} from '@arkade-os/swap/nostr';
import {SimplePool} from 'nostr-tools';
import {markPrivateFetch} from '../shielded/network-privacy.ts';
import {beforeNativeMutation,observeNativeResponse} from './mutations.ts';
import {NativePolicy,nativeUrl,type NativePurpose} from './policy.ts';
import {IsolatedIndexerProvider,IsolatedOnchainProvider} from './providers.ts';
import {NativeBridge,bindNativeProvider,type NativeEvent,type NativeStatus,type NativeMode} from './transport.ts';
import {NativeEventSource,NativeWebSocket} from './streams.ts';

export type {NativeStatus,NativeMode} from './transport.ts';
declare global {var __SHIELDED_NATIVE__:{version:1;poolOrigin:string}|undefined;}
let bridge:NativeBridge|undefined,installed=false;
const indexers=new Set<IsolatedIndexerProvider>(),pools=new Set<SimplePool>();
export const isNativeHost=()=>globalThis.__SHIELDED_NATIVE__?.version===1&&typeof globalThis.__SHIELDED_NATIVE__.poolOrigin==='string';
function connection(){
 if(!isNativeHost())throw new Error('This network transport requires the native Shielded host');
 if(!bridge){
  bridge=new NativeBridge({invoke:(command,args)=>invoke(command,args),channel:receive=>new Channel<NativeEvent>(receive)},new NativePolicy(globalThis.__SHIELDED_NATIVE__!.poolOrigin));
  bridge.beforeMutation=beforeNativeMutation;bridge.observeResponse=observeNativeResponse;
  let generation=0;
  bridge.subscribe(status=>{if(status.generation!==generation||status.phase!=='ready'){for(const provider of indexers)provider.retire();indexers.clear();for(const pool of pools)pool.destroy();pools.clear();}generation=status.generation;});
 }
 return bridge;
}
export const nativeFetch:typeof fetch=markPrivateFetch((input,init)=>connection().fetch(input,init));
export const nativeSessionFetch=(fetcher:typeof fetch=nativeFetch):typeof fetch=>markPrivateFetch(connection().bindFetch(fetcher));
function scopedFetch(purpose:NativePurpose):typeof fetch {
 return markPrivateFetch((input,init)=>{
  const b=connection(),url=nativeUrl(input instanceof Request?input.url:String(input),b.policy.poolOrigin);
  const route=b.policy.explicit(url.href,purpose,crypto.randomUUID());return b.fetch(input,init,route).finally(()=>b.release(route));
 });
}
export const nativeLnurlFetch:typeof fetch=scopedFetch('lnurl');
export const nativeClaimFetch:typeof fetch=scopedFetch('pool-sync');
export const nativeReleaseFetch:typeof fetch=scopedFetch('public');
export const nativeNetwork={
 status:():Promise<NativeStatus>=>connection().status(),start:(mode:NativeMode='tor'):Promise<NativeStatus>=>connection().start(mode),pause:():Promise<NativeStatus>=>connection().pause(),
 subscribe:(fn:(status:NativeStatus)=>void)=>connection().subscribe(fn),
 async check(signal:AbortSignal):Promise<void>{
  const b=connection(),current=b.sessionGuard(),url=b.policy.poolOrigin+'/api/rollup/status',route={...b.policy.classify(url,'GET'),key:'tor-health:'+crypto.randomUUID()};
  try{await b.fetch(url,{cache:'no-store',credentials:'omit',redirect:'error',signal},route);current();}
  finally{await b.release(route);}
 },
};
export function installNativeTransport():void {
 if(installed)return;const b=connection();installed=true;
 Object.defineProperty(globalThis,'fetch',{value:nativeFetch,writable:false,configurable:false});
 Object.defineProperty(globalThis,'EventSource',{value:class extends NativeEventSource {constructor(url:string|URL){super(String(url),b);}},writable:false,configurable:false});
 Object.defineProperty(globalThis,'WebSocket',{value:class extends NativeWebSocket {constructor(url:string|URL,protocols?:string|string[]){super(String(url),b,undefined,protocols);}},writable:false,configurable:false});
 Object.defineProperty(globalThis,'XMLHttpRequest',{value:class {constructor(){throw new Error('Native networking does not permit XMLHttpRequest');}},writable:false,configurable:false});
  for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])if(name in globalThis)Object.defineProperty(globalThis,name,{value:class {constructor(){throw new Error('Native networking does not permit WebRTC');}},writable:false,configurable:false});
}
export function nativeWalletProviders(arkUrl:string,indexerUrl:string){
 const b=connection(),check=b.sessionGuard();b.policy.registerArk(arkUrl,indexerUrl);
 const eventSource:EventSourceFactory=url=>{check();return new NativeEventSource(url,b);};
 const indexerSessionUrl=b.sessionUrl(indexerUrl),base=bindNativeProvider(new RestIndexerProvider(indexerSessionUrl,{eventSource}),check),indexerProvider=new IsolatedIndexerProvider(indexerSessionUrl,eventSource,base);indexers.add(indexerProvider);
 return {arkProvider:bindNativeProvider(new RestArkProvider(b.sessionUrl(arkUrl),{eventSource}),check),indexerProvider:bindNativeProvider(indexerProvider,check),onchainProvider:(network:NetworkName):OnchainProvider=>{
  check();const url=ESPLORA_URL[network];b.policy.registerEsplora(url);return bindNativeProvider(new IsolatedOnchainProvider(b.sessionUrl(url)),check);
 }};
}
function poolFor(purpose:'swap'|'discovery',check:()=>void){
 check();const b=connection(),identity=crypto.randomUUID(),routes=new Map<string,ReturnType<NativePolicy['explicit']>>();
 const Socket=class extends NativeWebSocket {constructor(url:string|URL,protocols?:string|string[]){check();const address=nativeUrl(String(url)),route=b.policy.explicit(address.href,purpose,identity+'|'+address.origin);routes.set(route.key,route);super(address.href,b,route,protocols);}};
 const pool=new SimplePool({enablePing:true,websocketImplementation:Socket} as ConstructorParameters<typeof SimplePool>[0]),destroy=pool.destroy.bind(pool);
 pool.destroy=()=>{destroy();pools.delete(pool);for(const route of routes.values())void b.release(route);routes.clear();};pools.add(pool);return pool;
}
export function nativeSwapConfig():Pick<SwapClientConfig,'fetchImpl'|'discovery'|'transportFor'> {
 const b=connection(),check=b.sessionGuard(),discoveryPool=poolFor('discovery',check),cards=nostrCardFetcher({pool:discoveryPool});
 return {fetchImpl:markPrivateFetch(b.bindFetch(scopedFetch('swap'))),discovery:{fetchImpl:markPrivateFetch(b.bindFetch(scopedFetch('discovery'))),transportCards:bindNativeProvider(cards,check)},transportFor:rendezvous=>{
  check();const pool=poolFor('swap',check),transport=attesting(nostrRfqTransport({relays:[...rendezvous.relays],solverPubkey:rendezvous.solverPubkey,pool}),rendezvous.solverPubkey),close=transport.close.bind(transport);
  transport.close=()=>{try{return close();}finally{pool.destroy();pools.delete(pool);}};return transport;
 }};
}
