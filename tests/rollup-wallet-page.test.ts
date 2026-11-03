import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {rollupWitness} from '../src/rollup/covenant.ts';
import {batchWitnessOutput,witnessOutput} from './fixtures/batch-witness.ts';
import {PAUSED_LINE,arkAssetHoldings,claimTokenError,claimUrl,depositFeeAmountLine,depositFeeBanner,depositFeeLine,depositFeeOutsideLine,holdingsText,invoiceCarriesAmount,invoiceFeeClause,invoiceQr,isInvoice,lightningMinimumLine,listedAssetLine,listingBlocked,payTarget,privateReceiveView,routeCopy,satsText,sheetLine,shieldFeeOf,shortValue} from '../app/src/rollup-client.ts';
import {batchStatements,bornAtFor,checkSigningRequest,depositFeeFor,pickNote,planFeeOf,poolApiOf,rollupApi,shieldableWithFee,shieldPlan,waitForSpend,type ArkCoin,type ShieldPlan,type SpendStatus} from '../src/shielded/pool.ts';
import type {OwnedNote} from '../packages/protocol/src/rollup/account.ts';
import type {EpochHistoryEntry,EpochOwnedNote} from '../packages/protocol/src/rollup/epoch-account.ts';
import {encodeClaimToken} from '../packages/protocol/src/rollup/bearer.ts';
import {rollupAddressOf} from '../packages/protocol/src/rollup/wallet.ts';
import {soundbarItem} from '../app/src/wallet-soundbar.tsx';
import {shieldTitle} from '../src/shielded/wallet.ts';
import type {PrivateReceiveState} from '../src/shielded/lnurl-receive.ts';

const note=(amount:bigint,nullifier:bigint):OwnedNote=>({amount,asset:0n,rho:1n,index:0,nullifier});
const tx=(inputs:{txid:string;index:number;script:Uint8Array}[])=>{
 const t=new Transaction({allowUnknownOutputs:true});
 for(const i of inputs)t.addInput({txid:i.txid,index:i.index,witnessUtxo:{script:i.script,amount:1000n}});
 t.addOutput({script:hex.decode('0014'+'11'.repeat(20)),amount:1000n});
 return t;
};
const psbt=(t:Transaction)=>base64.encode(t.toPSBT());

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

test('a depositor signs only a batch that spends the pool head first, its own coin at its input, and carries its statement',()=>{
 const pool=hex.decode('0014'+'aa'.repeat(20)),user=hex.decode('0014'+'bb'.repeat(20)),coin={txid:'cc'.repeat(32),vout:1},statement=0xffffn;
 const head=tx([{txid:'dd'.repeat(32),index:0,script:pool}]),mine=tx([{txid:coin.txid,index:coin.vout,script:user}]);
 const inputs=[{txid:head.id,index:0,script:pool},{txid:mine.id,index:0,script:user}];
 const carrying=(statements:bigint[])=>{const t=tx(inputs);t.addOutput(batchWitnessOutput(statements));return psbt(t);};
 const request:SpendStatus={status:'signing',arkTx:carrying([7n,statement]),checkpoints:[psbt(head),psbt(mine)],checkpoint:psbt(mine),vin:1};
 checkSigningRequest(request,coin,hex.encode(pool),statement);
 assert.throws(()=>checkSigningRequest(request,coin,hex.encode(user),statement),/pool head/);
 assert.throws(()=>checkSigningRequest(request,{...coin,vout:0},hex.encode(pool),statement),/deposit coin/);
 const elsewhere=tx([{txid:head.id,index:0,script:pool},{txid:'ee'.repeat(32),index:0,script:user}]);
 assert.throws(()=>checkSigningRequest({...request,arkTx:psbt(elsewhere)},coin,hex.encode(pool),statement),/deposit coin/);
 assert.throws(()=>checkSigningRequest({...request,arkTx:carrying([7n,statement+1n])},coin,hex.encode(pool),statement),/carry this deposit/);
 assert.throws(()=>checkSigningRequest({...request,arkTx:psbt(tx(inputs))},coin,hex.encode(pool),statement),/witness cannot be read/);
});

test('batchStatements reads every slot of a witness rollupWitness wrote, last slot first, and refuses one it cannot read',()=>{
 const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-epoch-covenant-snarkjs.json','utf8')),[slot]=fixture.slots,publics=slot.publicSignals.map(BigInt);
 const other=[publics[0]+1n,...publics.slice(1)],items=rollupWitness(fixture.batch.proof,[{proof:slot.proof,publics},{proof:slot.proof,publics:other}]);
 const witnessed=(witness:Uint8Array[])=>{const t=tx([{txid:'dd'.repeat(32),index:0,script:hex.decode('0014'+'aa'.repeat(20))}]);t.addOutput(witnessOutput(witness));return t;};
 assert.deepEqual(batchStatements(witnessed(items)),[other[0],publics[0]]);
 for(const bad of [items.slice(0,8),items.slice(0,-1)])assert.throws(()=>batchStatements(witnessed(bad)),/witness cannot be read/);
 assert.throws(()=>batchStatements(tx([{txid:'dd'.repeat(32),index:0,script:hex.decode('0014'+'aa'.repeat(20))}])),/witness cannot be read/);
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

const flat={fixedSats:100,bps:0},feeAddress=rollupAddressOf({owner:1n,viewPublic:new Uint8Array(32).fill(7)});
const coinOf=(n:number,value:number,assets?:ArkCoin['assets']):ArkCoin=>({txid:String(n).repeat(64).slice(0,64),vout:0,value,...(assets?{assets}:{})});
const planned=(coins:ArkCoin[],fee?:Parameters<typeof shieldPlan>[4],listed:string[]=[])=>shieldPlan(coins,new Set(listed),0,0,fee);

test('with a fee on, a plan whose coins are all pool payouts deposits the largest alone, so it keeps its exemption',()=>{
 const [a,b,c]=[coinOf(1,500),coinOf(2,900),coinOf(3,700)],exempt=()=>true;
 assert.deepEqual(planned([a,b,c],{schedule:flat,exempt}),{kind:'btc',coins:[b],amount:900});
 assert.deepEqual(planned([a,b,c],{schedule:flat,exempt:coin=>coin!==c}),{kind:'btc',coins:[a,b,c],amount:2100},'one coin that is not a payout leaves them merged');
 for(const fee of [{schedule:flat},{exempt},{schedule:{fixedSats:0,bps:0},exempt}])assert.deepEqual(planned([a,b,c],fee),{kind:'btc',coins:[a,b,c],amount:2100},'with no fee charging, or no exemption known, they merge as ever');
 assert.deepEqual(planned([c],{schedule:flat,exempt}),{kind:'btc',coins:[c],amount:700});
 const [small,large]=[coinOf(5,330),coinOf(6,400)],half=[coinOf(7,200),coinOf(8,200)];
 assert.deepEqual(planned([small,large],{schedule:flat,exempt}),{kind:'btc',coins:[large],amount:400},'the largest payout goes first, fee-free');
 assert.deepEqual(planned([small],{schedule:flat,exempt}),{kind:'btc',coins:[small],amount:330},'and the other alone on a later pass');
 assert.equal(planned(half,{schedule:flat,exempt:coin=>coin===half[0]}),undefined,'one coin that pays makes the whole plan pay: 400 less 100 is under the minimum');
});

test('a plan the fee would leave under the dust minimum is not shielded, and an asset coin behind it still is',()=>{
 const x='ee'.repeat(34),asset=coinOf(2,330,[{assetId:x,amount:9n}]),small=coinOf(1,400);
 assert.equal(planned([small],{schedule:flat}),undefined,'400 less the 100 fee leaves 300');
 assert.deepEqual(planned([small]),{kind:'btc',coins:[small],amount:400},'with no fee it shields as ever');
 assert.deepEqual(planned([small,asset],{schedule:flat},[x]),{kind:'asset',coin:asset,assetId:x,units:9n});
 assert.deepEqual([330,429,430].map(value=>planned([coinOf(3,value)],{schedule:flat})?.kind),[undefined,undefined,'btc'],'the plan keeps exactly the minimum, and plain sats get no free allowance');
 assert.deepEqual([659,660].map(value=>planned([coinOf(3,value)],{schedule:{fixedSats:0,bps:5_000}})?.kind),[undefined,'btc'],'the bps share rounds up');
 assert.deepEqual([329,330,429].map(value=>planned([coinOf(3,value)],{schedule:flat,exempt:()=>true})?.kind),[undefined,'btc','btc'],'a pool payout pays no fee, so only the dust minimum gates it');
 assert.equal(planned([small],{schedule:flat,exempt:()=>false}),undefined,'a coin that is not a payout still pays');
});

test('an asset coin shields when its carrier is free or the fee still leaves a dust carrier',()=>{
 const x='ee'.repeat(34),asset=(value:number)=>coinOf(1,value,[{assetId:x,amount:9n}]),carriers=[300,330,331,400,430,1000];
 assert.deepEqual(carriers.map(value=>shieldableWithFee({kind:'asset',coin:asset(value),assetId:x,units:9n},flat)),[true,true,false,false,true,true]);
 assert.deepEqual(carriers.map(value=>planned([asset(value)],{schedule:flat},[x])?.kind),['asset','asset',undefined,undefined,'asset','asset'],'the plan agrees');
 const returning=()=>true;
 assert.ok(carriers.every(value=>shieldableWithFee({kind:'asset',coin:asset(value),assetId:x,units:9n},flat,returning)),'a returning payout owes no carrier fee');
 assert.deepEqual([returning,()=>false].map(exempt=>planned([asset(400)],{schedule:flat,exempt},[x])?.kind),['asset',undefined]);
 const paying=coinOf(2,1000,[{assetId:x,amount:3n}]);
 assert.deepEqual(planned([asset(400),paying],{schedule:flat},[x]),{kind:'asset',coin:paying,assetId:x,units:3n},'a coin the fee would eat does not hold back the next one');
});

test('a plan owes the schedule\'s fee, and nothing when every coin in it is exempt',()=>{
 const x='ee'.repeat(34),schedule={fixedSats:100,bps:50},[a,b]=[coinOf(1,60_000),coinOf(2,40_000)],btc:ShieldPlan={kind:'btc',coins:[a,b],amount:100_000};
 const carrier=(value:number):ShieldPlan=>({kind:'asset',coin:coinOf(3,value,[{assetId:x,amount:9n}]),assetId:x,units:9n});
 assert.deepEqual([planFeeOf(btc,schedule),planFeeOf(btc,schedule,()=>true),planFeeOf(btc,schedule,coin=>coin===a),planFeeOf(btc,undefined)],[500n,0n,500n,0n],'one coin that pays makes the plan pay on the whole amount');
 assert.deepEqual([330,400].map(value=>planFeeOf(carrier(value),schedule)),[0n,100n],'a dust carrier is free and a bigger one pays the whole fee');
 assert.equal(planFeeOf(carrier(400),schedule,()=>true),0n);
});

test('a pool that advertises a malformed fee is read as no fee',()=>{
 const status=(depositFee:unknown)=>({pool:{depositFee}}) as never,good={fixedSats:100,bps:25,address:feeAddress};
 assert.deepEqual(depositFeeFor(status(good)),good);
 for(const bad of [{fixedSats:1,bps:99_999,address:feeAddress},{...good,fixedSats:0,bps:0},{...good,address:'shrol2xyz'},'fee',null,undefined])assert.equal(depositFeeFor(status(bad)),undefined,JSON.stringify(bad));
 assert.equal(depositFeeFor(undefined),undefined);
 assert.equal(depositFeeFor({} as never),undefined);
});

test('waiting on a spend gives up at its deadline, so a stalled batch cannot hold the wallet',async(t)=>{
 t.mock.timers.enable({apis:['Date']});
 let polls=0;
 const api=(async()=>{polls++;t.mock.timers.tick(15);return {status:'pending'};}) as never;
 await assert.rejects(waitForSpend('ab',async()=>{},api,1,20),/did not settle/);
 assert.equal(polls,2);
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

test('the soundbar shows a running action before the wallet\'s own upkeep, and nothing when idle',()=>{
 const sheet={title:shieldTitle({kind:'btc',coins:[],amount:3000}),steps:['Prepare the deposit coin','Prove the deposit on this device'],current:1};
 const idle={recovering:false,inFlight:false,syncing:false,recoveryLine:'Recovering notes.'};
 assert.equal(soundbarItem(idle),undefined);
 assert.deepEqual(soundbarItem({...idle,sheet,recovering:true,inFlight:true,syncing:true}),{title:'Shielding 3,000 sats',line:'Step 2 of 2: Prove the deposit on this device',state:'active',steps:sheet});
 assert.equal(soundbarItem({...idle,sheet:{...sheet,done:true}})?.state,'done');
 assert.deepEqual(soundbarItem({...idle,sheet:{...sheet,done:true,error:'The pool dropped this spend.'}}),{title:'Shielding 3,000 sats',line:'The pool dropped this spend. It tries again in a minute.',state:'failed',steps:{...sheet,done:true,error:'The pool dropped this spend.'}});
 assert.deepEqual(soundbarItem({...idle,recovering:true,inFlight:true,syncing:true}),{title:'Recovering',line:'Recovering notes.',state:'active'});
 assert.equal(soundbarItem({...idle,inFlight:true,syncing:true})?.title,'Notes in flight');
 assert.equal(soundbarItem({...idle,syncing:true})?.title,'Syncing');
});

test('a scanned or pasted payment code becomes a destination, and a payment link\'s amount comes with it',()=>{
 const invoice='lnbc10u1pjexample';
 assert.deepEqual(payTarget(' lightning:'+invoice.toUpperCase()+'\n'),{to:invoice});
 assert.deepEqual(payTarget('LIGHTNING:'+invoice),{to:invoice});
 assert.deepEqual(payTarget('bitcoin:bc1qexample?amount=0.00001&ark=tark1abc&lightning='+invoice),{to:'tark1abc',amount:1000});
 assert.deepEqual(payTarget('BITCOIN:BC1QEXAMPLE?AMOUNT=1.5&LIGHTNING='+invoice.toUpperCase()),{to:invoice,amount:150_000_000});
 assert.deepEqual(payTarget('bitcoin:bc1qexample?amount=0.000000001'),{to:'bc1qexample'});
 assert.deepEqual(payTarget('SHROL21ABC'),{to:'shrol21abc'});
 assert.deepEqual(payTarget('Satoshi@example.com'),{to:'Satoshi@example.com'});
 assert.throws(()=>payTarget('bitcoin:bc1qexample?amount=0.0001&req-pop=callback%3A'),/req-pop/);
 assert.throws(()=>payTarget('BITCOIN:BC1QEXAMPLE?REQ-SOMETHING=1'),/req-something/);
 assert.equal(invoiceQr(invoice),'LIGHTNING:'+invoice.toUpperCase());
 assert.throws(()=>payTarget('bitcoin:?amount=0.001'),/no destination/);
 assert.deepEqual(payTarget('bitcoin:?lightning=lnbc1x=y'),{to:'lnbc1x=y'});
});

test('a pool whose reserves are full refuses another listing instead of swallowing it',()=>{
 const pool=(reserves:number,maxReserves?:number)=>({token:'t',address:'a',script:'s',batches:0,root:'0',head:{txid:'ab',vout:0,value:1000},pending:0,padding:0,
  reserves:Object.fromEntries(Array.from({length:reserves},(_,i)=>[i.toString(16).padStart(2,'0').repeat(34),'1'])),...(maxReserves===undefined?{}:{maxReserves})});
 assert.equal(listingBlocked(pool(7,8)),undefined);
 assert.match(listingBlocked(pool(8,8))??'',/already lists 8 assets/);
 assert.match(listingBlocked(pool(9,8))??'',/would lose/,'a pool over its cap stays closed, not just at it');
 assert.equal(listingBlocked(pool(8)),undefined,'a pool that does not report a cap is not second-guessed');
 assert.equal(listingBlocked(undefined),undefined);
});

test('the route preview names what each rail makes public, and never leaves a rail unexplained',()=>{
 assert.deepEqual(routeCopy('shielded'),{title:'Private payment',detail:'The amount and both parties stay private.'});
 assert.equal(routeCopy('shielded-withdraw').title,'Withdraw from the pool');
 assert.match(routeCopy('shielded-withdraw').detail,/become public/);
 assert.equal(routeCopy('ark').title,'Arkade payment');
 assert.equal(routeCopy('ark-asset').title,'Arkade payment');
 assert.equal(routeCopy('onchain').title,'On-chain exit');
 const exit=routeCopy('shielded-exit');
 assert.equal(exit.title,'Withdraw on-chain');
 for(const claim of [/fresh key used only for this exit/,/amount and the destination become public/,/not linked to your deposit address/])assert.match(exit.detail,claim);
 assert.doesNotMatch(exit.detail,/your own Arkade address|linked to that address/,'the old disclosure must not outlive the fix');
 assert.match(routeCopy('lightning').detail,/One pool note pays a swap.*public/);
 assert.doesNotMatch(routeCopy('lightning').detail,/Arkade balance|whatever it lacks/,'the old top-up route must not outlive the fix');
 assert.deepEqual(routeCopy('lnurl-lightning'),routeCopy('lightning'));
 const shielded=routeCopy('lnurl-shielded');
 assert.equal(shielded.title,'Pay the Lightning address privately');
 for(const claim of [/private inside the pool/i,/shielded address its owner registered/,/address service sees the amount you request/,/also learns that you pay from the pool/])assert.match(shielded.detail,claim);
});

test('the deposit-fee line names a fixed fee, a share, or both, and says nothing when there is no fee',()=>{
 assert.equal(depositFeeLine(undefined),'');
 assert.equal(depositFeeLine({fixedSats:0,bps:0}),'');
 assert.match(depositFeeLine({fixedSats:100,bps:0}),/100-sat deposit fee/);
 assert.match(depositFeeLine({fixedSats:0,bps:50}),/0\.5% of each deposit/);
 assert.match(depositFeeLine({fixedSats:100,bps:50}),/100 sats or 0\.5%.*whichever is more/);
 assert.equal(depositFeeLine({fixedSats:2500,bps:0}),'This pool charges a 2,500-sat deposit fee.');
 assert.equal(depositFeeLine({fixedSats:0,bps:1}),'This pool charges a deposit fee of 0.01% of each deposit.');
 assert.equal(depositFeeLine({fixedSats:1500,bps:125}),'This pool charges a deposit fee of 1,500 sats or 1.25% of each deposit, whichever is more.');
});

test('the pause banner reads as a new fee when nothing was accepted, and as a rise when a lower fee was',()=>{
 const tail=' Nothing new moves into the pool until you accept it.',fixed={fixedSats:100,bps:0},both={fixedSats:100,bps:50};
 for(const accepted of [undefined,{fixedSats:0,bps:0}])assert.equal(depositFeeBanner(fixed,accepted),'This pool now charges a 100-sat deposit fee.'+tail);
 assert.equal(depositFeeBanner({fixedSats:0,bps:50},undefined),'This pool now charges a deposit fee of 0.5% of each deposit.'+tail);
 assert.equal(depositFeeBanner({fixedSats:300,bps:0},fixed),'This pool raised its deposit fee to 300 sats.'+tail);
 assert.equal(depositFeeBanner({fixedSats:0,bps:100},{fixedSats:0,bps:50}),'This pool raised its deposit fee to 1% of each deposit.'+tail);
 assert.equal(depositFeeBanner(both,fixed),'This pool raised its deposit fee to 100 sats or 0.5% of each deposit, whichever is more.'+tail);
 assert.equal(depositFeeBanner({fixedSats:0,bps:0},undefined),'');
 for(const text of [depositFeeLine(both),depositFeeBanner(both,undefined),depositFeeBanner(both,fixed)])assert.doesNotMatch(text,/bps|schedule|basis point/i);
});

test('the amount line states the fee a deposit pays and what reaches the pool, and nothing when it pays none',()=>{
 assert.equal(depositFeeAmountLine(100n,5000),'Your next deposit of 5,000 sats pays a 100-sat fee, so 4,900 sats reach the pool.');
 assert.equal(depositFeeAmountLine(12345n,123456789),'Your next deposit of 123,456,789 sats pays a 12,345-sat fee, so 123,444,444 sats reach the pool.');
 assert.equal(depositFeeAmountLine(0n,5000),'');
});

test('a shield row\'s fee is the deposited amount less the notes it created',()=>{
 const owned=(amount:bigint,asset=0n):EpochOwnedNote=>({amount,asset,rho:1n,epoch:0,index:0,nullifier:amount}),field=7n;
 const entry=(kind:EpochHistoryEntry['kind'],amounts:EpochHistoryEntry['amounts'],created:EpochOwnedNote[]):EpochHistoryEntry=>({kind,batch:1,epoch:0,amounts,spent:[],created,slots:[0]});
 assert.equal(shieldFeeOf(entry('shield',[{asset:0n,amount:1000n}],[owned(900n)])),100n);
 assert.equal(shieldFeeOf(entry('shield',[{asset:0n,amount:1000n}],[owned(1000n)])),0n);
 assert.equal(shieldFeeOf(entry('shield',[{asset:0n,amount:1000n}],[owned(500n),owned(400n)])),100n,'every BTC note it created counts');
 assert.equal(shieldFeeOf(entry('shield',[{asset:field,amount:9n},{asset:0n,amount:400n}],[owned(9n,field),owned(300n)])),100n,'an asset group reports its carrier\'s fee, not its units');
 assert.equal(shieldFeeOf(entry('shield',[{asset:field,amount:9n},{asset:0n,amount:330n}],[owned(9n,field),owned(330n)])),0n,'a dust-sized carrier is free');
 assert.equal(shieldFeeOf(entry('shield',[{asset:field,amount:9n},{asset:0n,amount:400n}],[owned(4n,field),owned(300n)])),100n,'asset units deposited do not count');
 assert.equal(shieldFeeOf(entry('shield',[{asset:0n,amount:400n}],[owned(5n,field),owned(300n)])),100n,'nor do asset notes created');
 for(const kind of ['receive','send','withdraw','merge','renew','recover'] as const)assert.equal(shieldFeeOf(entry(kind,[{asset:0n,amount:1000n}],[owned(900n)])),undefined,kind);
});

test('the private-receive box follows the user\'s choice, and one notice follows what the service lists',()=>{
 const none:PrivateReceiveState={on:false,pending:false,refused:false,withdrawing:false,listed:null};
 const table:[string,Partial<PrivateReceiveState>,boolean,string[]][]=[
  ['off',{},false,['','own','foreign']],
  ['on, not yet confirmed',{pending:true},true,['confirming','confirming','foreign']],
  ['live',{on:true},true,['','','foreign']],
  ['refused',{refused:true},false,['refused','own','foreign']],
  ['withdrawing',{withdrawing:true},false,['','pending','pending']],
 ];
 for(const [name,state,checked,notices] of table)([null,'own','foreign'] as const).forEach((listed,i)=>assert.deepEqual(privateReceiveView({...none,...state,listed}),{checked,notice:notices[i]},`${name}, listed ${listed}`));
});

test('a long value shows its start and end, and a short one shows whole',()=>{
 const address='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85w7uvgv97lw5jy95gz0xt75dsuwl424vj7efx3kzpx0g72kmh8ccllyxes';
 assert.equal(shortValue(address),'tark1qqcpq7yq3e8hhsx…kmh8ccllyxes');
 for(const whole of ['swift-badger@lnurl.mutinynet.arkade.sh','x'.repeat(48)])assert.equal(shortValue(whole),whole);
 assert.equal(shortValue('x'.repeat(49)),`${'x'.repeat(20)}…${'x'.repeat(12)}`);
});

test('the claim card reads a link\'s token and holdings without the network',()=>{
 const token=encodeClaimToken({secret:new Uint8Array(32).fill(1),batch:5});
 assert.equal(claimTokenError(token),'');
 assert.equal(claimTokenError('nonsense'),'Not a claim link.');
 assert.equal(claimUrl('https://pool.test',token),`https://pool.test/claim#${token}`);
 const id='1e291e28'.padEnd(64,'0')+'0000',field=7n,assetIdOf=(f:bigint)=>f===field?id:undefined;
 assert.equal(holdingsText([{asset:0n,amount:600n},{asset:0n,amount:400n}],assetIdOf),'1,000 sats');
 assert.equal(holdingsText([{asset:field,amount:9n}],assetIdOf),'9 units of asset 1e291e28…0000');
 assert.equal(holdingsText([{asset:3n,amount:2n},{asset:0n,amount:1n}],assetIdOf),'2 units of an unlisted asset and 1 sat');
 assert.equal(holdingsText([{asset:field,amount:2n**60n+1n}],assetIdOf),'1,152,921,504,606,846,977 units of asset 1e291e28…0000');
});

test('the keep-out line names the plain sats only the fee leaves under the minimum',()=>{
 const now=1_000_000,floor=25*3600_000,at=(n:number,value:number,hours=100):ArkCoin=>({...coinOf(n,value),expiresAt:now+hours*3600_000}),out=(coins:ArkCoin[])=>depositFeeOutsideLine(coins,flat,now,floor);
 assert.equal(out([at(1,400)]),'400 sats stay outside the pool: after the 100-sat deposit fee they would be below the 330-sat minimum.');
 assert.equal(out([at(1,200),at(2,200)]),out([at(3,400)]),'the plain coins one deposit would take count together');
 assert.match(depositFeeOutsideLine([at(1,659)],{fixedSats:0,bps:5_000},now,floor),/^659 sats .* after the 330-sat deposit fee/);
 const quiet:[ArkCoin[],string][]=[[[at(1,430)],'the fee leaves the minimum'],[[at(1,329)],'under the minimum with no fee too'],[[at(1,400,1)],'expiring, which the renew line covers'],[[],'no coins']];
 for(const [coins,why] of quiet)assert.equal(out(coins),'',why);
 const asset=coinOf(4,400,[{assetId:'ee'.repeat(34),amount:9n}]);
 assert.deepEqual([out([asset]),listedAssetLine([asset],flat,new Set(['ee'.repeat(34)]),now,floor,false)],['','This coin stays outside the pool: after the 100-sat deposit fee, its 400 sats would be below the 330-sat minimum.'],'an asset coin is told on its own card, not the funding one');
 assert.equal(depositFeeOutsideLine([at(1,400)],undefined,now,floor),'','no fee, no line');
});

test('the Lightning minimum is the smallest payout that keeps 330 sats after its own fee',()=>{
 const tail='move into the pool while this page is open; smaller payouts stay outside and are never combined automatically.';
 assert.equal(lightningMinimumLine(undefined),`Payouts of at least 330 sats ${tail}`,'no fee: the sentence as before');
 assert.equal(lightningMinimumLine(flat),`Payouts of at least 430 sats, the 330-sat minimum plus the deposit fee, ${tail}`);
 const pinned:[typeof flat,number][]=[[flat,430],[{fixedSats:0,bps:303},341],[{fixedSats:0,bps:5_000},660],[{fixedSats:2500,bps:125},2830],[{fixedSats:1,bps:9_999},3_300_000]];
 for(const [fee,least] of pinned){
  assert.match(lightningMinimumLine(fee),new RegExp(`^Payouts of at least ${least.toLocaleString('en-US')} sats,`),JSON.stringify(fee));
  assert.deepEqual([least-1,least].map(amount=>shieldableWithFee({kind:'btc',coins:[],amount},fee)),[false,true],`the wallet shields ${least} and not one sat less`);
 }
 assert.equal(lightningMinimumLine({fixedSats:0,bps:10_000}),'Payouts stay outside the pool: the deposit fee would leave each one below the 330-sat minimum.');
});

test('a listed asset coin the fee would leave under the carrier minimum says so, and while paused one it lets in waits',()=>{
 const x='ee'.repeat(34),listed=new Set([x]),now=1_000_000,floor=25*3600_000;
 const coin=(n:number,value:number,hours=100,assets=[{assetId:x,amount:9n}]):ArkCoin=>({...coinOf(n,value,assets),expiresAt:now+hours*3600_000});
 const line=(coins:ArkCoin[],fee:typeof flat|undefined,paused=false,ids:Set<string>=listed)=>listedAssetLine(coins,fee,ids,now,floor,paused);
 const out='This coin stays outside the pool: after the 100-sat deposit fee, its 400 sats would be below the 330-sat minimum.';
 assert.equal(line([coin(1,400),coin(2,330)],flat),out,'only the coin the fee keeps out');
 assert.deepEqual([line([coin(2,330)],flat,true),line([coin(1,400),coin(2,330)],flat,true),line([coin(1,400)],flat,true)],[PAUSED_LINE,`${out} ${PAUSED_LINE}`,out],'while paused a coin the fee lets in waits; one it keeps out is told only that');
 assert.equal(PAUSED_LINE,'Nothing new moves into the pool until you accept the new fee.');
 const quiet:[ArkCoin[],string][]=[[[coin(1,330)],'a dust carrier is free'],[[coin(1,430)],'the fee leaves the minimum'],[[coin(1,400,1)],'expiring'],[[coin(1,400,100,[{assetId:x,amount:9n},{assetId:'ff'.repeat(34),amount:1n}])],'a coin with two assets never shields']];
 for(const [coins,why] of quiet)assert.equal(line(coins,flat),'',why);
 assert.equal(line([coin(1,400)],flat,false,new Set()),'','an unlisted asset');
 assert.equal(line([coin(1,400)],undefined),'','no fee');
});

test('the banner says raised only when no part of the fee fell',()=>{
 const tail=' Nothing new moves into the pool until you accept it.';
 assert.equal(depositFeeBanner({fixedSats:100,bps:50},{fixedSats:200,bps:0}),'This pool changed its deposit fee to 100 sats or 0.5% of each deposit, whichever is more.'+tail);
 assert.equal(depositFeeBanner({fixedSats:200,bps:50},{fixedSats:200,bps:0}),'This pool raised its deposit fee to 200 sats or 0.5% of each deposit, whichever is more.'+tail,'a part that held is not a fall');
});

test('a waiting invoice names the deposit fee the pool takes from what arrives',()=>{
 assert.equal(invoiceFeeClause(undefined,5_050n,50n),'');
 assert.equal(invoiceFeeClause(flat,5_050n,50n),' and the deposit fee takes 100');
 assert.equal(invoiceFeeClause({fixedSats:0,bps:100},10_100n,100n),' and the deposit fee takes 100','1% of the 10,000-sat payout, not of the 10,100 paid');
});

test('a waiting invoice names no deposit fee for a payout too small to enter the pool',()=>{
 assert.equal(invoiceFeeClause({fixedSats:2500,bps:0},1_050n,50n),'','a flat 2,500 on a 1,000-sat payout');
 assert.deepEqual([479n,480n].map(pays=>invoiceFeeClause(flat,pays,50n)),['',' and the deposit fee takes 100'],'429 sats would keep 329; 430 keep the minimum');
});

test('a count of one reads as 1 sat',()=>{
 assert.deepEqual([satsText(1),satsText(1n),satsText(0),satsText(2_500n)],['1 sat','1 sat','0 sats','2,500 sats']);
 assert.equal(depositFeeLine({fixedSats:1,bps:50}),'This pool charges a deposit fee of 1 sat or 0.5% of each deposit, whichever is more.');
 assert.equal(depositFeeBanner({fixedSats:1,bps:50},{fixedSats:0,bps:50}),'This pool raised its deposit fee to 1 sat or 0.5% of each deposit, whichever is more. Nothing new moves into the pool until you accept it.');
 assert.equal(holdingsText([{asset:0n,amount:1n}],()=>undefined),'1 sat');
});
