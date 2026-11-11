import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NOSTR_RELAYS} from '../packages/protocol/src/nostr-carrier.ts';
import {generateOhttpKey} from '../src/rollup/ohttp-keys.ts';
import {isPrivateFetch} from '../src/shielded/network-privacy.ts';
import {privateTransport} from '../src/shielded/private-transport.ts';
import {PRIVATE_FLAG,bootPrivate,bootPrivateTransport,privateFlag} from '../app/src/private-boot.ts';

const PAGE='http://127.0.0.1:5173',POOL='https://shielded.mutinynet.arkade.sh';
const memory=()=>{const items=new Map<string,string>();return {items,getItem:(key:string)=>items.get(key)??null,setItem:(key:string,value:string)=>{items.set(key,value);},removeItem:(key:string)=>{items.delete(key);}};};
const pinned=async()=>{const {config,nostrPublic}=await generateOhttpKey();return {config:Buffer.from(config).toString('base64url'),gateway:nostrPublic,relays:'',poolOrigin:POOL};};
const blocked=()=>{throw new Error('blocked');},throwing={getItem:blocked,setItem:blocked,removeItem:blocked};
const flagged=()=>{const s=memory();s.setItem(PRIVATE_FLAG,'1');return s;};

test('?private=1 stores the flag, and no other value of private clears it',()=>{
 const s=memory();
 assert.equal(privateFlag('?private=0',s),false);assert.equal(s.items.has(PRIVATE_FLAG),false);
 assert.equal(privateFlag('?private=1',s),true);assert.equal(s.items.get(PRIVATE_FLAG),'1');
 for(const search of ['','?private=0','?private=yes'])assert.equal(privateFlag(search,s),true,search);
 assert.equal(s.items.get(PRIVATE_FLAG),'1');
});

test('?private=1 turns private mode on for the load where storage throws, and a flag storage cannot read is off',async()=>{
 assert.equal(privateFlag('?private=1',throwing),true);assert.equal(privateFlag('',throwing),false);
 const env=await pinned(),globals:Record<string,unknown>={fetch:async()=>new Response('direct'),WebSocket:class {}};
 const transport=bootPrivate(false,()=>bootPrivateTransport(env,'?private=1',throwing,PAGE,globals),'?private=1',throwing);
 try{assert.ok(transport);assert.equal(globals.fetch,transport.fetch);}finally{transport?.close();}
});

test('a build with no pinned gateway has no private transport, whatever the flag says',async()=>{
 const env=await pinned(),s=memory();
 assert.equal(bootPrivateTransport({...env,config:''},'?private=1',s,PAGE,{}),undefined);
 assert.equal(bootPrivateTransport({...env,gateway:''},'?private=1',s,PAGE,{}),undefined);
 assert.equal(privateTransport(),undefined);
});

test('an unpinned build that sees the flag stays closed, and stores no flag from the URL',()=>{
 const fresh=memory(),closed=/^Error: this build has no private gateway pinned$/;
 assert.throws(()=>bootPrivate(false,undefined,'?private=1',fresh),closed);assert.equal(fresh.items.has(PRIVATE_FLAG),false);
 assert.throws(()=>bootPrivate(false,undefined,'',flagged()),closed);
 assert.throws(()=>bootPrivate(false,undefined,'?private=1',throwing),closed);
 for(const storage of [memory(),throwing])assert.equal(bootPrivate(false,undefined,'?private=0',storage),undefined);
});

test('a native build neither installs the browser transport nor stays closed, whatever its pins and flag',()=>{
 let installs=0;
 for(const install of [()=>{installs++;return undefined;},undefined])assert.equal(bootPrivate(true,install,'?private=1',flagged()),undefined);
 assert.equal(installs,0);
});

test('a pinned build with the flag on installs the transport, with the six default relays when none is named',async()=>{
 const env=await pinned();
 const boot=(relays:string)=>{
  const globals:Record<string,unknown>={fetch:async()=>new Response('direct'),WebSocket:class {constructor(readonly url:string){}}};
  const transport=bootPrivateTransport({...env,relays},'?private=1',memory(),PAGE,globals)!;
  const permits=(url:string)=>{try{new (globals.WebSocket as typeof WebSocket)(url);return true;}catch{return false;}};
  return {transport,globals,permits};
 };
 const defaults=boot('');
 try{
  assert.equal(defaults.transport.pageSize,12);assert.ok(isPrivateFetch(defaults.transport.fetch));
  assert.equal(defaults.globals.fetch,defaults.transport.fetch);assert.notEqual(globalThis.fetch,defaults.transport.fetch);
  assert.deepEqual(['wss://a.example',...NOSTR_RELAYS].filter(defaults.permits),[...NOSTR_RELAYS]);
 }finally{defaults.transport.close();}
 const named=boot('wss://a.example, wss://b.example');
 try{assert.deepEqual(['wss://a.example','wss://b.example',...NOSTR_RELAYS].filter(named.permits),['wss://a.example','wss://b.example']);}
 finally{named.transport.close();}
});
