import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indexedDB} from 'fake-indexeddb';
import {ArkAddress,ConditionMultisigTapscript,ConditionWitness,DefaultVtxo,InMemoryContractRepository,MnemonicIdentity,P2A,SingleKey,Transaction,UnilateralExit,VtxoScript,deriveDescriptorLeafPubKey,getNetwork,onchainRail,provisionClaimSecret,provisionRefundKey,resolveDescriptorSigner,sequenceToTimelock,setArkPsbtField,timelockToSequence,type Wallet} from '@arkade-os/sdk';
import {Script} from '@scure/btc-signer';
import {sha256} from '@noble/hashes/sha2.js';
import {ripemd160} from '@noble/hashes/legacy.js';
import {InMemoryAssetSwapRepository,type Quote,type SwapClient,type SwapClientConfig,type SwapRecord,type SwapUpdate} from '@arkade-os/swap';
import {schnorr} from '@noble/curves/secp256k1.js';
import {base64,hex} from '@scure/base';
import {recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import {destinationFieldOf} from '../packages/protocol/src/rollup/notes.ts';
import {IndexedDbLightningRepository,InMemoryLightningRepository,type LightningRepository} from '../src/shielded/lightning-repository.ts';
import {LightningSessionBusy,artifactWallet,createPrivateLightning,lightningOwner,lightningSigner,materializeLightningArtifact,type PrivateLightningService} from '../src/shielded/lightning-wallet.ts';
import {ShieldedWallet} from '../src/shielded/wallet.ts';
import {checkRecoveryWitnessRepair,completeRecoveryWitnesses} from '../src/shielded/lightning-exit-witness.ts';
import {submitLightningSpend,validateLightningSpend,type LightningSpendRecord} from '../src/shielded/lightning-spend.ts';
import {LightningSwapRepository} from '../src/shielded/lightning-receipt.ts';
import {pageActivityHistory} from '../app/src/shielded-page.ts';

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
  body:{id:crypto.randomUUID().replaceAll('-',''),slot:{anchor:'0',rCur:{epoch:0,root:'0'},nullifiers:[nullifier],commitments:['0','0'],ctDigest:'0',groupId:'0',groupSize:1},publics:['0',nullifier,'0','0','1000','0',String(destinationFieldOf(ArkAddress.decode(address).pkScript.subarray(2)))],proof:{pi_a:[],pi_b:[],pi_c:[]},ciphertext:'00',program:hex.encode(ArkAddress.decode(address).pkScript.subarray(2))}};
}

for(const field of ['legacy','nf0','nf1','deposit','withdraw','asset','destination'] as const)test(`saved Lightning funding rejects inconsistent ${field} public signals without releasing its reservation`,()=>{
 const record=spend('tampered');assert.equal(validateLightningSpend(record,owner,pool),record);
 if(field==='legacy')record.body.publics=['0','0','1000','0','0'];
 else record.body.publics[{nf0:1,nf1:2,deposit:3,withdraw:4,asset:5,destination:6}[field]]='2';
 assert.throws(()=>validateLightningSpend(record,owner,pool),/invalid; its funds remain reserved/);
 assert.equal(record.state,'prepared');assert.deepEqual(record.nullifiers,['1']);
});
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
 const contracts:any[]=[],receivers=new Set<(event:any)=>void>(),funded:any[]=[],shielded:any[]=[],provisioned:string[]=[],starts:string[]=[],closed:string[]=[],live=new Set<string>(),configs:SwapClientConfig[]=[],historyReads:any[][]=[],changes:number[]=[],refreshed:unknown[]=[];
 const manager={createContract:async(params:any)=>{const old=contracts.find(c=>c.script===params.script);if(old)return old;const contract={...params,createdAt:Date.now()};contracts.push(contract);return contract;},getContracts:async()=>contracts,
  getContractsWithVtxos:async(...args:any[])=>{historyReads.push(args);return contracts.map(contract=>({contract,vtxos:contract.vtxos??[]}));},
  refreshOutpoints:async(points:unknown)=>{refreshed.push(points);return [];},setContractWatchState:async()=>{},onContractEvent:(fn:any)=>{receivers.add(fn);return()=>receivers.delete(fn);}};
 const base=Object.assign(companion(),{getContractManager:async()=>manager,getVtxos:async()=>[]});
 const ordinaryAddress=script.address('tark',server).encode();
 const wallet={pool:{status:{pool:{token:pool}}},token:pool,used:new Set(),notes:{release:()=>{}},self:{owner:owner},inFlight:new Set(),shieldedNotes:()=>[{amount:5000n,nullifier:1n}],canWithdraw:(n:bigint)=>n<=5000n,restoreLightningSpends:async()=>{},assertOpen:()=>{},reconcileLightningPayout:ShieldedWallet.prototype.reconcileLightningPayout,
  changed:()=>changes.push(changes.length),getAddress:async()=>ordinaryAddress,fundLightning:async(...args:any[])=>{funded.push(args);return 'ab'.repeat(32);},shieldLightning:async(...args:any[])=>{shielded.push(args);return {settled:async()=>{}};}} as unknown as ShieldedWallet;
 const repositories=new Map<string,InMemoryAssetSwapRepository>();
 const repositoryFor=(name:string)=>{let repo=repositories.get(name);if(!repo){repo=new InMemoryAssetSwapRepository();repositories.set(name,repo);}return repo;};
 const acquireSession=async(name:string)=>{if(live.has(name))throw new LightningSessionBusy();live.add(name);return async()=>{live.delete(name);};};
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
    const giveAsset=receive?'bolt11:mutinynet/slip44:1':'arkade:mutinynet/slip44:1',takeAsset=receive?'arkade:mutinynet/slip44:1':'bolt11:mutinynet/slip44:1';
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
 return {base,wallet,repositoryFor,acquireSession,clientFactory,funded,shielded,provisioned,starts,closed,live,repositories,contracts,receivers,configs,historyReads,changes,refreshed,
  failAccept(){throwAfterPersist=true;},overrideSend(params:Record<string,unknown>){sendOverride=params;},terminalOnAccept(){terminalOnAccept=true;}};
}

test('explicit invoice creation loads cold discovery while startup, history and resolve stay offline',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),calls:string[]=[],unavailable=new Error('DiscoverySnapshotUnavailable');let loaded=false;
 const clientFactory=(config:SwapClientConfig)=>{
  const client=f.clientFactory(config);if(config.policy?.drive!=='readonly')return client;
  return {...client,markets:async()=>{calls.push('markets');loaded=true;return client.markets();},resolve:async(input)=>{calls.push('resolve');if(!loaded)throw unavailable;return client.resolve(input);}} as SwapClient;
 };
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  assert.deepEqual(calls,[]);await service.getActivityHistory();
  for(const listener of f.receivers)listener({type:'connection_reset'});await flushTasks();assert.deepEqual(calls,[]);
  await assert.rejects(service.resolve({give:'bitcoin',via:'lightning',amount:2000n}),error=>error===unavailable);
  assert.deepEqual(calls,['resolve']);assert.deepEqual(await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),[]);
  const invoice=await service.receive({via:'lightning',amount:2000n});
  assert.equal(invoice.artifact.kind,'invoice');assert.deepEqual(calls,['resolve','markets','resolve']);
  assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool)).length,1);assert.equal(f.funded.length,0);
 }finally{await service[Symbol.asyncDispose]();}
});

for(const failedStage of ['markets','resolve'] as const)test(`explicit invoice discovery ${failedStage} failure preserves reservations without allocating an artifact or session`,async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),saved=spend('existing'),failure=new Error(`${failedStage} unavailable`),calls:string[]=[];
 await journal.create(saved);(f.wallet.inFlight as Set<bigint>).add(1n);
 const clientFactory=(config:SwapClientConfig)=>{
  const client=f.clientFactory(config);if(config.policy?.drive!=='readonly')return client;
  return {...client,markets:async()=>{calls.push('markets');if(failedStage==='markets')throw failure;return client.markets();},resolve:async(input)=>{calls.push('resolve');if(failedStage==='resolve')throw failure;return client.resolve(input);}} as SwapClient;
 };
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  await assert.rejects(service.receive({via:'lightning',amount:2000n}),error=>error===failure);
  assert.deepEqual(calls,failedStage==='markets'?['markets']:['markets','resolve']);
  assert.deepEqual(await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),[]);assert.deepEqual(await journal.list(owner,pool),[saved]);assert.deepEqual([...f.wallet.inFlight],[1n]);
  assert.equal(f.configs.length,1);assert.equal(f.contracts.length,0);assert.equal(f.live.size,0);assert.equal(f.funded.length,0);assert.equal(f.starts.length,0);
 }finally{await service[Symbol.asyncDispose]();}
});

const flushTasks=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
test('startup repairs an ended send receipt under its session lock without starting a payment client',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey());
 const artifact={...await journal.allocateArtifact(ownerKey,pool,'send'),state:'ended' as const,quoteId:'old-quote'};await journal.updateArtifact(ownerKey,pool,artifact);
 const name=`shielded-lightning-${ownerKey}-${pool}-${artifact.id}`,repository=new LightningSwapRepository(name),preimage=new Uint8Array(32).fill(7),paymentHash=hex.encode(sha256(preimage));
 const tx=new Transaction({allowUnknownInputs:true,allowUnknownOutputs:true}),funding='aa'.repeat(32);
 tx.addInput({txid:funding,index:1});tx.addOutput({script:script.pkScript,amount:2113n});setArkPsbtField(tx,0,ConditionWitness,[preimage]);
 const saved={id:artifact.quoteId,family:'rfq',kind:'lightning_send',state:'refunded',lockupPkScript:hex.encode(script.pkScript),lock:{hash:paymentHash},profile:{custom:'keep'},fundingTxid:funding,give:{amount:'2113'},createdAt:1,updatedAt:1} as unknown as SwapRecord;
 await repository.saveSwapRecord(saved);await repository[Symbol.asyncDispose]();let reads=0;
 Object.assign(f.base,{indexerProvider:{getVtxos:async()=>{assert.equal(f.live.has(name),true);reads++;return {vtxos:[{txid:funding,vout:1,spentBy:tx.id,arkTxId:'bb'.repeat(32)}]};},getVirtualTxs:async()=>({txs:[base64.encode(tx.toPSBT())]})}});
 const service=await createPrivateLightning({...f,companion:f.base,journal,repositoryFor:db=>new LightningSwapRepository(db),legacyRecovery:false});
 try{
  const reopened=new LightningSwapRepository(name),corrected=await reopened.getSwapRecord(saved.id);assert.ok(corrected?.family==='rfq');assert.equal(corrected.state,'settled');await reopened[Symbol.asyncDispose]();
  assert.equal(reads,1);assert.equal(f.configs.length,1);assert.equal(f.starts.length,0);assert.equal(f.funded.length,0);assert.equal(f.live.size,0);
  assert.equal((await journal.artifacts(ownerKey,pool))[0]!.state,'ended');
  const history=await service.getActivityHistory();assert.equal(history.length,1);assert.equal(history[0]!.intent?.label,'Paid via Lightning');assert.equal(history[0]!.amount,-2113);assert.equal(history[0]!.intent?.metadata?.fundingTxid,funding);
  await service[Symbol.asyncDispose]();
  const restored=await createPrivateLightning({...f,companion:f.base,journal,repositoryFor:db=>new LightningSwapRepository(db),legacyRecovery:false});
  try{assert.deepEqual(await restored.getActivityHistory(),history);assert.equal(reads,1);assert.equal(f.starts.length,0);assert.equal(f.funded.length,0);}
  finally{await restored[Symbol.asyncDispose]();}
 }finally{await service[Symbol.asyncDispose]();}
});

test('startup reports only the safe receipt schema diagnostic and leaves an unsupported store unchanged',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey()),poolName=`schema-${crypto.randomUUID()}`,errors:Error[]=[];
 Object.assign(f.wallet.pool.status.pool!,{token:poolName});
 const artifact={...await journal.allocateArtifact(ownerKey,poolName,'send'),state:'ended' as const,quoteId:'old-quote'};await journal.updateArtifact(ownerKey,poolName,artifact);
 const name=`shielded-lightning-${ownerKey}-${poolName}-${artifact.id}`,original={id:artifact.quoteId,state:'refunded',profile:{signer:'must-not-leak'}};
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,6);request.onupgradeneeded=()=>request.result.createObjectStore('swapRecords',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('swapRecords','readwrite');tx.objectStore('swapRecords').put(original);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
 const service=await createPrivateLightning({...f,companion:f.base,journal,repositoryFor:name=>new LightningSwapRepository(name),legacyRecovery:false,onError:error=>errors.push(error)});
 try{
  assert.equal(errors.length,1);assert.match(errors[0]!.message,/expected version 5.*found version 6/);assert.ok(!errors[0]!.message.includes('must-not-leak'));
  const saved=await new Promise((resolve,reject)=>{const request=db.transaction('swapRecords','readonly').objectStore('swapRecords').get(original.id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  assert.deepEqual(saved,original);assert.equal(f.funded.length,0);assert.equal(f.starts.length,0);assert.equal(f.live.size,0);
 }finally{db.close();await service[Symbol.asyncDispose]();}
});
async function recoveryFixture(journal:LightningRepository=new InMemoryLightningRepository()){
 const f=serviceFixture(),repository=new InMemoryContractRepository();
 Object.assign(f.base,{offchainTapscript:new DefaultVtxo.Script({pubKey:await root.xOnlyPublicKey(),serverPubKey:server,csvTimelock:{type:'blocks',value:2048n}})});
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 await service.receive({via:'lightning',amount:1000n});
 const contract=f.contracts[0]!,coin={txid:'ab'.repeat(32),vout:2,value:24887,script:contract.script,createdAt:new Date(1000),status:{isLeaf:false},isSpent:false,isSwept:false,isUnrolled:false,isPreconfirmed:true,commitmentTxIds:['cd'.repeat(32)]};
 contract.vtxos=[coin];await repository.saveContract(contract);
 const requests:unknown[]=[],broadcasts:unknown[]=[];
 Object.assign(f.base,{network:getNetwork('mutinynet'),contractRepository:repository,
  indexerProvider:{getVtxos:async(request:unknown)=>{requests.push(request);return {vtxos:[coin]};},getVtxoChain:async()=>({chain:[{txid:coin.txid,type:'INDEXER_CHAINED_TX_TYPE_ARK',spends:[]}]})},
  onchainProvider:{getCoins:async()=>[],getFeeRate:async()=>1,getTxStatus:async()=>({confirmed:true,block_height:100,block_time:1000}),broadcastTransaction:async(...args:unknown[])=>{broadcasts.push(args);throw new Error('Recovery quote broadcast');}}});
 return {...f,journal,service,contract,coin,requests,broadcasts,outpoint:`${coin.txid}:${coin.vout}`};
}

async function fundedRecoveryFixture(journal?:LightningRepository,conditional=false){
 const f=await recoveryFixture(journal),payer=SingleKey.fromHex('22'.repeat(32)),operator=SingleKey.fromHex('03'.repeat(32));
 const preimage=new Uint8Array(32).fill(7),condition=Script.encode(['SIZE',new Uint8Array([32]),'EQUALVERIFY','HASH160',ripemd160(sha256(preimage)),'EQUAL']);
 const input=conditional?new VtxoScript([ConditionMultisigTapscript.encode({conditionScript:condition,pubkeys:[await payer.xOnlyPublicKey(),server]}).script]):new DefaultVtxo.Script({pubKey:await payer.xOnlyPublicKey(),serverPubKey:server,csvTimelock:{type:'seconds',value:1024n}}),parent=new Transaction({version:3});
 parent.addInput({txid:'cd'.repeat(32),index:0,witnessUtxo:{script:input.pkScript,amount:BigInt(f.coin.value)},tapLeafScript:[conditional?input.leaves[0]!: (input as DefaultVtxo.Script).forfeit()]});
 if(conditional)setArkPsbtField(parent,0,ConditionWitness,[preimage]);
 parent.addOutput({script:hex.decode(f.coin.script),amount:BigInt(f.coin.value)});parent.addOutput(P2A);
 const signed=await operator.sign(await payer.sign(parent));f.coin.txid=signed.id;f.coin.vout=0;f.outpoint=`${signed.id}:0`;
 const confirmed=new Set<string>(),sent:string[][]=[];
 Object.assign(f.base,{signInputsByWitnessScript:(tx:Transaction)=>lightningSigner(f.base,f.contract.metadata.signingDescriptor).sign(tx)});
 Object.assign(f.base.indexerProvider,{getVtxoChain:async()=>({chain:[{txid:signed.id,type:'INDEXER_CHAINED_TX_TYPE_ARK',spends:[]}]}),getVirtualTxs:async()=>({txs:[base64.encode(signed.toPSBT())]})});
 Object.assign(f.base.onchainProvider,{getTxStatus:async(txid:string)=>{if(!confirmed.has(txid))throw new Error('not onchain');return {confirmed:true,blockHeight:100,blockTime:1000};},
  getCoins:async()=>[{txid:'ee'.repeat(32),vout:0,value:100000,status:{confirmed:true}}],getChainTip:async()=>({height:2148,time:999999}),
  broadcastTransaction:async(...txs:string[])=>{sent.push(txs);for(const raw of txs)confirmed.add(Transaction.fromRaw(hex.decode(raw)).id);return Transaction.fromRaw(hex.decode(txs[0]!)).id;}});
 return {...f,sent,confirmed,preimage,signedParent:signed};
}

function whenRecovered(wallet:ShieldedWallet,service:PrivateLightningService,outpoint:string){
 const changed=wallet.changed.bind(wallet);return new Promise<void>((resolve,reject)=>{wallet.changed=()=>{changed();void service.getRecovery(outpoint).then(record=>{if(record?.state==='complete')resolve();},reject);};});
}

test('recovery preparation retains the public hashlock witness omitted by the SDK finalizer',async()=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const prepared=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint));
  const parent=prepared.package!.steps.find(s=>s.kind==='package')!;assert.equal(parent.kind,'package');
  const witness=Transaction.fromRaw(hex.decode(parent.parentHex)).getInput(0).finalScriptWitness!;
  assert.deepEqual(witness.at(-3),f.preimage);assert.equal(witness.length,5);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('resuming an old conditional package saves its witness repair before broadcast without signing again',{timeout:15000},async t=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const prepared=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint));
  const parent=prepared.package!.steps.find(s=>s.kind==='package')!;assert.equal(parent.kind,'package');
  const unsigned=f.signedParent.clone();unsigned.finalize();parent.parentHex=unsigned.hex;
  delete (prepared as any).originalPackage;
  const rootOwner=hex.encode(await root.xOnlyPublicKey());
  await f.journal.saveReceiveState(rootOwner,'onchain-recovery','active-exit',{[f.outpoint]:prepared});
  const original=structuredClone(prepared.package),broadcast=f.base.onchainProvider.broadcastTransaction.bind(f.base.onchainProvider);
  t.mock.method(root,'sign',async()=>{throw new Error('Repair signed');});
  t.mock.method(root,'signDescriptorTransactions',async()=>{throw new Error('Repair signed descriptor');});
  t.mock.method(f.base.onchainProvider,'broadcastTransaction',async(...args:string[])=>{
   const saved=await f.service.getRecovery(f.outpoint);assert.deepEqual((saved as any).originalPackage,original);
   const step=saved!.package!.steps.find(s=>s.kind==='package')!;assert.equal(step.kind,'package');
   assert.deepEqual(Transaction.fromRaw(hex.decode(step.parentHex)).getInput(0).finalScriptWitness!.at(-3),f.preimage);
   return broadcast(...args);
  });
  const finished=whenRecovered(f.wallet,f.service,f.outpoint);await f.service.startRecovery(f.outpoint);await finished;
  assert.deepEqual((await f.service.getRecovery(f.outpoint) as any).originalPackage,original);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a condition repair rejects a wrong public preimage before saving or broadcasting',async t=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const wrong=f.signedParent.clone();wrong.updateInput(0,{unknown:undefined});setArkPsbtField(wrong,0,ConditionWitness,[new Uint8Array(32).fill(8)]);
  t.mock.method(f.base.indexerProvider,'getVirtualTxs',async()=>({txs:[base64.encode(wrong.toPSBT())]}));
  await assert.rejects(f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),/condition witness/);
  assert.deepEqual(f.sent,[]);assert.equal((await f.service.getRecovery(f.outpoint))!.state,'preparing');
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('repair-only export persists the original backup atomically and does not sign or broadcast',async t=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const saved=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),parent=saved.package!.steps.find(s=>s.kind==='package')!;assert.equal(parent.kind,'package');
  const old=f.signedParent.clone();old.finalize();parent.parentHex=old.hex;delete saved.originalPackage;
  const rootOwner=hex.encode(await root.xOnlyPublicKey()),original=structuredClone(saved.package);
  await f.journal.saveReceiveState(rootOwner,'onchain-recovery','active-exit',{[f.outpoint]:saved});
  assert.equal((await f.service.getRecovery(f.outpoint))!.needsWitnessRepair,true);
  t.mock.method(root,'sign',async()=>{throw new Error('Repair signed');});t.mock.method(root,'signDescriptorTransactions',async()=>{throw new Error('Repair signed descriptor');});
  const write=t.mock.method(f.journal,'saveReceiveState',async()=>{throw new Error('repair disk full');});
  await assert.rejects(f.service.repairRecovery(f.outpoint),/repair disk full/);
  assert.deepEqual((await f.service.getRecovery(f.outpoint))!.package,original);assert.deepEqual(f.sent,[]);write.mock.restore();
  const repaired=await f.service.repairRecovery(f.outpoint);assert.deepEqual(repaired.originalPackage,original);assert.equal(repaired.needsWitnessRepair,false);assert.deepEqual(f.sent,[]);
  t.mock.method(f.base.indexerProvider,'getVirtualTxs',async()=>{throw new Error('repair refetched');});
  assert.deepEqual(await f.service.repairRecovery(f.outpoint),repaired);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a conditional transaction falls back to the indexer for an input omitted from the local PSBT',async t=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const saved=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),parent=saved.package!.steps.find(s=>s.kind==='package')!;assert.equal(parent.kind,'package');
  const source=new Transaction({version:3}),input=f.signedParent.getInput(0);
  for(let i=0;i<2;i++){source.addInput({txid:input.txid,index:i,witnessUtxo:input.witnessUtxo,tapLeafScript:input.tapLeafScript});setArkPsbtField(source,i,ConditionWitness,[f.preimage]);}
  for(let i=0;i<f.signedParent.outputsLength;i++)source.addOutput(f.signedParent.getOutput(i));
  const full=await SingleKey.fromHex('03'.repeat(32)).sign(await SingleKey.fromHex('22'.repeat(32)).sign(source)),partial=full.clone();partial.updateInput(1,{unknown:undefined});
  const raw=full.clone();raw.finalize();const pkg=structuredClone(saved.package!);pkg.steps=[{...parent,parentTxid:raw.id,parentHex:raw.hex}];
  let reads=0;
  const repaired=await completeRecoveryWitnesses(pkg,{virtualTxRepository:{getVirtualTx:async()=>({psbt:base64.encode(partial.toPSBT())})},indexerProvider:{getVirtualTxs:async()=>{reads++;return {txs:[base64.encode(full.toPSBT())]};}}} as never);
  const step=repaired.steps[0]!;assert.equal(step.kind,'package');const tx=Transaction.fromRaw(hex.decode(step.parentHex));
  assert.equal(reads,1);for(let i=0;i<2;i++)assert.deepEqual(tx.getInput(i).finalScriptWitness!.at(-3),f.preimage);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a saved condition repair cannot change signatures, payments, fee children, or package totals',async()=>{
 const f=await fundedRecoveryFixture(undefined,true);
 try{
  const saved=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),original=saved.originalPackage!;
  assert.ok(original);checkRecoveryWitnessRepair(original,saved.package!);
  for(const change of ['signature','destination','child','totals'] as const){
   const altered=structuredClone(saved.package!),parent=altered.steps.find(s=>s.kind==='package')!;assert.equal(parent.kind,'package');
   if(change==='signature'){const tx=Transaction.fromRaw(hex.decode(parent.parentHex)),witness=tx.getInput(0).finalScriptWitness!;witness[0]![0]^=1;tx.updateInput(0,{finalScriptWitness:witness});parent.parentHex=tx.hex;}
   else if(change==='destination')altered.sweepAddress='tb1pforeign';
   else if(change==='child')parent.childHex+='00';
   else altered.totals.recoveredSats++;
   assert.throws(()=>checkRecoveryWitnessRepair(original,altered),/condition witness/);
  }
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('funded recovery persists the real signed package before any broadcast and resumes that exact package after service restart',{timeout:15000},async()=>{
 const name=`ln-exit-${crypto.randomUUID()}`,f=await fundedRecoveryFixture(new IndexedDbLightningRepository(name));
 try{
  const quote=await f.service.quoteRecovery(f.outpoint),prepared=await f.service.prepareRecovery(f.outpoint,quote);
  assert.equal(prepared.state,'ready');assert.equal(prepared.package!.steps[0]!.kind,'broadcast');assert.deepEqual(f.sent,[]);
  const sweep=prepared.package!.steps.find(s=>s.kind==='sweep')!;
  assert.equal(sweep.kind,'sweep');assert.equal(sweep.delay.value,2048);assert.equal(Transaction.fromRaw(hex.decode(sweep.hex)).getInput(0).sequence,2048);
  assert.deepEqual(await f.service.getRecovery(f.outpoint),prepared);
  await f.service[Symbol.asyncDispose]();await f.journal[Symbol.asyncDispose]();
  const reopened=new IndexedDbLightningRepository(name),restored=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal:reopened,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
  try{
   assert.deepEqual(await restored.getRecovery(f.outpoint),prepared);assert.deepEqual(f.sent,[]);
   const finished=whenRecovered(f.wallet,restored,f.outpoint);await restored.startRecovery(f.outpoint);await finished;
   const complete=await restored.getRecovery(f.outpoint);assert.equal(complete!.state,'complete',complete!.error??JSON.stringify(complete!.event));
   assert.equal(f.sent.length,3);assert.equal(f.sent[0]![0],prepared.package!.steps[0]!.kind==='broadcast'?prepared.package!.steps[0]!.hex:'');
   assert.equal(f.sent[2]![0],sweep.hex);assert.deepEqual(complete!.package,prepared.package);assert.equal(f.refreshed.length,2);
  }finally{await restored[Symbol.asyncDispose]();await reopened[Symbol.asyncDispose]();}
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a failed durable package write never broadcasts and leaves shielding held across reload',async t=>{
 const f=await fundedRecoveryFixture(),save=f.journal.saveReceiveState.bind(f.journal);
 t.mock.method(f.journal,'saveReceiveState',async(owner:string,pool:string,key:string,state:any)=>{if(Object.values(state).some((r:any)=>r.package))throw new Error('disk full');return save(owner,pool,key,state);});
 try{
  const quote=await f.service.quoteRecovery(f.outpoint);await assert.rejects(f.service.prepareRecovery(f.outpoint,quote),/disk full/);
  assert.equal((await f.service.getRecovery(f.outpoint))!.state,'preparing');assert.deepEqual(f.sent,[]);
  f.base.getVtxos=async()=>[f.coin] as never;for(const listener of f.receivers)listener({type:'connection_reset'});await flushTasks();assert.deepEqual(f.shielded,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('an unresolved shield attempt blocks recovery without discarding its journal or reservation',async()=>{
 const f=await fundedRecoveryFixture(),held=shieldingRecord('ambiguous',f.coin);await f.journal.create(held);Object.assign(f.wallet,{api:async()=>({status:'pending'})});
 try{
  const quote=await f.service.quoteRecovery(f.outpoint);await assert.rejects(f.service.prepareRecovery(f.outpoint,quote),/shielding.*unresolved/i);
  assert.deepEqual(await f.journal.get(owner,pool,held.id),held);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('recovery refuses substituted or stale quotes and never treats failed executor events as completion',async t=>{
 const f=await fundedRecoveryFixture();
 try{
  const quote=await f.service.quoteRecovery(f.outpoint);await assert.rejects(f.service.prepareRecovery(f.outpoint,{...quote}),/quote/i);
  await f.service.prepareRecovery(f.outpoint,quote);
  t.mock.method(f.base.onchainProvider,'broadcastTransaction',async()=>{throw new Error('response lost');});
  await f.service.startRecovery(f.outpoint);await flushTasks();
  const paused=await f.service.getRecovery(f.outpoint);assert.equal(paused!.state,'paused');assert.match(paused!.error!,/response lost/);assert.ok(paused!.package);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('resuming a mempool parent with a missing fee child relays the exact saved pair',{timeout:15000},async t=>{
 const f=await fundedRecoveryFixture();
 try{
  const prepared=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),pkg=prepared.package!;
  const parent=pkg.steps.find(s=>s.kind==='package')!,splitter=pkg.steps[0]!;assert.equal(parent.kind,'package');assert.equal(splitter.kind,'broadcast');
  f.confirmed.add(splitter.txid);const status=f.base.onchainProvider.getTxStatus.bind(f.base.onchainProvider);
  t.mock.method(f.base.onchainProvider,'getTxStatus',async(txid:string)=>txid===parent.parentTxid&&!f.confirmed.has(txid)?{confirmed:false}:status(txid));
  const finished=whenRecovered(f.wallet,f.service,f.outpoint);await f.service.startRecovery(f.outpoint);await finished;
  assert.deepEqual(f.sent[0],[parent.parentHex,parent.childHex]);const complete=await f.service.getRecovery(f.outpoint);assert.equal(complete!.state,'complete',complete!.error??JSON.stringify(complete!.event));
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('pausing during a status read prevents the SDK from broadcasting afterwards and retains the package',async t=>{
 const f=await fundedRecoveryFixture();let entered!:()=>void,release!:()=>void;
 const reading=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
 try{
  const prepared=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),saved=prepared.package;
  t.mock.method(f.base.onchainProvider,'getTxStatus',async()=>{entered();await barrier;throw new Error('missing');});
  await f.service.startRecovery(f.outpoint);await reading;
  const paused=f.service.pauseRecovery();release();await paused;
  assert.deepEqual(f.sent,[]);assert.equal((await f.service.getRecovery(f.outpoint))!.state,'paused');assert.deepEqual((await f.service.getRecovery(f.outpoint))!.package,saved);
 }finally{release?.();await f.service[Symbol.asyncDispose]();}
});

test('stale quotes and preparation over the quoted budget are refused before any funds move',async t=>{
 const f=await fundedRecoveryFixture();
 try{
  const stale=await f.service.quoteRecovery(f.outpoint),now=Date.now(),clock=t.mock.method(Date,'now',()=>now+300_001);
  await assert.rejects(f.service.prepareRecovery(f.outpoint,stale),/Refresh.*quote/);clock.mock.restore();
  const original=UnilateralExit.prepare;t.mock.method(UnilateralExit,'prepare',async(options:Parameters<typeof original>[0])=>{const pkg=await original(options);pkg.totals.totalFeeSats+=10000;return pkg;});
  await assert.rejects(f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),/quoted budget/);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a missing shielding status is ambiguous while an explicit drop reconciles only its exact reservation',async()=>{
 const f=await fundedRecoveryFixture(),held=shieldingRecord('old',f.coin),paths:string[]=[];
 await f.journal.create(held);Object.assign(f.wallet,{api:async(path:string)=>{paths.push(path);throw Object.assign(new Error('not found'),{status:404});}});
 try{
  const quote=await f.service.quoteRecovery(f.outpoint);await assert.rejects(f.service.prepareRecovery(f.outpoint,quote),/not found/);assert.deepEqual(await f.journal.get(owner,pool,held.id),held);
  Object.assign(f.wallet,{api:async(path:string)=>{paths.push(path);return {status:'dropped',reason:'invalid script'};}});
  await f.service.prepareRecovery(f.outpoint,quote);
  assert.deepEqual(paths,[`/spends/${held.body.id}`,`/spends/${held.body.id}`]);assert.equal((await f.journal.get(owner,pool,held.id))!.state,'dropped');assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a Lightning recovery quote uses the original block-delay contract without signing, allocating or changing pending shielding',async t=>{
 const f=await recoveryFixture(),sign=t.mock.method(root,'sign',async()=>{throw new Error('Recovery quote signed');}),signDescriptor=t.mock.method(root,'signDescriptorTransactions',async()=>{throw new Error('Recovery quote signed descriptor');});
 try{
  const held=shieldingRecord('held',f.coin);await f.journal.create(held);
  const artifacts=await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),payouts=await f.journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool);
  const quote=await f.service.quoteRecovery(f.outpoint);
  assert.equal(quote.vtxos.length,1);assert.equal(quote.vtxos[0]!.outpoint,f.outpoint);assert.deepEqual(quote.vtxos[0]!.delay,{type:'blocks',value:2048});
  assert.equal(quote.totals.recoveredSats,f.coin.value-quote.vtxos[0]!.sweepFee!);assert.ok(quote.totals.totalFeeSats>0);assert.match(quote.fundingAddress,/^tb1p/);
  assert.deepEqual(f.requests,[{outpoints:[{txid:f.coin.txid,vout:f.coin.vout}]},{outpoints:[{txid:f.coin.txid,vout:f.coin.vout}]}]);
  assert.deepEqual(await f.journal.list(owner,pool),[held]);assert.deepEqual(await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),artifacts);assert.deepEqual(await f.journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool),payouts);
  assert.equal(sign.mock.callCount(),0);assert.equal(signDescriptor.mock.callCount(),0);assert.deepEqual(f.broadcasts,[]);assert.deepEqual(f.funded,[]);assert.deepEqual(f.shielded,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a shielding inclusion racing preparation is terminal and stays shielded in history',async()=>{
 const f=await fundedRecoveryFixture();
 try{
  const quote=await f.service.quoteRecovery(f.outpoint),held=shieldingRecord('landed',f.coin);await f.journal.create(held);await f.journal.finish(owner,pool,held.id,{state:'included',txid:'cd'.repeat(32)});
  await assert.rejects(f.service.prepareRecovery(f.outpoint,quote),/already shielded/);
  assert.equal((await f.service.getRecovery(f.outpoint))!.state,'shielded');assert.equal((await f.service.getActivityHistory())[0]!.intent!.outcome,'shielded');assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('an older pool reservation blocks recovery without querying the new pool or releasing the old body',async()=>{
 const f=await fundedRecoveryFixture(),held={...shieldingRecord('older-pool',f.coin),pool:'previous-pool'};let reads=0;
 await f.journal.create(held);Object.assign(f.wallet,{api:async()=>{reads++;throw new Error('wrong pool queried');}});
 try{
  await assert.rejects(f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint)),/original pool.*unresolved/);
  assert.equal(reads,0);assert.deepEqual(await f.journal.get(owner,held.pool,held.id),held);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('a saved recovery retains its receipt and controls after the pool is reset',async()=>{
 const f=await fundedRecoveryFixture();
 try{
  const prepared=await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint));await f.service[Symbol.asyncDispose]();
  f.wallet.pool.status.pool!.token='new-pool';Object.assign(f.wallet,{token:'new-pool'});f.contracts.length=0;
  const restored=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal:f.journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
  try{
   const rows=await restored.getActivityHistory();assert.equal(rows.length,1);assert.equal(rows[0]!.intent!.metadata!.outpoint,f.outpoint);assert.equal(rows[0]!.intent!.outcome,'onchain-recovery');
   assert.deepEqual((await restored.getRecovery(f.outpoint))!.package,prepared.package);assert.deepEqual(f.sent,[]);
  }finally{await restored[Symbol.asyncDispose]();}
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('restoring a package with a substituted wallet destination blocks execution',async()=>{
 const f=await fundedRecoveryFixture();
 try{
  await f.service.prepareRecovery(f.outpoint,await f.service.quoteRecovery(f.outpoint));const rootOwner=hex.encode(await root.xOnlyPublicKey());
  const records=await f.journal.getReceiveState<Record<string,any>>(rootOwner,'onchain-recovery','active-exit');records![f.outpoint].package.sweepAddress='foreign';
  await f.journal.saveReceiveState(rootOwner,'onchain-recovery','active-exit',records);
  await assert.rejects(f.service.startRecovery(f.outpoint),/does not match/);assert.deepEqual(f.sent,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('IndexedDB finds payout reservations across pools after closing and reopening the journal',async()=>{
 const name=`ln-exit-pools-${crypto.randomUUID()}`,first=new IndexedDbLightningRepository(name),coin={txid:'ab'.repeat(32),vout:0,value:1000,script:'00'};
 const a={...shieldingRecord('pool-a',coin),pool:'A'},b={...shieldingRecord('pool-b',coin),pool:'B'};await first.create(a);await first.create(b);await first[Symbol.asyncDispose]();
 const restored=new IndexedDbLightningRepository(name);
 try{assert.deepEqual((await restored.payoutSpends(owner,a.reference)).map(r=>r.pool).sort(),['A','B']);assert.deepEqual(await restored.payoutSpends('foreign',a.reference),[]);}
 finally{await restored[Symbol.asyncDispose]();}
});

test('pending payout ancestry quotes fee children, total funding and only confirmed fee-wallet funds',async()=>{
 const f=await recoveryFixture();
 try{
  const payer=SingleKey.fromHex('22'.repeat(32)),operator=SingleKey.fromHex('03'.repeat(32));
  const input=new DefaultVtxo.Script({pubKey:await payer.xOnlyPublicKey(),serverPubKey:server,csvTimelock:{type:'seconds',value:1024n}}),parent=new Transaction({version:3});
  parent.addInput({txid:'cd'.repeat(32),index:0,witnessUtxo:{script:input.pkScript,amount:BigInt(f.coin.value)},tapLeafScript:[input.forfeit()]});
  parent.addOutput({script:hex.decode(f.coin.script),amount:BigInt(f.coin.value)});parent.addOutput(P2A);
  const signed=await operator.sign(await payer.sign(parent));f.coin.txid=signed.id;f.coin.vout=0;
  Object.assign(f.base.indexerProvider,{getVtxoChain:async()=>({chain:[{txid:signed.id,type:'INDEXER_CHAINED_TX_TYPE_ARK',spends:[]}]}),getVirtualTxs:async()=>({txs:[base64.encode(signed.toPSBT())]})});
  Object.assign(f.base.onchainProvider,{getTxStatus:async()=>{throw new Error('not onchain');},getCoins:async()=>[{txid:'ee'.repeat(32),vout:0,value:500,status:{confirmed:true}},{txid:'ff'.repeat(32),vout:0,value:10000,status:{confirmed:false}}]});
  const quote=await f.service.quoteRecovery(`${signed.id}:0`);
  assert.equal(quote.totals.txCount,4);assert.equal(quote.currentBalanceSats,500);assert.ok(quote.totals.fundingRequiredSats>quote.totals.totalFeeSats);
  assert.equal(quote.shortfallSats,quote.totals.fundingRequiredSats-500);assert.ok(quote.shortfallSats>0);assert.deepEqual(quote.vtxos[0]!.delay,{type:'blocks',value:2048});assert.deepEqual(f.broadcasts,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

for(const state of ['foreign','wrong-outpoint','spent','spentBy','settledBy','swept','asset','contract','descriptor'] as const)test(`a recovery quote rejects ${state} payout evidence before estimating`,async t=>{
 const f=await recoveryFixture(),estimate=t.mock.method(UnilateralExit,'estimate',async()=>{throw new Error('Estimator reached');});
 try{
  if(state==='foreign')f.coin.script='5120'+'ef'.repeat(32);
  if(state==='wrong-outpoint')f.coin.vout++;
  if(state==='spent')f.coin.isSpent=true;
  if(state==='spentBy')Object.assign(f.coin,{spentBy:'cd'.repeat(32)});
  if(state==='settledBy')Object.assign(f.coin,{settledBy:'cd'.repeat(32)});
  if(state==='swept')f.coin.isSwept=true;
  if(state==='asset')Object.assign(f.coin,{assets:[{assetId:'ee'.repeat(34),amount:1n}]});
  if(state==='contract')f.contract.params.csvTimelock='4194308';
  if(state==='descriptor')f.contract.metadata.signingDescriptor='foreign';
  await assert.rejects(f.service.quoteRecovery(f.outpoint),/payout|contract|descriptor/i);assert.equal(estimate.mock.callCount(),0);assert.deepEqual(f.broadcasts,[]);
 }finally{await f.service[Symbol.asyncDispose]();}
});

test('recovery quoting refuses an included shielding receipt and invalid or closed requests',async t=>{
 const f=await recoveryFixture(),estimate=t.mock.method(UnilateralExit,'estimate',async()=>{throw new Error('Estimator reached');});
 try{
  const held=shieldingRecord('included',f.coin);await f.journal.create(held);await f.journal.finish(owner,pool,held.id,{state:'included',txid:'cd'.repeat(32)});
  await assert.rejects(f.service.quoteRecovery(f.outpoint),/already shielded/i);
  for(const request of ['no-outpoint','ab:0',`${f.coin.txid}:-1`,`${f.coin.txid}:4294967296`])await assert.rejects(f.service.quoteRecovery(request),/outpoint/i);
  assert.equal(estimate.mock.callCount(),0);
 }finally{await f.service[Symbol.asyncDispose]();}
 await assert.rejects(f.service.quoteRecovery(f.outpoint),/closed/i);
});

test('an exit with no viable original-payout sweep is reported as unavailable',async t=>{
 const f=await recoveryFixture();t.mock.method(UnilateralExit,'estimate',async()=>({vtxos:[{outpoint:f.outpoint,skipped:'uneconomic'}]} as never));
 try{await assert.rejects(f.service.quoteRecovery(f.outpoint),/uneconomic/);assert.deepEqual(f.broadcasts,[]);}
 finally{await f.service[Symbol.asyncDispose]();}
});

function shieldingRecord(id:string,coin:{txid:string;vout:number;value:number;script:string}):LightningSpendRecord{
 const record=spend(id),reference=`${coin.txid}:${coin.vout}`,savedCoin={txid:coin.txid,vout:coin.vout,value:coin.value,tapTree:'00',leaf:'00'};
 delete record.paymentHash;delete record.body.program;
 return {...record,kind:'shield',reference,destination:coin.script,amount:String(coin.value),coin:savedCoin,
  body:{...record.body,publics:['0',record.nullifiers[0]!,'0',String(coin.value),'0','0','0'],coin:{txid:coin.txid,vout:coin.vout,tapTree:'00',leaf:'00'}}};
}

test('an actual Lightning receipt survives failed shielding, retry, spent inclusion and reload exactly once',async()=>{
 const f=serviceFixture(),name=`ln-history-${crypto.randomUUID()}`,errors:Error[]=[];
 let journal=new IndexedDbLightningRepository(name);
 const options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:(error:Error)=>errors.push(error)};
 let service=await createPrivateLightning(options);
 try{
  await service.receive({via:'lightning',amount:1000n});await service.receive({via:'lightning',amount:1000n});
  assert.deepEqual(await service.getActivityHistory(),[],'unpaid allocations are not receipts');
  const contract=f.contracts[0]!,coin={txid:'ab'.repeat(32),vout:2,value:987,script:contract.script,createdAt:new Date('2026-10-17T12:34:56Z'),isPreconfirmed:true,isSpent:false};
  contract.vtxos=[coin,{...coin}];f.contracts.push({script:hex.encode(script.pkScript),vtxos:[{...coin,txid:'cd'.repeat(32),value:9000,script:hex.encode(script.pkScript)}]});
  f.base.getVtxos=async()=>[coin] as never;f.wallet.shieldLightning=async()=>{throw new Error('pool rejected');};
  const before=f.changes.length;
  for(const listener of f.receivers)listener({type:'vtxo_received',contractScript:contract.script,vtxos:[coin]});
  await flushTasks();assert.equal(errors[0]?.message,'pool rejected');assert.ok(f.changes.length>=before+2,'receipt and failed shield both refresh history');
  let rows=await service.getActivityHistory();assert.equal(rows.length,1);const id=rows[0]!.id;
  assert.equal(rows[0]!.amount,987);assert.equal(rows[0]!.createdAt,coin.createdAt.getTime());assert.equal(rows[0]!.intent?.kind,'lightning-receive');assert.equal(rows[0]!.intent?.outcome,'received');
  assert.deepEqual(f.historyReads.at(-1),[undefined,undefined,{unspentOnly:false}]);
  const first=shieldingRecord('receipt-shield',coin);await journal.create(first);
  assert.equal((await service.getActivityHistory())[0]!.intent?.outcome,'shielding');
  await journal.finish(owner,pool,first.id,{state:'dropped',reason:'pool rejected'});
  assert.equal((await service.getActivityHistory())[0]!.intent?.outcome,'retrying');
  const retry=shieldingRecord('receipt-shield-retry',coin);await journal.create(retry);
  assert.equal((await service.getActivityHistory())[0]!.intent?.outcome,'shielding');
  await journal.finish(owner,pool,retry.id,{state:'included',txid:'ef'.repeat(32)});coin.isSpent=true;f.base.getVtxos=async()=>[];
  for(const listener of f.receivers)listener({type:'vtxo_spent',contractScript:contract.script,vtxos:[coin]});
  rows=await service.getActivityHistory();assert.equal(rows.length,1);assert.equal(rows[0]!.id,id);assert.equal(rows[0]!.amount,987);assert.equal(rows[0]!.intent?.outcome,'shielded');
  await service[Symbol.asyncDispose]();await journal[Symbol.asyncDispose]();journal=new IndexedDbLightningRepository(name);options.journal=journal;service=await createPrivateLightning(options);
  rows=await service.getActivityHistory();assert.equal(rows.length,1);assert.equal(rows[0]!.id,id);assert.equal(rows[0]!.intent?.outcome,'shielded');
 }finally{await service[Symbol.asyncDispose]();await journal[Symbol.asyncDispose]();}
});

test('receipt history refreshes when shielding starts before its durable submission is prepared',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
 try{
  await service.receive({via:'lightning',amount:1000n});const contract=f.contracts[0]!,coin={txid:'ab'.repeat(32),vout:0,value:1000,script:contract.script,createdAt:new Date(1000)};
  contract.vtxos=[coin];f.base.getVtxos=async()=>[coin] as never;f.wallet.shieldLightning=async()=>({settled:()=>pending}) as never;
  const before=f.changes.length,payouts=await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool);await service.registerPayouts(payouts);
  assert.ok(f.changes.length>before);assert.equal((await service.getActivityHistory())[0]!.intent?.outcome,'shielding');assert.deepEqual(await journal.list(owner,pool),[]);
  finish();await flushTasks();assert.equal((await service.getActivityHistory())[0]!.intent?.outcome,'received');
 }finally{finish();await service[Symbol.asyncDispose]();}
});

test('subdust Lightning receipts remain visible, distinct outpoints do not merge and unrelated events do not refresh them',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  await service.receive({via:'lightning',amount:1000n});const contract=f.contracts[0]!;
  contract.vtxos=[0,1].map(vout=>({txid:'ab'.repeat(32),vout,value:329,script:contract.script,createdAt:new Date(1000+vout),isPreconfirmed:false}));
  const rows=await service.getActivityHistory();assert.deepEqual(rows.map(row=>row.amount),[329,329]);assert.equal(new Set(rows.map(row=>row.id)).size,2);
  assert.ok(rows.every(row=>row.intent?.outcome==='below-minimum'));assert.equal(f.shielded.length,0);
  const before=f.changes.length;for(const listener of f.receivers)listener({type:'vtxo_received',contractScript:'unrelated',vtxos:[]});
  assert.equal(f.changes.length,before);
  for(const listener of f.receivers)listener({type:'connection_reset'});assert.equal(f.changes.length,before+1);
  await service.quote({to:'invoice'});const refund=f.contracts.at(-1)!;
  refund.vtxos=[{...contract.vtxos[0],txid:'cd'.repeat(32),script:refund.script,value:500}];
  assert.equal((await service.getActivityHistory()).find(row=>row.amount===500)!.intent?.label,'Lightning refund');
 }finally{await service[Symbol.asyncDispose]();}
});

test('saved Lightning shielding rejects a destination public signal without releasing its reservation',()=>{
 const record=shieldingRecord('tampered',{txid:'ab'.repeat(32),vout:0,value:1000,script:'00'});
 assert.equal(validateLightningSpend(record,owner,pool),record);record.body.publics[6]='2';
 assert.throws(()=>validateLightningSpend(record,owner,pool),/invalid; its funds remain reserved/);
 assert.equal(record.state,'prepared');assert.deepEqual(record.nullifiers,['1']);
});

test('a conclusively dropped payout shielding attempt retries under a new id with the same outpoint reference',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],attemptIds:string[]=[],references:string[]=[];
 const options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:(error:Error)=>errors.push(error)};
 const service=await createPrivateLightning(options);
 try{
  await service.receive({via:'lightning',amount:1000n});const payout=(await journal.payouts(hex.encode(await root.xOnlyPublicKey()),pool))[0]!;
  const coin={txid:'ab'.repeat(32),vout:0,value:1000,script:payout.script};f.base.getVtxos=async()=>[coin] as never;
  f.wallet.shieldLightning=async(_coin,_signer,store,request)=>{
   assert.ok([...f.live].some(name=>name.endsWith(`-payout-${coin.txid}:0`)));
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

for(const asset of ['arkade:mutinynet/slip44:1','arkade:mutinynet/slip44:0'] as const)test(`a ${asset.endsWith(':1')?'canonical':'legacy'} Mutinynet Bitcoin send funds its verified HTLC`,async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),clientFactory=(config:SwapClientConfig)=>{
  const client=f.clientFactory(config);return {...client,quote:async(input:Parameters<SwapClient['quote']>[0])=>{const quoted=await client.quote(input);return {...quoted,route:{...quoted.route,give:{...quoted.route.give,asset}},give:{...quoted.give,asset}} as Quote;}};
 };
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  const quoted=await service.quote({to:'invoice'});assert.equal(quoted.route.give.asset,asset);
  await service.accept(quoted);assert.equal(f.funded.length,1);assert.equal(f.funded[0]![2],script.address('tark',server).encode());assert.equal(f.funded[0]![3],1003n);assert.equal(f.funded[0]![6],quoted.expiresAt);
 }finally{await service[Symbol.asyncDispose]();}
});

for(const field of ['issued asset','give corridor','take corridor','deadline','program'] as const)test(`canonical Bitcoin funding still rejects a stored HTLC with an altered ${field}`,async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();
 const repositoryFor=(name:string)=>{
  const repository=f.repositoryFor(name),get=repository.getSwapRecord.bind(repository);
  repository.getSwapRecord=async id=>{
   const record=await get(id);if(record?.family!=='rfq')return record;
   if(field==='issued asset')return {...record,route:{...record.route,give:{...record.route.give,asset:`arkade:mutinynet/asset:${'ab'.repeat(34)}`}}};
   if(field==='give corridor')return {...record,route:{...record.route,give:{...record.route.give,corridor:'lightning'}}};
   if(field==='take corridor')return {...record,route:{...record.route,take:{...record.route.take,corridor:'arkade'}}};
   if(field==='deadline')return {...record,expiresAt:record.expiresAt+1};
   return {...record,lockupPkScript:'5120'+'ab'.repeat(32)};
  };
  return repository;
 };
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{await assert.rejects(service.accept(await service.quote({to:'invoice'})),{message:'Private Lightning funding does not match its stored HTLC'});assert.equal(f.funded.length,0);}
 finally{await service[Symbol.asyncDispose]();}
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
 const record=spend('lightning-fund-0',pool,'1','01'.repeat(32));record.amount='1003';record.body.publics[4]='1003';record.expiresAt=q.expiresAt;
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

test('a tab whose sibling holds a swap session still opens Lightning, and leaves that swap to the sibling',async()=>{
 const f=await interruptedFunding(),errors:Error[]=[],[artifact]=await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool);
 const held=`shielded-lightning-${await lightningOwner(f.base)}-${pool}-${artifact!.id}`;f.live.add(held);
 const service=await createPrivateLightning({...f.options,onError:error=>errors.push(error)});
 try{
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.funded.length,0,'only the tab holding the session drives the swap');
  assert.match(errors.map(e=>e.message).join('|'),/another tab/);
 }finally{await service[Symbol.asyncDispose]();}
 assert.ok(f.live.has(held));
});

test('a tab takes over a swap on the next timer pass after its sibling lets go of it',async t=>{
 const f=await interruptedFunding(),[artifact]=await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool);
 const held=`shielded-lightning-${await lightningOwner(f.base)}-${pool}-${artifact!.id}`;f.live.add(held);
 t.mock.timers.enable({apis:['setTimeout']});
 const service=await createPrivateLightning(f.options);
 try{
  await flushTasks();t.mock.timers.tick(20_000);await flushTasks();
  assert.equal(f.funded.length,0,'a sibling still holding the swap keeps it');
  f.live.delete(held);t.mock.timers.tick(20_000);await flushTasks();
  assert.equal(f.funded.length,1,'the swap resumes here once the sibling lets go');assert.ok(f.live.has(held));
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a tab taking over a swap its sibling started later also watches that swap\'s payout',async t=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false};
 t.mock.timers.enable({apis:['setTimeout']});
 const tab=await createPrivateLightning(options);
 try{
  const sibling=await createPrivateLightning(options),q=await sibling.quote({to:'invoice'});f.failAccept();await assert.rejects(sibling.accept(q),/lost acceptance response/);await sibling[Symbol.asyncDispose]();
  const [artifact]=await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),watched:string[]=[];
  t.mock.method(await f.base.getContractManager(),'setContractWatchState',async(script:string)=>{watched.push(script);});
  t.mock.timers.tick(20_000);await flushTasks();
  assert.ok(watched.includes(artifact!.script!),'the payout is watched by the tab that now drives the swap');
 }finally{await tab[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a tab also watches the payout of a swap its sibling started later and that has already ended',async t=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false};
 t.mock.timers.enable({apis:['setTimeout']});
 const tab=await createPrivateLightning(options);
 try{
  const sibling=await createPrivateLightning(options),q=await sibling.quote({to:'invoice'});f.failAccept();await assert.rejects(sibling.accept(q),/lost acceptance response/);await sibling[Symbol.asyncDispose]();
  const key=hex.encode(await root.xOnlyPublicKey()),[artifact]=await journal.artifacts(key,pool);artifact!.state='ended';await journal.updateArtifact(key,pool,artifact!);
  const watched:string[]=[];t.mock.method(await f.base.getContractManager(),'setContractWatchState',async(script:string)=>{watched.push(script);});
  const starts=f.starts.length;t.mock.timers.tick(20_000);await flushTasks();
  assert.ok(watched.includes(artifact!.script!));assert.equal(f.starts.length,starts);assert.equal(f.funded.length,0,'an ended swap is watched, not driven');
 }finally{await tab[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a payout watch that fails is reported once and retried, so the swap is still taken over',async t=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:(error:Error)=>errors.push(error)};
 t.mock.timers.enable({apis:['setTimeout']});
 const tab=await createPrivateLightning(options);
 try{
  const sibling=await createPrivateLightning(options),q=await sibling.quote({to:'invoice'});f.failAccept();await assert.rejects(sibling.accept(q),/lost acceptance response/);await sibling[Symbol.asyncDispose]();
  const [artifact]=await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool);let failures=2;
  t.mock.method(await f.base.getContractManager(),'setContractWatchState',async()=>{if(failures-->0)throw new Error('watch unavailable');});
  const starts=f.starts.length;
  for(let i=0;i<2;i++){t.mock.timers.tick(20_000);await flushTasks();}
  assert.equal(failures,0,'each pass retries the watch');assert.equal(f.starts.length,starts,'a swap is not started while its payout is unwatched');
  t.mock.timers.tick(20_000);await flushTasks();
  assert.equal(errors.filter(e=>e.message==='watch unavailable').length,1);assert.ok(f.starts.length>starts,'the swap is taken over once its watch is in place');assert.ok(f.live.has(`shielded-lightning-${await lightningOwner(f.base)}-${pool}-${artifact!.id}`));
 }finally{await tab[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a swap that cannot open for another reason is reported once, not again on every tick',async t=>{
 const f=await interruptedFunding(),errors:Error[]=[],[artifact]=await f.journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool);
 const lock=`shielded-lightning-${await lightningOwner(f.base)}-${pool}-${artifact!.id}`;
 const acquireSession=async(name:string)=>{if(name===lock)throw new Error('locks unavailable');return f.acquireSession(name);};
 t.mock.timers.enable({apis:['setTimeout']});
 const service=await createPrivateLightning({...f.options,acquireSession,onError:error=>errors.push(error)});
 try{
  await flushTasks();t.mock.timers.tick(20_000);await flushTasks();t.mock.timers.tick(20_000);await flushTasks();
  assert.deepEqual(errors.map(e=>e.message).filter(m=>m==='locks unavailable'),['locks unavailable']);assert.equal(f.funded.length,0);
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a swap taken over on a tick that then fails to start is reported once and its session released',async t=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],options={wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:(error:Error)=>errors.push(error)};
 const first=await createPrivateLightning(options),q=await first.quote({to:'invoice'});f.failAccept();await assert.rejects(first.accept(q),/lost acceptance response/);await first[Symbol.asyncDispose]();
 const record=spend('lightning-fund-0',pool,'1','01'.repeat(32));record.amount='999';record.body.publics[4]='999';record.expiresAt=q.expiresAt;await journal.create(record);
 const [artifact]=await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),pool),held=`shielded-lightning-${await lightningOwner(f.base)}-${pool}-${artifact!.id}`;f.live.add(held);
 t.mock.timers.enable({apis:['setTimeout']});
 const service=await createPrivateLightning(options);
 try{
  f.live.delete(held);t.mock.timers.tick(20_000);await flushTasks();t.mock.timers.tick(20_000);await flushTasks();
  assert.equal(errors.filter(e=>/does not match its accepted HTLC/.test(e.message)).length,1);
  assert.equal(f.live.has(held),false);assert.equal(f.funded.length,0);
 }finally{await service[Symbol.asyncDispose]();t.mock.timers.reset();}
});

test('a tab whose sibling holds legacy recovery still opens Lightning, and leaves legacy swaps to the sibling',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],address=await f.wallet.getAddress(),held=`shielded-lightning-legacy-${address}`;f.live.add(held);
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,onError:error=>errors.push(error)});
 try{assert.equal(f.repositories.has(`shielded-swaps-${address}`),false);assert.deepEqual(errors,[]);}
 finally{await service[Symbol.asyncDispose]();}
 assert.ok(f.live.has(held));
});

test('a legacy lock that fails for another reason is reported, and legacy recovery is skipped',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),errors:Error[]=[],address=await f.wallet.getAddress();
 const acquireSession=async(name:string)=>{if(name.startsWith('shielded-lightning-legacy-'))throw new Error('no browser locking');return f.acquireSession(name);};
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession,onError:error=>errors.push(error)});
 try{assert.equal(f.repositories.has(`shielded-swaps-${address}`),false);assert.deepEqual(errors.map(e=>e.message),['no browser locking']);}
 finally{await service[Symbol.asyncDispose]();}
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

test('a Lightning send offers the biggest spendable unreserved note, never one awaiting recovery, and nothing before the wallet can anchor',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository();let anchored=true;
 (f.wallet.inFlight as Set<bigint>).add(3n);
 Object.assign(f.wallet,{shieldedNotes:()=>[{amount:9000n,nullifier:1n},{amount:700n,nullifier:2n},{amount:800n,nullifier:3n}],
  account:{spendableNotes:(_asset:bigint,inFlight:ReadonlySet<bigint>)=>{if(!anchored)throw new Error('cannot anchor yet');return [{amount:700n,nullifier:2n},{amount:800n,nullifier:3n}].filter(n=>!inFlight.has(n.nullifier));}}});
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false});
 try{
  await service.quote({to:'invoice'});
  const view=f.configs.find(c=>c.policy?.drive==='manual')!.wallet;
  assert.equal((await view.getBalance()).available,700,'the 9000-sat note awaits recovery and the 800-sat one is reserved');
  anchored=false;assert.equal((await view.getBalance()).available,0);
 }finally{await service[Symbol.asyncDispose]();}
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

for(const disposeDuringRepair of [false,true])test(`live terminal receipt repair uses atomic IndexedDB persistence ${disposeDuringRepair?'while disposal waits':'and enriches payer history'}`,async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),poolName=`live-receipt-${crypto.randomUUID()}`,errors:Error[]=[];
 Object.assign(f.wallet.pool.status.pool!,{token:poolName});
 const preimage=new Uint8Array(32).fill(8),paymentHash=hex.encode(sha256(preimage)),funding='ab'.repeat(32),tx=new Transaction({allowUnknownInputs:true,allowUnknownOutputs:true});
 tx.addInput({txid:funding,index:1});tx.addOutput({script:script.pkScript,amount:1003n});setArkPsbtField(tx,0,ConditionWitness,[preimage]);
 let release!:()=>void,emit!:(update:SwapUpdate)=>void,repository!:LightningSwapRepository,name='',casEntered=false,committed=false,disposed=false,reads=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const repositoryFor=(db:string)=>{
  const store=new LightningSwapRepository(db);if(db.endsWith('-markets'))return store;
  repository=store;name=db;const save=store.saveSwapRecordIfUnchanged.bind(store),close=store[Symbol.asyncDispose].bind(store);
  store.saveSwapRecordIfUnchanged=async(expected,next)=>{casEntered=true;await gate;assert.equal(disposed,false);assert.ok(f.live.has(name));committed=await save(expected,next);return committed;};
  store[Symbol.asyncDispose]=async()=>{assert.equal(committed,true);disposed=true;await close();};return store;
 };
 const clientFactory=(config:SwapClientConfig)=>{
  const client=f.clientFactory(config);if(config.policy?.drive==='readonly')return client;
  return {...client,quote:async(input:Parameters<SwapClient['quote']>[0])=>({...await client.quote(input),lock:{hash:paymentHash}}),
   onUpdate:(listener:(update:SwapUpdate)=>void)=>{emit=listener;return client.onUpdate(listener);}} as SwapClient;
 };
 Object.assign(f.base,{indexerProvider:{getVtxos:async()=>{assert.ok(f.live.has(name));reads++;return {vtxos:[{txid:funding,vout:1,spentBy:tx.id,arkTxId:'bb'.repeat(32)}]};},getVirtualTxs:async()=>({txs:[base64.encode(tx.toPSBT())]})}});
 const service=await createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor,clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,onError:error=>errors.push(error)});
 let closing:Promise<void>|undefined;
 try{
  const quote=await service.quote({to:'invoice'}),accepted=await service.accept(quote);
  assert.equal(accepted.outcome,'open');assert.equal(f.starts.length,1);assert.equal(f.funded.length,1);assert.equal(reads,0);assert.equal(casEntered,false);
  const stored=await repository.getSwapRecord(quote.id);assert.ok(stored?.family==='rfq');assert.equal(stored.state,'created');
  const refunded={...stored,state:'refunded' as const,fundingTxid:funding,profile:{...stored.profile,custom:'preserve-live-metadata'}};
  await repository.saveSwapRecord(refunded);
  emit({swap:{...accepted,outcome:'refunded'},outcome:'refunded',detail:{family:'rfq',state:'refunded'}} as unknown as SwapUpdate);
  await flushTasks();assert.equal(casEntered,true);assert.equal(reads,1);const pending=await repository.getSwapRecord(quote.id);assert.ok(pending?.family==='rfq');assert.equal(pending.state,'refunded');
  if(disposeDuringRepair){closing=service[Symbol.asyncDispose]();await flushTasks();}
  assert.equal(disposed,false);assert.equal(committed,false);assert.ok(f.live.has(name));assert.equal(f.closed.length,0);
  release();if(closing)await closing;else await flushTasks();
  assert.equal(committed,true);assert.equal(disposed,true);assert.equal(f.live.size,0);assert.equal(f.funded.length,1);assert.deepEqual(errors,[]);
  const reopened=new LightningSwapRepository(name);
  try{
   const corrected=await reopened.getSwapRecord(quote.id);assert.ok(corrected?.family==='rfq');assert.equal(corrected.state,'settled');
   assert.equal(corrected.settlementPreimageHex,hex.encode(preimage));assert.equal(hex.encode(sha256(hex.decode(corrected.settlementPreimageHex!))),paymentHash);
   assert.deepEqual(corrected.profile,refunded.profile);assert.equal(corrected.fundingTxid,funding);assert.equal(corrected.refundTxid,undefined);
  }finally{await reopened[Symbol.asyncDispose]();}
  assert.equal((await journal.artifacts(hex.encode(await root.xOnlyPublicKey()),poolName))[0]!.state,'ended');
  if(!disposeDuringRepair){
   const history=await service.getActivityHistory();assert.equal(history.length,1);assert.equal(history[0]!.amount,-1003);assert.equal(history[0]!.intent?.outcome,'paid');assert.equal(history[0]!.intent?.metadata?.fundingTxid,funding);
   const withdrawal={...history[0]!,id:'pool-withdrawal',intent:{kind:'unshield' as const,label:'Withdrawn from the pool',metadata:{batch:146}}};
   const merged=pageActivityHistory([withdrawal],history);assert.equal(merged.length,1);assert.equal(merged[0]!.id,withdrawal.id);assert.equal(merged[0]!.intent?.label,'Paid via Lightning');assert.equal(merged[0]!.intent?.outcome,'paid');
   assert.equal(merged[0]!.amount,withdrawal.amount);assert.deepEqual(merged[0]!.txs,withdrawal.txs);assert.deepEqual(merged[0]!.intent?.metadata,withdrawal.intent.metadata);
  }
 }finally{release();await closing;await service[Symbol.asyncDispose]();}
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

const BTC='tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l';
const YOUNG_FEE={intentFee:{offchainInput:"inputType == 'vtxo' && now() - birth < 86400.0 ? amount * 0.002 : 0.0"},txFeeRate:'0'};
const payoutCoin=(script:string,value=20_041)=>({txid:'ab'.repeat(32),vout:0,value,script,createdAt:new Date(),status:{isLeaf:false},isSpent:false,isSwept:false,isUnrolled:false,isPreconfirmed:false,commitmentTxIds:['cd'.repeat(32)]});
const exitService=(f:ReturnType<typeof serviceFixture>,journal:LightningRepository,onError?:(error:Error)=>void)=>
 createPrivateLightning({wallet:f.wallet,companion:f.base,journal,repositoryFor:f.repositoryFor,clientFactory:f.clientFactory,acquireSession:f.acquireSession,legacyRecovery:false,...(onError?{onError}:{})});

test('an exit payout reserves a fresh HD key, persists it before the pool is asked, and holds it from the payout scan',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey());
 const service=await exitService(f,journal);
 try{
  const first=await service.exitPayout();
  const [saved,...rest]=await journal.artifacts(ownerKey,pool);
  assert.deepEqual([rest.length,saved?.kind,saved?.address],[0,'exit',first.address]);
  assert.deepEqual(await journal.payouts(ownerKey,pool),[{id:saved!.id,descriptor:saved!.descriptor!,address:saved!.address!,script:saved!.script!}],'durable before any withdrawal is submitted');
  assert.notEqual(first.address,await f.wallet.getAddress(),'never the static funding address deposits arrive at');
  const coin=payoutCoin(saved!.script!);f.base.getVtxos=async()=>[coin] as never;
  for(const listener of f.receivers)listener({type:'vtxo_received',contractScript:coin.script});
  await flushTasks();
  assert.equal(f.shielded.length,0,'a reserved payout is never shielded while its exit runs');
  assert.equal((await first.coin(coin.value))?.txid,coin.txid);
  assert.equal(await first.coin(coin.value+1),undefined,'only a coin of the withdrawn size counts as the payout');
  await first.release({spent:false});await flushTasks();
  assert.equal(f.shielded.length,1,'released unspent, it shields back into the pool like a stranded Lightning payout');
  assert.equal(f.shielded[0]![0].script,coin.script);
  const second=await service.exitPayout();
  assert.notEqual(second.address,first.address,'no two exits share a payout key');
  assert.deepEqual((await journal.artifacts(ownerKey,pool)).map(a=>a.index),[0,1]);
 }finally{await service[Symbol.asyncDispose]();}
});

test('an exit payout keyed to another server is refused before it is saved, watched or held, and a reload never watches it',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey()),body=new Uint8Array(32).fill(7);
 const service=await exitService(f,journal),contracts=f.contracts.length,held=f.live.size;
 try{
  await assert.rejects(service.exitPayout(new ArkAddress(await root.xOnlyPublicKey(),body,'tark').encode()),/another Arkade server/);
  const [refused]=await journal.artifacts(ownerKey,pool);
  assert.deepEqual([refused?.kind,refused?.state,refused?.descriptor],['exit','ended',undefined]);
  assert.deepEqual([await journal.payouts(ownerKey,pool),f.contracts.length,f.live.size],[[],contracts,held]);
  const payout=await service.exitPayout(new ArkAddress(server,body,'tark').encode());
  assert.equal((await journal.artifacts(ownerKey,pool))[1]?.address,payout.address);
  await payout.release({spent:true});
 }finally{await service[Symbol.asyncDispose]();}
 const restored=await exitService(f,journal);
 try{await flushTasks();assert.equal(f.contracts.some(c=>c.script===undefined||c.address===undefined),false);assert.deepEqual((await journal.payouts(ownerKey,pool)).length,1);}
 finally{await restored[Symbol.asyncDispose]();}
});

test('a spent exit payout is left alone, while a reload shields an unreleased one back into the pool',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey());
 const service=await exitService(f,journal);
 const payout=await service.exitPayout(),saved=(await journal.artifacts(ownerKey,pool))[0]!;
 await payout.release({spent:true});
 assert.equal(f.shielded.length,0,'a payout the exit spent is never shielded back');
 const stranded=await service.exitPayout(),second=(await journal.artifacts(ownerKey,pool))[1]!;
 assert.notEqual(stranded.address,payout.address);
 const coin=payoutCoin(second.script!);f.base.getVtxos=async()=>[coin] as never;
 await service[Symbol.asyncDispose]();
 assert.equal(f.shielded.length,0,'disposal alone shields nothing');
 const restored=await exitService(f,journal);
 try{
  await flushTasks();
  assert.equal(f.shielded.length,1,'startup re-registers the saved payout and shields it back');
  assert.equal(f.shielded[0]![0].script,coin.script);
 }finally{await restored[Symbol.asyncDispose]();}
});

test('the real onchain rail offboards an exit payout through the payout key the SDK resolves and signs with',async()=>{
 const journal=new InMemoryLightningRepository(),base=companion();
 const artifact=await materializeLightningArtifact(base,await journal.allocateArtifact(owner,pool,'exit'));
 const leaf=deriveDescriptorLeafPubKey(artifact.descriptor!);
 const payoutScript=new DefaultVtxo.Script({pubKey:leaf,serverPubKey:server,csvTimelock:sequenceToTimelock(Number(artifact.csvTimelock))});
 assert.equal(hex.encode(payoutScript.pkScript),artifact.script,'the watched script is the one this descriptor keys');
 // What Wallet.signerForDescriptor delegates to, so InputSignerRouter routes the payout input here.
 assert.deepEqual(await (await resolveDescriptorSigner(artifact.descriptor!,root)).xOnlyPublicKey(),leaf);
 const settled:any[]=[],signer=lightningSigner(base,artifact.descriptor!);
 const signing=Object.assign(companion(),{settle:async(params:any)=>{
  settled.push(params);
  const input=params.inputs[0],tx=new Transaction({allowUnknownOutputs:true});
  tx.addInput({txid:input.txid,index:input.vout,witnessUtxo:{script:payoutScript.pkScript,amount:BigInt(input.value)},tapLeafScript:[payoutScript.forfeit()]});
  tx.addOutput({script:payoutScript.pkScript,amount:params.outputs[0].amount});
  const signed=await signer.sign(tx,[0]);
  assert.deepEqual(signed.getInput(0).tapScriptSig![0]![0].pubKey,leaf,'the payout input carries the payout key signature');
  return 'ef'.repeat(32);
 }});
 const view=await artifactWallet(signing,artifact,async()=>{throw new Error('an exit offboards its payout; it never sends it');},()=>20_041);
 const coin=payoutCoin(artifact.script!);
 const quote=await onchainRail({feeInfo:async()=>YOUNG_FEE}).quote({raw:BTC,amount:20_000,selectedVtxos:[coin] as never},{wallet:view,prefs:{priority:['onchain']}} as never);
 assert.deepEqual([quote.amount,quote.fee,quote.total],[20_000,41,20_041],'the fresh key leaves the exit arithmetic alone');
 assert.equal((await (await quote.send()).settled()).txid,'ef'.repeat(32));
 assert.deepEqual(settled,[{inputs:[coin],outputs:[{address:BTC,amount:20_000n}]}],'only the payout coin, with no change output');
 await assert.rejects(view.send({address:BTC,amount:20_000} as never),/never sends it/);
});

test('a tab opened mid-exit skips the payout from the moment it is published, then shields it once released',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey()),errors:Error[]=[];
 const mine=await exitService(f,journal);
 try{
  const payout=await mine.exitPayout(),saved=(await journal.artifacts(ownerKey,pool))[0]!;
  const coin=payoutCoin(saved.script!);f.base.getVtxos=async()=>[coin] as never;
  // The other tab opens after the payout is published but before this exit has seen the coin.
  const other=await exitService(f,journal,error=>errors.push(error));
  try{
   await flushTasks();
   assert.equal(f.shielded.length,0,'the script reservation holds before coin() takes the outpoint lock');
   assert.equal((await payout.coin(coin.value))?.txid,coin.txid);
   for(const listener of f.receivers)listener({type:'vtxo_received',contractScript:coin.script});
   await flushTasks();
   assert.equal(f.shielded.length,0,'and still holds once the exit owns the coin');
   assert.deepEqual(errors,[],'the other tab skips quietly rather than failing the exit after the pool paid');
  }finally{await other[Symbol.asyncDispose]();}
  await payout.release({spent:false});await flushTasks();
  assert.equal(f.shielded.length,1,'once the exit releases it unspent, the payout shields back into the pool');
  assert.equal(f.shielded[0]![0].script,coin.script);
 }finally{await mine[Symbol.asyncDispose]();}
});

test('a completed exit leaves no payout row in history, while a stranded payout still shows one',async()=>{
 const f=serviceFixture(),journal=new InMemoryLightningRepository(),ownerKey=hex.encode(await root.xOnlyPublicKey());
 const service=await exitService(f,journal);
 const rowsOf=async()=>(await service.getActivityHistory()).filter(row=>row.intent?.kind==='lightning-receive');
 try{
  const done=await service.exitPayout(),spent=(await journal.artifacts(ownerKey,pool))[0]!;
  f.contracts.find(c=>c.script===spent.script)!.vtxos=[{...payoutCoin(spent.script!),isSpent:true,spentBy:'ef'.repeat(32)}];
  await done.release({spent:true});
  assert.deepEqual(await rowsOf(),[],'the offboard already spent it, and the SDK history carries that spend');
  const stranded=await service.exitPayout(),unspent=(await journal.artifacts(ownerKey,pool))[1]!;
  f.contracts.find(c=>c.script===unspent.script)!.vtxos=[payoutCoin(unspent.script!)];
  await stranded.release({spent:false});
  const rows=await rowsOf();
  assert.equal(rows.length,1,'a payout still sitting on its key stays visible for recovery');
  assert.deepEqual([rows[0]!.intent?.label,rows[0]!.amount],['On-chain exit payout',20_041]);
 }finally{await service[Symbol.asyncDispose]();}
});
