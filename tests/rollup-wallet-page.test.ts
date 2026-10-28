import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {arkAssetHoldings,claimTokenError,claimUrl,holdingsText,invoiceCarriesAmount,invoiceQr,isInvoice,listingBlocked,payTarget,privateReceiveView,routeCopy,sheetLine,shortValue} from '../app/src/rollup-client.ts';
import {bornAtFor,checkSigningRequest,pickNote,poolApiOf,rollupApi,shieldPlan,waitForSpend,type SpendStatus} from '../src/shielded/pool.ts';
import type {OwnedNote} from '../packages/protocol/src/rollup/account.ts';
import {encodeClaimToken} from '../packages/protocol/src/rollup/bearer.ts';
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
 assert.match(routeCopy('shielded-exit').detail,/become public, linked to that address/);
 assert.match(routeCopy('lightning').detail,/public/);
 const shielded=routeCopy('lnurl-shielded');
 assert.equal(shielded.title,'Pay the Lightning address privately');
 for(const claim of [/private inside the pool/i,/shielded address its owner registered/,/address service sees the amount you request/,/also learns that you pay from the pool/])assert.match(shielded.detail,claim);
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
 assert.equal(holdingsText([{asset:3n,amount:2n},{asset:0n,amount:1n}],assetIdOf),'2 units of an unlisted asset and 1 sats');
 assert.equal(holdingsText([{asset:field,amount:2n**60n+1n}],assetIdOf),'1,152,921,504,606,846,977 units of asset 1e291e28…0000');
});
