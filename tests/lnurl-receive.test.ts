import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MnemonicIdentity,SingleKey,type CreateContractParams,type Wallet} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {CHECK_EVERY_MS,HD_REFUSED,RECOVERY_GAP,ROTATE_AFTER_MS,createLnurlReceive,receiveBranch,receiveDestination,type LnurlPayout} from '../src/shielded/lnurl-receive.ts';

const mnemonic='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hdIdentity=MnemonicIdentity.fromMnemonic(mnemonic,{isMainnet:false});
const server=await SingleKey.fromHex('02'.repeat(32)).compressedPublicKey();
const branch=receiveBranch(hdIdentity.descriptor,{serverPubKey:hex.encode(server).slice(-64),hrp:'tark',exitDelay:{type:'seconds',value:2048}});
const at=(index:number)=>receiveDestination(branch,index);
const domain='lnurl.example',baseUrl=`https://${domain}`,receiver={handle:'alice',username:'alice',lightningAddress:`alice@${domain}`,domain,status:'active',lnurl:'LNURL',nameless:false,sessionLnurl:null};
const legacyKey=`lnurl-hd-v1:${JSON.stringify([baseUrl,domain])}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const isBind=(r:{url:string;init?:RequestInit})=>r.url.endsWith('/arkade')&&r.init?.method==='POST';

function setup({aliases=[] as typeof receiver[],exitDelay=2048n}={}){
 const state=new Map<string,unknown>(),requests:{url:string;init?:RequestInit}[]=[],watched:CreateContractParams[]=[],registered:LnurlPayout[][]=[],funded=new Set<string>(),listeners=new Set<(event:{type:string})=>void>();
 let signed=0,saveFailure=false,clock=0,scans=0,bindReply:(body:Record<string,string>)=>Response|Promise<Response>=()=>json({ok:true});
 const identity=SingleKey.fromHex('01'.repeat(32)),sign=identity.signMessage.bind(identity);
 identity.signMessage=async(...args)=>{signed++;return sign(...args);};
 const companion={identity:hdIdentity,network:{hrp:'tark'},getArkadeInfo:async()=>({network:'mutinynet',signerPubkey:hex.encode(server),unilateralExitDelay:exitDelay}),
  indexerProvider:{getVtxos:async({scripts}:{scripts:string[]})=>{scans++;return {vtxos:scripts.filter(script=>funded.has(script)).map(script=>({script}))};}},
  getContractManager:async()=>({createContract:async(params:CreateContractParams)=>{watched.push(params);return params;},onContractEvent:(listener:(event:{type:string})=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}})} as unknown as Wallet;
 const key=(pool:string,name:string)=>JSON.stringify([pool,name]);
 const journal={getReceiveState:async<T,>(_owner:string,pool:string,name:string)=>structuredClone(state.get(key(pool,name))) as T|undefined,
  saveReceiveState:async(_owner:string,pool:string,name:string,value:unknown)=>{if(saveFailure)throw new Error('save failed');state.set(key(pool,name),structuredClone(value));}};
 const fetch=async(url:string,init?:RequestInit)=>{
  requests.push({url,init});
  if(url.endsWith('/lnurl/address'))return init?.method==='POST'?(aliases.push(receiver),json(receiver)):json(aliases);
  if(url.endsWith('/arkade'))return bindReply(JSON.parse(String(init?.body)));
  return json({error:'not found'},404);
 };
 const config={identity,companion,journal,owner:'owner',pool:'pool',baseUrl,fetch,now:()=>clock,onPayouts:async(rows:LnurlPayout[])=>{registered.push(rows);}};
 const saved=()=>state.get(key('lnurl-receive','state-v1')) as {next:number;payouts:{script:string;index:number;id:string;claimPublicKey:string}[];servers:Record<string,{current?:string;boundAt?:number;refused?:true}>}|undefined;
 const bound=()=>requests.filter(isBind).map(r=>JSON.parse(String(r.init?.body)) as Record<string,string>);
 return {service:createLnurlReceive(config),config,state,requests,watched,registered,funded,listeners,saved,bound,aliases,key,
  signed:()=>signed,scans:()=>scans,tick:(ms:number)=>{clock+=ms;},saveFailure:(value:boolean)=>{saveFailure=value;},reply:(fn:typeof bindReply)=>{bindReply=fn;}};
}
const refusal=()=>json({error:'An HD receiver cannot be downgraded by a static registration',code:'invalid_rails'},400);

test('no signing, network or watch before the alias is enabled, including the background loop',async()=>{
 const f=setup();assert.equal(await f.service.current(),undefined);assert.equal(await f.service.enabled(),false);
 f.service.start();await new Promise(resolve=>setTimeout(resolve,5));await f.service.dispose();
 assert.equal(f.signed(),0);assert.equal(f.requests.length,0);assert.equal(f.watched.length,0);assert.equal(f.scans(),0);
});

test('claim binds the first locally derived /2/7 child with its compressed claim key',async()=>{
 const f=setup(),alias=await f.service.claim(),[body]=f.bound();
 assert.equal(alias.lightningAddress,receiver.lightningAddress);
 assert.deepEqual(Object.keys(body!).sort(),['arkadeAddress','claimPublicKey','domain']);
 assert.equal(body!.arkadeAddress,at(0).address);assert.equal(body!.claimPublicKey,at(0).claimPublicKey);assert.match(body!.claimPublicKey!,/^0[23][0-9a-f]{64}$/);
 assert.match(at(0).descriptor,/\/2\/7\/0\)$/);assert.ok(hdIdentity.ownsDescriptor(at(0).descriptor));
 assert.equal(f.watched[0]!.script,at(0).script);assert.equal(f.watched[0]!.metadata?.signingDescriptor,at(0).descriptor);assert.equal(f.watched[0]!.params.csvTimelock,at(0).params!.csvTimelock);
 assert.deepEqual(f.registered.flat().map(row=>row.script),[at(0).script]);
 assert.ok(f.requests.every(r=>r.init?.redirect==='error'&&r.init.credentials==='omit'));
});

test('no descriptor, extended key, fingerprint or derivation path ever reaches the LNURL server',async()=>{
 const f=setup();await f.service.claim();
 f.tick(ROTATE_AFTER_MS);await f.service.check();
 f.funded.add(f.saved()!.servers[JSON.stringify([baseUrl,domain])]!.current!);await f.service.check();
 await createLnurlReceive({...f.config,journal:{getReceiveState:async()=>undefined,saveReceiveState:async()=>{}}}).recover();
 const fingerprint=/\[([0-9a-f]{8})\//.exec(hdIdentity.descriptor)![1]!,xpub=/[xt]pub[1-9A-HJ-NP-Za-km-z]+/.exec(hdIdentity.descriptor)![0];
 assert.ok(f.bound().length>=4);
 for(const r of f.requests){
  const wire=`${r.url} ${String(r.init?.body??'')}`;
  for(const secret of [fingerprint,xpub,branch.hd.descriptor.match(/[xt]pub[^/]+/)![0],'/2/7','descriptor','"hd"','tr(','tpub','xpub'])assert.ok(!wire.includes(secret),`${secret} leaked in ${wire}`);
 }
 for(const body of f.bound())assert.deepEqual(Object.keys(body).sort(),['arkadeAddress','claimPublicKey','domain']);
});

test('the index and bound record are durable before the bind request leaves',async()=>{
 const f=setup();let atBind:ReturnType<typeof f.saved>;
 f.reply(()=>{atBind=structuredClone(f.saved());throw new TypeError('connection closed');});
 await assert.rejects(f.service.claim(),/Request failed/);
 assert.equal(atBind!.next,1);assert.equal(atBind!.payouts[0]!.script,at(0).script);assert.equal(Object.values(atBind!.servers)[0]!.current,at(0).script);
 f.reply(()=>json({ok:true}));const restart=createLnurlReceive(f.config);await restart.check();
 assert.deepEqual(f.bound().map(body=>body.arkadeAddress),[at(0).address,at(0).address]);assert.equal(f.saved()!.next,1);
 assert.ok(f.registered.flat().some(row=>row.script===at(0).script));
});

for(const delay of [144n,2048n])test(`the bound script interprets the operator duration ${delay} using the SDK wallet policy`,async()=>{
 const f=setup({exitDelay:delay});await f.service.claim();
 assert.equal(f.watched[0]!.params.csvTimelock,receiveDestination(receiveBranch(hdIdentity.descriptor,{serverPubKey:hex.encode(server).slice(-64),hrp:'tark',exitDelay:{type:delay<512n?'blocks':'seconds',value:Number(delay)}}),0).params!.csvTimelock);
});

for(const delay of [513n,4194308n])test(`a noncanonical operator duration ${delay} is rejected before binding`,async()=>{
 const f=setup({exitDelay:delay});await assert.rejects(f.service.claim(),/Invalid HD receive script configuration/);
 assert.equal(f.bound().length,0);
});

test('a failed local write sends nothing to the LNURL server',async()=>{
 const f=setup();f.saveFailure(true);await assert.rejects(f.service.claim(),/save failed/);assert.equal(f.requests.length,0);
});

test('the timer rotates only once the bound address is a full period old, and re-asserts it before then',async()=>{
 const f=setup();await f.service.claim();
 f.tick(ROTATE_AFTER_MS-1);await f.service.check();
 assert.deepEqual(f.bound().map(body=>body.arkadeAddress),[at(0).address,at(0).address]);
 f.tick(1);await f.service.check();await f.service.check();
 assert.deepEqual(f.bound().map(body=>body.arkadeAddress).slice(2),[at(1).address,at(1).address]);assert.equal(f.saved()!.next,2);
 assert.ok(CHECK_EVERY_MS<ROTATE_AFTER_MS);
});

test('a payment to the bound address rotates it, and the paid address stays watched across restarts',async()=>{
 const f=setup();await f.service.claim();f.funded.add(at(0).script);
 f.service.start();await new Promise(resolve=>setTimeout(resolve,5));for(const listener of f.listeners)listener({type:'vtxo_received'});await f.service.dispose();
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);assert.equal(f.saved()!.next,2);
 const restart=createLnurlReceive(f.config),before=f.registered.length;await restart.check();
 assert.deepEqual(f.registered.slice(before).flat().map(row=>row.script).sort(),[at(0).script,at(1).script].sort());
 assert.deepEqual((await restart.payouts()).map(row=>row.script),[at(0).script,at(1).script]);
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);
});

test('an HD-mode alias is refused explicitly, keeps its payouts watched and retries without burning indexes or sending a descriptor',async()=>{
 const f=setup({aliases:[receiver]}),legacy=[at(0),at(2)].map(({descriptor,address,script},i)=>({id:`lnurl:${JSON.stringify([domain,'alice',i+1])}`,descriptor,address,script}));
 f.state.set(f.key('pool',legacyKey),{v:1,enabled:true,bindingVersion:2,receivers:[{...receiver,lightningAddress:receiver.lightningAddress}],cursors:{},payouts:legacy});
 f.reply(refusal);
 await assert.rejects(f.service.check(),{message:HD_REFUSED});
 assert.deepEqual(f.registered.flat().map(row=>row.id).slice(0,2),legacy.map(row=>row.id));
 const server=()=>Object.values(f.saved()!.servers)[0]!;
 assert.equal(server().refused,true);assert.equal(f.saved()!.next,4);assert.equal(server().current,at(3).script);
 f.funded.add(at(5).script);f.tick(ROTATE_AFTER_MS);
 await assert.rejects(f.service.check(),{message:HD_REFUSED});
 assert.equal(f.saved()!.next,6);assert.equal(server().current,at(3).script);assert.ok(f.registered.flat().some(row=>row.script===at(5).script));
 f.reply(()=>json({ok:true}));await f.service.check();
 assert.equal(server().refused,undefined);assert.equal(f.bound().at(-1)!.arkadeAddress,at(3).address);
 for(const body of f.bound())assert.deepEqual(Object.keys(body).sort(),['arkadeAddress','claimPublicKey','domain']);
});

test('the HD journal migrates without network and keeps every recorded payout watched and signable',async()=>{
 const f=setup({aliases:[receiver]}),legacy=[at(0),at(5)].map(({descriptor,address,script},i)=>({id:`lnurl:${JSON.stringify([domain,'alice',i+1])}`,descriptor,address,script}));
 f.state.set(f.key('pool',legacyKey),{v:1,enabled:true,receivers:[{handle:'alice',domain,lightningAddress:receiver.lightningAddress,lnurl:'LNURL',status:'active'}],cursors:{'x':2},payouts:legacy});
 assert.equal((await f.service.current())?.handle,'alice');assert.equal(await f.service.enabled(),true);
 assert.deepEqual((await f.service.payouts()).map(row=>[row.id,row.index,row.claimPublicKey]),[[legacy[0]!.id,0,at(0).claimPublicKey],[legacy[1]!.id,5,at(5).claimPublicKey]]);
 assert.equal(f.requests.length,0);assert.equal(f.saved(),undefined);
 f.funded.add(at(8).script);await f.service.check();
 assert.deepEqual(f.registered[0]!,legacy);assert.deepEqual(f.registered[1]!.map(row=>row.script),[6,7,8].map(i=>at(i).script));
 assert.equal(f.bound()[0]!.arkadeAddress,at(9).address);
 await f.service.check();assert.equal(f.saved()!.next,10);assert.equal(f.bound().length,2);
 for(const row of legacy)assert.ok(hdIdentity.ownsDescriptor(row.descriptor));
 assert.ok(f.state.has(f.key('pool',legacyKey)));
});

test('phrase recovery watches every /2/7 child up to the last funded one and binds above it',async()=>{
 const f=setup({aliases:[receiver]});f.funded.add(at(3).script);f.funded.add(at(120).script);f.funded.add(at(120+RECOVERY_GAP+60).script);
 assert.deepEqual((await f.service.recover()).map(row=>row.handle),['alice']);
 const payouts=await f.service.payouts();
 assert.equal(payouts.length,122);assert.deepEqual(payouts.slice(0,121).map(row=>row.index),Array.from({length:121},(_,i)=>i));
 assert.equal(f.saved()!.next,122);assert.equal(f.bound()[0]!.arkadeAddress,at(121).address);
 assert.ok(f.registered.flat().some(row=>row.script===at(3).script));
});

test('recovery on an unused seed binds index 0 after one gap of scanning',async()=>{
 const f=setup({aliases:[receiver]});await f.service.recover();
 assert.equal(f.bound()[0]!.arkadeAddress,at(0).address);assert.equal(f.scans(),RECOVERY_GAP/50);
});

test('claim does not take over an alias another wallet already owns',async()=>{
 const f=setup({aliases:[receiver]});
 await assert.rejects(f.service.claim(),/Recover a Lightning address/);
 assert.equal(f.bound().length,0);assert.equal(await f.service.current(),undefined);
});
