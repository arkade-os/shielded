import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test,type TestContext} from 'node:test';
import {ESPLORA_URL} from '@arkade-os/sdk';
import {normalizeURL} from 'nostr-tools/utils';
import {NOSTR_RELAYS,NOSTR_REQUEST_KIND} from '../packages/protocol/src/nostr-carrier.ts';
import {IsolatedOnchainProvider} from '../src/native/providers.ts';
import {createOhttpGateway} from '../src/rollup/ohttp-gateway.ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {startNostrCarrier} from '../src/rollup/nostr-carrier.ts';
import {isPrivateFetch} from '../src/shielded/network-privacy.ts';
import {installPrivateTransport} from '../src/shielded/private-transport.ts';
import {createNostrBus} from './fixtures/nostr-bus.ts';

const POOL='https://pool.example',PAGE='http://127.0.0.1:5173',LOOPBACK='http://127.0.0.1:9',ARK='https://ark.example',ESPLORA=ESPLORA_URL.mutinynet,ID='ab'.repeat(16);
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const memory=()=>{const items=new Map<string,string>();return {getItem:(key:string)=>items.get(key)??null,setItem:(key:string,value:string)=>{items.set(key,value);},removeItem:(key:string)=>{items.delete(key);}};};

async function rig(t:TestContext,{pageOrigin=POOL,globals={},reply=()=>Response.json({ok:true})}:{pageOrigin?:string;globals?:Record<string,unknown>;reply?:(url:string)=>Response}={}){
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
 const target:Record<string,unknown>={fetch:async(input:string)=>{direct.push(String(input));return new Response('direct');},...globals};
 const transport=installPrivateTransport({config:key.config,gateway:key.nostrPublic,poolOrigin:POOL,pageOrigin,storage:memory(),socket:Sentinel as unknown as typeof WebSocket,globals:target});t.after(()=>transport.close());
 return {transport,globals:target,calls,direct,made,Sentinel,requests:()=>bus.published.filter(event=>event.kind===NOSTR_REQUEST_KIND)};
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

test('the page assets and the proving files go direct, and nothing else under /api does',async t=>{
 const g=await rig(t),paths=['/','/assets/app.js','/api/rollup/proving/epoch-spend.wasm?v='+'c'.repeat(64)];
 for(const path of paths)assert.equal(await (await g.transport.fetch(path)).text(),'direct',path);
 assert.deepEqual(g.direct,paths.map(path=>POOL+path));
 for(const path of ['/api/native/releases','/api/other'])await assert.rejects(g.transport.fetch(path),/does not permit/,path);
 assert.deepEqual([g.requests().length,g.calls.length],[0,0]);
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

test('the transport fetch is marked private',async t=>{
 const g=await rig(t);
 assert.ok(isPrivateFetch(g.transport.fetch));assert.equal(g.globals.fetch,g.transport.fetch);
});

test('EventSource, XMLHttpRequest and WebRTC are refused, and WebSocket only reaches the pinned relays',async t=>{
 const g=await rig(t),G=g.globals as Record<string,new(url?:string)=>{close?():void}>;
 for(const name of ['EventSource','XMLHttpRequest','RTCPeerConnection'])assert.throws(()=>new G[name]!(ARK),/does not permit/,name);
 for(const name of ['fetch','EventSource','WebSocket','XMLHttpRequest','RTCPeerConnection']){const {writable,configurable}=Object.getOwnPropertyDescriptor(g.globals,name)!;assert.deepEqual({writable,configurable},{writable:false,configurable:false},name);}
 for(const url of ['wss://relay.snort.social','wss://relay.snort.social/']){const socket=new G.WebSocket!(url);assert.ok(socket instanceof g.Sentinel,url);socket.close!();}
 for(const url of ['wss://nostr.arkade.sh','ws://relay.snort.social'])assert.throws(()=>new G.WebSocket!(url),/does not permit/,url);
});

test('the sealed fetch is given the original WebSocket, not the guarded one',async t=>{
 const g=await rig(t,{globals:{WebSocket:class {constructor(){throw new Error('the page WebSocket was used');}}}});
 assert.equal((await g.transport.fetch('/api/rollup/status')).status,200);
 assert.ok(g.made.length&&g.made.every(made=>made===g.Sentinel),'every relay socket was built by the original constructor itself');
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

test('the module never imports the native entry point',()=>{
 assert.doesNotMatch(readFileSync('src/shielded/private-transport.ts','utf8'),/native\/index/);
 for(const file of ['policy','providers','mutations'])assert.doesNotMatch(readFileSync(`src/native/${file}.ts`,'utf8'),/@tauri-apps/,file);
});
