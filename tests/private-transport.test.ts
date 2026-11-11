import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test,type TestContext} from 'node:test';
import {ESPLORA_URL} from '@arkade-os/sdk';
import {normalizeURL} from 'nostr-tools/utils';
import {NOSTR_CHUNK_BYTES,NOSTR_RELAYS,NOSTR_REQUEST_KIND} from '../packages/protocol/src/nostr-carrier.ts';
import {IsolatedOnchainProvider} from '../src/native/providers.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {startNostrCarrier} from '../src/rollup/nostr-carrier.ts';
import {isPrivateFetch,isSealedFetch,markPrivateFetch,privatePoolPage} from '../src/shielded/network-privacy.ts';
import {poolApiOf} from '../src/shielded/pool.ts';
import {installPrivateTransport,privateTransport,PRIVATE_PAGE} from '../src/shielded/private-transport.ts';
import {SealedFetchError} from '../src/shielded/sealed-fetch.ts';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const POOL='https://pool.example',PAGE='http://127.0.0.1:5173',LOOPBACK='http://127.0.0.1:9',ARK='https://ark.example',ESPLORA=ESPLORA_URL.mutinynet,ID='ab'.repeat(16);
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const memory=()=>{const items=new Map<string,string>();return {getItem:(key:string)=>items.get(key)??null,setItem:(key:string,value:string)=>{items.set(key,value);},removeItem:(key:string)=>{items.delete(key);}};};

async function rig(t:TestContext,{pageOrigin=POOL,globals={},reply=()=>Response.json({ok:true}),inject=true}:{pageOrigin?:string;globals?:Record<string,unknown>;reply?:(url:string)=>Response;inject?:boolean}={}){
 // Node's own WebSocket reaches the six public relays, so a pool that lost its websocketImplementation fails here instead.
 const real=globalThis.WebSocket;globalThis.WebSocket=class {constructor(){throw new Error('a test reached for a public relay');}} as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=real;});
 const key=(await loadOhttpKey((await generateOhttpKey()).env))!,bus=createNostrBus(),calls:string[]=[],direct:string[]=[],made:unknown[]=[];
 const router=createOhttpGateway({key,upstreams:[{origin:ARK,prefix:'/v1/'},{origin:new URL(ESPLORA).origin,prefix:'/api/'}],poolOrigin:POOL,poolLoopback:LOOPBACK,gatewayToken:'token',fetch:(async(url:string)=>{calls.push(url);return reply(url);}) as unknown as typeof fetch});
 // The relay pool hands each socket a normalized URL, so the gateway listens on the same strings.
 const carrier=startNostrCarrier({open:router.open,secret:key.nostrSecret,relays:NOSTR_RELAYS.map(normalizeURL),pool:bus.pool});t.after(()=>carrier.close());await settle();
 // The sentinel is a WebSocket over the bus, speaking NIP-01 to the sealed fetch's own relay pool.
 class Sentinel {
  static OPEN=1;static CLOSING=2;static CLOSED=3;
  readyState=0;onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;private subs=new Map<string,{close():void}>();
  constructor(readonly url:string){made.push(new.target);setTimeout(()=>{if(this.readyState)return;this.readyState=1;this.onopen?.();});}
  private answer(message:unknown[]){if(this.readyState===1)this.onmessage?.({data:JSON.stringify(message)});}
  send(raw:string){
   const [type,first,second]=JSON.parse(raw);
   if(type==='EVENT')void Promise.all(bus.pool.publish([this.url],first)).then(([note])=>this.answer(['OK',first.id,true,note]),(error:Error)=>this.answer(['OK',first.id,false,error.message]));
   if(type==='REQ'){this.subs.set(first,bus.pool.subscribeMany([this.url],second,{onevent:event=>this.answer(['EVENT',first,event])}));this.answer(['EOSE',first]);}
   if(type==='CLOSE'){this.subs.get(first)?.close();this.subs.delete(first);}
  }
  close(){this.readyState=3;for(const sub of this.subs.values())sub.close();this.subs.clear();}
 }
 const target:Record<string,unknown>={fetch:async(input:string)=>{direct.push(String(input));return new Response('direct');},...(inject?{}:{WebSocket:Sentinel}),...globals};
 const transport=installPrivateTransport({config:key.config,gateway:key.nostrPublic,poolOrigin:POOL,pageOrigin,storage:memory(),...(inject?{socket:Sentinel as unknown as typeof WebSocket}:{}),globals:target});t.after(()=>transport.close());
 return {transport,globals:target,bus,calls,direct,made,Sentinel,requests:()=>bus.published.filter(event=>event.kind===NOSTR_REQUEST_KIND)};
}

test('a relative pool path is rewritten to the pinned pool origin and sealed',async t=>{
 const g=await rig(t,{pageOrigin:PAGE});
 assert.equal((await g.transport.fetch('/api/rollup/status')).status,200);
 assert.deepEqual([g.calls,g.direct],[[LOOPBACK+'/api/rollup/status'],[]]);
 assert.ok(g.requests().length&&!JSON.stringify(g.requests()).includes('127.0.0.1'));
});

test('a pool path is sealed even when the page origin is the pool origin',async t=>{
 const g=await rig(t);
 assert.equal((await g.transport.fetch('/api/rollup/status')).status,200);
 assert.deepEqual([g.calls,g.direct],[[LOOPBACK+'/api/rollup/status'],[]]);
});

test('the page assets, the proving files and a GET of the release list go direct, and nothing else under /api does',async t=>{
 const g=await rig(t),paths=['/','/assets/app.js','/api/rollup/proving/epoch-spend.wasm?v='+'c'.repeat(64),'/api/native/releases'];
 for(const path of paths)assert.equal(await (await g.transport.fetch(path)).text(),'direct',path);
 assert.deepEqual(g.direct,paths.map(path=>POOL+path));
 await assert.rejects(g.transport.fetch('/api/other'),/does not permit/);
 for(const method of ['POST','HEAD'])await assert.rejects(g.transport.fetch('/api/native/releases',{method}),/does not permit/,method);
 assert.deepEqual([g.requests().length,g.calls.length,g.direct.length],[0,0,paths.length]);
});

test('on a page origin other than the pool, the page assets and the proving files still go direct',async t=>{
 const g=await rig(t,{pageOrigin:PAGE}),paths=['/assets/app.js','/api/rollup/proving/epoch-spend.wasm'];
 for(const path of paths)assert.equal(await (await g.transport.fetch(path)).text(),'direct',path);
 assert.deepEqual([g.direct,g.requests().length],[paths.map(path=>PAGE+path),0]);
});

test('a pool API path in any case is classified for sealing, never sent direct, and a proving path in any case goes direct',async t=>{
 const g=await rig(t,{pageOrigin:PAGE});
 await assert.rejects(g.transport.fetch('/API/rollup/status'),/not approved: GET https:\/\/pool\.example\/API\/rollup\/status$/,'rewritten to the pool origin in its own case, which the native policy refuses');
 await assert.rejects(g.transport.fetch('/API/other'),/does not permit/);
 assert.equal(await (await g.transport.fetch('/Api/Rollup/proving/epoch-spend.wasm')).text(),'direct');
 assert.deepEqual([g.direct,g.requests().length],[[PAGE+'/Api/Rollup/proving/epoch-spend.wasm'],0]);
});

test('an absolute proving URL at the pool origin is refused rather than sealed',async t=>{
 const g=await rig(t,{pageOrigin:PAGE});
 await assert.rejects(g.transport.fetch(POOL+'/api/rollup/proving/epoch-spend.wasm'),/does not permit/);
 assert.deepEqual([g.requests().length,g.direct.length],[0,0]);
});

test('arkd, indexer and Esplora requests are classified before they are sealed',async t=>{
 const g=await rig(t),utxos=ESPLORA+'/address/tb1qexample/utxo',p=g.transport.providers(ARK,ARK);
 await assert.rejects(g.transport.fetch(utxos),/not approved/,'Esplora is not approved until the SDK asks for its provider');
 p.onchainProvider('mutinynet');
 await assert.rejects(g.transport.fetch(ARK+'/v1/indexer/vtxos?scripts=aa&scripts=bb'),/exactly one item/);
 await assert.rejects(g.transport.fetch('https://evil.example/x'),/not approved/);
 assert.equal(g.requests().length,0,'nothing refused was published');
 for(const url of [ARK+'/v1/indexer/vtxos?scripts=aa',utxos])assert.equal((await g.transport.fetch(url)).status,200,url);
 assert.deepEqual(g.calls,[ARK+'/v1/indexer/vtxos?scripts=aa',utxos]);
});

test('the transport fetch is marked private and sealed',async t=>{
 const g=await rig(t);
 assert.ok(isPrivateFetch(g.transport.fetch));assert.ok(isSealedFetch(g.transport.fetch));assert.equal(g.globals.fetch,g.transport.fetch);
});

test('a pool api on the transport fetch pages at the transport size, unless told otherwise, and a native private fetcher keeps 50',async t=>{
 const g=await rig(t),native=markPrivateFetch((async()=>Response.json({})) as typeof fetch);
 assert.deepEqual([poolApiOf('',g.transport.fetch),poolApiOf('',g.transport.fetch,30),poolApiOf('',native)].map(api=>privatePoolPage(api)),[PRIVATE_PAGE,30,50]);
});

test('a second install returns the first transport',async t=>{
 const g=await rig(t);
 assert.equal(installPrivateTransport({config:new Uint8Array(),gateway:'',poolOrigin:'https://other.example',pageOrigin:PAGE,globals:g.globals}),g.transport);
 assert.equal(privateTransport(),g.transport);
});

test('EventSource, XMLHttpRequest and WebRTC are refused, and WebSocket only reaches the pinned relays',async t=>{
 const g=await rig(t),G=g.globals as Record<string,new(url?:string)=>{url?:string;close?():void}>;
 for(const name of ['EventSource','XMLHttpRequest','RTCPeerConnection'])assert.throws(()=>new G[name]!(ARK),/does not permit/,name);
 for(const name of ['fetch','EventSource','WebSocket','XMLHttpRequest','RTCPeerConnection']){const {writable,configurable}=Object.getOwnPropertyDescriptor(g.globals,name)!;assert.deepEqual({writable,configurable},{writable:false,configurable:false},name);}
 for(const url of ['wss://relay.snort.social','wss://relay.snort.social/','relay.snort.social']){const socket=new G.WebSocket!(url);assert.ok(socket instanceof g.Sentinel,url);assert.equal(socket.url,'wss://relay.snort.social/',url);socket.close!();}
 for(const url of ['wss://nostr.arkade.sh','ws://relay.snort.social'])assert.throws(()=>new G.WebSocket!(url),/does not permit/,url);
});

test('an injected socket builds every relay socket, not the page WebSocket nor the guarded one',async t=>{
 const g=await rig(t,{globals:{WebSocket:class {constructor(){throw new Error('the page WebSocket was used');}}}});
 assert.equal((await g.transport.fetch('/api/rollup/status')).status,200);
 assert.ok(g.made.length&&g.made.every(made=>made===g.Sentinel),'every relay socket was built by the original constructor itself');
});

test('with no socket injected, the sealed fetch gets the page WebSocket captured before the guard replaced it',async t=>{
 const g=await rig(t,{inject:false});
 assert.notEqual(g.globals.WebSocket,g.Sentinel);
 assert.equal((await g.transport.fetch('/api/rollup/status')).status,200);
 assert.ok(g.made.length&&g.made.every(made=>made===g.Sentinel),'a socket the guard built would carry its own new.target');
});

test('providers carry no event source and an onchain provider that polls',async t=>{
 const g=await rig(t),p=g.transport.providers(ARK,ARK),onchain=p.onchainProvider('mutinynet');
 assert.deepEqual([Reflect.get(p.arkProvider,'eventSource'),Reflect.get(p.indexerProvider,'eventSource')],[undefined,undefined]);
 assert.throws(()=>p.indexerProvider.getFilteredSubscription({} as never,new AbortController().signal),/individual script/);
 assert.ok(onchain instanceof IsolatedOnchainProvider&&onchain.forcePolling);
 const original=globalThis.fetch,sent:string[]=[];globalThis.fetch=(async(input:string)=>{sent.push(input);return Response.json({subscriptionId:'remote'});}) as unknown as typeof fetch;
 try{await p.indexerProvider.unsubscribeForScripts(await p.indexerProvider.subscribeForScripts(['aa']));}finally{globalThis.fetch=original;}
 assert.deepEqual(sent,[],'a watched script is polled, never subscribed');
});

test('a pool spend POST is journalled before it goes out and resolved by its own GET',async t=>{
 let reserved:bigint[]=[];
 const g=await rig(t,{reply:url=>{if(url.endsWith('/spends')){reserved=g.transport.journal.pendingPoolNullifiers(POOL);return Response.json({id:ID},{status:202});}return Response.json({status:'included',txid:'d'.repeat(64)});}});
 assert.equal((await g.transport.fetch('/api/rollup/spends',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID,slot:{nullifiers:['17']}})})).status,202);
 assert.deepEqual([reserved,g.transport.journal.pendingPoolNullifiers(POOL)],[[17n],[17n]],'the entry was written before the POST reached the pool');
 assert.equal((await g.transport.fetch('/api/rollup/spends/'+ID)).status,200);
 assert.deepEqual([g.calls,g.transport.journal.pendingPoolNullifiers(POOL)],[[LOOPBACK+'/api/rollup/spends',LOOPBACK+'/api/rollup/spends/'+ID],[]]);
});

const spendPost=(id:string,nf:string,pad='')=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,slot:{nullifiers:[nf]},pad})});
test('a sealed 404 frees a journalled spend only once the 15-minute grace has passed',async t=>{
 const g=await rig(t,{reply:url=>url.endsWith('/spends')?Response.json({id:ID},{status:202}):Response.json({error:'Unknown spend; it may have expired or the server restarted.'},{status:404})});
 const start=Date.now();let at=start;t.mock.method(Date,'now',()=>at);
 assert.equal((await g.transport.fetch('/api/rollup/spends',spendPost(ID,'17'))).status,202);
 for(const [later,left] of [[899_999,[17n]],[900_001,[]]] as const){
  at=start+later;assert.equal((await g.transport.fetch('/api/rollup/spends/'+ID)).status,404);
  assert.deepEqual(g.transport.journal.pendingPoolNullifiers(POOL),left,String(later));
 }
});

test('a pending entry whose GET answers 404 clears at 900 001 ms of age through reconcile, which never runs twice at once',async t=>{
 const g=await rig(t,{reply:url=>url.endsWith('/spends')?Response.json({id:ID},{status:202}):Response.json({error:'Unknown spend; it may have expired or the server restarted.'},{status:404})});
 const start=Date.now();let at=start;t.mock.method(Date,'now',()=>at);
 assert.equal((await g.transport.fetch('/api/rollup/spends',spendPost(ID,'17'))).status,202);
 at=start+899_999;assert.equal(await g.transport.reconcile(),true);
 at=start+900_001;const first=g.transport.reconcile();assert.equal(g.transport.reconcile(),first);
 assert.deepEqual([await first,g.transport.journal.pendingPoolNullifiers(POOL)],[false,[]]);
 assert.equal(await g.transport.reconcile(),false);
 assert.equal(g.calls.filter(url=>url.endsWith('/spends/'+ID)).length,2,'one read per reconcile that found the entry');
});

test('a spend POST that never went out frees its reservation at once, and one that may have run keeps it',async t=>{
 const g=await rig(t),fails=(code:string)=>(error:unknown)=>error instanceof SealedFetchError&&error.code===code;
 await assert.rejects(g.transport.fetch('/api/rollup/spends',spendPost(ID,'17','0'.repeat(NOSTR_CHUNK_BYTES))),fails('too-large'));
 assert.deepEqual(g.transport.journal.pendingPoolNullifiers(POOL),[]);
 for(const relay of NOSTR_RELAYS)g.bus.relay(normalizeURL(relay)).accept=false;
 await assert.rejects(g.transport.fetch('/api/rollup/spends',spendPost(ID,'17')),fails('outcome-unknown'),'the freed id goes out again, and every relay refuses it');
 assert.deepEqual(g.transport.journal.pendingPoolNullifiers(POOL),[17n]);
 g.transport.close();
 await assert.rejects(g.transport.fetch('/api/rollup/spends',spendPost('cd'.repeat(16),'23')),fails('unavailable'));
 assert.deepEqual([g.transport.journal.pendingPoolNullifiers(POOL),g.calls],[[17n],[]]);
});

test('the module never imports the native entry point',()=>{
 const entry=/(?:from|import\(?)\s*'(?:\.\.\/native|\.)(?:\/index(?:\.[jt]s)?)?\/?'|@tauri-apps/;
 for(const bad of ["import {x} from '../native';","import {x} from '../native/index.ts';","import {x} from '.';","import {x} from './index.js';","import '../native/';","await import('../native/index');","import {invoke} from '@tauri-apps/api/core';"])assert.match(bad,entry,bad);
 for(const file of ['src/shielded/private-transport.ts','src/shielded/sealed-fetch.ts','src/shielded/network-privacy.ts','src/native/policy.ts','src/native/providers.ts','src/native/mutations.ts'])assert.doesNotMatch(readFileSync(file,'utf8'),entry,file);
});
