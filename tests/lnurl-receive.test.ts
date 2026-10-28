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
const domain='lnurl.example',baseUrl=`https://${domain}`,receiver={handle:'alice',username:'alice',lightningAddress:`alice@${domain}`,domain,status:'active',lnurl:'LNURL',nameless:false,sessionLnurl:null};
const legacyKey=`lnurl-hd-v1:${JSON.stringify([baseUrl,domain])}`;
const SHROL=bech32m.encode('shrol2',bech32m.toWords(new Uint8Array(64).fill(7)),false),shielded={type:'shielded',destination:SHROL};
interface Bind {arkadeAddress:string;claimPublicKey:string;domain:string;methods?:{type:string;destination:string}[]}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const isBind=(r:{url:string;init?:RequestInit})=>r.url.endsWith('/arkade')&&r.init?.method==='POST';

function setup({aliases=[] as typeof receiver[],exitDelay=2048n}={}){
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
  if(url.endsWith('/lnurl/address'))return init?.method==='POST'?(aliases.push(receiver),json(receiver)):json(aliases.map(row=>kept.has(row.handle)?{...row,paymentMethods:kept.get(row.handle)}:row));
  if(url.endsWith('/arkade')){
   const body=JSON.parse(String(init?.body)) as Bind,answer=await bindReply(body);
   if(answer.ok&&keeps&&body.methods)kept.set(decodeURIComponent(url.split('/').at(-2)!),body.methods);
   return answer;
  }
  return json({error:'not found'},404);
 };
 const config={identity,companion,journal,owner:'owner',pool:'pool',baseUrl,fetch,now:()=>clock,shieldedAddress:()=>{reads++;return SHROL;},onPayouts:async(rows:LnurlPayout[])=>{registered.push(rows);}};
 const saved=()=>state.get(key('lnurl-receive','state-v1')) as {next:number;payouts:{script:string;index:number;id:string;claimPublicKey:string}[];servers:Record<string,{current?:string;boundAt?:number;refused?:true;methods?:true;methodsRefused?:true;withdraw?:true}>}|undefined;
 const bound=()=>requests.filter(isBind).map(r=>JSON.parse(String(r.init?.body)) as Bind);
 return {service:createLnurlReceive(config),config,state,requests,watched,registered,funded,listeners,saved,bound,aliases,key,
  signed:()=>signed,scans:()=>scans,reads:()=>reads,keep:(value:boolean)=>{keeps=value;},forge:(change:(entry:Record<string,unknown>)=>void)=>{const stored=structuredClone(state.get(key('lnurl-receive','state-v1'))) as {servers:Record<string,Record<string,unknown>>};Object.values(stored.servers).forEach(change);state.set(key('lnurl-receive','state-v1'),stored);},tick:(ms:number)=>{clock+=ms;},saveFailure:(value:boolean)=>{saveFailure=value;},reply:(fn:typeof bindReply)=>{bindReply=fn;}};
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
 assert.deepEqual([f.reads(),await f.service.privateReceive()],[0,false]);
});

test('switching private receive on registers the shielded address on every bound alias',async()=>{
 const bob={...receiver,handle:'bob',username:'bob',lightningAddress:`bob@${domain}`},f=setup({aliases:[receiver,bob]});
 await f.service.recover();await f.service.setPrivateReceive(true);
 assert.deepEqual(f.bound().map(b=>b.methods?.length),[undefined,undefined,1,1]);
 assert.deepEqual(f.requests.filter(isBind).slice(-2).map(r=>r.url.split('/').at(-2)),['alice','bob']);
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[shielded],[shielded]]);
 assert.deepEqual([await f.service.privateReceive(),(await f.service.current())?.paymentMethods],[true,[shielded]]);
});

test('switching it off withdraws the method rather than merely stopping',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);await f.service.setPrivateReceive(false);
 assert.deepEqual(f.bound().at(-1)!.methods,[]);assert.equal(await f.service.privateReceive(),false);
 assert.deepEqual(f.requests.slice(-2).map(r=>`${r.init?.method??'GET'} ${new URL(r.url).pathname}`),['POST /lnurl/address/alice/arkade','GET /lnurl/address']);
 assert.equal(Object.values(f.saved()!.servers)[0]!.withdraw,undefined);
 f.tick(ROTATE_AFTER_MS);await f.service.check();
 assert.equal(f.bound().at(-1)!.methods,undefined);
});

test('a server that keeps the method after a withdrawal is reported, and the withdrawal stays pending',async()=>{
 const f=setup(),server=()=>Object.values(f.saved()!.servers)[0]!;
 await f.service.claim();await f.service.setPrivateReceive(true);f.keep(false);
 await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual([server().withdraw,await f.service.privateReceive()],[true,false]);
 await assert.rejects(f.service.check(),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual(f.bound().slice(-2).map(b=>b.methods),[[],[]]);
 await assert.rejects(f.service.recover(),{message:METHODS_NOT_WITHDRAWN});assert.equal(server().methods,undefined);
 f.keep(true);await f.service.check();
 assert.deepEqual([server().withdraw,await f.service.privateReceive()],[undefined,false]);
 await f.service.check();assert.equal(f.bound().at(-1)!.methods,undefined);
 f.forge(entry=>Object.assign(entry,{methods:true,withdraw:true}));
 assert.equal(await f.service.privateReceive(),false);
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
 assert.equal(await restart.privateReceive(),true);await restart.check();
 assert.equal(f.bound().filter(b=>Array.isArray(b.methods)&&b.methods.length===1).length,2);
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);
});

test('a server that silently drops the method is reported, not treated as private',async()=>{
 const f=setup();f.keep(false);await f.service.claim();
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.equal(await f.service.privateReceive(),false);
 await assert.rejects(f.service.check(),{message:METHODS_REFUSED});
 assert.deepEqual(f.bound().at(-1)!.methods,[shielded]);
 f.keep(true);await f.service.check();assert.equal(await f.service.privateReceive(),true);
});

test('private receive is not reported live until a listing has echoed the method',async()=>{
 const f=setup();await f.service.claim();f.reply(()=>{throw new TypeError('connection closed');});
 await assert.rejects(f.service.setPrivateReceive(true),/Request failed/);assert.equal(await f.service.privateReceive(),false);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal(await f.service.privateReceive(),true);
});

test('a 400 refusal of the method does not stall the identity bind or burn an index',async()=>{
 const f=setup();await f.service.claim();f.reply(body=>body.methods?json({error:'method type is reserved'},400):json({ok:true}));
 await assert.rejects(f.service.setPrivateReceive(true),{message:METHODS_REFUSED});
 assert.deepEqual(f.bound().slice(-2).map(b=>[b.methods,b.arkadeAddress]),[[[shielded],at(0).address],[undefined,at(0).address]]);
 f.tick(ROTATE_AFTER_MS);await assert.rejects(f.service.check(),{message:METHODS_REFUSED});
 assert.equal(f.bound().at(-1)!.arkadeAddress,at(1).address);assert.equal(f.saved()!.next,2);
 assert.equal(Object.values(f.saved()!.servers)[0]!.refused,undefined);assert.equal(await f.service.privateReceive(),false);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal(await f.service.privateReceive(),true);
});

test('an invalid_rails refusal still reports HD mode, not a method failure',async()=>{
 const f=setup();await f.service.claim();f.reply(refusal);
 await assert.rejects(f.service.setPrivateReceive(true),{message:HD_REFUSED});
 assert.equal(f.bound().length,2);assert.equal(Object.values(f.saved()!.servers)[0]!.refused,true);assert.equal(await f.service.privateReceive(),false);
 f.reply(()=>json({ok:true}));await f.service.check();assert.equal(await f.service.privateReceive(),true);
});

test('private receive needs an enabled alias and a shielded address, and fails without side effects',async()=>{
 const f=setup();await assert.rejects(f.service.setPrivateReceive(true),/Lightning address/);
 await f.service.setPrivateReceive(false);assert.deepEqual([f.requests.length,f.reads()],[0,0]);
 await f.service.claim();await assert.rejects(createLnurlReceive({...f.config,shieldedAddress:undefined}).setPrivateReceive(true),/shielded address/);
 assert.deepEqual([f.bound().length,await f.service.privateReceive()],[1,false]);
});

test('a restored device adopts the shielded method the service already advertises, and can withdraw it',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);f.state.clear();
 const restored=createLnurlReceive(f.config);
 assert.equal(await restored.privateReceive(),false);
 await restored.recover();
 assert.deepEqual([await restored.privateReceive(),f.bound().at(-1)!.methods],[true,[shielded]]);
 await restored.check();assert.equal(await restored.privateReceive(),true);
 f.forge(entry=>{for(const row of entry.receivers as {paymentMethods?:unknown}[])delete row.paymentMethods;});
 await restored.check();assert.deepEqual((await restored.current())?.paymentMethods,[shielded]);
 await restored.setPrivateReceive(false);
 assert.deepEqual([f.bound().at(-1)!.methods,await restored.privateReceive(),(await restored.current())?.paymentMethods],[[],false,[]]);
});

test('switching off after a restore withdraws a method the service still lists, even when no flag survived',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);f.state.clear();
 const restored=createLnurlReceive({...f.config,shieldedAddress:undefined});
 await restored.recover();
 assert.deepEqual([await restored.privateReceive(),(await restored.current())?.paymentMethods],[false,[shielded]]);
 await restored.setPrivateReceive(false);
 assert.deepEqual(f.requests.slice(-2).map(r=>`${r.init?.method??'GET'} ${new URL(r.url).pathname}`),['POST /lnurl/address/alice/arkade','GET /lnurl/address']);
 assert.deepEqual([f.bound().at(-1)!.methods,(await restored.current())?.paymentMethods],[[],[]]);
});

test('claim on a device whose journal lacks the flag adopts what the service advertises',async()=>{
 const f=setup();await f.service.claim();await f.service.setPrivateReceive(true);
 f.forge(entry=>{delete entry.methods;delete entry.methodsRefused;});
 const device=createLnurlReceive(f.config);
 assert.equal(await device.privateReceive(),false);
 await device.claim();assert.equal(await device.privateReceive(),true);
});

test('a listed shielded entry with our own address is adopted',async()=>{
 const f=setup({aliases:[{...receiver,paymentMethods:[shielded]} as typeof receiver]});
 await f.service.recover();
 assert.deepEqual([await f.service.privateReceive(),f.bound().at(-1)!.methods],[true,[shielded]]);
 assert.equal(await f.service.foreignShielded(),false);
});

test('a shielded entry naming a different destination is never adopted, no bind carries our address, and switching off still withdraws it',async()=>{
 const other=bech32m.encode('shrol2',bech32m.toWords(new Uint8Array(64).fill(9)),false);
 const f=setup({aliases:[{...receiver,paymentMethods:[{type:'shielded',destination:other}]} as typeof receiver]});
 await f.service.recover();
 assert.deepEqual(f.bound().map(b=>b.methods),[undefined]);assert.equal(JSON.stringify(f.requests).includes(SHROL),false);
 assert.deepEqual([await f.service.privateReceive(),await f.service.foreignShielded()],[false,true]);
 await f.service.setPrivateReceive(false);
 assert.deepEqual([f.bound().at(-1)!.methods,await f.service.foreignShielded(),(await f.service.current())?.paymentMethods],[[],false,[]]);
});

test('a shielded entry with a malformed or empty destination is never adopted, yet still counts as advertised',async()=>{
 const odd=[{type:'shielded'},{type:'shielded',destination:''},{type:'shielded',destination:42}].map((method,i)=>({...receiver,handle:`odd${i}`,username:`odd${i}`,lightningAddress:`odd${i}@${domain}`,paymentMethods:[method]}) as typeof receiver);
 const f=setup({aliases:odd});await f.service.recover();
 assert.deepEqual(f.bound().map(b=>b.methods),[undefined,undefined,undefined]);
 assert.deepEqual([await f.service.privateReceive(),await f.service.foreignShielded()],[false,true]);
 f.keep(false);await assert.rejects(f.service.setPrivateReceive(false),{message:METHODS_NOT_WITHDRAWN});
 assert.deepEqual([f.bound().slice(-3).map(b=>b.methods),Object.values(f.saved()!.servers)[0]!.withdraw],[[[],[],[]],true]);
});
