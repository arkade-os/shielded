import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {test} from 'node:test';
import {ArkAddress,InMemoryContractRepository,InMemoryWalletRepository,SingleKey,VtxoScript,type ExtendedVirtualCoin} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import info from './fixtures/ark-info.json' with {type:'json'};
import {fullViewOf} from '../app/src/Disclose.tsx';
import * as prover from '../app/src/shielded-prover.ts';
import {fullViewKeyOf,parseFullViewKey} from '../packages/protocol/src/rollup/disclosure.ts';
import {anchorOf} from '../packages/protocol/src/rollup/epoch.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {akOf,assetFieldOfId} from '../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import type {LightningSpendRecord,LightningSpendStore} from '../src/shielded/lightning-spend.ts';
import {epochTransferBody} from '../src/shielded/epoch-pool.ts';
import {RECOVERY_LINE} from '../src/shielded/epoch-recovery.ts';
import {epochCatchUp} from '../src/shielded/epoch-sync.ts';
import {poolApiOf,transferBody,type PoolApi,type RollupPoolStatus} from '../src/shielded/pool.ts';
import {ShieldedWallet,loadAccount,shieldedKeysOf} from '../src/shielded/wallet.ts';
import {epochPool,fromBody,type PoolSpend} from './fixtures/epoch-pool.ts';
import {hash,keySet,listen,offline,proof,ready,scratch} from './fixtures/epoch-service.ts';

const TOKEN='2df7aa3628161299e03ef35e71916d68952490aa7b37423e358ab32bbe26a7de0000',ASSET='ee'.repeat(34);
const POOL_ADDRESS='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const pool=ArkAddress.decode(POOL_ADDRESS),elsewhere=new ArkAddress(pool.serverPubKey,new Uint8Array(32).fill(9),pool.hrp).encode();
const answer=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
type Body={id:string;slot:Record<string,unknown>};

/** The fake epoch pool behind a fetch: every POST /spends body is kept and must pass the epoch parser and the operator's anchor comparison; a poll lands what is queued, a recovery as its own batch. */
function walletPool(epochLen=4){
 const fake=epochPool(hash,epochLen),bodies:Body[]=[],refused:string[]=[],queued:{id:string;spend:PoolSpend}[]=[],landed=new Map<string,{batch:number;txid:string}>();
 let gate=Promise.resolve();
 const fetcher=(async(url:string,init?:RequestInit)=>{
  const path=String(url).replace('/api/rollup',''),polled=/^\/spends\/([0-9a-f]+)$/.exec(path)?.[1];
  if(init?.method==='POST'&&path==='/spends'){
   const body=JSON.parse(String(init.body));bodies.push(body);
   if('root' in body.slot)return answer(400,{error:'An epoch slot names its anchor, not a root.'});
   let spend:PoolSpend;
   try{const {slot,publics,ciphertext}=fromBody(body);spend={slot,publics,ciphertext};}
   catch(error){return answer(400,{error:(error as Error).message});}
   if(spend.slot.rCur&&spend.slot.anchor!==anchorOf(hash,fake.state.nextAnchorRoot(),spend.slot.rCur.root)){refused.push(body.id);return answer(400,{error:'The spend opens against another previous-epoch root than the next batch does; prove it again.',code:'stale-anchor'});}
   queued.push({id:body.id,spend});
   return answer(202,{id:body.id,status:'pending'});
  }
  if(polled){
   await gate;
   if(queued.some(q=>q.id===polled)){
    const all=queued.splice(0),kindOf=({slot}:PoolSpend)=>slot.origin!==undefined?'recover':slot.nullifiers.length===2?'join':'spend';
    for(const kind of ['spend','join','recover'] as const){
     const mine=all.filter(q=>kindOf(q.spend)===kind);
     for(const part of kind==='recover'?mine.map(q=>[q]):mine.length?[mine]:[]){const record=fake.land(kind,part.map(q=>q.spend));for(const q of part)landed.set(q.id,{batch:fake.records.length-1,txid:record.txid!});}
    }
   }
   const done=landed.get(polled);return done?answer(200,{status:'included',...done}):answer(404,{error:'Unknown spend.'});
  }
  try{
   const body=await fake.api<Record<string,any>>(path);
   return answer(200,path==='/status'?{...body,pool:{...body.pool,token:TOKEN,address:POOL_ADDRESS,script:hex.encode(pool.pkScript),reserves:{[ASSET]:'reserve'}}}:body);
  }catch(error){return answer((error as {status?:number}).status??400,{error:(error as Error).message});}
 }) as unknown as typeof fetch;
 /** Polls wait until the returned function is called. */
 const hold=()=>{let open!:()=>void;gate=new Promise<void>(resolve=>{open=resolve;});return open;};
 return {fake,bodies,refused,fetcher,hold};
}
const openWallet=async(fetcher:typeof fetch,store:LightningSpendStore,seed='11')=>ShieldedWallet.create({identity:SingleKey.fromHex(seed.repeat(32)),walletMode:'static',settlementConfig:false,
 storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
 arkProvider:{serverUrl:'https://mutinynet.arkade.sh',getInfo:async()=>info} as never,
 indexerProvider:{getVtxos:async()=>({vtxos:[]}),getVirtualTxs:async()=>({txs:[]}),subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never,
 onchainProvider:{getCoins:async()=>[],getTransactions:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never,
 pool:{origin:'',status:await (await fetcher('/api/rollup/status')).json() as RollupPoolStatus},secret:seed.repeat(32),hash,prover:{prove:async()=>proof},fetcher,lightningSpendStore:store});
const memoryStore=():LightningSpendStore=>{
 const rows=new Map<string,LightningSpendRecord>();
 return {get:async(_o,_p,id)=>rows.get(id),list:async()=>[...rows.values()],create:async r=>{rows.set(r.id,r);return r;},finish:async(_o,_p,id,result)=>{rows.set(id,{...rows.get(id)!,...result});}};
};
/** One watchdog tick, with no timer left behind; the upkeep it starts is decided once `decided` resolves. */
const tick=async(wallet:ShieldedWallet)=>{clearTimeout((wallet as any).timer);await (wallet as any).tick();clearTimeout((wallet as any).timer);};
const decided=(wallet:ShieldedWallet)=>wallet.notes.pick(async()=>undefined,()=>[]);
const until=async(ok:()=>boolean,what:string)=>{for(let i=0;i<500&&!ok();i++)await sleep(10);assert.ok(ok(),what);};
const bobAddress=()=>{const bob=deriveRollupKeys2('22'.repeat(32),'mutinynet');return rollupAddressOf(rollupRecipientOf(hash,bob.ask,bob.nk,bob.viewSecret));};
const lightningPayout=async()=>{
 const child=SingleKey.fromHex('44'.repeat(32)),tree=new VtxoScript([hex.decode('20'+hex.encode(await child.xOnlyPublicKey())+'ac')]);
 const coin:ExtendedVirtualCoin={txid:'ab'.repeat(32),vout:1,value:1000,status:{confirmed:true},script:hex.encode(tree.pkScript),createdAt:new Date(),isUnrolled:false,tapTree:tree.encode(),intentTapLeafScript:tree.leaves[0]!,forfeitTapLeafScript:tree.leaves[0]!};
 return {coin,child};
};

test('no spend body built by the wallet carries slot.root, and every one carries slot.anchor',async()=>{
 const {fake,bodies,fetcher,hold}=walletPool(8),{self}=shieldedKeysOf(hash,'11'.repeat(32)),journal=memoryStore(),payout=await lightningPayout();
 fake.land('spend',[await fake.deposit(self,1000n),await fake.deposit(self,500n)]);
 const wallet=await openWallet(fetcher,journal);
 (wallet as any).depositCoin=async(txid:string,value:number,_asset:unknown,vout=0)=>({txid,vout,value,tapTree:'aa',leaf:'bb'});
 try{
  assert.equal(wallet.shieldedBalance(),1500n);
  await (await wallet.pay(bobAddress(),100n)).settled();
  await (await wallet.withdraw(elsewhere,330n)).settled();
  await (await wallet.mintLink(200n)).settled();
  await (await wallet.claimLink(wallet.links()[0]!.token)).settled();
  await wallet.fundLightning('ln-1','33'.repeat(32),elsewhere,330n,journal);
  const consolidate=wallet.account.consolidate.bind(wallet.account);
  wallet.account.consolidate=(to,asset,inFlight)=>consolidate(to,asset,inFlight,1);
  await (await wallet.merge())!.settled();
  delete (wallet.account as Partial<EpochAccount>).consolidate;
  await (await wallet.shield([{txid:'dd'.repeat(32),vout:0,value:600}]))!.settled();
  await (await wallet.shield([{txid:'ee'.repeat(32),vout:0,value:330,assets:[{assetId:ASSET,amount:50n}]}]))!.settled();
  await (await wallet.withdraw(elsewhere,20n,{asset:ASSET,sats:330n})).settled();
  await (await wallet.shieldLightning(payout.coin,payout.child,journal,{id:'ln-2',reference:`${payout.coin.txid}:${payout.coin.vout}`})).settled();
  // The last batch of epoch 2: the note shielded in epoch 1 is due for renewal, and the epoch-0 notes need a recovery.
  while(fake.state.batchCount<23)fake.land();
  const open=hold();await tick(wallet);await until(()=>bodies.length===14,'the renewal and the recovery posted');open();
  await until(()=>wallet.batchCount()===25,'both landed, and the wallet synced them');
  assert.equal(bodies.length,14,'pay, withdraw, mint, claim, Lightning funding, merge, BTC shield, asset shield (2), asset withdraw (2), Lightning shield, renewal and recovery');
  for(const body of bodies)assert.deepEqual(['root' in body.slot,'anchor' in body.slot,'rCur' in body.slot!=='origin' in body.slot],[false,true,true],JSON.stringify(body.slot));
  assert.deepEqual([bodies.filter(b=>'origin' in b.slot).length,fake.records.at(-1)!.kind],[1,'recover']);
 }finally{await wallet.dispose();}
});

test('withdraw picks a spendable note when a smaller one is recovering',async()=>{
 const {fake,bodies,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),journal=memoryStore();
 fake.land('spend',[await fake.deposit(self,400n),await fake.deposit(self,2000n)]);
 while(fake.state.batchCount<8)fake.land();
 fake.land('spend',[await fake.deposit(self,1000n)]);
 const wallet=await openWallet(fetcher,journal),[small,large,live]=wallet.account.notes();
 try{
  assert.deepEqual([small,large,live].map(n=>[n!.epoch,n!.amount]),[[0,400n],[0,2000n],[2,1000n]]);
  assert.deepEqual([wallet.maxPrivatePayment(),wallet.canWithdraw(1000n),wallet.canWithdraw(1500n)],[1000n,true,false],'a recovering note is held, never spendable');
  await (await wallet.withdraw(elsewhere,330n)).settled();
  assert.deepEqual(bodies.at(-1)!.slot.nullifiers,[String(live!.nullifier)]);
  await wallet.fundLightning('ln-1','33'.repeat(32),elsewhere,330n,journal);
  assert.deepEqual([bodies.length,wallet.shieldedBalance()],[2,2740n]);
 }finally{await wallet.dispose();}
});

test('a wallet holding a note in its last epoch renews it once, as a join, at a spread point',async t=>{
 const {fake,bodies,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),draw=globalThis.crypto.getRandomValues.bind(globalThis.crypto);
 // renewalDue draws one 32-bit word; a half puts the target of a note first seen at batch 0 of a 4-batch epoch at batch 1.
 t.mock.method(globalThis.crypto,'getRandomValues',((w:ArrayBufferView)=>w instanceof Uint32Array&&w.length===1?(w[0]=2**31,w):draw(w as never)) as never);
 fake.land('spend',[await fake.deposit(self,300n),await fake.deposit(self,100n)]);
 while(fake.state.batchCount<4)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),due=wallet.account.notes();
 try{
  await tick(wallet);await decided(wallet);
  assert.equal(bodies.length,0,'not at first sight');
  fake.land();await tick(wallet);await until(()=>bodies.length===1&&wallet.inFlight.size===0,'renewed at its target');
  await tick(wallet);await decided(wallet);
  assert.equal(bodies.length,1,'once');
  assert.deepEqual([[...bodies[0]!.slot.nullifiers as string[]].sort(),'rCur' in bodies[0]!.slot,fake.records.length,fake.records.at(-1)!.kind],[due.map(n=>String(n.nullifier)).sort(),true,6,'join']);
  assert.deepEqual(wallet.account.notes().map(n=>[n.epoch,n.amount]),[[1,400n]]);
 }finally{await wallet.dispose();}
});

test('a payment holding one due note leaves the other due notes to renew',async t=>{
 const {fake,bodies,fetcher,hold}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),draw=globalThis.crypto.getRandomValues.bind(globalThis.crypto);
 t.mock.method(globalThis.crypto,'getRandomValues',((w:ArrayBufferView)=>w instanceof Uint32Array&&w.length===1?(w[0]=0,w):draw(w as never)) as never);
 fake.land('spend',await Promise.all([100n,300n,700n].map(amount=>fake.deposit(self,amount))));
 while(fake.state.batchCount<4)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),[small,mid,large]=wallet.account.notes();
 try{
  const open=hold();await wallet.pay(bobAddress(),600n);await until(()=>bodies.length===1,'the payment posted');
  await tick(wallet);await until(()=>bodies.length===2,'the renewal posted');open();
  assert.deepEqual(bodies.map(b=>[...b.slot.nullifiers as string[]].sort()),[[large],[small,mid]].map(notes=>notes.map(n=>String(n!.nullifier)).sort()));
  await until(()=>wallet.inFlight.size===0,'both landed');
 }finally{await wallet.dispose();}
});

test('while one renewal is in flight no second plan starts, and the next follows once it lands',async t=>{
 const {fake,bodies,fetcher,hold}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),draw=globalThis.crypto.getRandomValues.bind(globalThis.crypto);
 t.mock.method(globalThis.crypto,'getRandomValues',((w:ArrayBufferView)=>w instanceof Uint32Array&&w.length===1?(w[0]=0,w):draw(w as never)) as never);
 fake.land('spend',await Promise.all([100n,300n,700n].map(amount=>fake.deposit(self,amount))));
 while(fake.state.batchCount<4)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),[small,mid,large]=wallet.account.notes();
 try{
  const open=hold();await tick(wallet);await until(()=>bodies.length===1,'the first renewal posted');
  await tick(wallet);await decided(wallet);
  assert.deepEqual([bodies.length,wallet.inFlight],[1,new Set([small!.nullifier,mid!.nullifier])],'no second plan while the first is in flight');
  open();await until(()=>wallet.inFlight.size===0,'the first renewal landed');
  await tick(wallet);await until(()=>bodies.length===2,'the next renewal posted');
  assert.deepEqual(bodies[1]!.slot.nullifiers,[String(large!.nullifier)]);
 }finally{await wallet.dispose();}
});

test('a wallet holding a note two epochs old recovers it, and shows one line while it does',async()=>{
 const {fake,bodies,fetcher,hold}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),announced:unknown[]=[];
 fake.land('spend',[await fake.deposit(self,500n)]);
 while(fake.state.batchCount<9)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),[old]=wallet.account.notes();
 wallet.onAction(handle=>announced.push(handle));
 try{
  assert.deepEqual([old!.epoch,wallet.recovering,RECOVERY_LINE],[0,[old],'Recovering an older note']);
  assert.deepEqual(wallet.recoveryInFlight,[],'it needs a recovery, and none is running yet');
  const open=hold();await tick(wallet);await until(()=>bodies.length===1,'the recovery posted');
  assert.deepEqual([wallet.recovering,wallet.inFlight.has(old!.nullifier)],[[old],true],'the line stays while the recovery is in flight');
  assert.deepEqual(wallet.recoveryInFlight,[old],'now it is recovering');
  open();await until(()=>wallet.inFlight.size===0,'the recovery landed');
  const [fresh]=wallet.account.notes();
  assert.deepEqual([bodies[0]!.slot.origin,'rCur' in bodies[0]!.slot,fake.records.at(-1)!.kind],[0,false,'recover']);
  assert.deepEqual([wallet.recovering,fresh!.epoch,wallet.shieldedBalance(),wallet.shieldedHistory().at(-1)!.kind,announced],[[],2,500n,'recover',[]],'one line, and no step sheet');
 }finally{await wallet.dispose();}
});

test('a group whose legs straddle a rotation is rebuilt whole, not re-signed leg by leg',async()=>{
 const {fake,bodies,refused,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),built:EpochBuiltSpend[]=[];
 fake.land('spend',await Promise.all([400n,300n,200n].map(amount=>fake.deposit(self,amount))));
 while(fake.state.batchCount<3)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),spend=wallet.account.spend.bind(wallet.account);
 // A sync between the legs lands the epoch's last batch, so only the first leg holds the old previous-epoch root.
 wallet.account.spend=async(...args)=>{const leg=await spend(...args);built.push(leg);if(built.length===1){fake.land();await wallet.sync();}return leg;};
 try{
  await (await wallet.pay(bobAddress(),600n)).settled();
  const digest=(s:{slot:object})=>String((s.slot as {ctDigest:unknown}).ctDigest);
  assert.deepEqual([refused.length,built.length,bodies.length],[1,4,3],'one stale-anchor, then both legs built again');
  assert.deepEqual(bodies.map(digest),[built[0]!,built[2]!,built[3]!].map(digest),'the refused leg, then a fresh group; the second leg as first built is never posted');
  assert.deepEqual([wallet.shieldedBalance(),wallet.inFlight.size],[300n,0]);
 }finally{await wallet.dispose();}
});

test('a rebuilt asset payment keeps to the note it holds when the pool status names no reserve for its asset',async()=>{
 const {fake,bodies,refused,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),field=assetFieldOfId(ASSET);
 fake.land('spend',await Promise.all([100n,50n].map(deposit=>fake.transfer({ask:0n,nk:0n,self,request:{asset:field,deposit}}))));
 while(fake.state.batchCount<3)fake.land();
 const wallet=await openWallet(fetcher,memoryStore()),notes=wallet.account.notes(field),spend=wallet.account.spend.bind(wallet.account);
 const held=notes.find(n=>n.amount===100n)!,other=notes.find(n=>n.amount===50n)!;
 // Another action holds the smaller note, and a rotation lands right after the first build.
 wallet.notes.inFlight.add(other.nullifier);delete wallet.pool.status.pool!.reserves;
 let built=0;wallet.account.spend=async(...args)=>{const leg=await spend(...args);if(!built++)fake.land();return leg;};
 try{
  await (await wallet.pay(bobAddress(),50n,ASSET)).settled();
  assert.deepEqual([refused.length,bodies.map(b=>b.slot.nullifiers)],[1,[[String(held.nullifier)],[String(held.nullifier)]]]);
  assert.equal(wallet.inFlight.has(other.nullifier),true);
 }finally{await wallet.dispose();}
});

test('a Lightning funding refused as stale after a rotation is dropped and frees its note, so the reopened wallet funds afresh',async()=>{
 const {fake,bodies,refused,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),journal=memoryStore();
 const fund=(id:string,w:ShieldedWallet)=>w.fundLightning(id,'33'.repeat(32),elsewhere,330n,journal);
 fake.land('spend',[await fake.deposit(self,1000n)]);
 let wallet=await openWallet(fetcher,journal);
 try{
  const api=wallet.api,[note]=wallet.account.notes();
  wallet.api=(async(path:string)=>{if(path.startsWith('/spends/'))throw Object.assign(new Error('Unknown spend.'),{status:404});throw new Error('response lost');}) as PoolApi;
  await assert.rejects(fund('ln-1',wallet),/response lost/);
  wallet.api=api;
  while(fake.state.batchCount<4)fake.land();
  await assert.rejects(fund('ln-1',wallet),/prove it again/);
  assert.deepEqual([refused.length,(await journal.get('','','ln-1'))!.state,wallet.inFlight.has(note!.nullifier)],[1,'dropped',false]);
  await wallet.dispose();wallet=await openWallet(fetcher,journal);
  assert.equal(wallet.inFlight.has(note!.nullifier),false);
  await fund('ln-2',wallet);
  assert.deepEqual([bodies.length,bodies[1]!.slot.nullifiers,bodies[1]!.slot.anchor!==bodies[0]!.slot.anchor],[2,[String(note!.nullifier)],true]);
 }finally{await wallet.dispose();}
});

test('a first-run wallet whose pool is unreachable opens empty with an error, not a throw',async()=>{
 const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),down=(async()=>{throw new Error('The pool did not answer (network error).');}) as PoolApi;
 const loaded=await loadAccount(hash,keys,{token:TOKEN,epochLen:128,bornAt:7,api:down});
 assert.deepEqual([loaded.resumed,loaded.offline,loaded.account.batchCount,loaded.account.epochLen,loaded.account.notes()],[false,true,0,128,[]]);
 assert.match(loaded.error!,/did not answer/);
 await assert.rejects(loadAccount(hash,keys,{token:TOKEN,bornAt:7,api:down}),/did not answer/,'with no cached epoch length, the error state rather than an invented one');
});

test('a claim link claimed two epochs late recovers to the claimer',async()=>{
 const {fake,bodies,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32));
 fake.land('spend',[await fake.deposit(self,1000n)]);
 const alice=await openWallet(fetcher,memoryStore());
 let bob:ShieldedWallet|undefined;
 try{
  await (await alice.mintLink(300n)).settled();
  const [link]=alice.links();
  while(fake.state.batchCount<9)fake.land();
  bob=await openWallet(fetcher,memoryStore(),'22');
  await (await bob.claimLink(link!.token)).settled();
  await alice.sync();
  assert.deepEqual([bodies.at(-1)!.slot.origin,'rCur' in bodies.at(-1)!.slot,fake.records.at(-1)!.kind],[0,false,'recover']);
  assert.deepEqual([bob.shieldedBalance(),bob.account.notes().map(n=>n.epoch),alice.links()[0]!.state],[300n,[2],'claimed']);
 }finally{await alice.dispose();await bob?.dispose();}
});

test('the /watch full viewing key replays with EpochAccount, which refuses a record whose commitments do not rebuild its block root',async()=>{
 const fake=epochPool(hash,4),keys=deriveRollupKeys2('11'.repeat(32),'mutinynet');
 fake.land('spend',[await fake.deposit(rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret),700n)]);
 const key=parseFullViewKey(hash,fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret));
 assert.deepEqual((await fullViewOf(hash,key,fake.api)).notes().map(n=>[n.epoch,n.amount]),[[0,700n]]);
 // A padding slot's leaf, so the note itself still opens.
 const [record]=fake.records,tampered={...record!,slots:record!.slots.map((s,i)=>i===1?{...s,commitments:['1',s.commitments[1]] as [string,string]}:s)};
 const api=(async(path:string)=>path.startsWith('/batches')?{total:1,batches:[tampered]}:fake.api(path)) as PoolApi;
 await assert.rejects(fullViewOf(hash,key,api),/do not rebuild the block root/);
});

let served:ReturnType<typeof serve>|undefined;
const serve=async()=>{
 const request=await listen(await ready(offline(),scratch('rollup-wire-guard-'),keySet('epoch'),'64'));
 const origin=`http://127.0.0.1:${(request.server.address() as AddressInfo).port}`;
 return {request,origin,api:poolApiOf(origin)};
};
const service=()=>served??=serve();

test('a classic transferBody body is refused by the epoch /spends parser',async()=>{
 const {request,api}=await service(),keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),account=EpochAccount.owning(hash,keys,{epochLen:64});
 await epochCatchUp(account,api);
 const built=await account.spend({deposit:0n},rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret)),id=()=>randomBytes(16).toString('hex');
 const post=async(body:unknown)=>{const r=await request('/api/rollup/spends',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return [r.status,await r.json()];};
 assert.deepEqual(await post(transferBody(id(),built,proof)),[400,{error:'An epoch slot names its anchor, not a root.'}]);
 const epoch=epochTransferBody(id(),built,proof);
 assert.deepEqual(await post(epoch),[202,{id:epoch.id,status:'pending'}],'the same spend in the epoch body is admitted');
});

test('the browser prover asks for epoch-spend.wasm, and the classic name 404s on the same pool',async t=>{
 const {origin,api}=await service(),status=await api<RollupPoolStatus>('/status'),real=globalThis.fetch,asked:string[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{const r=await real(origin+String(url));asked.push(`${String(url).split('?')[0]} ${r.status}`);return r;});
 const built={witness:{input:{},slot:{nullifiers:[1n]}},slot:{nullifiers:[1n]}} as unknown as EpochBuiltSpend;
 // The served files are stand-ins, so snarkjs refuses them; only what was asked for, and the answer, matter here.
 await prover.browserProver(()=>status).prove(built,'spend').catch(()=>{});
 prover.prefetchProvingKeys(status,'join');
 for(let i=0;i<200&&asked.length<4;i++)await sleep(10);
 assert.deepEqual(asked.sort(),['epoch-join.wasm','epoch-join.zkey','epoch-spend.wasm','epoch-spend.zkey'].map(file=>`/api/rollup/proving/${file} 200`));
 for(const file of ['spend.wasm','spend.zkey','join.wasm','join.zkey'])assert.equal((await real(`${origin}/api/rollup/proving/${file}`)).status,404,file);
});
