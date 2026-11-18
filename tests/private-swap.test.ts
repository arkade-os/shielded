import assert from 'node:assert/strict';
import {test} from 'node:test';
import {v2 as nip44} from 'nostr-tools/nip44';
import {finalizeEvent,generateSecretKey,getPublicKey,type Event} from 'nostr-tools/pure';
import {rendezvousPool} from '../src/shielded/private-transport.ts';
import info from './fixtures/ark-info.json' with {type:'json'};

// Installed before the swap modules load: their Nostr module captures WebSocket as it evaluates, as the browser's captures the private transport's guard.
const sockets:string[]=[];
globalThis.WebSocket=class {constructor(url:string){sockets.push(String(url));throw new Error('a swap module opened a socket');}} as unknown as typeof WebSocket;
const {privateSwapConfig}=await import('../src/shielded/private-swap.ts');
const {createSwapClient,InMemoryAssetSwapRepository}=await import('@arkade-os/swap');

const POOL='https://pool.example',solver=generateSecretKey(),S=getPublicKey(solver);
const configOf=(fetcher:typeof fetch)=>privateSwapConfig({fetch:fetcher,poolOrigin:POOL,rfqPool:()=>rendezvousPool(fetcher,POOL)});

test('a private swap transport attests the solver it meets, and its RFQ goes to the pool rendezvous sealed to that solver',async()=>{
 const posts:{url:string;body:{kind:number;event:Event;filter:unknown;waitMs:number}}[]=[];
 const fetcher=(async(url:string,init:RequestInit)=>{
  const body=JSON.parse(String(init.body)),key=nip44.utils.getConversationKey(solver,body.event.pubkey),asked=JSON.parse(nip44.decrypt(body.event.content,key));posts.push({url,body});
  const reply=finalizeEvent({kind:24859,created_at:Math.floor(Date.now()/1000),tags:[['p',body.event.pubkey]],content:nip44.encrypt(JSON.stringify({v:1,type:'rfq_status',rfq_id:asked.rfq_id,state:'open'}),key)},solver);
  return Response.json({events:[reply]});
 }) as unknown as typeof fetch;
 const transport=await configOf(fetcher).transportFor!({card:{} as never,solverPubkey:S,relays:['wss://nostr.arkade.sh']});
 assert.equal((transport as {attestedResponder?:string}).attestedResponder,S,'without the attestation verifyResponder fails every quote');
 try{assert.deepEqual(await transport.status('rfq-1'),{v:1,type:'rfq_status',rfq_id:'rfq-1',state:'open'});}finally{await transport.close();}
 assert.deepEqual(posts.map(({url,body})=>[url,body.kind,body.waitMs,body.filter]),[[POOL+'/api/rollup/rendezvous',24859,25_000,{kinds:[24859],'#p':[posts[0]!.body.event.pubkey],authors:[S]}]]);
 assert.notEqual(posts[0]!.body.event.content.includes('rfq-1'),true,'the pool sees only ciphertext');
 assert.deepEqual(sockets,[]);
});

test('swap discovery reads the registry from the pool mirror and solver cards through the rendezvous, never arkade-os.github.io nor a socket',async()=>{
 const asked:string[]=[],index={version:0,network:'mutinynet',generated_at:Math.floor(Date.now()/1000),commit:'0'.repeat(40),markets:[],solvers:[{name:'ln-solver-mutinynet',discovery_pubkey:S,transports:{nostr:{relays:['wss://nostr.arkade.sh']}}}]};
 const fetcher=(async(input:string,init?:RequestInit)=>{
  asked.push(`${init?.method??'GET'} ${input}${init?.body?' '+JSON.parse(String(init.body)).kind:''}`);
  return String(input).endsWith('/solver-registry')?Response.json(index):Response.json({events:[]});
 }) as unknown as typeof fetch;
 const client=createSwapClient({wallet:{getArkadeInfo:async()=>info} as never,repository:new InMemoryAssetSwapRepository(),policy:{drive:'readonly'},...configOf(fetcher)});
 try{assert.deepEqual(await client.markets(),[]);}finally{await client[Symbol.asyncDispose]();}
 assert.deepEqual(asked,[`GET ${POOL}/api/rollup/solver-registry`,`POST ${POOL}/api/rollup/rendezvous 38859`]);
 assert.deepEqual(sockets,[]);
});

test('a rendezvous the pool cannot serve fails the RFQ at once, and a card read that fails yields no card',async()=>{
 const fetcher=(async()=>new Response('Not Found',{status:404})) as unknown as typeof fetch,pool=rendezvousPool(fetcher,POOL),closed:string[]=[],wallet=generateSecretKey();
 pool.subscribeMany(['wss://nostr.arkade.sh'],{kinds:[38859],authors:[S],'#d':['mutinynet']},{onclose:reasons=>closed.push(...reasons.map(({reason})=>reason))});
 pool.subscribeMany(['wss://nostr.arkade.sh'],{kinds:[24859],'#p':[getPublicKey(wallet)],authors:[S]},{});
 const [published]=pool.publish(['wss://nostr.arkade.sh'],finalizeEvent({kind:24859,created_at:0,tags:[['p',S]],content:'x'},wallet));
 await assert.rejects(published!,/rendezvous answered 404/);
 assert.match(String(closed[0]),/rendezvous answered 404/);
});

test('an RFQ with no open reply subscription is refused before any request, rather than sent without a filter',async()=>{
 let asked=0;const fetcher=(async()=>{asked++;return Response.json({events:[]});}) as unknown as typeof fetch,wallet=generateSecretKey();
 const rfq=finalizeEvent({kind:24859,created_at:0,tags:[['p',S]],content:'x'},wallet),pool=rendezvousPool(fetcher,POOL);
 await assert.rejects(pool.publish(['wss://nostr.arkade.sh'],rfq)[0]!,/no open reply subscription/,'never subscribed');
 pool.subscribeMany(['wss://nostr.arkade.sh'],{kinds:[24859],'#p':[getPublicKey(wallet)],authors:[S]},{}).close();
 await assert.rejects(pool.publish(['wss://nostr.arkade.sh'],rfq)[0]!,/no open reply subscription/,'subscription closed');
 assert.equal(asked,0);
});
