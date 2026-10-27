import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {schnorr} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {asset,DefaultVtxo,Intent,SingleKey,Transaction,UnknownPacket} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {offlineNativeFixture} from './fixtures/native.ts';
import info from './fixtures/ark-info.json' with {type:'json'};
import type {StockNetworkInfo} from '../src/stock/network.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET} from '../src/rollup/covenant.ts';
import {carriedReserves,flushRollupIntent,fundRollupRenewalFee,isRollupFeeForfeit,leftoverRenewal,RENEWAL_CHUNK,renewalChunks,renewedRollupPoolCoins,renewRollupPool,rollupForfeitsForArkd,rollupPoolPoints,rollupRenewalDigest,rollupRenewalDue,rollupRenewalFee,rollupRenewalSignature} from '../src/rollup/renewal.ts';

/** What mutinynet's /v1/info advertises under .fees: 0.2% of every VTXO input younger than a day, and nothing else. */
const FEES={offchainInput:"inputType == 'vtxo' && now() - birth < 86400.0 ? amount * 0.002 : 0.0",offchainOutput:'0.0',onchainInput:'0.0',onchainOutput:'0.0'};
const POOL='5120'+'99'.repeat(32),OWN='5120'+'ab'.repeat(32);
const ago=(hours:number)=>new Date(Date.now()-hours*3600_000);
const head={txid:'aa'.repeat(32),vout:0,value:6000,script:POOL,createdAt:ago(1)},repaid=[{value:6000,script:POOL}];
const own=(value:number,vout=0,hours=1)=>({txid:'f0'.repeat(31)+'0'+String(vout),vout,value,script:OWN,createdAt:ago(hours)});

// tools/vm/rollup_renewal_test.go pins the same digest for the covenant's gate.
test('the renewal gate signs the digest the covenant rebuilds',()=>{
 const head={txid:'11'.repeat(31)+'22',vout:1},digest=rollupRenewalDigest(['02aa'],head);
 assert.equal(hex.encode(digest),'6944d7770653359361fe902a84dbbc6c04215166753f1e9001da525711c4906e');
 const secret=new Uint8Array(32).fill(0x42);
 assert.equal(schnorr.verify(rollupRenewalSignature(secret,['02aa'],head),digest,schnorr.getPublicKey(secret)),true);
});

// L3 observed the renewed head and its reserve at one txid, vouts 0 and 1, in the intent's output order.
test('the renewed coins are the token head and the reserves that follow it, not whatever holds the asset',()=>{
 const token=asset.AssetId.create('cc'.repeat(32),0).toString(),x=asset.AssetId.create('dd'.repeat(32),0).toString();
 const head={txid:'ab'.repeat(32),vout:0,value:3000,assets:[{assetId:token,amount:1n}]};
 const reserve={txid:head.txid,vout:1,value:330,assets:[{assetId:x,amount:10_000n}]};
 const stranger={txid:'cd'.repeat(32),vout:0,value:330,assets:[{assetId:x,amount:1n}]};
 const renewed=renewedRollupPoolCoins(token,[[x,'10000']],[stranger,head,reserve]);
 assert.equal(renewed.head,head);
 assert.deepEqual(renewed.reserves,[{assetId:x,coin:reserve,amount:'10000'}]);
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,stranger]),/not indexed yet/,'a stranger at another outpoint is not the reserve');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,{...reserve,assets:[{assetId:x,amount:9000n}]}]),/does not hold/,'a reserve short of the amount it tracked');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[head,{...reserve,assets:[...reserve.assets,{assetId:token,amount:1n}]}]),/does not hold/,'a reserve carrying something else too');
 assert.throws(()=>renewedRollupPoolCoins(token,[[x,'10000']],[{...head,assets:[{assetId:token,amount:2n}]},reserve]),/head is not indexed/,'a token that is not the supply-1 pool token');
});

test('renewal comes due on the soonest expiry among the head and every reserve',()=>{
 const x='bb'.repeat(34),coin=(txid:string,vout:number)=>({txid:txid.repeat(32),vout,value:330,sourceTxHex:''});
 const archive={version:1 as const,head:coin('aa',0),reserves:{[x]:{...coin('cc',1),amount:'5'}},batches:0};
 const points=rollupPoolPoints(archive);
 assert.deepEqual(points,[{txid:'aa'.repeat(32),vout:0},{txid:'cc'.repeat(32),vout:1}],'the head leads and every reserve follows, as the intent orders them');
 const now=Date.now(),window=48*3600_000,at=(p:{txid:string;vout:number},hours:number)=>({...p,expiresAt:new Date(now+hours*3600_000)});
 assert.equal(rollupRenewalDue(points,[at(points[0]!,120),at(points[1]!,30)],window,now),true,'a reserve arkd sweeps first pulls renewal forward');
 assert.equal(rollupRenewalDue(points,[at(points[1]!,120),at(points[0]!,120)],window,now),false);
 assert.throws(()=>rollupRenewalDue(points,[at(points[0]!,120)],window,now),/c{64}:1 is not indexed/,'an unreturned coin may be the one about to expire');
 assert.throws(()=>rollupRenewalDue(points,points,window,now),/no expiry/);
});

// The dry-run pool was refused with INTENT_INSUFFICIENT_FEE (31): got 0 min expected 12, on a 6000-sat head.
test('the renewal fee is what arkd charges for the intent, and nothing once the head is a day old',()=>{
 assert.equal(rollupRenewalFee(FEES,[head],repaid),12,'0.2% of a young head, the sum arkd asked the dry-run pool for');
 assert.equal(rollupRenewalFee(FEES,[{...head,createdAt:ago(25)}],repaid),0,'past the young window the renewal owes nothing');
 assert.equal(rollupRenewalFee(FEES,[{...head,isSwept:true}],repaid),0,'a swept input is recoverable, not a vtxo input');
 assert.equal(rollupRenewalFee(FEES,[head,own(1000)],[...repaid,{value:986,script:OWN}]),14,'a young fee coin pays 0.2% of itself, and the change output is free');
 assert.equal(rollupRenewalFee(FEES,[{...head,value:5},own(5)],repaid),1,'the programs are summed over the inputs before rounding up, not rounded one by one');
 assert.equal(rollupRenewalFee({},[head],repaid),0,'a server advertising no program charges nothing');
});

const fund=(coins:readonly ReturnType<typeof own>[],pool:readonly typeof head[]=[head])=>fundRollupRenewalFee({fees:FEES,dust:330,pool,outputs:repaid,coins});
const [small,mid,big,tight,exact]=[own(400,1),own(1000,2),own(50_000,3),own(340,4),own(13,5)];

test('the fee comes from the smallest operator coins that cover it, and the surplus goes back above dust',()=>{
 assert.deepEqual(fund([big,mid,small]),{coins:[small],fee:13,change:387},'the smallest covering coin alone, its own 0.2% included');
 assert.deepEqual(fund([big,mid]),{coins:[mid],fee:14,change:986});
 assert.deepEqual(fund([{...small,txid:'f1'.repeat(32)},small]),{coins:[small],fee:13,change:387},'equal values are broken by outpoint, so the same wallet always funds the same way');
 // ponytail: a coin whose surplus is dust is spent whole; picking a larger one instead would consolidate, which this does not try.
 assert.deepEqual(fund([tight]),{coins:[tight],fee:340,change:0},'a 327-sat surplus is below dust, so it tops the fee up instead');
 assert.deepEqual(fund([exact]),{coins:[exact],fee:13,change:0},'a coin worth exactly the fee leaves no output behind');
 assert.deepEqual(fund([mid],[{...head,createdAt:ago(25)}]),{coins:[],fee:0,change:0},'an old head owes nothing, so no coin of the operator\'s is touched');
});

test('an operator wallet that cannot cover the fee refuses the renewal before anything is registered',()=>{
 assert.throws(()=>fund([]),/^Error: The operator wallet needs 330 sats to pay the renewal fee\.$/,'a top-up under dust could not be spent, so asking for the 12 would not unblock it');
 assert.throws(()=>fund([own(12,6)]),/needs 330 sats/,'the coin owes 0.2% of itself too, so 12 does not cover 12');
});

test('a renewal hands out its intent id before the round, and names it when the round fails',async()=>{
 const token=asset.AssetId.create('cc'.repeat(32),0).toString();
 const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const leaves={batch:Uint8Array.of(0x51),batchJoin:Uint8Array.of(0x54),reserve:Uint8Array.of(0x52),renew:Uint8Array.of(0x53)};
 const pool=rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
 const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:3000n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,new Uint8Array(64))]);
 const head={txid:parent.id,vout:0,value:3000,sourceTxHex:hex.encode(parent.toBytes())};
 const vtxo={txid:head.txid,vout:0,value:3000,script:hex.encode(pool.tree.pkScript),isSpent:false,prevTx:parent.toBytes()};
 const seen:string[]=[];
 const providers={
  ark:{getInfo:async()=>info,registerIntent:async()=>'intent-42',getEventStream:async function*(){throw new Error('the round was dropped');}},
  emulator:{submitIntent:async({proof}:{proof:string})=>proof},
  indexer:{getVtxos:async()=>({vtxos:[vtxo]}),getVirtualTxs:async()=>({txs:[]})},
 };
 const network={network:'mutinynet',arkUrl:'https://ark.invalid',emulatorUrl:'https://emulator.invalid'} as unknown as StockNetworkInfo;
 await assert.rejects(renewRollupPool({network,identity:SingleKey.fromHex('04'.repeat(32)),operatorSecret:randomBytes(32),pool:pool.tree,renewLeaf:pool.renew,
  leaves,token,archive:{version:1,head,reserves:{},batches:0},onIntent:id=>{seen.push(id);},providers:providers as never}),/intent-42/);
 assert.deepEqual(seen,['intent-42'],'the id reaches the caller before the round, so a stranded intent can be cleared');
});

test('a renewal chunk carries the head and only the reserves it names, and chunks follow the expiries',async()=>{
 const id=(b:string)=>asset.AssetId.create(b.repeat(32),0).toString(),token=id('cc'),[x,y,z]=[id('d1'),id('d2'),id('d3')];
 const [server,emulator]=await Promise.all(['01','02'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
 const leaves={batch:Uint8Array.of(0x51),batchJoin:Uint8Array.of(0x54),reserve:Uint8Array.of(0x52),renew:Uint8Array.of(0x53)};
 const pool=rollupPoolTree(server,emulator,leaves,{type:'seconds',value:2048});
 const holds=(assetId:string,vout:number,amount:bigint)=>asset.AssetGroup.create(asset.AssetId.fromString(assetId),null,[asset.AssetInput.create(0,amount)],[asset.AssetOutput.create(vout,amount)],[]);
 const parent=offlineNativeFixture([3000n,330n,330n,330n].map(amount=>({script:pool.tree.pkScript,amount})),[asset.Packet.create([holds(token,0,1n),holds(x,1,5n),holds(y,2,6n),holds(z,3,7n)]),new UnknownPacket(ROLLUP_STATE_PACKET,new Uint8Array(64))]);
 const coin=(vout:number,value:number)=>({txid:parent.id,vout,value,sourceTxHex:hex.encode(parent.toBytes())});
 const archive={version:1 as const,head:coin(0,3000),reserves:{[x]:{...coin(1,330),amount:'5'},[y]:{...coin(2,330),amount:'6'},[z]:{...coin(3,330),amount:'7'}},batches:0};
 const vtxos=[0,1,2,3].map(vout=>({txid:parent.id,vout,value:vout?330:3000,script:hex.encode(pool.tree.pkScript),isSpent:false,prevTx:parent.toBytes()}));
 let proof='';
 const providers={
  ark:{getInfo:async()=>info,registerIntent:async()=>'intent-7',getEventStream:async function*(){throw new Error('the round was dropped');}},
  emulator:{submitIntent:async(o:{proof:string})=>(proof=o.proof)},
  indexer:{getVtxos:async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:vtxos.filter(v=>outpoints.some(p=>p.vout===v.vout))}),getVirtualTxs:async()=>({txs:[]})},
 };
 const network={network:'mutinynet',arkUrl:'https://ark.invalid',emulatorUrl:'https://emulator.invalid'} as unknown as StockNetworkInfo;
 await assert.rejects(renewRollupPool({network,identity:SingleKey.fromHex('04'.repeat(32)),operatorSecret:randomBytes(32),pool:pool.tree,renewLeaf:pool.renew,
  leaves,token,archive,reserves:[z,x],providers:providers as never}),/intent-7/);
 const tx=Transaction.fromPSBT(base64.decode(proof)),spent=Array.from({length:tx.inputsLength-1},(_,i)=>tx.getInput(i+1).index);
 assert.deepEqual(spent,[0,3,1],'the head first, then the named reserves in order; the other reserve stays out');
 assert.equal(tx.outputsLength,4,'one output per carried coin, plus the extension');
 const expiry:Record<number,number>={1:30,2:10,3:20};
 assert.deepEqual(renewalChunks(archive.reserves,c=>expiry[c.vout]!),[[y,z,x]]);
 const many=Object.fromEntries(Array.from({length:RENEWAL_CHUNK+1},(_,i)=>[id(String(10+i)),coin(1,330)]));
 assert.deepEqual(renewalChunks(many,()=>0).map(c=>c.length),[RENEWAL_CHUNK,1]);
 assert.deepEqual(renewalChunks({},()=>0),[[]],'with no reserve, one intent still renews the head');
});

test('a renewal repays every pool coin unchanged, pays the fee from an operator coin and returns its change',async()=>{
 const id=(b:string)=>asset.AssetId.create(b.repeat(32),0).toString(),token=id('cc'),x=id('d1');
 const identity=SingleKey.fromHex('04'.repeat(32));
 const [server,emulator,operator]=await Promise.all([SingleKey.fromHex('01'.repeat(32)),SingleKey.fromHex('02'.repeat(32)),identity].map(k=>k.xOnlyPublicKey()));
 const leaves={batch:Uint8Array.of(0x51),batchJoin:Uint8Array.of(0x54),reserve:Uint8Array.of(0x52),renew:Uint8Array.of(0x53)};
 const pool=rollupPoolTree(server!,emulator!,leaves,{type:'seconds',value:2048});
 const holds=(assetId:string,vout:number,amount:bigint)=>asset.AssetGroup.create(asset.AssetId.fromString(assetId),null,[asset.AssetInput.create(0,amount)],[asset.AssetOutput.create(vout,amount)],[]);
 const parent=offlineNativeFixture([3000n,330n].map(amount=>({script:pool.tree.pkScript,amount})),[asset.Packet.create([holds(token,0,1n),holds(x,1,5n)]),new UnknownPacket(ROLLUP_STATE_PACKET,new Uint8Array(64))]);
 const coin=(vout:number,value:number)=>({txid:parent.id,vout,value,sourceTxHex:hex.encode(parent.toBytes())});
 const archive={version:1 as const,head:coin(0,3000),reserves:{[x]:{...coin(1,330),amount:'5'}},batches:0};
 const vtxos=[0,1].map(vout=>({txid:parent.id,vout,value:vout?330:3000,script:hex.encode(pool.tree.pkScript),isSpent:false,prevTx:parent.toBytes(),createdAt:ago(1)}));
 const tree=new DefaultVtxo.Script({pubKey:operator!,serverPubKey:server!,csvTimelock:{type:'seconds',value:1024n}});
 const source=offlineNativeFixture([{script:tree.pkScript,amount:1000n}]);
 const fee={txid:source.id,vout:0,value:1000,script:hex.encode(tree.pkScript),isSpent:false,createdAt:ago(1),prevTx:source.toBytes(),tapTree:tree.encode(),forfeitTapLeafScript:tree.forfeit(),intentTapLeafScript:tree.forfeit()};
 let proof='',emulated='';
 const providers={
  ark:{getInfo:async()=>({...info,fees:{...info.fees,intentFee:FEES},dust:330n}),registerIntent:async(i:{proof:string})=>{proof=i.proof;return 'intent-5';},getEventStream:async function*(){throw new Error('the round was dropped');}},
  emulator:{submitIntent:async(o:{proof:string})=>(emulated=o.proof)},
  indexer:{getVtxos:async({outpoints}:{outpoints:{txid:string;vout:number}[]})=>({vtxos:vtxos.filter(v=>outpoints.some(p=>p.vout===v.vout))}),getVirtualTxs:async()=>({txs:[]})},
  wallet:async()=>({wallet:{dispose:async()=>{}},address:'',externalProgram:'',coins:[{amount:1000,coin:fee,funding:{}}]}),
 };
 const network={network:'mutinynet',arkUrl:'https://ark.invalid',emulatorUrl:'https://emulator.invalid'} as unknown as StockNetworkInfo;
 await assert.rejects(renewRollupPool({network,identity,operatorSecret:randomBytes(32),pool:pool.tree,renewLeaf:pool.renew,
  leaves,token,archive,providers:providers as never}),/intent-5/);
 const tx=Transaction.fromPSBT(base64.decode(proof)),at=(i:number)=>[hex.encode(tx.getOutput(i).script!),Number(tx.getOutput(i).amount)];
 assert.equal(tx.inputsLength,4,'the head, its reserve and one operator coin, after the proof\'s own input');
 assert.deepEqual([1,2,3].map(i=>`${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`),
  [`${parent.id}:0`,`${parent.id}:1`,`${source.id}:0`],'the head stays at input 1, the reserve follows it, and the fee coin comes last');
 assert.deepEqual([at(0),at(1)],[[hex.encode(pool.tree.pkScript),3000],[hex.encode(pool.tree.pkScript),330]],'the head and reserve outputs repay their inputs byte for byte');
 assert.deepEqual(at(2),[hex.encode(tree.pkScript),991],'the change returns to the operator');
 assert.deepEqual([tx.outputsLength,Number(tx.getOutput(3).amount)],[4,0],'the extension stays last, where the asset packet\'s vouts leave it');
 assert.equal(Intent.fee(tx),9,'0.2% each of the 3000 head, the 330 reserve and the 1000 fee coin, summed then rounded up');
 assert.ok(tx.getInput(3).tapScriptSig?.length,'the operator signed its own fee input in the registered proof');
 assert.equal(tx.getInput(1).tapScriptSig,undefined,'...and did not touch the pool inputs the emulator signs');
 assert.equal(Transaction.fromPSBT(base64.decode(emulated)).getInput(3).tapScriptSig,undefined,'the signature is added after the emulator, so its round trip cannot drop it');
 const forfeit=(txid:string,index:number)=>{const f=new Transaction({allowUnknownInputs:true});f.addInput({txid:hex.decode(txid),index});return f;};
 assert.equal(isRollupFeeForfeit([fee],forfeit(source.id,0)),true);
 assert.deepEqual([isRollupFeeForfeit([fee],forfeit(parent.id,0)),isRollupFeeForfeit([fee],forfeit(source.id,1)),isRollupFeeForfeit([],forfeit(source.id,0))],[false,false,false],'a pool coin, another vout and a fee-free renewal all pass straight through');
 const psbt=(tx:Transaction)=>base64.encode(tx.toPSBT()),mine=psbt(forfeit(source.id,0));
 const sent=[psbt(forfeit(parent.id,0)),mine,psbt(forfeit(parent.id,1))];
 assert.deepEqual(rollupForfeitsForArkd([fee],sent,['head','reserve']),['head',mine,'reserve'],'measured live: 2 forfeits in, 1 back, and arkd refusing with INTERNAL_ERROR (0): missing forfeit transactions');
 assert.deepEqual(rollupForfeitsForArkd([],sent,['a','b','c']),['a','b','c'],'with no fee coin the emulator\'s answer is passed through whole');
 assert.deepEqual(rollupForfeitsForArkd([fee],sent,[]),sent,'an emulator that answers nothing cannot drop ours either');
});

test('an interrupted chunk is adopted in the order its intent carried, and only an archive reserve can be carried',()=>{
 const id=(b:string)=>asset.AssetId.create(b.repeat(32),0).toString(),token=id('cc'),[x,y,z]=[id('d1'),id('d2'),id('d3')];
 const reserves={[x]:{amount:'5'},[y]:{amount:'6'},[z]:{amount:'7'}};
 assert.deepEqual(Object.keys(carriedReserves(reserves,[z,x])),[z,x]);
 assert.deepEqual(Object.keys(carriedReserves(reserves)),[x,y,z],'a renewal.json from before chunks names no ids, so it carried every reserve');
 assert.throws(()=>carriedReserves(reserves,[z,id('ee')]),/not in the archive/);
 const txid='ef'.repeat(32),out=(vout:number,assetId:string,amount:bigint)=>({txid,vout,value:vout?330:3000,assets:[{assetId,amount}]});
 const moved=renewedRollupPoolCoins(token,Object.entries(carriedReserves(reserves,[z,x])).map(([assetId,r])=>[assetId,r.amount] as const),[out(2,x,5n),out(0,token,1n),out(1,z,7n)]);
 assert.deepEqual(moved.reserves.map(r=>[r.assetId,r.coin.vout]),[[z,1],[x,2]],'each carried reserve sits after the head in the intent\'s order');
});

test('a stranded renewal intent is confirmed in its round and cleared when that round fails',async()=>{
 const hash=hex.encode(sha256(new TextEncoder().encode('intent-42'))),confirmed:string[]=[],topics:string[][]=[];
 const ark={confirmRegistration:async(id:string)=>{confirmed.push(id);},getEventStream:async function*(_signal:AbortSignal,t:string[]){
  topics.push(t);
  yield {type:'batch_failed',id:'earlier',reason:'not enough intent confirmations received'};
  yield {type:'batch_started',id:'other',intentIdHashes:['ff'.repeat(32)]};
  yield {type:'batch_started',id:'ours',intentIdHashes:[hash]};
  yield {type:'batch_failed',id:'ours',reason:'musig2 signing session timed out (nonce collection), collected 0/1 nonces'};
 }};
 assert.equal(await flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:['ab:0'],ark:ark as never}),'flushed');
 assert.deepEqual(confirmed,['intent-42']);
 assert.deepEqual(topics,[['ab:0']]);
});

test('an intent no round picks up is reported absent, without confirming anything',async()=>{
 const ark={confirmRegistration:async()=>{throw new Error('nothing to confirm');},getEventStream:async function*(signal:AbortSignal){
  yield {type:'batch_started',id:'other',intentIdHashes:[]};
  await new Promise(resolve=>signal.addEventListener('abort',resolve));
 }};
 assert.equal(await flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:[],waitMs:50,ark:ark as never}),'absent');
});

test('a renewal left behind by a dead process is adopted, cleared or flushed according to the head',()=>{
 const pending={intentId:'intent-42',head:{txid:'aa'.repeat(32),vout:0}};
 assert.equal(leftoverRenewal(pending,{txid:'bb'.repeat(32),vout:0},undefined),'done','the head was relocated before the process died');
 assert.equal(leftoverRenewal(pending,pending.head,{settledBy:'cc'.repeat(32)}),'adopt','the round settled the head, so its new coins exist');
 assert.equal(leftoverRenewal(pending,pending.head,{isSpent:true}),'moved','an offchain spend is not a renewal');
 assert.equal(leftoverRenewal(pending,pending.head,{isSpent:false}),'flush');
});

test('an event stream that closes before the wait ends proves nothing about the intent',async()=>{
 const ark={confirmRegistration:async()=>{},getEventStream:async function*(){yield {type:'batch_started',id:'other',intentIdHashes:[]};}};
 await assert.rejects(flushRollupIntent({arkUrl:'https://ark.invalid',intentId:'intent-42',topics:[],waitMs:5000,ark:ark as never}),/closed/);
});
