import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {checkSigningRequest,pickNote,rollupApi,shieldPlan,spendBody,waitForSpend,type SpendStatus} from '../app/src/rollup-client.ts';
import type {BuiltSpend,OwnedNote} from '../packages/protocol/src/rollup/account.ts';

const note=(amount:bigint,nullifier:bigint):OwnedNote=>({amount,asset:0n,rho:1n,index:0,nullifier});
const tx=(inputs:{txid:string;index:number;script:Uint8Array}[])=>{
 const t=new Transaction({allowUnknownOutputs:true});
 for(const i of inputs)t.addInput({txid:i.txid,index:i.index,witnessUtxo:{script:i.script,amount:1000n}});
 t.addOutput({script:hex.decode('0014'+'11'.repeat(20)),amount:1000n});
 return t;
};
const psbt=(t:Transaction)=>base64.encode(t.toPSBT());

test('a spend takes the smallest single note that covers it, skipping notes already in flight',()=>{
 const notes=[note(500n,1n),note(120n,2n),note(300n,3n)];
 assert.equal(pickNote(notes,250n,new Set())?.amount,300n);
 assert.equal(pickNote(notes,250n,new Set([3n]))?.amount,500n);
 assert.equal(pickNote(notes,600n,new Set()),undefined);
});

test('a spend body carries decimal field elements, the hex record, and only the legs it has',()=>{
 const built={witness:{slot:{root:7n,nullifiers:[11n],commitments:[12n,13n],ctDigest:14n,groupId:0n,groupSize:0},publicSignals:[1n,2n,0n,0n,0n],input:{}},ciphertext:Uint8Array.of(1,2),change:0n} as unknown as BuiltSpend;
 const proof={pi_a:['1'],pi_b:[['2']],pi_c:['3']};
 assert.deepEqual(spendBody('ab',built,proof),{id:'ab',slot:{root:'7',nullifiers:['11'],commitments:['12','13'],ctDigest:'14',groupId:'0',groupSize:0},publics:['1','2','0','0','0'],proof,ciphertext:'0102'});
 const member={...built,witness:{...built.witness,slot:{...built.witness.slot,groupId:99n,groupSize:3}}} as BuiltSpend;
 assert.deepEqual([spendBody('ab',member,proof).slot.groupId,spendBody('ab',member,proof).slot.groupSize],['99',3]);
 const withLegs=spendBody('ab',built,proof,{program:new Uint8Array(32).fill(1),coin:{txid:'cd'.repeat(32),vout:2,tapTree:'aa',leaf:'bb'},asset:'ee'.repeat(34)});
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
