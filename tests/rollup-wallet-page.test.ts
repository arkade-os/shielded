import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {arkAssetHoldings,claimTokenError,claimUrl,holdingsText,invoiceCarriesAmount,isInvoice,routeCopy,sheetLine} from '../app/src/rollup-client.ts';
import {bornAtFor,checkSigningRequest,pickNote,poolApiOf,provingUrls,rollupApi,shieldPlan,transferBody,waitForSpend,type SpendStatus} from '../src/shielded/pool.ts';
import type {BuiltSpend,OwnedNote} from '../packages/protocol/src/rollup/account.ts';
import {encodeClaimToken} from '../packages/protocol/src/rollup/bearer.ts';

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
 assert.deepEqual(provingUrls(join,proving,'http://pool.test'),{wasm:'http://pool.test/api/rollup/proving/join.wasm?v=j1',zkey:'http://pool.test/api/rollup/proving/join.zkey?v=j2'});
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
 const seen:string[]=[],spy=(async(url:string)=>{seen.push(url);return new Response('{}');}) as unknown as typeof fetch;
 await rollupApi('/status',undefined,spy,0);await rollupApi('/status',undefined,spy,0,'http://pool.test');await poolApiOf('http://pool.test',spy)('/status');
 assert.deepEqual(seen,['/api/rollup/status','http://pool.test/api/rollup/status','http://pool.test/api/rollup/status'],'a page keeps relative URLs; a Node caller names the pool by origin');
});

test('a refusal keeps the pool\'s rejection code, so a lost race reads differently from other errors',async()=>{
 const refusing=(async()=>new Response(JSON.stringify({error:'The note is already spent or pending.',code:'double-spend'}),{status:400})) as unknown as typeof fetch;
 await assert.rejects(rollupApi('/spends',{},refusing,0),(error:Error&{status?:number;code?:string})=>error.status===400&&error.code==='double-spend'&&/already spent/.test(error.message));
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

test('an invoice takes a typed amount only when it pins none, and Lightning addresses are not invoices',()=>{
 const pinned='lntbs10u1p4dpdhppp5mrkkvsl380k972sd7admdw8f2q27a3afwkz4hhcneq6ycsx62dysdqqcqzzsxqyz5vqsp5vga9lqg0c6dlele06x7zduqwjeevhwyur8erfhr073vttlsrwh0s9qxpqysgq';
 const open='lntbs1p4dpdhppp5mrkkvsl380k972sd7admdw8f2q27a3afwkz4hhcneq6ycsx62dysdqqcqzzsxqyz5vqsp5vga9lqg0c6dlele06x7zduqwjeevhwyur8erfhr073vttlsrwh0s9qxpqysgq';
 assert.deepEqual([pinned,`lightning:${pinned}`,'LNBCRT2500U1PXYZ'].map(invoiceCarriesAmount),[true,true,true]);
 assert.deepEqual([open,'lnbc1pxyz','alice@lnurl.mutinynet.arkade.sh','LNURL1DP68GURN8GHJ7','tark1qq'].map(invoiceCarriesAmount),[false,false,false,false,false]);
 assert.deepEqual(['alice@pay.example','LNURL1DP68GURN8GHJ7',open].map(isInvoice),[false,false,true]);
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

test('the status sheet renders a step state the handle produced, title and all',()=>{
 const state={title:'Sending privately',steps:['Pick notes','Prove the payment on this device','Submit to the pool'],current:1};
 assert.equal(sheetLine(state),'Step 2 of 3: Prove the payment on this device');
 assert.equal(sheetLine({...state,current:2,done:true}),'Done');
 assert.equal(sheetLine({...state,error:'The pool dropped this spend.'}),'The pool dropped this spend.');
});

test('the route preview names what each rail makes public, and never leaves a rail unexplained',()=>{
 assert.deepEqual(routeCopy('shielded'),{title:'Private payment',detail:'The amount and both parties stay private.'});
 assert.equal(routeCopy('shielded-withdraw').title,'Withdraw from the pool');
 assert.match(routeCopy('shielded-withdraw').detail,/become public/);
 assert.equal(routeCopy('ark').title,'Arkade payment');
 assert.equal(routeCopy('ark-asset').title,'Arkade payment');
 assert.equal(routeCopy('onchain').title,'On-chain exit');
 assert.match(routeCopy('lightning').detail,/public/);
});

test('the claim card reads a link\'s token and holdings without the network',()=>{
 const token=encodeClaimToken({secret:new Uint8Array(32).fill(1),batch:5});
 assert.equal(claimTokenError(token),'');
 assert.equal(claimTokenError('nonsense'),'Not a claim link.');
 assert.equal(claimUrl('https://pool.test',token),`https://pool.test/claim#${token}`);
 const id='1e291e28'.padEnd(64,'0')+'0000',field=7n,assetIdOf=(f:bigint)=>f===field?id:undefined;
 assert.equal(holdingsText([{asset:0n,amount:600n},{asset:0n,amount:400n}],assetIdOf),'1,000 sats');
 assert.equal(holdingsText([{asset:field,amount:9n}],assetIdOf),'9 units of asset 1e291e28…0000');
 assert.equal(holdingsText([{asset:3n,amount:2n},{asset:0n,amount:1n}],assetIdOf),'2 units of an unlisted asset and 1 sats');
});
