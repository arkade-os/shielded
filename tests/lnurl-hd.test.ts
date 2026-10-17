import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DefaultVtxo,MnemonicIdentity,SingleKey,deriveDescriptorLeafCompressedPubKey,type CreateContractParams,type Wallet} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {createHdLnurl,type HdReceiveConfig,type HdReceiveAllocation} from '../src/shielded/lnurl-hd.ts';

const mnemonic='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hdIdentity=MnemonicIdentity.fromMnemonic(mnemonic,{isMainnet:false});
const server=await SingleKey.fromHex('02'.repeat(32)).compressedPublicKey();
const domain='lnurl.example',receiver={handle:'alice',username:'alice',lightningAddress:`alice@${domain}`,domain,status:'active',lnurl:'LNURL',nameless:false,sessionLnurl:null};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function allocation(hd:HdReceiveConfig,index:number,id=index+1):HdReceiveAllocation{
 const descriptor=hd.descriptor.replace('*',String(index)),claim=deriveDescriptorLeafCompressedPubKey(descriptor);
 const script=new DefaultVtxo.Script({pubKey:claim.slice(1),serverPubKey:hex.decode(hd.serverPubKey),csvTimelock:{type:hd.exitDelay.type,value:BigInt(hd.exitDelay.value)}});
 return {id,index,descriptor,claimPublicKey:hex.encode(claim),arkadeAddress:script.address(hd.hrp,hex.decode(hd.serverPubKey)).encode(),hd,createdAt:1};
}
function setup(){
 const state=new Map<string,unknown>(),requests:{url:string;init?:RequestInit}[]=[],watched:CreateContractParams[]=[],payouts:unknown[]=[];
 let signed=0,watchFailure=false,saveFailure=false,callbackFailure=false;
 const identity=SingleKey.fromHex('01'.repeat(32)),sign=identity.signMessage.bind(identity);
 identity.signMessage=async(...args)=>{signed++;return sign(...args);};
 const companion={identity:hdIdentity,network:{hrp:'tark'},getArkadeInfo:async()=>({network:'mutinynet',signerPubkey:hex.encode(server),unilateralExitDelay:144n}),getContractManager:async()=>({createContract:async(params:CreateContractParams)=>{if(watchFailure)throw new Error('watch failed');watched.push(params);return params;}})} as unknown as Wallet;
 let respond:(url:string,init?:RequestInit)=>Promise<Response>=async(url)=>url.endsWith('/lnurl/address')?json([receiver]):json({allocations:[],nextAfter:0});
 const journal={getReceiveState:async<T,>(_owner:string,_pool:string,key:string)=>structuredClone(state.get(key)) as T|undefined,saveReceiveState:async(_owner:string,_pool:string,key:string,value:unknown)=>{if(saveFailure)throw new Error('save failed');state.set(key,structuredClone(value));}};
 const config={identity,companion,journal,owner:'owner',pool:'pool',baseUrl:`https://${domain}`,fetch:async(url:string,init?:RequestInit)=>{requests.push({url,init});return respond(url,init);},onAllocation:async(value:unknown)=>{if(callbackFailure)throw new Error('payout failed');payouts.push(value);}};
 const service=createHdLnurl(config);
 const claim=async()=>{
  let hd:HdReceiveConfig|undefined;
  respond=async(url,init)=>{if(url.endsWith('/arkade')){hd=JSON.parse(String(init?.body)).hd;return json({receiveMode:'hd'});}if(init?.method==='POST')return json(receiver);if(url.includes('/allocations'))return json({allocations:[],nextAfter:0});return json([receiver]);};
  await service.claim();return hd!;
 };
 return {service,config,state,requests,watched,payouts,claim,signed:()=>signed,respond:(fn:typeof respond)=>{respond=fn;},watchFailure:(value:boolean)=>{watchFailure=value;},saveFailure:(value:boolean)=>{saveFailure=value;},callbackFailure:(value:boolean)=>{callbackFailure=value;}};
}

test('HD alias has no signing or network activity before explicit enable, including its background loop',async()=>{
 const f=setup();assert.equal(await f.service.current(),undefined);assert.equal(await f.service.enabled(),false);assert.deepEqual(await f.service.recover(),[]);
 f.service.start();await new Promise(resolve=>setTimeout(resolve,5));await f.service.dispose();
 assert.equal(f.signed(),0);assert.equal(f.requests.length,0);
});

test('HD alias exports only its scoped public branch and requires explicit server acknowledgement',async()=>{
 const f=setup(),hd=await f.claim(),body=JSON.parse(String(f.requests.find(r=>r.url.endsWith('/arkade'))!.init?.body));
 assert.deepEqual(Object.keys(body).sort(),['domain','hd']);assert.match(hd.descriptor,/\/2\/7\]tpub[^/]+\/\*\)$/);
 assert.ok(!JSON.stringify(body).includes(hdIdentity.descriptor.match(/tpub[^/]+/)![0]));
 assert.equal((await f.service.current())?.lightningAddress,receiver.lightningAddress);
 assert.ok(f.requests.every(r=>r.init?.redirect==='error'&&r.init.credentials==='omit'));
 const old=setup();old.respond(async(_url,init)=>json(init?.method==='POST'&&String(init.body).includes('"hd"')?{ok:true}:receiver));
 await assert.rejects(old.service.claim(),/confirm.*HD|support.*HD/);assert.equal(await old.service.current(),undefined);
});

test('HD alias refuses any remote mutation when persisting explicit enable fails',async()=>{
 const f=setup();f.saveFailure(true);await assert.rejects(f.service.claim(),/save failed/);assert.equal(f.requests.length,0);
});

test('HD allocation recovery imports arbitrary gaps with local signing descriptors and original script settings',async()=>{
 const f=setup(),hd=await f.claim(),historic={...hd,serverPubKey:hex.encode(await SingleKey.fromHex('03'.repeat(32)).xOnlyPublicKey()),exitDelay:{type:'seconds' as const,value:1024}};
 const first=allocation(historic,1000,1),last=allocation(hd,100000,9);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=0')?json({allocations:[first],nextAfter:1}):url.includes('after=1&')?json({allocations:[last],nextAfter:9}):json({allocations:[],nextAfter:9}));
 await f.service.recover();assert.equal(f.watched.length,2);assert.equal(f.payouts.length,2);
 assert.equal(f.watched[0].params.serverPubKey,historic.serverPubKey);assert.equal(f.watched[0].params.csvTimelock,String((1<<22)|2));
 for(const [i,row]of f.watched.entries()){
  const descriptor=String(row.metadata?.signingDescriptor);assert.ok(hdIdentity.ownsDescriptor(descriptor));assert.match(descriptor,new RegExp(`/2/7/${[1000,100000][i]}\\)$`));
  assert.equal(hex.encode(deriveDescriptorLeafCompressedPubKey(descriptor)),[first,last][i].claimPublicKey);
 }
 const restart=createHdLnurl(f.config);assert.equal((await restart.current())?.lightningAddress,receiver.lightningAddress);assert.equal((await restart.allocations()).length,2);
});

for(const field of ['descriptor','claimPublicKey','arkadeAddress','hd'] as const)test(`HD allocation rejects tampered ${field} before cursor or watch changes`,async()=>{
 const f=setup(),hd=await f.claim(),row=allocation(hd,77,1);
 if(field==='hd')row.hd={...hd,descriptor:hd.descriptor.replace('/2/7]', '/2/8]')};else row[field]='bad';
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):json({allocations:[row],nextAfter:1}));
 await assert.rejects(f.service.recover(),/HD|allocation|descriptor/i);assert.equal(f.watched.length,0);assert.equal(f.payouts.length,0);assert.equal((await f.service.allocations()).length,0);
});

for(const failure of ['watch','callback'] as const)test(`HD history cursor remains retryable after ${failure} failure`,async()=>{
 const f=setup(),hd=await f.claim(),row=allocation(hd,200,2);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=0')?json({allocations:[row],nextAfter:2}):json({allocations:[],nextAfter:2}));
 if(failure==='watch')f.watchFailure(true);else f.callbackFailure(true);
 await assert.rejects(f.service.recover(),/failed/);assert.equal((await f.service.allocations()).length,0);
 f.watchFailure(false);f.callbackFailure(false);await f.service.recover();assert.equal((await f.service.allocations()).length,1);
});

test('phrase recovery is explicit, restores revoked histories and upgrades active aliases with an HD acknowledgement',async()=>{
 const f=setup(),other=setup(),hd=await other.claim(),row=allocation(hd,10000,17),revoked={...receiver,handle:'old',status:'revoked'};
 f.respond(async(url,init)=>url.endsWith('/lnurl/address')?json([receiver,revoked]):init?.method==='POST'?json({receiveMode:'hd'}):url.includes('/old/')&&url.includes('after=0')?json({allocations:[row],nextAfter:17}):json({allocations:[],nextAfter:url.includes('/old/')?17:0}));
 assert.deepEqual(await f.service.recover(),[]);assert.equal(f.requests.length,0);
 await f.service.recover({explicit:true});assert.equal((await f.service.current())?.handle,'alice');assert.equal((await f.service.allocations()).length,1);
 assert.equal(f.requests.filter(r=>r.init?.method==='POST').length,1);
});

test('HD cursor is not acknowledged when its durable write fails',async()=>{
 const f=setup(),hd=await f.claim(),row=allocation(hd,100,8);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=0')?json({allocations:[row],nextAfter:8}):json({allocations:[],nextAfter:8}));
 f.saveFailure(true);await assert.rejects(f.service.recover(),/save failed/);assert.equal((await f.service.allocations()).length,0);
 f.saveFailure(false);await f.service.recover();assert.equal((await f.service.allocations()).length,1);
 assert.equal(f.requests.filter(r=>r.url.includes('after=0&')).length,3);
});

for(const malformed of ['index','cursor','order'] as const)test(`HD allocation rejects malformed ${malformed} without importing scripts`,async()=>{
 const f=setup(),hd=await f.claim(),row=allocation(hd,7,8);
 const page={allocations:[row],nextAfter:8};
 if(malformed==='index')row.index=0x80000000;if(malformed==='cursor')page.nextAfter=7;if(malformed==='order')page.allocations.push(row);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):json(page));
 await assert.rejects(f.service.recover(),/HD receive allocation|HD receive allocation index/);assert.equal(f.watched.length,0);assert.equal((await f.service.allocations()).length,0);
});

test('fresh-device recovery fails closed on an older server and never advertises its static alias',async()=>{
 const f=setup();f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):json({ok:true}));
 await assert.rejects(f.service.recover({explicit:true}),/confirm.*HD/);assert.equal(await f.service.current(),undefined);
});

test('background recovery preserves explicit HD acknowledgement and never binds an unrelated active alias',async()=>{
 const f=setup();await f.claim();const writes=f.requests.filter(r=>r.init?.method==='POST').length;
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver,{...receiver,handle:'other',lightningAddress:`other@${domain}`} ]):json({allocations:[],nextAfter:0}));
 await f.service.recover();assert.equal(f.requests.filter(r=>r.init?.method==='POST').length,writes);assert.equal((await f.service.current())?.handle,'alice');
});

for(const setting of ['serverPubKey','exitDelay','hrp'] as const)test(`HD history rejects tampered historical ${setting} instead of substituting current operator settings`,async()=>{
 const f=setup(),hd=await f.claim(),row=allocation(hd,9,20);
 row.hd={...hd,...(setting==='serverPubKey'?{serverPubKey:hex.encode(await SingleKey.fromHex('03'.repeat(32)).xOnlyPublicKey())}:setting==='exitDelay'?{exitDelay:{type:'blocks',value:500}}:{hrp:'ark'})};
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):json({allocations:[row],nextAfter:20}));
 await assert.rejects(f.service.recover(),/HD allocation|network mismatch/);assert.equal(f.watched.length,0);assert.equal((await f.service.allocations()).length,0);
});

test('reloaded alias replays a failed history import while preserving earlier durable payouts',async()=>{
 const f=setup(),hd=await f.claim(),first=allocation(hd,30,10),last=allocation(hd,10000,20);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=0&')?json({allocations:[first],nextAfter:10}):json({allocations:[],nextAfter:10}));
 await f.service.recover();assert.equal((await f.service.allocations()).length,1);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=10&')?json({allocations:[last],nextAfter:20}):json({allocations:[],nextAfter:20}));
 f.callbackFailure(true);await assert.rejects(f.service.recover(),/payout failed/);
 const restart=createHdLnurl(f.config);assert.equal((await restart.allocations()).length,1);f.callbackFailure(false);
 await restart.recover();assert.equal((await restart.allocations()).length,2);assert.equal((await restart.current())?.handle,'alice');
});

test('two aliases on one scoped branch retain independent allocation cursors and payouts',async()=>{
 const f=setup(),other=setup(),hd=await other.claim(),second={...receiver,handle:'second',lightningAddress:`second@${domain}`};
 const firstRow=allocation(hd,0,200),secondRow=allocation(hd,1,100);
 f.respond(async(url,init)=>{
  if(url.endsWith('/lnurl/address'))return json([receiver,second]);if(init?.method==='POST')return json({receiveMode:'hd'});
  const row=url.includes('/second/')?secondRow:firstRow;
  return json(url.includes('after=0&')?{allocations:[row],nextAfter:row.id}:{allocations:[],nextAfter:row.id});
 });
 await f.service.recover({explicit:true});assert.equal((await f.service.allocations()).length,2);
 assert.equal(new Set(f.watched.map(row=>row.script)).size,2);assert.equal(new Set((await f.service.allocations()).map(row=>row.id)).size,2);
 const count=f.watched.length;await createHdLnurl(f.config).recover();assert.equal(f.watched.length,count);
});

test('HD history rejects an oversized page before any watch, payout or cursor write',async()=>{
 const f=setup(),hd=await f.claim(),rows=Array.from({length:101},(_,index)=>allocation(hd,index)),before=structuredClone(f.state);
 f.respond(async(url)=>url.endsWith('/lnurl/address')?json([receiver]):url.includes('after=0&')?json({allocations:rows,nextAfter:101}):json({allocations:[],nextAfter:101}));
 await assert.rejects(f.service.recover(),{message:'Invalid HD receive allocation page'});
 assert.equal(f.watched.length,0);assert.equal(f.payouts.length,0);assert.deepEqual(f.state,before);assert.equal((await f.service.allocations()).length,0);
});
