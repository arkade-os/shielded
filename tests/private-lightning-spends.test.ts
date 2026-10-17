import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,DefaultVtxo,InMemoryContractRepository,InMemoryWalletRepository,SingleKey,Transaction,VtxoScript,type ExtendedVirtualCoin} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {Script} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import info from './fixtures/ark-info.json' with {type:'json'};
import type {BuiltSpend,PublishedSlot} from '../packages/protocol/src/rollup/account.ts';
import {lightningSpendConflict,sameLightningSpendRequest,validateLightningSpend,type LightningSpendRecord,type LightningSpendStore} from '../src/shielded/lightning-spend.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {ShieldedWallet,type ShieldedProver} from '../src/shielded/wallet.ts';
import {rollupApi,type PoolApi,type RollupPoolStatus} from '../src/shielded/pool.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const TOKEN='2df7aa3628161299e03ef35e71916d68952490aa7b37423e358ab32bbe26a7de0000';
const ADDRESS='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const SCRIPT=hex.encode(ArkAddress.decode(ADDRESS).pkScript),PAYMENT='33'.repeat(32),TXID='44'.repeat(32);
const destination=(()=>{const a=ArkAddress.decode(ADDRESS);return new ArkAddress(a.serverPubKey,new Uint8Array(32).fill(9),a.hrp).encode();})();
const status:RollupPoolStatus={phase:'ready',message:'',pool:{token:TOKEN,address:ADDRESS,script:SCRIPT,batches:0,root:'0',head:{txid:'ab'.repeat(32),vout:0,value:1000},pending:0,padding:0,reserves:{}}};
const prover:ShieldedProver={prove:async()=>({pi_a:[],pi_b:[],pi_c:[]})};
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
class Store implements LightningSpendStore {
 readonly rows=new Map<string,LightningSpendRecord>();
 async get(owner:string,pool:string,id:string){const r=this.rows.get(id);return r&&r.owner===owner&&r.pool===pool?clone(r):undefined;}
 async list(owner:string,pool:string){return [...this.rows.values()].filter(r=>r.owner===owner&&r.pool===pool).map(clone);}
 async create(record:LightningSpendRecord){
  validateLightningSpend(record,record.owner,record.pool);
  const existing=this.rows.get(record.id);
  if(existing){if(!sameLightningSpendRequest(existing,record))throw new Error('Mismatched Lightning request.');return clone(existing);}
  if([...this.rows.values()].some(r=>lightningSpendConflict(r,record)))throw new Error('A Lightning spend already reserves these funds or payment.');
  this.rows.set(record.id,clone(record));return clone(record);
 }
 async finish(owner:string,pool:string,id:string,result:{state:'included'|'dropped';txid?:string;reason?:string}){const r=(await this.get(owner,pool,id))!;this.rows.set(id,{...r,...result});}
}
async function open(store:LightningSpendStore,repository=new InMemoryShieldedNoteRepository(),p=prover){
 return ShieldedWallet.create({identity:SingleKey.fromHex('11'.repeat(32)),walletMode:'static',settlementConfig:false,
  storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
  arkProvider:{serverUrl:'https://mutinynet.arkade.sh',getInfo:async()=>info} as never,
  indexerProvider:{getVtxos:async()=>({vtxos:[]}),getVirtualTxs:async()=>({txs:[]}),subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never,
  onchainProvider:{getCoins:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never,
  pool:{origin:'',status},secret:'11'.repeat(32),hash,prover:p,shieldedRepository:repository,lightningSpendStore:store,
  fetcher:(async()=>new Response(JSON.stringify({total:0,batches:[]}))) as typeof fetch});
}
const published=({witness,ciphertext}:BuiltSpend):PublishedSlot=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:String(witness.slot.groupId),groupSize:witness.slot.groupSize,publics:witness.publicSignals.map(String),ciphertext:hex.encode(ciphertext)});
async function fund(wallet:ShieldedWallet,amounts=[900n]){const deposits=await Promise.all(amounts.map(deposit=>wallet.account.spend({deposit},wallet.self)));await wallet.account.apply({kind:'spend',slots:deposits.map(published),txid:'de'.repeat(32)});await wallet.save();}
const missing=()=>Object.assign(new Error('Unknown spend after restart.'),{status:404});
function includedApi(onPost:(body:unknown)=>void=()=>{}):PoolApi {
 let posted=false;
 return (async(path:string,body?:unknown)=>{
  if(path.startsWith('/batches'))return {total:1,batches:[]};
  if(path==='/spends'){posted=true;onPost(body);return {};}
  if(!posted)throw missing();
  return {status:'included',txid:TXID};
 }) as PoolApi;
}

test('Lightning funding persists one exact private withdrawal before POST and never reads ordinary coins',async()=>{
 const store=new Store(),wallet=await open(store);let posts=0,proofs=0;
 try{
  await fund(wallet,[400n,900n]);
  wallet.prover={prove:async()=>{proofs++;return prover.prove(undefined as never,'spend');}};
  wallet.getSpendableVtxos=async()=>{throw new Error('ordinary coins touched');};wallet.send=async()=>{throw new Error('native send touched');};
  wallet.api=includedApi(body=>{posts++;const saved=store.rows.get('fund-1')!;assert.deepEqual(body,saved.body);assert.equal(saved.state,'prepared');assert.equal(saved.destination,destination);assert.equal(saved.amount,'700');assert.equal(saved.body.program,hex.encode(ArkAddress.decode(destination).pkScript.subarray(2)));assert.equal(saved.nullifiers.length,1);assert.equal(saved.body.publics[4],'700');});
  assert.equal(await wallet.fundLightning('fund-1',PAYMENT,destination,700n,store),TXID);
  assert.equal(store.rows.get('fund-1')!.state,'included');assert.equal(posts,1);assert.equal(proofs,1);
  assert.equal(await wallet.fundLightning('fund-1',PAYMENT,destination,700n,store),TXID);assert.equal(posts,1);assert.equal(proofs,1);
  await assert.rejects(wallet.fundLightning('fund-1',PAYMENT,destination,600n,store),/mismatch|different/i);
  await assert.rejects(wallet.fundLightning('fund-2',PAYMENT,destination,330n,store),/already|payment/i);assert.equal(posts,1);
 }finally{await wallet.dispose();}
});

test('a lost response and reload retain reservations and replay the same proof, id, and nullifier',async()=>{
 const store=new Store(),repository=new InMemoryShieldedNoteRepository();let proofs=0;
 const p:ShieldedProver={prove:async()=>{proofs++;return prover.prove(undefined as never,'spend');}};
 let wallet=await open(store,repository,p),saved:LightningSpendRecord;
 try{
  await fund(wallet);
  wallet.api=(async(path:string)=>{if(path.startsWith('/spends/'))throw missing();throw new Error('response lost');}) as PoolApi;
  await assert.rejects(wallet.fundLightning('lost',PAYMENT,destination,700n,store),/response lost/);
  saved=clone(store.rows.get('lost')!);assert.equal(wallet.inFlight.has(BigInt(saved.nullifiers[0]!)),true);
  await wallet.dispose();wallet=await open(store,repository,p);
  assert.equal(wallet.inFlight.has(BigInt(saved.nullifiers[0]!)),true);assert.equal(wallet.canWithdraw(700n),false);
  wallet.api=includedApi(body=>assert.deepEqual(body,saved.body));
  assert.equal(await wallet.fundLightning('lost',PAYMENT,destination,700n,store),TXID);assert.equal(proofs,1);
  assert.deepEqual(store.rows.get('lost')!.body,saved.body);
 }finally{await wallet.dispose();}
});

test('failed durable writes submit nothing, and ambiguous polls never release or select a replacement',async()=>{
 const store=new Store(),wallet=await open(store);let posts=0;
 try{
  await fund(wallet,[900n,1000n]);wallet.api=(async()=>{posts++;throw new Error('unexpected POST');}) as PoolApi;
  const create=store.create.bind(store);store.create=async()=>{throw new Error('disk full');};
  await assert.rejects(wallet.fundLightning('failure',PAYMENT,destination,700n,store),/disk full/);assert.equal(posts,0);
  store.create=create;wallet.api=(async(path:string)=>{if(path==='/spends'){posts++;return {};}throw missing();}) as PoolApi;
  await assert.rejects(wallet.fundLightning('pending',PAYMENT,destination,700n,store),/Unknown spend/);
  const saved=clone(store.rows.get('pending')!);
  await assert.rejects(wallet.fundLightning('pending',PAYMENT,destination,700n,store),/Unknown spend/);
  assert.deepEqual(store.rows.get('pending')!.body,saved.body);assert.equal(wallet.inFlight.has(BigInt(saved.nullifiers[0]!)),true);assert.equal(posts,2);
 }finally{await wallet.dispose();}
});

test('only an explicit dropped status releases a Lightning reservation; retry needs a new artifact',async()=>{
 const store=new Store(),wallet=await open(store);
 try{
  await fund(wallet);wallet.api=(async(path:string)=>path==='/spends'?{}:{status:'dropped',reason:'conclusively refused'}) as PoolApi;
  await assert.rejects(wallet.fundLightning('dropped',PAYMENT,destination,700n,store),/conclusively refused/);
  assert.equal(wallet.inFlight.size,0);assert.equal(store.rows.get('dropped')!.state,'dropped');
  wallet.api=includedApi();await assert.rejects(wallet.fundLightning('dropped',PAYMENT,destination,700n,store),/conclusively refused/);
  assert.equal(await wallet.fundLightning('retry',PAYMENT,destination,700n,store),TXID);
 }finally{await wallet.dispose();}
});

const tx=(txid:string,index:number,script:Uint8Array,leaf?:ExtendedVirtualCoin['intentTapLeafScript'])=>{const t=new Transaction({allowUnknownOutputs:true});t.addInput({txid,index,witnessUtxo:{script,amount:1000n},...(leaf?{tapLeafScript:[leaf]}:{})});t.addOutput({script,amount:1000n});return t;};
test('one external HD payout is shielded directly and only its child signer signs the deposit',async()=>{
 const store=new Store(),wallet=await open(store),child=SingleKey.fromHex('22'.repeat(32)),key=await child.xOnlyPublicKey();
 const tree=new VtxoScript([hex.decode('20'+hex.encode(key)+'ac')]);
 const coin={txid:'cc'.repeat(32),vout:1,value:1000,status:{confirmed:true},script:hex.encode(tree.pkScript),createdAt:new Date(),isUnrolled:false,tapTree:tree.encode(),intentTapLeafScript:tree.leaves[0]!,forfeitTapLeafScript:tree.leaves[0]!} satisfies ExtendedVirtualCoin;
 const head=tx('dd'.repeat(32),0,hex.decode(SCRIPT)),mine=tx(coin.txid,coin.vout,tree.pkScript,tree.leaves[0]);
 const ark=new Transaction({allowUnknownOutputs:true});
 ark.addInput({txid:head.id,index:0,witnessUtxo:{script:hex.decode(SCRIPT),amount:1000n}});
 ark.addInput({txid:mine.id,index:0,witnessUtxo:{script:tree.pkScript,amount:1000n},tapLeafScript:[tree.leaves[0]!]});ark.addOutput({script:tree.pkScript,amount:2000n});
 const signing={status:'signing',arkTx:base64.encode(ark.toPSBT()),checkpoints:[base64.encode(head.toPSBT()),base64.encode(mine.toPSBT())],checkpoint:base64.encode(mine.toPSBT()),vin:1};
 let posted=false,signed=false,childSigns=0;
 const signer={xOnlyPublicKey:()=>child.xOnlyPublicKey(),compressedPublicKey:()=>child.compressedPublicKey(),signerSession:()=>child.signerSession(),signMessage:child.signMessage.bind(child),sign:async(...args:Parameters<typeof child.sign>)=>{childSigns++;return child.sign(...args);}};
 try{
  wallet.getSpendableVtxos=async()=>{throw new Error('ordinary coins touched');};wallet.send=async()=>{throw new Error('native send touched');};
  wallet.api=(async(path:string,body?:any)=>{
   if(path.startsWith('/batches'))return {total:0,batches:[]};
   if(path==='/spends'){posted=true;assert.equal(store.rows.get('shield')!.state,'prepared');assert.equal(body.publics[3],'1000');assert.equal(body.coin.txid,coin.txid);return {};}
   if(path.endsWith('/sign')){signed=true;const input=Transaction.fromPSBT(base64.decode(body.arkTx)).getInput(1);assert.equal(input.tapScriptSig?.length,1);assert.equal(hex.encode(input.tapScriptSig![0]![0].pubKey),hex.encode(key));return {};}
   if(!posted)throw missing();return signed?{status:'included',txid:TXID}:signing;
  }) as PoolApi;
  const handle=await wallet.shieldLightning(coin,signer,store,{id:'shield',reference:`${coin.txid}:${coin.vout}`});
  assert.equal((await handle.settled()).txid,TXID);assert.equal(childSigns,2);assert.equal(store.rows.get('shield')!.state,'included');
  assert.equal((await (await wallet.shieldLightning(coin,signer,store,{id:'shield',reference:`${coin.txid}:${coin.vout}`})).settled()).txid,TXID);assert.equal(childSigns,2);
 }finally{await wallet.dispose();}
});

test('embedded child-key bytes are rejected before proving unless they are the exact signature operand',async()=>{
 const child=SingleKey.fromHex('22'.repeat(32)),foreign=await SingleKey.fromHex('33'.repeat(32)).xOnlyPublicKey(),key=hex.encode(await child.xOnlyPublicKey());
 for(const embedded of [`00${key}`,`f${key}0`]){
  const store=new Store(),wallet=await open(store);let proofs=0,requests=0;
  const script=Script.encode([hex.decode(embedded),'DROP',foreign,'CHECKSIG']),tree=new VtxoScript([script]);
  const coin:ExtendedVirtualCoin={txid:'cc'.repeat(32),vout:1,value:1000,status:{confirmed:true},script:hex.encode(tree.pkScript),createdAt:new Date(),isUnrolled:false,tapTree:tree.encode(),intentTapLeafScript:tree.leaves[0]!,forfeitTapLeafScript:tree.leaves[0]!};
  try{
   assert.equal(hex.encode(script).includes(key),true);
   wallet.prover={prove:async()=>{proofs++;throw new Error('The prover must not run');}};wallet.api=(async()=>{requests++;throw new Error('The API must not run');}) as PoolApi;
   await assert.rejects(async()=>{const handle=await wallet.shieldLightning(coin,child,store,{id:'embedded',reference:`${coin.txid}:${coin.vout}`});await handle.settled();},/child signer/);
   assert.equal(proofs,0);assert.equal(requests,0);assert.equal(store.rows.size,0);
  }finally{await wallet.dispose();}
 }
});

test('both DefaultVtxo child signature leaves pass the payout signer check',async()=>{
 const child=SingleKey.fromHex('22'.repeat(32)),tree=new DefaultVtxo.Script({pubKey:await child.xOnlyPublicKey(),serverPubKey:ArkAddress.decode(ADDRESS).serverPubKey,csvTimelock:{type:'seconds',value:1024n}});
 for(const leaf of [tree.forfeit(),tree.exit()]){
  const store=new Store(),wallet=await open(store);let proofs=0;
  const coin:ExtendedVirtualCoin={txid:'cc'.repeat(32),vout:1,value:1000,status:{confirmed:true},script:hex.encode(tree.pkScript),createdAt:new Date(),isUnrolled:false,tapTree:tree.encode(),intentTapLeafScript:leaf,forfeitTapLeafScript:tree.forfeit()};
  try{
   wallet.prover={prove:async()=>{proofs++;throw new Error('validated child signature operand');}};
   const handle=await wallet.shieldLightning(coin,child,store,{id:'default',reference:`${coin.txid}:${coin.vout}`});
   await assert.rejects(handle.settled(),/validated child signature operand/);assert.equal(proofs,1);
  }finally{await wallet.dispose();}
 }
});

test('durable funding holds are refreshed before ordinary private note selection',async()=>{
 const store=new Store(),repository=new InMemoryShieldedNoteRepository(),first=await open(store,repository),second=await open(store,repository);
 try{
  await fund(first);second.account=first.account;
  first.api=(async()=>{throw new Error('network unknown');}) as PoolApi;
  await assert.rejects(first.fundLightning('held',PAYMENT,destination,700n,store),/network unknown/);
  const handle=await second.withdraw(destination,700n);await assert.rejects(handle.settled(),/No single note/);
 }finally{await first.dispose();await second.dispose();}
});

test('concurrent calls for one Lightning artifact share its single submission',async()=>{
 const store=new Store(),wallet=await open(store);let gets=0,posts=0,posted=false,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 try{
  await fund(wallet);wallet.api=(async(path:string)=>{
   if(path.startsWith('/batches'))return {total:1,batches:[]};
   if(path==='/spends'){posts++;posted=true;return {};}
   if(!posted){gets++;entered();await gate;throw missing();}return {status:'included',txid:TXID};
  }) as PoolApi;
  const first=wallet.fundLightning('concurrent',PAYMENT,destination,700n,store);await started;
  const second=wallet.fundLightning('concurrent',PAYMENT,destination,700n,store);await new Promise(resolve=>setTimeout(resolve,20));release();
  assert.deepEqual(await Promise.all([first,second]),[TXID,TXID]);assert.equal(gets,1);assert.equal(posts,1);
 }finally{release();await wallet.dispose();}
});

test('a concurrent journal winner keeps its original body and never reserves the losing proof input',async()=>{
 const store=new Store(),first=await open(store),second=await open(store);let releaseFirst!:()=>void,releaseSecond!:()=>void,enteredFirst!:()=>void,enteredSecond!:()=>void;
 const gateFirst=new Promise<void>(r=>{releaseFirst=r;}),gateSecond=new Promise<void>(r=>{releaseSecond=r;}),readyFirst=new Promise<void>(r=>{enteredFirst=r;}),readySecond=new Promise<void>(r=>{enteredSecond=r;});
 try{
  await fund(first,[900n,1000n]);second.account=first.account;
  const [winner,loser]=first.account.notes().sort((a,b)=>a.amount<b.amount?-1:1);second.notes.inFlight.add(winner!.nullifier);
  first.prover={prove:async()=>{enteredFirst();await gateFirst;return prover.prove(undefined as never,'spend');}};
  second.prover={prove:async()=>{enteredSecond();await gateSecond;return prover.prove(undefined as never,'spend');}};
  first.api=includedApi();second.api=includedApi(body=>assert.deepEqual(body,store.rows.get('race')!.body));
  const a=first.fundLightning('race',PAYMENT,destination,700n,store);await readyFirst;
  const b=second.fundLightning('race',PAYMENT,destination,700n,store);await readySecond;
  releaseFirst();assert.equal(await a,TXID);releaseSecond();assert.equal(await b,TXID);
  assert.equal(store.rows.get('race')!.nullifiers[0],String(winner!.nullifier));assert.equal(second.inFlight.has(loser!.nullifier),false);
 }finally{releaseFirst();releaseSecond();await first.dispose();await second.dispose();}
});

test('an inclusion journal write failure keeps the saved body and reservation without another POST',async()=>{
 const store=new Store(),wallet=await open(store);let posts=0;
 try{
  await fund(wallet);const finish=store.finish.bind(store);store.finish=async()=>{throw new Error('inclusion disk failure');};
  wallet.api=includedApi(()=>{posts++;});
  await assert.rejects(wallet.fundLightning('included-write',PAYMENT,destination,700n,store),/inclusion disk failure/);
  const saved=clone(store.rows.get('included-write')!);assert.equal(saved.state,'prepared');assert.equal(wallet.inFlight.has(BigInt(saved.nullifiers[0]!)),true);
  store.finish=finish;assert.equal(await wallet.fundLightning('included-write',PAYMENT,destination,700n,store),TXID);
  assert.equal(posts,1);assert.deepEqual(store.rows.get('included-write')!.body,saved.body);
 }finally{await wallet.dispose();}
});

test('an unreadable or inconsistent journal blocks wallet startup and ordinary spending',async()=>{
 const store=new Store(),repository=new InMemoryShieldedNoteRepository(),wallet=await open(store,repository);
 try{
  await fund(wallet);wallet.api=(async()=>{throw new Error('network unknown');}) as PoolApi;
  await assert.rejects(wallet.fundLightning('corrupt',PAYMENT,destination,700n,store),/network unknown/);
  store.rows.get('corrupt')!.body.program='00'.repeat(32);
  await assert.rejects(open(store,repository),/saved Lightning spend is invalid/);
  const handle=await wallet.withdraw(destination,330n);await assert.rejects(handle.settled(),/saved Lightning spend is invalid/);
  const list=store.list.bind(store);store.list=async()=>{throw new Error('journal unavailable');};
  await assert.rejects(open(store,repository),/journal unavailable/);store.list=list;
 }finally{await wallet.dispose();}
});

test('closing a wallet cancels pending Lightning funding and shielding before disposing their service',async()=>{
 for(const kind of ['fund','shield'] as const){
  const store=new Store(),repository=new InMemoryShieldedNoteRepository(),wallet=await open(store,repository);
  const child=SingleKey.fromHex('22'.repeat(32)),tree=new VtxoScript([hex.decode('20'+hex.encode(await child.xOnlyPublicKey())+'ac')]);
  const coin:ExtendedVirtualCoin={txid:'cc'.repeat(32),vout:1,value:1000,status:{confirmed:true},script:hex.encode(tree.pkScript),createdAt:new Date(),isUnrolled:false,tapTree:tree.encode(),intentTapLeafScript:tree.leaves[0]!,forfeitTapLeafScript:tree.leaves[0]!};
  let posted=false,entered!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;
  const polling=new Promise<void>(resolve=>{entered=resolve;});let action:Promise<unknown>|undefined;
  try{
   if(kind==='fund')await fund(wallet);
   wallet.api=(async(path:string)=>{if(path==='/spends'){posted=true;return {};}if(!posted)throw missing();entered();return {status:'pending'};}) as PoolApi;
   action=kind==='fund'?wallet.fundLightning('closing',PAYMENT,destination,700n,store):(await wallet.shieldLightning(coin,child,store,{id:'closing',reference:`${coin.txid}:${coin.vout}`})).settled();
   const failed=assert.rejects(action,/closed/);await polling;
   wallet.swaps={[Symbol.asyncDispose]:async()=>{await action!.catch(()=>{});}} as never;
   await Promise.race([wallet.dispose(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lightning disposal deadlocked')),3000);})]);await failed;
   const record=store.rows.get('closing')!;assert.equal(record.state,'prepared');
   const restored=await open(store,repository);
   try{assert.equal(restored.inFlight.has(BigInt(record.nullifiers[0]!)),true);if(kind==='shield')assert.equal(restored.planFor([{txid:coin.txid,vout:coin.vout,value:coin.value}],false),undefined);}finally{await restored.dispose();}
  }finally{if(timer)clearTimeout(timer);await wallet.dispose();await action?.catch(()=>{});}
 }
});

test('a proof that outlives its HTLC deadline stays reserved and cannot be POSTed or extended',async t=>{
 const store=new Store(),wallet=await open(store);let now=1_000_000,posts=0;
 try{
  await fund(wallet);t.mock.method(Date,'now',()=>now);
  wallet.prover={prove:async()=>{now=1_002_000;return prover.prove(undefined as never,'spend');}};
  wallet.api=(async(path:string)=>{if(path==='/spends'){posts++;return {};}throw missing();}) as PoolApi;
  await assert.rejects(wallet.fundLightning('expired',PAYMENT,destination,700n,store,undefined,1001),/expired|deadline/i);
  const saved=store.rows.get('expired')!;assert.equal(saved.state,'prepared');assert.equal(saved.expiresAt,1001);assert.equal(posts,0);assert.equal(wallet.inFlight.has(BigInt(saved.nullifiers[0]!)),true);
  await assert.rejects(wallet.fundLightning('expired',PAYMENT,destination,700n,store,undefined,2000),/different|changed/i);assert.equal(posts,0);
  await assert.rejects(wallet.fundLightning('expired',PAYMENT,destination,700n,store,undefined,1001),/expired|deadline/i);assert.equal(posts,0);
 }finally{await wallet.dispose();}
});

test('expired Lightning requests still reconcile known pending or included submissions',async t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);
 for(const initial of ['pending','included'] as const){
  const store=new Store(),wallet=await open(store);let gets=0,posts=0;
  try{
   await fund(wallet);now=1_000_000;wallet.api=(async()=>{throw new Error('network unknown');}) as PoolApi;
   await assert.rejects(wallet.fundLightning('known',PAYMENT,destination,700n,store,undefined,1001),/network unknown/);
   now=1_002_000;wallet.api=(async(path:string)=>{
    if(path.startsWith('/batches'))return {total:1,batches:[]};
    if(path==='/spends'){posts++;throw new Error('expired POST');}
    return initial==='pending'&&gets++===0?{status:'pending'}:{status:'included',txid:TXID};
   }) as PoolApi;
   assert.equal(await wallet.fundLightning('known',PAYMENT,destination,700n,store,undefined,1001),TXID);assert.equal(posts,0);assert.equal(store.rows.get('known')!.state,'included');
  }finally{await wallet.dispose();}
 }
});

test('an internal pool API retry checks the funding deadline again before POSTing',async t=>{
 const store=new Store(),wallet=await open(store);let now=1_000_000,posts=0;
 try{
  await fund(wallet);t.mock.method(Date,'now',()=>now);
  const fetcher=(async(_url:unknown,init?:RequestInit)=>{
   if(init?.method==='POST'){posts++;now=1_002_000;return new Response(JSON.stringify({error:'busy'}),{status:503});}
   return new Response(JSON.stringify({error:'Unknown spend'}),{status:404});
  }) as typeof fetch;
  wallet.api=<T,>(path:string,body?:unknown,beforeRequest?:()=>void)=>rollupApi<T>(path,body,fetcher,0,'',beforeRequest);
  await assert.rejects(wallet.fundLightning('retry-expiry',PAYMENT,destination,700n,store,undefined,1001),/expired|deadline/);
  assert.equal(posts,1);assert.equal(store.rows.get('retry-expiry')!.state,'prepared');assert.equal(wallet.inFlight.size,1);
 }finally{await wallet.dispose();}
});
