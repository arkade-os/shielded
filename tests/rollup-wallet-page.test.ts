import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {arkAssetHoldings,bornAtFor,checkSigningRequest,pickNote,provingUrls,rollupApi,sheetLine,shieldPlan,transferBody,waitForSpend,type SpendStatus} from '../app/src/rollup-client.ts';
import type {BuiltSpend,OwnedNote} from '../packages/protocol/src/rollup/account.ts';

const note=(amount:bigint,nullifier:bigint):OwnedNote=>({amount,asset:0n,rho:1n,index:0,nullifier});
const tx=(inputs:{txid:string;index:number;script:Uint8Array}[])=>{
 const t=new Transaction({allowUnknownOutputs:true});
 for(const i of inputs)t.addInput({txid:i.txid,index:i.index,witnessUtxo:{script:i.script,amount:1000n}});
 t.addOutput({script:hex.decode('0014'+'11'.repeat(20)),amount:1000n});
 return t;
};
const psbt=(t:Transaction)=>base64.encode(t.toPSBT());

test('a join body carries both nullifiers and proves with the join artifacts, which a spend never fetches',()=>{
 const spend={witness:{slot:{root:7n,nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:0n,groupSize:0},publicSignals:[1n,0n,0n,0n,0n],input:{}},ciphertext:Uint8Array.of(1),change:0n} as unknown as BuiltSpend;
 const join={...spend,witness:{...spend.witness,slot:{...spend.witness.slot,nullifiers:[11n,21n]}}} as BuiltSpend;
 assert.deepEqual(transferBody('ab',join,{pi_a:[],pi_b:[],pi_c:[]}).slot.nullifiers,['11','21']);
 const proving={spend:{wasm:'s1',zkey:'s2'},join:{wasm:'j1',zkey:'j2'},batch:{wasm:'b1',zkey:'b2'},batchJoin:{wasm:'k1',zkey:'k2'}};
 assert.deepEqual(provingUrls(spend,proving),{wasm:'/api/rollup/proving/spend.wasm?v=s1',zkey:'/api/rollup/proving/spend.zkey?v=s2'});
 assert.deepEqual(provingUrls(join,proving),{wasm:'/api/rollup/proving/join.wasm?v=j1',zkey:'/api/rollup/proving/join.zkey?v=j2'});
});

test('a wallet skips the history before its birth in one pool, and reads every batch of the next',()=>{
 const store=new Map<string,string>(),storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 store.set('born','new');
 assert.equal(bornAtFor(storage,'born',{token:'g1',batches:13}),13,'a fresh wallet skips what came before it');
 assert.equal(bornAtFor(storage,'born',{token:'g1',batches:20}),13,'and remembers where it was born');
 assert.equal(bornAtFor(storage,'born',{token:'g2',batches:4}),0,'a new pool is read from its first batch');
 store.clear();store.set('born','13');
 assert.equal(bornAtFor(storage,'born',{token:'g2',batches:5}),0,'a genesis-1 marker does not carry over');
});

test('a spend takes the smallest single note that covers it, skipping notes already in flight',()=>{
 const notes=[note(500n,1n),note(120n,2n),note(300n,3n)];
 assert.equal(pickNote(notes,250n,new Set())?.amount,300n);
 assert.equal(pickNote(notes,250n,new Set([3n]))?.amount,500n);
 assert.equal(pickNote(notes,600n,new Set()),undefined);
});

test('a spend body carries decimal field elements, the hex record, and only the legs it has',()=>{
 const built={witness:{slot:{root:7n,nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:0n,groupSize:0},publicSignals:[1n,2n,0n,0n,0n],input:{}},ciphertext:Uint8Array.of(1,2),change:0n} as unknown as BuiltSpend;
 const proof={pi_a:['1'],pi_b:[['2']],pi_c:['3']};
 assert.deepEqual(transferBody('ab',built,proof),{id:'ab',slot:{root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0},publics:['1','2','0','0','0'],proof,ciphertext:'0102'});
 const member={...built,witness:{...built.witness,slot:{...built.witness.slot,groupId:99n,groupSize:3}}} as BuiltSpend;
 assert.deepEqual([transferBody('ab',member,proof).slot.groupId,transferBody('ab',member,proof).slot.groupSize],['99',3]);
 const withLegs=transferBody('ab',built,proof,{program:new Uint8Array(32).fill(1),coin:{txid:'cd'.repeat(32),vout:2,tapTree:'aa',leaf:'bb'},asset:'ee'.repeat(34)});
 assert.equal(withLegs.program,'01'.repeat(32));
 assert.equal(withLegs.asset,'ee'.repeat(34));
 assert.deepEqual(withLegs.coin,{txid:'cd'.repeat(32),vout:2,tapTree:'aa',leaf:'bb'});
});

test('a depositor signs only a batch that spends the pool head first and its own coin at its input',()=>{
 const pool=hex.decode('0014'+'aa'.repeat(20)),user=hex.decode('0014'+'bb'.repeat(20)),coin={txid:'cc'.repeat(32),vout:1};
 const head=tx([{txid:'dd'.repeat(32),index:0,script:pool}]),mine=tx([{txid:coin.txid,index:coin.vout,script:user}]);
 const ark=tx([{txid:head.id,index:0,script:pool},{txid:mine.id,index:0,script:user}]);
 const request:SpendStatus={status:'signing',arkTx:psbt(ark),checkpoints:[psbt(head),psbt(mine)],checkpoint:psbt(mine),vin:1};
 checkSigningRequest(request,coin,hex.encode(pool));
 assert.throws(()=>checkSigningRequest(request,coin,hex.encode(user)),/pool head/);
 assert.throws(()=>checkSigningRequest(request,{...coin,vout:0},hex.encode(pool)),/deposit coin/);
 const elsewhere=tx([{txid:head.id,index:0,script:pool},{txid:'ee'.repeat(32),index:0,script:user}]);
 assert.throws(()=>checkSigningRequest({...request,arkTx:psbt(elsewhere)},coin,hex.encode(pool)),/deposit coin/);
});

test('waiting on a spend signs each distinct batch once and stops when it is settled',async()=>{
 const replies:SpendStatus[]=[{status:'pending'},{status:'signing',arkTx:'A'},{status:'signing',arkTx:'A'},{status:'pending'},{status:'signing',arkTx:'B'},{status:'included',batch:4,txid:'t'}];
 const signed:string[]=[];
 const final=await waitForSpend('id',async s=>{signed.push(s.arkTx!);},async()=>replies.shift() as never,0);
 assert.deepEqual(signed,['A','B']);
 assert.deepEqual(final,{status:'included',batch:4,txid:'t'});
});

test('the API client retries outages, but reports a refusal at once',async()=>{
 let calls=0;
 const flaky=(async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');if(calls===2)return new Response('{}',{status:502});return new Response('{"ok":1}',{status:200});}) as unknown as typeof fetch;
 assert.deepEqual(await rollupApi('/status',undefined,flaky,0),{ok:1});
 assert.equal(calls,3);
 const refusing=(async()=>new Response('{"error":"Invalid client proof."}',{status:400})) as unknown as typeof fetch;
 await assert.rejects(rollupApi('/spends',{},refusing,0),/Invalid client proof/);
});

test('auto-shield takes every spendable coin the pool will still accept, BTC first, then listed assets one coin at a time',()=>{
 const now=1_000_000,x='ee'.repeat(34),y='ff'.repeat(34);
 const coin=(n:number,value:number,hours:number,assets?:{assetId:string;amount:bigint}[])=>({txid:String(n).repeat(64).slice(0,64),vout:0,value,expiresAt:now+hours*3600_000,...(assets?{assets}:{})});
 const fresh=[coin(1,600,100),coin(2,500,100),coin(3,330,100,[{assetId:x,amount:9n}]),coin(4,330,100,[{assetId:y,amount:5n}]),coin(5,900,20)];
 assert.deepEqual(shieldPlan(fresh,new Set([x]),now,25*3600_000),{kind:'btc',coins:[fresh[0],fresh[1]],amount:1100},'expiring and asset coins stay out of the BTC deposit');
 assert.deepEqual(shieldPlan(fresh.slice(2),new Set([x]),now,25*3600_000),{kind:'asset',coin:fresh[2],assetId:x,units:9n},'only a listed asset');
 assert.equal(shieldPlan([coin(1,329,100),coin(5,900,20)],new Set(),now,25*3600_000),undefined,'below the dust, or expiring');
});

test('waiting on a spend gives up at its deadline, so a stalled batch cannot hold the wallet',async()=>{
 let polls=0;
 const api=(async()=>{polls++;return {status:'pending'};}) as never;
 await assert.rejects(waitForSpend('ab',async()=>{},api,1,20),/did not settle/);
 assert.ok(polls>1);
});

test('the status sheet names the step in progress, then the outcome',()=>{
 const a={steps:['Pick notes','Prove the payment on this device','Submit to the pool'],current:1};
 assert.equal(sheetLine(a),'Step 2 of 3: Prove the payment on this device');
 assert.equal(sheetLine({...a,current:3,done:true}),'Done');
 assert.equal(sheetLine({...a,error:'The pool dropped this spend.'}),'The pool dropped this spend.');
});

test('withdrawn asset units are listed apart from the rest, so the wallet never promises to shield them',()=>{
 const a='aa'.repeat(34),b='bb'.repeat(34),coin=(txid:string,assetId?:string,amount=0n)=>({txid,vout:0,value:330,...(assetId?{assets:[{assetId,amount}]}:{})});
 const rows=arkAssetHoldings([coin('paid',a,39n),coin('own',a,10n),coin('own2',b,5n),coin('sats')],c=>c.txid==='paid');
 assert.deepEqual(rows.map(r=>[r.assetId,r.payout,r.units,r.coins.map(c=>c.txid)]),[[a,true,39n,['paid']],[a,false,10n,['own']],[b,false,5n,['own2']]]);
});
