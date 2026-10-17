import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indexedDB} from 'fake-indexeddb';
import {ArkAddress,DefaultVtxo,MnemonicIdentity,SingleKey,Transaction,provisionClaimSecret,provisionRefundKey,sequenceToTimelock,timelockToSequence,type Wallet} from '@arkade-os/sdk';
import {InMemoryAssetSwapRepository,type Quote,type SwapClient,type SwapClientConfig,type SwapRecord,type SwapUpdate} from '@arkade-os/swap';
import {schnorr} from '@noble/curves/secp256k1.js';
import {hex} from '@scure/base';
import {recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import {IndexedDbLightningRepository,InMemoryLightningRepository} from '../src/shielded/lightning-repository.ts';
import {artifactWallet,createPrivateLightning,materializeLightningArtifact} from '../src/shielded/lightning-wallet.ts';
import type {ShieldedWallet} from '../src/shielded/wallet.ts';
import {submitLightningSpend,type LightningSpendRecord} from '../src/shielded/lightning-spend.ts';

globalThis.indexedDB=indexedDB;
const owner='owner',pool='pool',secret='11'.repeat(32);
const root=MnemonicIdentity.fromMnemonic(recoveryPhraseOf(secret),{isMainnet:false});
const server=await SingleKey.fromPrivateKey(new Uint8Array(32).fill(3)).xOnlyPublicKey();
const script=new DefaultVtxo.Script({pubKey:await root.xOnlyPublicKey(),serverPubKey:server,csvTimelock:{type:'seconds',value:1024n}});
function companion(){return {identity:root,network:{hrp:'tark'},arkServerPublicKey:server,offchainTapscript:script,
 getBalance:async()=>{throw new Error('ordinary balance used');},send:async()=>{throw new Error('ordinary selection used');}} as unknown as Wallet;}

test('IndexedDB allocates distinct permanent artifact indices across connections and reload, including unpaid gaps',async()=>{
 const name=`ln-test-${crypto.randomUUID()}`,a=new IndexedDbLightningRepository(name),b=new IndexedDbLightningRepository(name);
 const allocated=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).allocateArtifact(owner,pool,'receive')));
 assert.deepEqual(allocated.map(a=>a.index).sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i));
 await a[Symbol.asyncDispose]();await b[Symbol.asyncDispose]();
 const reloaded=new IndexedDbLightningRepository(name);
 assert.equal((await reloaded.allocateArtifact(owner,'different-pool','send')).index,12);
 assert.equal((await reloaded.allocateArtifact(owner,pool,'send')).index,13);
 assert.equal((await reloaded.artifacts(owner,pool)).length,13);
 await reloaded[Symbol.asyncDispose]();
});

test('the in-memory HD counter stays global when the wallet changes pools',async()=>{
 const journal=new InMemoryLightningRepository();
 assert.equal((await journal.allocateArtifact(owner,'A','send')).index,0);
 assert.equal((await journal.allocateArtifact(owner,'B','receive')).index,1);
 assert.equal((await journal.allocateArtifact(owner,'A','send')).index,2);
});

function spend(id:string,poolName=pool,nullifier='1',hash='03'.repeat(32)):LightningSpendRecord{
 const address=script.address('tark',server).encode();
 return {v:1,id,owner,pool:poolName,reference:hash,kind:'fund',paymentHash:hash,destination:address,amount:'1000',nullifiers:[nullifier],state:'prepared',
  body:{id:crypto.randomUUID().replaceAll('-',''),slot:{root:'0',nullifiers:[nullifier],commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:1},publics:['0','0','1000','0','0'],proof:{pi_a:[],pi_b:[],pi_c:[]},ciphertext:'00',program:hex.encode(ArkAddress.decode(address).pkScript.subarray(2))}};
}
test('IndexedDB atomically rejects invoice and nullifier reuse, including a different pool and after reload',async()=>{
 const name=`ln-spends-${crypto.randomUUID()}`,a=new IndexedDbLightningRepository(name),b=new IndexedDbLightningRepository(name),first=spend('first');
 const results=await Promise.allSettled([a.create(first),b.create(spend('second','another-pool','2'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const stored=results[0]!.status==='fulfilled'?first:spend('second','another-pool','2');
 const store=stored.id==='first'?a:b;
 await store.finish(owner,stored.pool,stored.id,{state:'included',txid:'ab'.repeat(32)});
 await assert.rejects(a.create(spend('third','third-pool','3')),/already reserved or paid/);
 if(stored.id==='first')await assert.rejects(a.create(spend('nullifier',pool,'1','04'.repeat(32))),/already reserved/);
 await a[Symbol.asyncDispose]();await b[Symbol.asyncDispose]();
 const reloaded=new IndexedDbLightningRepository(name);
 await assert.rejects(reloaded.create(spend('reloaded','fourth-pool','4')),/already reserved or paid/);
 await reloaded[Symbol.asyncDispose]();
});

test('create-if-absent returns the original durable body when the same logical artifact races',async()=>{
 const name=`ln-idempotent-${crypto.randomUUID()}`,a=new IndexedDbLightningRepository(name),b=new IndexedDbLightningRepository(name);
 const first=spend('same'),second=spend('same',pool,'2');
 const records=await Promise.all([a.create(first),b.create(second)]);
 assert.deepEqual(records[0],records[1]);assert.equal((await a.list(owner,pool)).length,1);
 await a[Symbol.asyncDispose]();await b[Symbol.asyncDispose]();
});

function serviceFixture(){
 const contracts:any[]=[],receivers=new Set<(event:any)=>void>(),funded:any[]=[],shielded:any[]=[],provisioned:string[]=[],starts:string[]=[],closed:string[]=[],live=new Set<string>(),configs:SwapClientConfig[]=[];
 const manager={createContract:async(params:any)=>{const old=contracts.find(c=>c.script===params.script);if(old)return old;const contract={...params,createdAt:Date.now()};contracts.push(contract);return contract;},getContracts:async()=>contracts,setContractWatchState:async()=>{},onContractEvent:(fn:any)=>{receivers.add(fn);return()=>receivers.delete(fn);}};
 const base=Object.assign(companion(),{getContractManager:async()=>manager,getVtxos:async()=>[]});
 const ordinaryAddress=script.address('tark',server).encode();
 const wallet={pool:{status:{pool:{token:pool}}},self:{owner:owner},inFlight:new Set(),shieldedNotes:()=>[{amount:5000n,nullifier:1n}],canWithdraw:(n:bigint)=>n<=5000n,restoreLightningSpends:async()=>{},
  getAddress:async()=>ordinaryAddress,fundLightning:async(...args:any[])=>{funded.push(args);return 'ab'.repeat(32);},shieldLightning:async(...args:any[])=>{shielded.push(args);return {settled:async()=>{}};}} as unknown as ShieldedWallet;
 const repositories=new Map<string,InMemoryAssetSwapRepository>();
 const repositoryFor=(name:string)=>{let repo=repositories.get(name);if(!repo){repo=new InMemoryAssetSwapRepository();repositories.set(name,repo);}return repo;};
 const acquireSession=async(name:string)=>{if(live.has(name))throw new Error('another tab');live.add(name);return async()=>{live.delete(name);};};
 let sequence=0,throwAfterPersist=false,sendOverride:Record<string,unknown>|undefined,terminalOnAccept=false;
 const clientFactory=(config:SwapClientConfig)=>{
  configs.push(config);
  const id=`client-${sequence++}`,listeners=new Set<(u:SwapUpdate)=>void>(),store=config.repository!;
  const resolution=(input:any)=>({give:{corridor:input.via?'lightning':'arkade'},take:{corridor:input.via?'arkade':'lightning'},eligible:1,amount:{value:input.amount??1000n}});
  const getRecords=async()=>{const page=await store.getSwapRecordsPage({limit:100});return page.items;};
  const client={ready:Promise.resolve(),start:async()=>{starts.push(id);},stop:async()=>{},markets:async()=>[],resolve:async(input:any)=>resolution(input),
   quote:async(input:any)=>{
    const receive=!!input.via,view=config.wallet,key=receive?await provisionClaimSecret(view):await provisionRefundKey(view);
    provisioned.push(hex.encode(key.pubkey));
    const giveAsset=receive?'bolt11:mutinynet/slip44:0':'arkade:mutinynet/slip44:0',takeAsset=receive?'arkade:mutinynet/slip44:0':'bolt11:mutinynet/slip44:0';
    return {id:`quote-${sequence++}`,route:{give:{corridor:receive?'lightning':'arkade',asset:giveAsset,instrument:{kind:'wallet'}},take:{corridor:receive?'arkade':'lightning',asset:takeAsset,instrument:{kind:'wallet'}}},give:{asset:giveAsset,amount:1003n},take:{asset:takeAsset,amount:1000n},fee:{asset:giveAsset,amount:3n},lock:{hash:'01'.repeat(32)},expiresAt:Math.floor(Date.now()/1000)+600,market:{kind:'card',key:'test'},...(receive?{artifact:{kind:'invoice',bolt11:'test-invoice'}}:{})} as unknown as Quote;
   },accept:async(q:Quote)=>{
    const address=await config.wallet.getAddress(),lockupPkScript=hex.encode(script.pkScript),lockupAddress=ordinaryAddress;
    const record={...q,family:'rfq',kind:q.route.give.corridor==='arkade'?'lightning_send':'lightning_receive',state:'created',rfqId:'rfq',lockupAddress,lockupPkScript,profile:{},give:{...q.give,amount:String(q.give.amount)},take:{...q.take,amount:String(q.take.amount)},fee:{...q.fee,amount:String(q.fee.amount)},createdAt:1,updatedAt:1} as unknown as SwapRecord;
    await store.saveSwapRecord(record);
    if(throwAfterPersist){throwAfterPersist=false;throw new Error('lost acceptance response');}
    if(q.route.give.corridor==='arkade')await config.wallet.send({address:lockupAddress,amount:1003,...sendOverride});
    const swap={...q,id:`rfq:${q.id}`,family:'rfq',outcome:terminalOnAccept?'paid':'open',createdAt:1,updatedAt:1};
    if(terminalOnAccept)for(const listener of listeners)listener({swap,outcome:'paid',detail:{family:'rfq',state:'settled'}} as unknown as SwapUpdate);
    return swap;
   },onUpdate:(fn:(u:SwapUpdate)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},swaps:async()=>getRecords(),
   [Symbol.asyncDispose]:async()=>{closed.push(id);},
  } as unknown as SwapClient;
  return client;
 };
 return {base,wallet,repositoryFor,acquireSession,clientFactory,funded,shielded,provisioned,starts,closed,live,repositories,contracts,receivers,configs,
  failAccept(){throwAfterPersist=true;},overrideSend(params:Record<string,unknown>){sendOverride=params;},terminalOnAccept(){terminalOnAccept=true;}};
}

const flushTasks=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
function shieldingRecord(id:string,coin:{txid:string;vout:number;value:number;script:string}):LightningSpendRecord{
 const record=spend(id),reference=`${coin.txid}:${coin.vout}`,savedCoin={txid:coin.txid,vout:coin.vout,value:coin.value,tapTree:'00',leaf:'00'};
 delete record.paymentHash;delete record.body.program;
 return {...record,kind:'shield',reference,destination:coin.script,amount:String(coin.value),coin:savedCoin,
  body:{...record.body,publics:['0',String(coin.value),'0','0','0'],coin:{txid:coin.txid,vout:coin.vout,tapTree:'00',leaf:'00'}}};
}

test('a conclusively dropped payout shielding attempt retries under a new id with the same outpoint reference',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],attemptIds:string[]=[],references:string[]=[];
 const options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:(error:Error)=>errors.push(error)};
 const service=await createPrivateLightning(options);
 try{
  await service.receive({via:'lightning',amount:1000n});const payout=(await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!;
  const coin={txid:'ab'.repeat(32),vout:0,value:1000,script:payout.script};f.base.getVtxos=async()=>[coin] as never;
  f.wallet.shieldLightning=async(_coin,_signer,store,request)=>{
   assert.ok([...f.live].some(name=>name.endsWith(`-shield-${coin.txid}:0`)));
   const old=await store.get(owner,pool,request.id);
   if(old)return {settled:async()=>{if(old.state==='dropped')throw new Error('previous attempt dropped');}} as never;
   attemptIds.push(request.id);references.push(request.reference);
   await store.create(shieldingRecord(request.id,coin));await store.finish(owner,pool,request.id,attemptIds.length===1?{state:'dropped',reason:'pool rejected'}:{state:'included',txid:'cd'.repeat(32)});
   return {settled:async()=>{if(attemptIds.length===1)throw new Error('pool rejected');}} as never;
  };
  await service.registerPayouts([payout]);await flushTasks();assert.equal(errors.length,1);
  await service.registerPayouts([payout]);await flushTasks();
  assert.equal(attemptIds.length,2);assert.notEqual(attemptIds[0],attemptIds[1]);assert.deepEqual(references,[`${coin.txid}:0`,`${coin.txid}:0`]);
  assert.deepEqual((await journal.list(owner,pool)).map(record=>record.state),['dropped','included']);
 }finally{await service[Symbol.asyncDispose]();}
});

for(const state of ['prepared','included'] as const)test(`reload reuses the original ${state} shielding id and durable body without another POST`,async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false};
 const first=await createPrivateLightning(options);await first.receive({via:'lightning',amount:1000n});await first[Symbol.asyncDispose]();
 const payout=(await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!,coin={txid:'ab'.repeat(32),vout:0,value:1000,script:payout.script},id=`lightning-shield-${coin.txid}:0${state==='prepared'?'-1':''}`;
 const saved=shieldingRecord(id,coin);await journal.create(saved);if(state==='included')await journal.finish(owner,pool,id,{state,txid:'cd'.repeat(32)});
 let calls=0,posts=0;f.base.getVtxos=async()=>[coin] as never;
 f.wallet.shieldLightning=async(_coin,_signer,store,request)=>{calls++;assert.equal(request.id,id);assert.equal(request.reference,`${coin.txid}:0`);const existing=await store.get(owner,pool,id);if(!existing)posts++;assert.deepEqual(existing!.body,saved.body);return {settled:async()=>{if(state==='prepared')throw new Error('ambiguous pool reply');}} as never;};
 const restored=await createPrivateLightning(options);
 try{await flushTasks();assert.equal(calls,1);assert.equal(posts,0);assert.equal((await journal.list(owner,pool)).length,1);}finally{await restored[Symbol.asyncDispose]();}
});

test('startup ensures every artifact contract before one combined payout scan and reconstructs a missing payout journal',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),artifactOwner=hex.encode(await root.xOnlyPublicKey());
 for(let i=0;i<3;i++){const artifact=await materializeLightningArtifact(f.base,await journal.allocateArtifact(artifactOwner,pool,'receive'));await journal.updateArtifact(artifactOwner,pool,artifact);}
 let scans=0;f.base.getVtxos=async()=>{scans++;assert.equal(f.contracts.length,3);return [];};
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{assert.equal(scans,1);assert.equal((await journal.payouts(artifactOwner,pool)).length,3);}finally{await service[Symbol.asyncDispose]();}
});

test('startup refuses an artifact with a descriptor but incomplete payout settings',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),artifactOwner=hex.encode(await root.xOnlyPublicKey()),artifact=await journal.allocateArtifact(artifactOwner,pool,'receive');
 await journal.updateArtifact(artifactOwner,pool,{...artifact,descriptor:root.descriptor.replace('*','0')});
 await assert.rejects(createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false}),/Incomplete saved Lightning artifact/);
});

test('private Lightning funds only the verified full HTLC from the pool and persists distinct unpaid receive artifacts',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  const q=await service.quote({to:'invoice'});await service.accept(q);
  assert.equal(f.funded.length,1);assert.deepEqual(f.funded[0]!.slice(1,4),['01'.repeat(32),script.address('tark',server).encode(),1003n]);
  assert.equal(f.funded[0]![6],q.expiresAt);
  const [a,b]=await Promise.all([service.receive({via:'lightning',amount:1000n}),service.receive({via:'lightning',amount:1000n})]);
  assert.notEqual(a.id,b.id);assert.equal(new Set(f.provisioned).size,3);
  assert.equal(f.shielded.length,0);assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,3);
 }finally{await service[Symbol.asyncDispose]();}
 assert.equal(f.live.size,0);
});

test('acceptance ambiguity reconstructs the same durable artifact and resumes it on reload',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false};
 const service=await createPrivateLightning(options),q=await service.quote({to:'invoice'});f.failAccept();
 await assert.rejects(service.accept(q),/lost acceptance response/);
 assert.equal(f.funded.length,0);assert.equal(f.starts.length,1);
 await service[Symbol.asyncDispose]();
 const restored=await createPrivateLightning(options);
 try{assert.equal(f.starts.length,2);assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,1);}finally{await restored[Symbol.asyncDispose]();}
});

async function interruptedFunding(){
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false};
 const service=await createPrivateLightning(options),q=await service.quote({to:'invoice'});f.failAccept();await assert.rejects(service.accept(q),/lost acceptance response/);await service[Symbol.asyncDispose]();
 const record=spend('lightning-fund-0',pool,'1','01'.repeat(32));record.amount='1003';record.body.publics[2]='1003';record.expiresAt=q.expiresAt;
 await journal.create(record);return {...f,journal,options,record};
}

test('reload resumes only an existing durable funding body for the same accepted artifact',async()=>{
 const f=await interruptedFunding(),service=await createPrivateLightning(f.options);
 try{
  for(let i=0;i<20&&!f.funded.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.funded.length,1);assert.equal(f.funded[0]![0],'lightning-fund-0');
  assert.deepEqual((await f.journal.get(owner,pool,'lightning-fund-0'))!.body,f.record.body);
  assert.equal((await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,1);
 }finally{await service[Symbol.asyncDispose]();}
});

test('expired recovery reconciles the saved spend without creating another funding POST',async t=>{
 const f=await interruptedFunding(),errors:Error[]=[];let gets=0,posts=0;
 t.mock.timers.enable({apis:['Date'],now:(f.record.expiresAt!+1)*1000});
 f.wallet.fundLightning=async(_id,_hash,_address,_amount,store,_signal,expiresAt)=>{
  assert.equal(expiresAt,f.record.expiresAt);
  const result=await submitLightningSpend(f.record,store,{identity:SingleKey.fromPrivateKey(new Uint8Array(32).fill(5)),poolScript:'',api:async(path,body)=>{
   if(body!==undefined){posts++;throw new Error('must not post expired funding');}gets++;throw Object.assign(new Error('not found'),{status:404});
  }});return result.txid!;
 };
 const service=await createPrivateLightning({...f.options,onError:error=>errors.push(error)});
 try{
  for(let i=0;i<20&&!errors.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(gets,2);assert.equal(posts,0);assert.match(errors[0]!.message,/deadline expired/);
  assert.equal((await f.journal.get(owner,pool,f.record.id))!.state,'prepared');
  assert.equal((await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!.state,'accepted');
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('transient funding recovery retries the same artifact on the next timer pass',async t=>{
 const f=await interruptedFunding();let attempts=0;
 t.mock.timers.enable({apis:['setTimeout']});
 f.wallet.fundLightning=async id=>{assert.equal(id,f.record.id);attempts++;if(attempts===1)throw new Error('temporary pool outage');return 'ab'.repeat(32);};
 const service=await createPrivateLightning(f.options);
 const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
 try{
  await flush();assert.equal(attempts,1);t.mock.timers.tick(20_000);await flush();assert.equal(attempts,2);
  assert.equal((await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,1);
  const records=await Promise.all([...f.repositories.values()].map(async repository=>(await repository.getSwapRecordsPage({limit:100})).items));
  assert.equal(records.flat().find(record=>record.id.startsWith('quote-'))!.fundingTxid,'ab'.repeat(32));
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a failed SDK record cannot retire a prepared funding attempt and late inclusion restores chain monitoring',async()=>{
 const f=await interruptedFunding(),artifact=(await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!;
 let recordRepository:InMemoryAssetSwapRepository|undefined;
 for(const candidate of f.repositories.values())if(await candidate.getSwapRecord(artifact.quoteId!))recordRepository=candidate;
 const record=(await recordRepository!.getSwapRecord(artifact.quoteId!))!;
 await recordRepository!.saveSwapRecord({...record,...record.family==='rfq'?{state:'failed',failure:'deadline reached before funding'}:{}} as SwapRecord);
 let resume!:(txid:string)=>void;
 f.wallet.fundLightning=async()=>new Promise(resolve=>{resume=async txid=>{await f.journal.finish(owner,pool,f.record.id,{state:'included',txid});resolve(txid);};});
 const clientFactory=(config:SwapClientConfig)=>{
  const client=f.clientFactory(config),listeners=new Set<(u:SwapUpdate)=>void>();
  const ready=(async()=>{const rows=(await config.repository!.getSwapRecordsPage({limit:100})).items;for(const row of rows)if(row.family==='rfq'&&row.state==='failed')for(const listener of listeners)listener({swap:{...row,id:`rfq:${row.id}`},outcome:'failed',detail:{family:'rfq',state:'failed'}} as unknown as SwapUpdate);})();
  return {...client,ready,onUpdate:(listener:(u:SwapUpdate)=>void)=>{listeners.add(listener);const off=client.onUpdate(listener);return()=>{listeners.delete(listener);off();};}};
 };
 const service=await createPrivateLightning({...f.options,clientFactory});
 try{
  assert.equal((await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!.state,'accepted');
  assert.ok(resume);resume('ab'.repeat(32));
  for(let i=0;i<20;i++){const latest=await recordRepository!.getSwapRecord(artifact.quoteId!);if(latest?.fundingTxid)break;await new Promise(resolve=>setTimeout(resolve,5));}
  const latest=(await recordRepository!.getSwapRecord(artifact.quoteId!))!;
  assert.equal(latest.family==='rfq'&&latest.state,'pending');assert.equal(latest.fundingTxid,'ab'.repeat(32));
  assert.equal((await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!.state,'accepted');
 }finally{await service[Symbol.asyncDispose]();}
});

test('disposing recovery aborts its wait while the exact funding record remains reserved',async()=>{
 const f=await interruptedFunding();let waiting=false;
 f.wallet.fundLightning=async(_id,_hash,_address,_amount,_store,signal)=>new Promise((_resolve,reject)=>{waiting=true;signal!.addEventListener('abort',()=>reject(new Error('closed')),{once:true});});
 const service=await createPrivateLightning(f.options);
 for(let i=0;i<20&&!waiting;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(waiting);await service[Symbol.asyncDispose]();
 assert.equal(f.live.size,0);assert.equal((await f.journal.get(owner,pool,'lightning-fund-0'))!.state,'prepared');
});

test('a rich ordinary wallet cannot fund an impossible pool payment or bypass the exact HTLC send guard',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();let quoted=0;
 f.wallet.canWithdraw=()=>false;
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:config=>{const c=f.clientFactory(config);const original=c.quote;c.quote=async input=>{quoted++;return original(input);};return c;},acquireSession:f.acquireSession,legacyRecovery:false});
 try{await assert.rejects(service.quote({to:'invoice'}),/No single unreserved pool note/);assert.equal(quoted,0);assert.equal(f.funded.length,0);}finally{await service[Symbol.asyncDispose]();}
});

test('an individual Lightning receive below the pool minimum refuses locally and exact minimum remains receivable',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();let quotes=0,accepts=0;
 const clientFactory=(config:SwapClientConfig)=>{const client=f.clientFactory(config),quote=client.quote,accept=client.accept;return {...client,
  quote:async(input:Parameters<SwapClient['quote']>[0])=>{quotes++;const quoted=await quote(input);return {...quoted,take:{...quoted.take,amount:330n}};},
  accept:async(quoted:Quote)=>{accepts++;return accept(quoted);}};};
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  await assert.rejects(service.receive({via:'lightning',amount:329n}),/individual Lightning payout needs at least 330 sats/);
  assert.equal(quotes,0);assert.equal(accepts,0);assert.equal(f.funded.length,0);assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,0);
  const received=await service.receive({via:'lightning',amount:330n});assert.equal(received.take.amount,330n);assert.equal(quotes,1);assert.equal(accepts,1);
 }finally{await service[Symbol.asyncDispose]();}
});

test('a receive quote whose net payout falls below the pool minimum is never accepted',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();let accepts=0;
 const clientFactory=(config:SwapClientConfig)=>{const client=f.clientFactory(config),quote=client.quote;return {...client,
  quote:async(input:Parameters<SwapClient['quote']>[0])=>{const quoted=await quote(input);return {...quoted,take:{...quoted.take,amount:329n}};},
  accept:async()=>{accepts++;throw new Error('must not accept');}};};
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{await assert.rejects(service.receive({via:'lightning',amount:330n}),/quoted individual Lightning payout is below.*330 sats/);assert.equal(accepts,0);assert.equal(f.funded.length,0);}finally{await service[Symbol.asyncDispose]();}
});

test('stored HTLC funding rejects altered amount, assets, extra selection and wrong destination',async()=>{
 for(const override of [{amount:1002},{assets:[]},{selectedVtxos:[]},{address:new ArkAddress(server,new Uint8Array(32).fill(9),'tark').encode()}]){
  const f=serviceFixture(),journal=new InMemoryLightningRepository();f.overrideSend(override);
  const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
  try{const q=await service.quote({to:'invoice'});await assert.rejects(service.accept(q),/verified HTLC|stored HTLC/);assert.equal(f.funded.length,0);}finally{await service[Symbol.asyncDispose]();}
 }
});

test('terminal updates during acceptance dispose once after the payment returns and keep recovery records',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();f.terminalOnAccept();
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  const result=await service.accept(await service.quote({to:'invoice'}));assert.equal(result.outcome,'paid');
  assert.equal(f.funded.length,1);assert.equal(f.live.size,0);assert.equal(f.closed.length,1);
  assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!.state,'ended');
  assert.equal(f.contracts.length,1);
 }finally{await service[Symbol.asyncDispose]();}
});

test('legacy recovery opens the exact previous store and disables every new funding send',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession});
 try{
  const name=`shielded-swaps-${await f.wallet.getAddress()}`;
  assert.ok(f.repositories.has(name));assert.equal(f.starts.length,1);
  const legacy=f.configs.find(c=>c.repository===f.repositories.get(name))!;
  assert.equal(await legacy.wallet.getAddress(),await f.wallet.getAddress());
  await assert.rejects(legacy.wallet.send({address:await f.wallet.getAddress(),amount:1000}),/Legacy Lightning funding is disabled/);
  assert.equal(f.funded.length,0);
 }finally{await service[Symbol.asyncDispose]();}
 assert.equal(f.live.size,0);
});

test('a private payout shields only its exact coin under its child signer while ordinary coins are ignored',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  await service.receive({via:'lightning',amount:1000n});const contract=f.contracts[0]!,record=(await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!;
  const own={txid:'ab'.repeat(32),vout:0,value:1000,script:record.script},ordinary={txid:'cd'.repeat(32),vout:1,value:9000,script:hex.encode(script.pkScript)};
  f.base.getVtxos=async()=>[own,ordinary] as never;
  await service.registerPayouts([record]);
  for(let i=0;i<20&&!f.shielded.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.shielded.length,1);assert.equal(f.shielded[0]![0],own);
  assert.equal(hex.encode(await f.shielded[0]![1].xOnlyPublicKey()),contract.params.pubKey);
 }finally{await service[Symbol.asyncDispose]();}
});

test('a received subdust payout reports its individual minimum and never combines it with ordinary coins',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[];
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:error=>errors.push(error)});
 try{
  await service.receive({via:'lightning',amount:1000n});const payout=(await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!;
  f.base.getVtxos=async()=>[{txid:'ab'.repeat(32),vout:0,value:329,script:payout.script},{txid:'cd'.repeat(32),vout:1,value:9000,script:hex.encode(script.pkScript)}] as never;
  await service.registerPayouts([payout]);
  assert.match(errors[0]!.message,/individual Lightning payout is below.*330 sats.*cannot be shielded alone/);
  assert.equal(f.shielded.length,0);assert.equal(f.funded.length,0);
 }finally{await service[Symbol.asyncDispose]();}
});

test('payout polling reports failures and keeps retrying after a failed read',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[];
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:error=>errors.push(error)});
 try{
  await service.quote({to:'invoice'});let reads=0;
  f.base.getVtxos=async()=>{reads++;if(reads===1)throw new Error('temporary indexer outage');return [];};
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  t.mock.timers.tick(20_000);await flush();assert.equal(errors[0]?.message,'temporary indexer outage');
  t.mock.timers.tick(20_000);await flush();assert.equal(reads,2);
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('real SDK refund and claim provisioning use fresh recoverable child keys and destinations for unpaid artifacts',async()=>{
 const journal=new InMemoryLightningRepository(),base=companion();
 const allocations=await Promise.all([journal.allocateArtifact(owner,pool,'send'),journal.allocateArtifact(owner,pool,'receive')]);
 const records=await Promise.all(allocations.map(a=>materializeLightningArtifact(base,a)));
 const views=await Promise.all(records.map(record=>artifactWallet(base,record,async()=>{throw new Error('not funded');},()=>1000)));
 const [refund,claim]=await Promise.all([provisionRefundKey(views[0]!),provisionClaimSecret(views[1]!)]);
 assert.notEqual(hex.encode(refund.pubkey),hex.encode(claim.pubkey));assert.notEqual(refund.address,await views[1]!.getAddress());
 assert.notEqual(refund.address,script.address('tark',server).encode());
 const recovered=await artifactWallet(companion(),records[1]!,async()=>{throw new Error('not funded');},()=>1000);
 assert.deepEqual(await provisionClaimSecret(recovered),claim);
 const message=new Uint8Array(32).fill(4),sig=await recovered.identity.signMessage(message,'schnorr');
 assert.ok(schnorr.verify(sig,message,claim.pubkey));
 const received=new DefaultVtxo.Script({pubKey:claim.pubkey,serverPubKey:server,csvTimelock:sequenceToTimelock(Number(records[1]!.csvTimelock))});
 const tx=new Transaction({allowUnknownOutputs:true});tx.addInput({txid:'11'.repeat(32),index:0,witnessUtxo:{script:received.pkScript,amount:1000n},tapLeafScript:[received.forfeit()]});tx.addOutput({script:received.pkScript,amount:900n});
 const signed=await recovered.identity.sign(tx,[0]);assert.equal(signed.getInput(0).tapScriptSig!.length,1);assert.deepEqual(signed.getInput(0).tapScriptSig![0]![0].pubKey,claim.pubkey);
 await assert.rejects(recovered.signerForDescriptor('tr('+'33'.repeat(32)+')'),/artifact/);
 assert.equal(timelockToSequence(script.options.csvTimelock),4194306);
});
