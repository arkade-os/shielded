import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MnemonicIdentity,SingleKey,type CreateContractParams,type Wallet} from '@arkade-os/sdk';
import {bech32m,hex} from '@scure/base';
import {CHECK_EVERY_MS,HD_REFUSED,METHODS_NOT_WITHDRAWN,METHODS_REFUSED,RECOVERY_GAP,ROTATE_AFTER_MS,createLnurlReceive,receiveBranch,receiveDestination,type LnurlPayout} from '../src/shielded/lnurl-receive.ts';

const mnemonic='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hdIdentity=MnemonicIdentity.fromMnemonic(mnemonic,{isMainnet:false});
const server=await SingleKey.fromHex('02'.repeat(32)).compressedPublicKey();
const branch=receiveBranch(hdIdentity.descriptor,{serverPubKey:hex.encode(server).slice(-64),hrp:'tark',exitDelay:{type:'seconds',value:2048}});
const at=(index:number)=>receiveDestination(branch,index);
type TestReceiver={handle:string;username:string|null;lightningAddress:string|null;domain:string;status:string;lnurl:string;nameless:boolean;sessionLnurl:string|null;paymentMethods?:{type:string;destination?:string}[]};
const domain='lnurl.example',baseUrl=`https://${domain}`;
const receiver:TestReceiver={handle:'alice',username:'alice',lightningAddress:`alice@${domain}`,domain,status:'active',lnurl:'LNURL',nameless:false,sessionLnurl:null};
const sessionLnurl='LNURL1SESSION',nameless:TestReceiver={handle:'ab'.repeat(32),username:null,lightningAddress:null,domain,status:'active',lnurl:sessionLnurl,nameless:true,sessionLnurl};
const legacyKey=`lnurl-hd-v1:${JSON.stringify([baseUrl,domain])}`;
const SHROL=bech32m.encode('shrol2',bech32m.toWords(new Uint8Array(64).fill(7)),false),shielded={type:'shielded',destination:SHROL};
interface Bind {arkadeAddress:string;claimPublicKey:string;domain:string;methods?:{type:string;destination:string}[]}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const isBind=(r:{url:string;init?:RequestInit})=>r.url.endsWith('/arkade')&&r.init?.method==='POST';

function setup({aliases=[] as typeof receiver[],exitDelay=2048n,namelessSupported=true}={}){
 const state=new Map<string,unknown>(),kept=new Map<string,unknown>(),requests:{url:string;init?:RequestInit}[]=[],watched:CreateContractParams[]=[],registered:LnurlPayout[][]=[],funded=new Set<string>(),listeners=new Set<(event:{type:string})=>void>();
 let signed=0,saveFailure=false,clock=0,scans=0,reads=0,keeps=true,bindReply:(body:Bind)=>Response|Promise<Response>=()=>json({ok:true});
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
  if(url.endsWith('/lnurl/address')){
   if(init?.method==='POST'){
    const body=JSON.parse(String(init.body)) as {nameless?:boolean};
    if(body.nameless&&namelessSupported){const owned=aliases.find(row=>!!row.sessionLnurl)??nameless;if(!aliases.includes(owned))aliases.push(owned);return json(owned);}
    aliases.push(receiver);return json(receiver);
   }
   return json(aliases.map(row=>kept.has(row.handle)?{...row,paymentMethods:kept.get(row.handle)}:row));
  }
  if(init?.method==='PATCH'&&new URL(url).pathname.startsWith('/lnurl/address/')){
   const handle=decodeURIComponent(new URL(url).pathname.split('/').at(-1)!),index=aliases.findIndex(row=>row.handle===handle);
   if(index<0||!aliases[index]!.sessionLnurl)return json({error:'not a nameless receiver'},404);
   const upgraded={...aliases[index]!,handle:receiver.handle,username:receiver.username,lightningAddress:receiver.lightningAddress,nameless:false};
   if(kept.has(handle)){kept.set(upgraded.handle,kept.get(handle)!);kept.delete(handle);}
   aliases[index]=upgraded;return json(upgraded);
  }
  if(url.endsWith('/arkade')){
   const body=JSON.parse(String(init?.body)) as Bind,answer=await bindReply(body);
   if(answer.ok&&keeps&&body.methods)kept.set(decodeURIComponent(url.split('/').at(-2)!),body.methods);
   return answer;
  }
  return json({error:'not found'},404);
 };
 const config={identity,companion,journal,owner:'owner',pool:'pool',baseUrl,fetch,now:()=>clock,shieldedAddress:()=>{reads++;return SHROL;},onPayouts:async(rows:LnurlPayout[])=>{registered.push(rows);}};
 const saved=()=>state.get(key('lnurl-receive','state-v1')) as {next:number;payouts:{script:string;index:number;id:string;claimPublicKey:string}[];servers:Record<string,{current?:string;boundAt?:number;refused?:true;recovering?:true;methods?:true;methodsPending?:true;methodsRefused?:true;withdraw?:true}>}|undefined;
 const bound=()=>requests.filter(isBind).map(r=>JSON.parse(String(r.init?.body)) as Bind);
 return {service:createLnurlReceive(config),config,state,requests,watched,registered,funded,listeners,saved,bound,aliases,key,
  signed:()=>signed,scans:()=>scans,reads:()=>reads,keep:(value:boolean)=>{keeps=value;},relist:(handle:string,methods:unknown[])=>{kept.set(handle,methods);},forge:(change:(entry:Record<string,unknown>)=>void)=>{const stored=structuredClone(state.get(key('lnurl-receive','state-v1'))) as {servers:Record<string,Record<string,unknown>>};Object.values(stored.servers).forEach(change);state.set(key('lnurl-receive','state-v1'),stored);},tick:(ms:number)=>{clock+=ms;},saveFailure:(value:boolean)=>{saveFailure=value;},reply:(fn:typeof bindReply)=>{bindReply=fn;}};
}
const refusal=()=>json({error:'An HD receiver cannot be downgraded by a static registration',code:'invalid_rails'},400);

test('no signing, network or watch before the alias is enabled, including the background loop',async()=>{
 const f=setup();assert.equal(await f.service.current(),undefined);assert.equal(await f.service.enabled(),false);
 f.service.start();await new Promise(resolve=>setTimeout(resolve,5));await f.service.dispose();
 assert.equal(f.signed(),0);assert.equal(f.requests.length,0);assert.equal(f.watched.length,0);assert.equal(f.scans(),0);
});

test('a page cancellation inherited by the address service prevents registration',async()=>{
 const f=setup(),controller=new AbortController();controller.abort();
 const service=createLnurlReceive({...f.config,signal:controller.signal});
 await assert.rejects(service.ensureUnified(),/disposed/);
 assert.equal(f.requests.length,0);assert.equal(f.watched.length,0);assert.equal(f.scans(),0);
});

test('disposing an address activation reports blocked payout registration without hanging',async()=>{
 const f=setup();let entered!:()=>void,signal:AbortSignal|undefined;const waiting=new Promise<void>(resolve=>{entered=resolve;}),never=new Promise<void>(()=>{});
 const service=createLnurlReceive({...f.config,onPayouts:async(_rows,next)=>{signal=next;entered();await never;}}),activation=service.ensureUnified();
 await waiting;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await assert.rejects(Promise.race([service.dispose(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('dispose waited for payout registration')),250);})]),/still finishing/);
  await assert.rejects(activation,/disposed/);
   assert.equal(signal?.aborted,true);
 }finally{if(timer)clearTimeout(timer);}
});

test('a payout registration rejected after disposal is already handled',async()=>{
 const f=setup();let entered!:()=>void,refuse!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),late=new Promise<void>((_resolve,reject)=>{refuse=()=>reject(new Error('late payout failure'));});
 const service=createLnurlReceive({...f.config,onPayouts:async()=>{entered();await late;}}),activation=service.ensureUnified();
 await waiting;await assert.rejects(service.dispose(),/still finishing/);refuse?.();await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(activation,/disposed/);
});

test('disposing during a blocked contract watch does not wait for the IndexedDB operation',async()=>{
 const f=setup();let entered!:()=>void,release!:()=>void,finished!:()=>void,saves=0;
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),late=new Promise<void>(resolve=>{release=resolve;}),done=new Promise<void>(resolve=>{finished=resolve;});
 const save=f.config.journal.saveReceiveState;
 f.config.journal.saveReceiveState=async(...args)=>{saves++;await save(...args);};
 (f.config.companion as unknown as {getContractManager:()=>Promise<unknown>}).getContractManager=async()=>({
  createContract:async()=>{entered();await late;finished();},
  onContractEvent:()=>()=>{},
 });
 const service=createLnurlReceive(f.config),activation=service.ensureUnified();
 await waiting;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await assert.rejects(Promise.race([service.dispose(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('dispose waited for contract creation')),250);})]),/still finishing/);
  await assert.rejects(activation,/disposed/);
  const savesAtDisposal=saves;release();await done;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saves,savesAtDisposal);assert.equal(f.registered.length,0);assert.equal(f.bound().length,0);
  await service.dispose();
 }finally{release?.();if(timer)clearTimeout(timer);}
});

test('a unified receiver registers without a name or shielded method and binds before its QR is ready',async()=>{
 const f=setup(),result=await f.service.ensureUnified();
 assert.deepEqual([result.lnurl,result.lightningAddress,result.nameless],[sessionLnurl,undefined,true]);
 assert.equal((await f.service.current())?.lnurl,sessionLnurl);
 assert.equal(f.requests.filter(r=>r.url.endsWith('/lnurl/address')&&r.init?.method==='POST').length,1);
 const registered=f.requests.find(r=>r.url.endsWith('/lnurl/address')&&r.init?.method==='POST')!;
 assert.equal(JSON.parse(String(registered.init?.body)).nameless,true);
 assert.deepEqual(Object.keys(f.bound()[0]!).sort(),['arkadeAddress','claimPublicKey','domain']);
 assert.equal(f.reads(),0);
 assert.equal(f.scans(),0);
 assert.equal(JSON.stringify(f.requests).includes(SHROL),false);
});

test('unified setup reports progress through local state, Tor service work, watch restoration and binding',async()=>{
 const f=setup(),stages:string[]=[],service=createLnurlReceive({...f.config,onStage:stage=>stages.push(stage)});
 await service.ensureUnified();
 assert.deepEqual(stages,[
  'Reading your saved receiver',
  'Checking the Lightning address service through Tor',
  'Registering your unified address',
  'Restoring payout watches',
  'Binding your payment routes',
  'Unified address ready',
 ]);
});

test('a slow Lightning handoff cannot hold the unified address behind swap startup',async()=>{
 const f=setup();let release!:()=>void,finished=0,ready=0,attempts=0;const held=new Promise<void>(resolve=>{release=resolve;});
 const service=createLnurlReceive({...f.config,watchStartupGraceMs:20,onPayouts:async(_rows,signal)=>{attempts++;await held;if(!signal.aborted)finished++;},onPayoutReady:()=>ready++});
 const receiver=await Promise.race([service.ensureUnified(),new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('unified address waited for swap startup')),250))]);
 assert.equal(receiver.lnurl,sessionLnurl);
 assert.equal(f.bound().length,1);assert.deepEqual([finished,ready,attempts],[0,0,1]);
 await service.check();assert.equal(attempts,1);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual([finished,ready],[1,1]);
  await service.check();assert.equal(attempts,1);
 await service.dispose();
});

test('a payout watch that fails after startup reports separately and retries without replacing the address',async()=>{
 const f=setup();let release!:()=>void,attempts=0,ready=0;const failure=new Error('late payout watch failed'),reported:{error:unknown;revision:number}[]=[];
 const held=new Promise<void>(resolve=>{release=resolve;});
 const service=createLnurlReceive({...f.config,watchStartupGraceMs:20,onPayouts:async()=>{if(++attempts===1){await held;throw failure;}},onPayoutError:(error,revision)=>reported.push({error,revision}),onPayoutReady:()=>ready++});
 const receiver=await service.ensureUnified();
 assert.equal(receiver.lnurl,sessionLnurl);assert.equal(f.bound().length,1);
 f.funded.add(at(0).script);await service.check();
 assert.deepEqual([attempts,ready],[2,0]);
 release();
 for(let i=0;i<20&&!reported.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(reported,[{error:failure,revision:1}]);
 await service.check();
 assert.deepEqual([attempts,ready],[3,1]);
 await service.check();assert.equal(attempts,3);
 await service.dispose();
});

test('a successful newer subset watch leaves an older failed payout eligible and keeps receive unhealthy',async()=>{
 const f=setup(),failure=new Error('older payout watch failed'),ready:number[]=[],reported:number[]=[];
 let releaseFirst!:()=>void,enteredFirst!:()=>void,attempts=0;
 const firstEntered=new Promise<void>(resolve=>{enteredFirst=resolve;}),
  firstHeld=new Promise<void>(resolve=>{releaseFirst=resolve;});
 const service=createLnurlReceive({...f.config,watchStartupGraceMs:20,
  onPayouts:async()=>{
   attempts++;
   if(attempts===1){enteredFirst();await firstHeld;throw failure;}
  },
  onPayoutError:(_error,revision)=>reported.push(revision),
  onPayoutReady:revision=>ready.push(revision),
 });
 const activation=service.ensureUnified();
 await firstEntered;
 await activation;
 f.funded.add(at(0).script);
 await service.check();
 assert.equal(attempts,2);
 assert.deepEqual(ready,[],'a newer subset does not cover the still-pending payout');
 releaseFirst();
 for(let i=0;i<20&&!reported.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(reported,[1]);
 await service.check();
 assert.equal(attempts,3,'the failed payout is retried');
 assert.deepEqual(ready,[3],'receive becomes healthy only after the full payout set is covered');
 await service.dispose();
});

test('a fresh journal recovers funded session payouts before binding a unified receiver',async()=>{
 const f=setup({aliases:[nameless]});f.funded.add(at(3).script);f.funded.add(at(70).script);
 await f.service.ensureUnified();
 assert.equal(f.bound()[0]!.arkadeAddress,at(71).address);
 assert.deepEqual(f.saved()!.payouts.map(row=>row.index),Array.from({length:72},(_,i)=>i));
 assert.ok(f.registered.flat().some(row=>row.script===at(70).script));
 assert.equal(f.requests.some(r=>r.init?.method==='POST'&&r.url.endsWith('/lnurl/address')),false);
});

test('a failed initial unified journal save prevents remote registration',async()=>{
 const f=setup();f.saveFailure(true);
 await assert.rejects(f.service.ensureUnified(),/save failed/);
 assert.equal(f.requests.length,0);assert.equal(f.aliases.length,0);
});

test('a background check after restart finishes a failed fresh-journal recovery scan',async()=>{
 const f=setup({aliases:[nameless]}),indexer=f.config.companion.indexerProvider,read=indexer.getVtxos.bind(indexer);let fail=true;
 f.funded.add(at(3).script);indexer.getVtxos=async(...args)=>{if(fail){fail=false;throw new Error('scan failed');}return read(...args);};
 await assert.rejects(f.service.ensureUnified(),/scan failed/);assert.equal(f.bound().length,0);
 assert.equal(Object.values(f.saved()!.servers)[0]!.recovering,true);
 const restart=createLnurlReceive(f.config);await restart.check();assert.equal(f.bound()[0]!.arkadeAddress,at(4).address);
 assert.ok(f.registered.flat().some(row=>row.script===at(3).script));
 assert.equal(Object.values(f.saved()!.servers)[0]!.recovering,undefined);
 const scans=f.scans();await restart.check();assert.equal(f.scans()-scans,1);
});

test('an unsupported nameless registration stays pending and cannot bind through retries',async()=>{
 const f=setup({namelessSupported:false});
 for(const service of [f.service,f.service,createLnurlReceive(f.config)])await assert.rejects(service.ensureUnified(),/did not register a unified address.*Recover a Lightning address/);
 assert.equal(f.aliases.length,1);assert.equal(f.bound().length,0);assert.equal(await f.service.current(),undefined);
 const stored=f.state.get(f.key('lnurl-receive','state-v1')) as {servers:Record<string,{pending?:string}>};
 assert.equal(Object.values(stored.servers)[0]!.pending,receiver.handle);
 await f.service.recover();assert.equal((await f.service.current())?.handle,receiver.handle);assert.equal(f.bound().length,1);
});

test('a unified QR stays the same after its receiver claims a Lightning address',async()=>{
 const f=setup(),before=await f.service.ensureUnified(),payouts=f.saved()!.next;
 const named=await f.service.claimName();
 assert.deepEqual([named.lightningAddress,named.lnurl,named.sessionLnurl],[receiver.lightningAddress,before.lnurl,before.lnurl]);
 assert.equal(f.requests.filter(r=>r.init?.method==='PATCH').length,1);
 assert.equal(f.saved()!.next,payouts);
 assert.equal((await createLnurlReceive(f.config).ensureUnified()).lnurl,before.lnurl);
 assert.equal((await f.service.current())?.handle,'alice');
});

test('naming a unified receiver keeps its confirmed shielded method and the same QR',async()=>{
 const f=setup(),before=await f.service.ensureUnified();
 await f.service.setPrivateReceive(true);
 assert.deepEqual(await f.service.privateReceiveState(),{on:true,pending:false,refused:false,withdrawing:false,listed:'own'});
 const named=await f.service.claimName();
 assert.equal(named.lnurl,before.lnurl);
 const listed=await (await f.config.fetch(`${baseUrl}/lnurl/address`)).json() as TestReceiver[];
 assert.deepEqual(listed.find(row=>row.handle===named.handle)?.paymentMethods,[shielded]);
 assert.deepEqual(await f.service.privateReceiveState(),{on:true,pending:false,refused:false,withdrawing:false,listed:'own'});
 assert.equal((await f.service.current())?.paymentMethods?.[0]?.destination,SHROL);
});

test('an explicit methods list returned by naming replaces the previous local snapshot',async()=>{
 const f=setup();await f.service.ensureUnified();await f.service.setPrivateReceive(true);
 const service=createLnurlReceive({...f.config,fetch:async(url,init)=>{
  const response=await f.config.fetch(url,init);
  if(init?.method!=='PATCH')return response;
  f.relist(receiver.handle,[]);return json({...await response.json(),paymentMethods:[]});
 }});
 await service.claimName();
 assert.deepEqual((await service.current())?.paymentMethods,[]);
 assert.equal((await service.privateReceiveState()).listed,null);
});

for(const rotate of [false,true])test(`a failed ${rotate?'rotated':'first'} payout watch is restored before a unified bind retry`,async()=>{
 const f=setup();let fail=!rotate;
 const service=createLnurlReceive({...f.config,onPayouts:async rows=>{if(fail)throw new Error('watch failed');await f.config.onPayouts(rows);}});
 if(rotate){await service.ensureUnified();f.funded.add(at(0).script);fail=true;}
 await assert.rejects(service.ensureUnified(),/watch failed/);
 const index=rotate?1:0,before=f.bound().length;assert.equal(f.saved()!.next,index+1);
 f.reply(body=>{assert.ok(f.registered.flat().some(row=>row.address===body.arkadeAddress));return json({ok:true});});fail=false;
 await service.ensureUnified();
 assert.equal(f.bound().length,before+1);assert.equal(f.bound().at(-1)!.arkadeAddress,at(index).address);
});

test('recovered payouts are watched again after adoption fails before the unified bind',async()=>{
 const f=setup({aliases:[nameless]});f.funded.add(at(3).script);let fail=true;
 const service=createLnurlReceive({...f.config,onPayouts:async rows=>{if(fail)throw new Error('watch failed');await f.config.onPayouts(rows);}});
 await assert.rejects(service.ensureUnified(),/watch failed/);assert.equal(f.bound().length,0);
 assert.equal(f.saved()!.next,4);fail=false;await service.ensureUnified();
 assert.deepEqual([...new Set(f.registered.flat().map(row=>row.script))].sort(),Array.from({length:5},(_,i)=>at(i).script).sort());
 assert.equal(f.bound()[0]!.arkadeAddress,at(4).address);
});

for(const recreate of [false,true])test(`a persisted payout with failed SDK hydration is reattached before binding${recreate?' after service recreation':''}`,async()=>{
 const f=setup(),contracts=new Map<string,CreateContractParams>(),attached=new Set<string>();let updates=0,failAttach=true;
 const manager={createContract:async(params:CreateContractParams)=>{
  const existing=contracts.get(params.script);if(existing)return existing;
  contracts.set(params.script,params);throw new Error('hydration failed');
 },updateContract:async(script:string,changes:object)=>{
  updates++;assert.deepEqual(changes,{});if(failAttach)throw new Error('reattach failed');
  attached.add(script);return contracts.get(script)!;
 }};
 f.config.companion.getContractManager=async()=>manager as unknown as Awaited<ReturnType<Wallet['getContractManager']>>;
 await assert.rejects(f.service.ensureUnified(),/hydration failed/);
 assert.equal(contracts.has(at(0).script),true);assert.equal(attached.size,0);assert.equal(f.bound().length,0);
 const retry=recreate?createLnurlReceive(f.config):f.service;
 f.reply(body=>{assert.ok(attached.has(at(0).script));assert.equal(body.arkadeAddress,at(0).address);return json({ok:true});});
 await assert.rejects(retry.ensureUnified(),/reattach failed/);assert.equal(f.bound().length,0);
 failAttach=false;await retry.ensureUnified();assert.equal(updates,2);
 await createLnurlReceive(f.config).ensureUnified();assert.equal(updates,2);
});

test('a nameless registration survives a failed local write and binds on retry',async()=>{
 const f=setup();let writes=0;
 const service=createLnurlReceive({...f.config,journal:{...f.config.journal,saveReceiveState:async(...args)=>{if(++writes===2)throw new Error('save failed');return f.config.journal.saveReceiveState(...args);}}});
 await assert.rejects(service.ensureUnified(),/save failed/);
 assert.equal(f.bound().length,0);
 assert.equal(f.aliases.filter(row=>row.sessionLnurl===sessionLnurl).length,1);
 assert.equal((await createLnurlReceive(f.config).ensureUnified()).lnurl,sessionLnurl);
 assert.equal(f.bound().length,1);
});

test('a failed payout bind does not resolve a unified QR, and retry finishes the same receiver',async()=>{
 const f=setup();f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.ensureUnified(),/Request failed/);
 assert.equal(f.aliases.length,1);
 f.reply(()=>json({ok:true}));
 assert.equal((await createLnurlReceive(f.config).ensureUnified()).lnurl,sessionLnurl);
 assert.equal(f.saved()!.next,1);
});

test('a failed local save after naming is repaired from the stable session LNURL',async()=>{
 const f=setup();await f.service.ensureUnified();let fail=true;
 const journal={...f.config.journal,saveReceiveState:async(...args:Parameters<typeof f.config.journal.saveReceiveState>)=>{
  const state=args[3] as {servers:Record<string,{receivers:{lightningAddress?:string}[]}>};
  if(fail&&Object.values(state.servers).some(server=>server.receivers.some(row=>!!row.lightningAddress)))throw new Error('save failed');
  return f.config.journal.saveReceiveState(...args);
 }};
 await assert.rejects(createLnurlReceive({...f.config,journal}).claimName(),/save failed/);
 fail=false;
 const restored=await createLnurlReceive(f.config).ensureUnified();
 assert.deepEqual([restored.lightningAddress,restored.lnurl],[receiver.lightningAddress,sessionLnurl]);
 assert.equal(f.requests.filter(r=>r.init?.method==='PATCH').length,1);
});

test('an already tracked named receiver keeps its existing LNURL without a nameless registration',async()=>{
 const f=setup(),claimed=await f.service.claim(),requests=f.requests.length,scans=f.scans();
 const result=await f.service.ensureUnified();
 assert.equal(f.scans()-scans,1);
 assert.equal(result.lnurl,claimed.lnurl);
 assert.equal((await f.service.claimName()).lightningAddress,receiver.lightningAddress);
 assert.equal(f.requests.slice(requests).filter(r=>r.init?.method==='PATCH'||r.init?.method==='POST'&&r.url.endsWith('/lnurl/address')).length,0);
});

test('an untracked legacy named receiver still needs explicit recovery',async()=>{
 const f=setup({aliases:[receiver]});
 await assert.rejects(f.service.ensureUnified(),/Recover a Lightning address/);
 assert.equal(f.bound().length,0);
 assert.equal(f.requests.some(r=>r.init?.method==='POST'&&r.url.endsWith('/lnurl/address')),false);
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
 // Legacy payouts reuse the contracts the HD code created; registerPayouts rejects one that is missing.
 assert.deepEqual(f.watched.map(row=>row.script),[6,7,8,9].map(i=>at(i).script));
 await f.service.check();assert.equal(f.saved()!.next,10);assert.equal(f.bound().length,2);
 for(const row of legacy)assert.ok(hdIdentity.ownsDescriptor(row.descriptor));
 assert.ok(f.state.has(f.key('pool',legacyKey)));
});

test('after a failed first bind, migration keeps scanning and replaces a reserved child the HD service paid',async()=>{
 const f=setup({aliases:[receiver]}),legacy=[{id:'lnurl:legacy',descriptor:at(2).descriptor,address:at(2).address,script:at(2).script}];
 f.state.set(f.key('pool',legacyKey),{v:1,enabled:true,receivers:[{handle:'alice',domain,lightningAddress:receiver.lightningAddress,lnurl:'LNURL',status:'active'}],cursors:{},payouts:legacy});
 f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.check(),/Request failed/);assert.equal(f.bound()[0]!.arkadeAddress,at(3).address);
 f.funded.add(at(3).script);f.funded.add(at(6).script);f.reply(()=>json({ok:true}));await f.service.check();
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(7).address);assert.ok(f.registered.flat().some(row=>row.script===at(6).script));
 const scans=f.scans();await f.service.check();assert.equal(f.scans()-scans,1);
});

test('phrase recovery watches every /2/7 child up to the last funded one and binds above it',async()=>{
 const f=setup({aliases:[receiver]});f.funded.add(at(3).script);f.funded.add(at(120).script);f.funded.add(at(120+RECOVERY_GAP+60).script);
 assert.deepEqual((await f.service.recover()).map(row=>row.handle),['alice']);
 const payouts=await f.service.payouts();
 assert.equal(payouts.length,122);assert.deepEqual(payouts.slice(0,121).map(row=>row.index),Array.from({length:121},(_,i)=>i));
 assert.equal(f.saved()!.next,122);assert.equal(f.bound()[0]!.arkadeAddress,at(121).address);
 const scripts=f.registered.flat().map(row=>row.script);assert.equal(new Set(scripts).size,scripts.length);assert.ok(scripts.includes(at(3).script));
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

test('no shielded address reaches the LNURL server until private receive is switched on',async()=>{
 const f=setup();await f.service.claim();f.tick(ROTATE_AFTER_MS);await f.service.check();
 assert.deepEqual(f.bound().map(b=>b.methods),[undefined,undefined]);
 assert.equal(JSON.stringify(f.requests).includes(SHROL),false);
 assert.deepEqual([f.reads(),(await f.service.privateReceiveState()).on],[0,false]);
});

test('switching private receive on registers the shielded address on every bound alias',async()=>{
 const bob={...receiver,handle:'bob',username:'bob',lightningAddress:`bob@${domain}`},f=setup({aliases:[receiver,bob]});
 await f.service.recover();await f.service.setPrivateReceive(true);
 assert.deepEqual(f.bound().map(b=>b.methods?.length),[undefined,undefined,1,1]);
 assert.deepEqual(f.requests.filter(isBind).slice(-2).map(r=>r.url.split('/').at(-2)),['alice','bob']);
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[shielded],[shielded]]);
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.current())?.paymentMethods],[true,[shielded]]);
});

test('switching it off withdraws the method rather than merely stopping',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);await f.service.setPrivateReceive(false);
 assert.deepEqual(f.bound().at(-1)!.methods,[]);assert.equal((await f.service.privateReceiveState()).on,false);
 assert.deepEqual(f.requests.slice(-2).map(r=>`${r.init?.method??'GET'} ${new URL(r.url).pathname}`),['POST /lnurl/address/alice/arkade','GET /lnurl/address']);
 assert.equal(Object.values(f.saved()!.servers)[0]!.withdraw,undefined);
 f.tick(ROTATE_AFTER_MS);await f.service.check();
 assert.equal(f.bound().at(-1)!.methods,undefined);
});

test('a server that keeps the method after a withdrawal is reported, and the withdrawal stays pending',async()=>{
 const f=setup(),server=()=>Object.values(f.saved()!.servers)[0]!;
 await f.service.claim();await f.service.setPrivateReceive(true);f.keep(false);
 await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual([server().withdraw,(await f.service.privateReceiveState()).on],[true,false]);
 await assert.rejects(f.service.check(),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[],[]]);
 await assert.rejects(f.service.recover(),{message:METHODS_NOT_WITHDRAWN});assert.equal(server().methods,undefined);
 f.keep(true);await f.service.check();
 assert.deepEqual([server().withdraw,(await f.service.privateReceiveState()).on],[undefined,false]);
 await f.service.check();assert.equal(f.bound().at(-1)!.methods,undefined);
 f.forge(entry=>Object.assign(entry,{methods:true,withdraw:true}));
 assert.equal((await f.service.privateReceiveState()).on,false);
 await f.service.check();assert.deepEqual(f.bound().at(-1)!.methods,[]);
});

test('a switch-off that cannot reach the service is retried until the withdrawal lands',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(false),/Request failed/);
 f.reply(()=>json({ok:true}));await createLnurlReceive(f.config).check();
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[],[]]);
 await f.service.check();assert.equal(f.bound().at(-1)!.methods,undefined);
});

test('the flag survives a restart and each rotation re-registers the method',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.tick(ROTATE_AFTER_MS);const restart=createLnurlReceive(f.config);
 assert.equal((await restart.privateReceiveState()).on,true);await restart.check();
 assert.equal(f.bound().filter(b=>Array.isArray(b.methods)&&b.methods.length===1).length,2);
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);
});

test('a server that silently drops the method is reported, not treated as private',async()=>{
 const f=setup();f.keep(false);await f.service.claim();
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[false,true]);
 assert.deepEqual(f.bound().at(-1)!.methods,[shielded]);
});

test('after a refusal the address is not sent again, on a check or a rotation',async()=>{
 const f=setup();f.keep(false);await f.service.claim();
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 const binds=f.bound().length,reads=f.reads(),requests=f.requests.length;
 await f.service.check();f.tick(ROTATE_AFTER_MS);await f.service.check();
 assert.deepEqual([f.bound().slice(binds).map(b=>b.methods),f.reads()],[[undefined,undefined],reads]);
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);
 assert.equal(JSON.stringify(f.requests.slice(requests)).includes(SHROL),false);
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[false,true]);
});

test('a refusal survives a restart, and switching off clears it without a request',async()=>{
 const f=setup();f.keep(false);await f.service.claim();
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 const restart=createLnurlReceive(f.config);
 assert.deepEqual([(await restart.privateReceiveState()).on,(await restart.privateReceiveState()).refused],[false,true]);
 const requests=f.requests.length;await restart.setPrivateReceive(false);
 assert.deepEqual([(await restart.privateReceiveState()).refused,f.requests.length],[false,requests]);
});

test('switching on again after a refusal sends the address once more, and goes live on a service that keeps it',async()=>{
 const f=setup();f.keep(false);await f.service.claim();
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 const binds=f.bound().length;
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.deepEqual(f.bound().slice(binds).map(b=>b.methods),[[shielded]]);
 f.keep(true);await f.service.setPrivateReceive(true);
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused,f.bound().at(-1)!.methods],[true,false,[shielded]]);
});

test('private receive is not reported live until a listing has echoed the method',async()=>{
 const f=setup();await f.service.claim();f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(true),/Request failed/);assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[false,false]);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal((await f.service.privateReceiveState()).on,true);
});

test('a 400 refusal of the method does not stall the identity bind or burn an index',async()=>{
 const f=setup();await f.service.claim();f.reply(body=>body.methods?json({error:'method type is reserved'},400):json({ok:true}));
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.deepEqual(f.bound().slice(-2).map(b=>[b.methods,b.arkadeAddress]),[[[shielded],at(0).address],[undefined,at(0).address]]);
 f.tick(ROTATE_AFTER_MS);await f.service.check();
 assert.deepEqual([f.bound().at(-1)!.arkadeAddress,f.bound().at(-1)!.methods,f.saved()!.next],[at(1).address,undefined,2]);
 assert.equal(Object.values(f.saved()!.servers)[0]!.refused,undefined);assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[false,true]);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal((await f.service.privateReceiveState()).on,false);
 await f.service.setPrivateReceive(true);assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[true,false]);
});

test('an invalid_rails refusal still reports HD mode, not a method failure',async()=>{
 const f=setup();await f.service.claim();f.reply(refusal);
 await assert.rejects(f.service.setPrivateReceive(true),{message:HD_REFUSED});
 assert.equal(f.bound().length,2);assert.equal(Object.values(f.saved()!.servers)[0]!.refused,true);assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused],[false,false]);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal((await f.service.privateReceiveState()).on,true);
});

test('private receive needs an enabled alias and a shielded address, and fails without side effects',async()=>{
 const f=setup();await assert.rejects(f.service.setPrivateReceive(true),/Lightning address/);
 await f.service.setPrivateReceive(false);assert.deepEqual([f.requests.length,f.reads()],[0,0]);
 await f.service.claim();await assert.rejects(createLnurlReceive({...f.config,shieldedAddress:undefined}).setPrivateReceive(true),/shielded address/);
 assert.deepEqual([f.bound().length,(await f.service.privateReceiveState()).on],[1,false]);
});

test('a restored device does not adopt the shielded method its listing shows, and opting in again is explicit',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);f.state.clear();
 const restored=createLnurlReceive(f.config),binds=f.bound().length,reads=f.reads();
 await restored.recover();await restored.check();
 assert.deepEqual([f.bound().slice(binds).map(b=>b.methods),f.reads(),(await restored.privateReceiveState()).on],[[undefined,undefined],reads,false]);
 assert.equal((await restored.privateReceiveState()).listed,'own');
 await restored.setPrivateReceive(true);
 assert.deepEqual([f.bound().at(-1)!.methods,(await restored.privateReceiveState()).on],[[shielded],true]);
 f.forge(entry=>{for(const row of entry.receivers as {paymentMethods?:unknown}[])delete row.paymentMethods;});
 await restored.check();assert.deepEqual((await restored.current())?.paymentMethods,[shielded]);
 await restored.setPrivateReceive(false);
 assert.deepEqual([f.bound().at(-1)!.methods,(await restored.privateReceiveState()).on,(await restored.privateReceiveState()).listed],[[],false,null]);
});

test('switching off after a restore withdraws a method the service still lists, even when no flag survived',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);f.state.clear();
 const restored=createLnurlReceive(f.config);
 await restored.recover();
 assert.deepEqual([(await restored.privateReceiveState()).on,(await restored.current())?.paymentMethods],[false,[shielded]]);
 const reads=f.reads();await restored.setPrivateReceive(false);
 assert.deepEqual(f.requests.slice(-2).map(r=>`${r.init?.method??'GET'} ${new URL(r.url).pathname}`),['POST /lnurl/address/alice/arkade','GET /lnurl/address']);
 assert.deepEqual([f.bound().at(-1)!.methods,(await restored.current())?.paymentMethods,f.reads()],[[],[],reads]);
});

test('claim on a device whose journal lacks the flag does not adopt what the service lists either',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.forge(entry=>{delete entry.methods;delete entry.methodsPending;});
 const device=createLnurlReceive(f.config),binds=f.bound().length,reads=f.reads();
 await device.claim();
 assert.deepEqual([f.bound().slice(binds).map(b=>b.methods),f.reads(),(await device.privateReceiveState()).on],[[undefined],reads,false]);
 assert.equal((await device.privateReceiveState()).listed,'own');
});

test('a listing that names several candidates, ours among them, is never adopted and our address is never sent',async()=>{
 const candidate=(fill:number)=>bech32m.encode('shrol2',bech32m.toWords(new Uint8Array(64).fill(fill)),false);
 const probes=[candidate(9),SHROL,candidate(11)].map((destination,i)=>({...receiver,handle:`probe${i}`,username:`probe${i}`,lightningAddress:`probe${i}@${domain}`,paymentMethods:[{type:'shielded',destination}]}) as typeof receiver);
 const f=setup({aliases:probes});await f.service.recover();await f.service.check();
 assert.deepEqual([f.bound().length,f.bound().every(b=>b.methods===undefined),f.reads()],[6,true,0]);
 assert.equal(JSON.stringify(f.requests).includes(SHROL),false);
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).listed],[false,'foreign']);
 const reads=f.reads();await f.service.setPrivateReceive(false);
 assert.deepEqual([f.bound().slice(-3).map(b=>b.methods),f.reads(),(await f.service.privateReceiveState()).listed],[[[],[],[]],reads,null]);
});

test('after a verified switch-off, the service listing our address again does not turn private receive back on',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);await f.service.setPrivateReceive(false);
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).listed],[false,null]);
 f.relist('alice',[shielded]);const binds=f.bound().length,reads=f.reads();
 await f.service.recover();await f.service.check();
 assert.deepEqual([f.bound().slice(binds).map(b=>b.methods),f.reads(),(await f.service.privateReceiveState()).on],[[undefined,undefined],reads,false]);
 assert.equal((await f.service.privateReceiveState()).listed,'own');
});

for(const [shape,method] of [['no destination',{type:'shielded'}],['an empty destination',{type:'shielded',destination:''}],['a numeric destination',{type:'shielded',destination:42}]] as const)test(`a shielded entry with ${shape} counts as foreign and keeps a withdrawal pending`,async()=>{
 const f=setup({aliases:[{...receiver,paymentMethods:[method]} as typeof receiver]});await f.service.recover();
 assert.deepEqual([f.bound().map(b=>b.methods),(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).listed],[[undefined],false,'foreign']);
 f.keep(false);await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual([f.bound().at(-1)!.methods,Object.values(f.saved()!.servers)[0]!.withdraw,(await f.service.privateReceiveState()).listed],[[],true,'foreign']);
});

test('an empty own address never matches an empty listed destination',async()=>{
 const f=setup({aliases:[{...receiver,paymentMethods:[{type:'shielded'}]} as typeof receiver]});
 const empty=createLnurlReceive({...f.config,shieldedAddress:()=>''});
 await empty.recover();
 assert.equal((await empty.privateReceiveState()).listed,'foreign');
 await assert.rejects(empty.setPrivateReceive(true),/shielded address/);
});

const FOREIGN=bech32m.encode('shrol2',bech32m.toWords(new Uint8Array(64).fill(9)),false);
const listing=(...destinations:string[])=>destinations.map((destination,i)=>({...receiver,handle:`alias${i}`,username:`alias${i}`,lightningAddress:`alias${i}@${domain}`,paymentMethods:[{type:'shielded',destination}]}) as typeof receiver);

test('two aliases that both list our address read as ours',async()=>{
 const f=setup({aliases:listing(SHROL,SHROL)});await f.service.recover();
 assert.equal((await f.service.privateReceiveState()).listed,'own');
});

for(const [order,destinations] of [['first',[SHROL,FOREIGN]],['last',[FOREIGN,SHROL]]] as const)test(`a foreign address on one alias makes the listing foreign with ours ${order}`,async()=>{
 const f=setup({aliases:listing(...destinations)});await f.service.recover();
 assert.equal((await f.service.privateReceiveState()).listed,'foreign');
});

test('the private-receive snapshot answers from the last listing and sends nothing',async()=>{
 const f=setup({aliases:listing(SHROL,SHROL)});await f.service.recover();
 const requests=f.requests.length,saved=JSON.stringify(f.saved());
 f.relist('alias0',[{type:'shielded',destination:FOREIGN}]);
 assert.equal((await f.service.privateReceiveState()).listed,'own');
 assert.deepEqual([f.requests.length,JSON.stringify(f.saved())],[requests,saved]);
});

const state3=async(service:ReturnType<typeof setup>['service'])=>{const s=await service.privateReceiveState();return [s.pending,s.on,s.refused];};

test('a switch-on that cannot reach the service reads as pending, neither live nor refused',async()=>{
 const f=setup();await f.service.claim();f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(true),/Request failed/);
 assert.deepEqual(await state3(f.service),[true,false,false]);
});

test('a switch-on whose bind lands but whose confirming read fails reads as pending, and goes live at the next check',async()=>{
 const f=setup();await f.service.claim();let down=true;
 const svc=createLnurlReceive({...f.config,fetch:(url:string,init?:RequestInit)=>down&&url.endsWith('/lnurl/address')&&!init?.method?Promise.reject(new TypeError('network down')):f.config.fetch(url,init)});
 await assert.rejects(svc.setPrivateReceive(true));
 assert.deepEqual([await state3(svc),f.bound().at(-1)!.methods],[[true,false,false],[shielded]]);
 down=false;await svc.check();
 assert.deepEqual(await state3(svc),[false,true,false]);
});

test('switching off from pending withdraws with [] on every alias and never reads the address',async()=>{
 const bob={...receiver,handle:'bob',username:'bob',lightningAddress:`bob@${domain}`},f=setup({aliases:[receiver,bob]});
 await f.service.recover();f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(true),/Request failed/);
 assert.equal((await f.service.privateReceiveState()).pending,true);
 f.reply(()=>json({ok:true}));const binds=f.bound().length,reads=f.reads();
 await f.service.setPrivateReceive(false);
 assert.deepEqual([f.bound().slice(binds).map(b=>b.methods),f.reads()],[[[],[]],reads]);
 assert.deepEqual([await state3(f.service),Object.values(f.saved()!.servers)[0]!.withdraw],[[false,false,false],undefined]);
});

test('live and refused both read pending false',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 assert.deepEqual(await state3(f.service),[false,true,false]);
 const g=setup();g.keep(false);await g.service.claim();await assert.rejects(g.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.deepEqual(await state3(g.service),[false,false,true]);
});

test('an off device learns at its next check what another device listed, and sends nothing new',async()=>{
 const f=setup();await f.service.claim();
 const requests=f.requests.length,reads=f.reads();
 f.relist('alice',[shielded]);await f.service.check();
 assert.deepEqual([f.requests.slice(requests).map(r=>r.init?.method??'GET'),f.reads()],[['POST','GET'],reads]);
 assert.equal((await f.service.privateReceiveState()).listed,'own');
 f.relist('alice',[{type:'shielded',destination:FOREIGN}]);await f.service.check();
 assert.equal((await f.service.privateReceiveState()).listed,'foreign');
 const sent=f.requests.slice(requests);
 assert.deepEqual([sent.filter(isBind).map(r=>'methods' in JSON.parse(String(r.init?.body))),JSON.stringify(sent).includes(SHROL),(await f.service.privateReceiveState()).on],[[false,false],false,false]);
});

test('switching off from the refused state while a listing remains still withdraws it',async()=>{
 const bob={...receiver,handle:'bob',username:'bob',lightningAddress:`bob@${domain}`},f=setup({aliases:[receiver,bob]});
 await f.service.recover();await f.service.setPrivateReceive(true);
 f.relist('bob',[]);f.keep(false);
 await assert.rejects(f.service.check(),{message:METHODS_REFUSED});
 assert.deepEqual([(await f.service.privateReceiveState()).on,(await f.service.privateReceiveState()).refused,(await f.service.privateReceiveState()).listed],[false,true,'own']);
 f.keep(true);await f.service.setPrivateReceive(false);
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[],[]]);
 assert.deepEqual([(await f.service.privateReceiveState()).refused,(await f.service.privateReceiveState()).listed],[false,null]);
});

test('a refusal that leaves the address listed on one alias withdraws it at the next check',async()=>{
 const bob={...receiver,handle:'bob',username:'bob',lightningAddress:`bob@${domain}`},f=setup({aliases:[receiver,bob]});
 await f.service.recover();await f.service.setPrivateReceive(true);
 f.relist('bob',[]);f.keep(false);
 await assert.rejects(f.service.check(),{message:METHODS_REFUSED});
 const refused=await f.service.privateReceiveState();
 assert.deepEqual([refused.refused,refused.withdrawing,refused.listed],[true,true,'own']);
 f.keep(true);const reads=f.reads(),requests=f.requests.length;await f.service.check();
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[],[]]);
 const done=await f.service.privateReceiveState();
 assert.deepEqual([done.refused,done.withdrawing,done.listed,f.reads()],[true,false,null,reads]);
 assert.equal(JSON.stringify(f.requests.slice(requests)).includes(SHROL),false);
});

const flaky=(f:ReturnType<typeof setup>,down:()=>boolean)=>createLnurlReceive({...f.config,fetch:(url:string,init?:RequestInit)=>down()&&url.endsWith('/lnurl/address')&&!init?.method?Promise.reject(new TypeError('network down')):f.config.fetch(url,init)});
const rejectMethods=(f:ReturnType<typeof setup>)=>f.reply(body=>body.methods?.length?json({error:'method type is reserved'},400):json({ok:true}));

test('a 400 refusal after an unconfirmed switch-on withdraws what the earlier bind left listed',async()=>{
 const f=setup();await f.service.claim();let down=true;const svc=flaky(f,()=>down);
 await assert.rejects(svc.setPrivateReceive(true));
 down=false;rejectMethods(f);
 await assert.rejects(svc.check(),{message:METHODS_REFUSED});
 const refused=await svc.privateReceiveState();
 assert.deepEqual([refused.refused,refused.withdrawing,refused.listed],[true,true,'own']);
 const reads=f.reads();await svc.check();
 const done=await svc.privateReceiveState();
 assert.deepEqual([f.bound().at(-1)!.methods,done.withdrawing,done.listed,f.reads()],[[],false,null,reads]);
});

test('a 400 refusal whose listing cannot be read still owes the withdrawal',async()=>{
 const f=setup();await f.service.claim();let down=true;const svc=flaky(f,()=>down);rejectMethods(f);
 await assert.rejects(svc.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.equal((await svc.privateReceiveState()).withdrawing,true);
 down=false;await svc.check();
 assert.deepEqual([f.bound().at(-1)!.methods,(await svc.privateReceiveState()).withdrawing],[[],false]);
});

test('a service that rejects even methods: [] still gets the identity bind, and the withdrawal stays owed',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.reply(body=>body.methods?json({error:'methods are not supported'},400):json({ok:true}));
 const before=f.bound().length;
 await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual([f.bound().slice(before).map(b=>b.methods),(await f.service.privateReceiveState()).withdrawing],[[[],undefined],true]);
});

const listings=(f:{requests:{url:string;init?:RequestInit}[]})=>f.requests.filter(r=>r.url.endsWith('/lnurl/address')&&(r.init?.method??'GET')==='GET').length;

test('claim and recover each read the listing once',async()=>{
 const f=setup(),g=setup({aliases:[receiver]});
 await f.service.claim();await g.service.recover();
 assert.deepEqual([listings(f),listings(g)],[1,1]);
});

test('a claim whose bind landed resolves even when a later listing read would fail',async()=>{
 const f=setup();let gets=0;
 const svc=createLnurlReceive({...f.config,fetch:(url:string,init?:RequestInit)=>url.endsWith('/lnurl/address')&&!init?.method&&++gets>1?Promise.reject(new TypeError('network down')):f.config.fetch(url,init)});
 assert.equal((await svc.claim()).lightningAddress,receiver.lightningAddress);
 assert.deepEqual([f.bound().length,(await svc.current())?.handle],[1,'alice']);
});

test('a check in the off state reads the listing once, and not at all without an active alias',async()=>{
 const f=setup();await f.service.claim();
 const before=listings(f);await f.service.check();
 assert.equal(listings(f)-before,1);
 f.forge(entry=>{for(const row of entry.receivers as {status:string}[])row.status='inactive';});
 const idle=listings(f);await f.service.check();
 assert.equal(listings(f),idle);
});

test('a check that settles a pending withdrawal reads the listing once',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);f.keep(false);
 await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 f.keep(true);const before=listings(f);await f.service.check();
 assert.deepEqual([listings(f)-before,Object.values(f.saved()!.servers)[0]!.withdraw],[1,undefined]);
});

test('a check while on reads the listing once',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 const before=listings(f);await f.service.check();
 assert.equal(listings(f)-before,1);
});

test('after a switch-off whose bind fails, the snapshot reads withdrawing beside the listing, and a reload keeps it',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(false),/Request failed/);
 const held={on:false,pending:false,refused:false,withdrawing:true,listed:'own'};
 assert.deepEqual(await f.service.privateReceiveState(),held);
 assert.deepEqual(await createLnurlReceive(f.config).privateReceiveState(),held);
});

test('the snapshot reads the address only when something is listed',async()=>{
 const f=setup();await f.service.claim();
 await f.service.privateReceiveState();assert.equal(f.reads(),0);
 f.relist('alice',[shielded]);await f.service.check();
 assert.deepEqual([(await f.service.privateReceiveState()).listed,f.reads()],['own',1]);
});

test('a recover that rejects with a method error has already saved the alias',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.forge(entry=>{entry.receivers=[];});f.relist('alice',[]);f.keep(false);
 assert.equal(await f.service.current(),undefined);
 await assert.rejects(f.service.recover(),{message:METHODS_REFUSED});
 assert.equal((await f.service.current())?.handle,'alice');
});
