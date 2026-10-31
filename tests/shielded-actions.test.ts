import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {ArkAddress,Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {submitAll} from '../src/shielded/submit.ts';
import {NoteReservation,coversWithdrawal,mergeAssetFields,needsRenewal,nextShieldPlan,programOf,shieldTitle,shieldedSteps,topThree} from '../src/shielded/wallet.ts';
import {batchWitnessOutput} from './fixtures/batch-witness.ts';
import {epochPool} from './fixtures/epoch-pool.ts';

const built=(nullifiers:bigint[],groupId=0n,groupSize=0)=>{const slot={nullifiers,commitments:[12n,13n],ctDigest:14n,groupId,groupSize};
 return {witness:{slot:{root:7n,...slot},publicSignals:[1n,0n,0n,0n,0n],input:{}},slot:{anchor:7n,rCur:{epoch:0,root:8n},...slot},ciphertext:Uint8Array.of(1),change:0n} as unknown as EpochBuiltSpend;};
const prover={prove:async(_b:EpochBuiltSpend,circuit:'spend'|'join')=>({pi_a:[circuit],pi_b:[],pi_c:[]})};
const identity={sign:async(tx:Transaction)=>tx} as never;
const POOL_SCRIPT='51'.repeat(17);
const tx=(inputs:{txid:string;index:number;script:Uint8Array}[])=>{const t=new Transaction({allowUnknownOutputs:true});for(const i of inputs)t.addInput({txid:i.txid,index:i.index,witnessUtxo:{script:i.script,amount:1000n}});t.addOutput({script:hex.decode('0014'+'11'.repeat(20)),amount:1000n});return t;};
const deps=(api:never)=>({api,prover,identity,poolScript:POOL_SCRIPT});

test('a group is proved then submitted in the order its id commits to, and every member is awaited',async()=>{
 const submitted:string[]=[],steps:number[]=[];
 const api=(async(path:string,body?:{slot?:{anchor:string;nullifiers:string[]}})=>{
  if(path==='/spends'){assert.deepEqual([body!.slot!.anchor,'root' in body!.slot!],['7',false]);submitted.push(body!.slot!.nullifiers[0]!);return {};}
  return {status:'included',batch:4,txid:'t'};
 }) as never;
 const members=[built([11n],99n,3),built([21n],99n,3),built([31n],99n,3)].map(b=>({built:b}));
 const final=await submitAll(members,{...deps(api),step:n=>steps.push(n),first:1});
 assert.deepEqual(submitted,['11','21','31']);
 assert.deepEqual(steps,[1,2,3]);
 assert.deepEqual(final,{status:'included',batch:4,txid:'t'});
});

test('a two-nullifier member proves with the join circuit and a one-nullifier member with spend',async()=>{
 const circuits:string[]=[];
 const api=(async(path:string,body?:{proof?:{pi_a:string[]}})=>path==='/spends'?(circuits.push(body!.proof!.pi_a[0]!),{}):{status:'included',txid:'t'}) as never;
 await submitAll([{built:built([11n,12n])}],{...deps(api),step:()=>{},first:0});
 await submitAll([{built:built([11n])}],{...deps(api),step:()=>{},first:0});
 assert.deepEqual(circuits,['join','spend']);
});

test('only the member that owns a deposit coin signs, a member without one is refused, and so is a batch without its statement',async()=>{
 const pool=hex.decode('5120'+'aa'.repeat(32)),user=hex.decode('0014'+'bb'.repeat(20)),coin={txid:'cc'.repeat(32),vout:1};
 const head=tx([{txid:'dd'.repeat(32),index:0,script:pool}]),mine=tx([{txid:coin.txid,index:coin.vout,script:user}]);
 const batch=(statement:bigint)=>{const ark=tx([{txid:head.id,index:0,script:pool},{txid:mine.id,index:0,script:user}]);ark.addOutput(batchWitnessOutput([statement]));return base64.encode(ark.toPSBT());};
 let signing={status:'signing',arkTx:batch(1n),checkpoints:[base64.encode(head.toPSBT()),base64.encode(mine.toPSBT())],checkpoint:base64.encode(mine.toPSBT()),vin:1};
 const signed:string[]=[];
 let asked=false;
 const api=(async(path:string)=>{
  if(path==='/spends')return {};
  if(path.endsWith('/sign')){signed.push(path);return {};}
  if(!asked){asked=true;return signing;}
  return {status:'included',txid:'t'};
 }) as never;
 const withCoin={api,prover,identity,poolScript:hex.encode(pool)};
 const final=await submitAll([{built:built([11n]),extra:{coin:{txid:coin.txid,vout:coin.vout,tapTree:'aa',leaf:'bb'}},coin}],{...withCoin,step:()=>{},first:0});
 assert.equal(final.status,'included');
 assert.equal(signed.length,1);
 asked=false;
 await assert.rejects(submitAll([{built:built([11n])}],{...withCoin,step:()=>{},first:0}),/no deposit coin/i);
 asked=false;signing={...signing,arkTx:batch(2n)};
 await assert.rejects(submitAll([{built:built([11n]),coin}],{...withCoin,step:()=>{},first:0}),/does not carry this deposit/);
 assert.equal(signed.length,1,'the swapped batch is never signed');
});

test('ordinary deposits poll slowly while still signing within the server round',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const pool=hex.decode('5120'+'aa'.repeat(32)),user=hex.decode('0014'+'bb'.repeat(20)),coin={txid:'cc'.repeat(32),vout:1};
 const head=tx([{txid:'dd'.repeat(32),index:0,script:pool}]),mine=tx([{txid:coin.txid,index:coin.vout,script:user}]);
 const ark=tx([{txid:head.id,index:0,script:pool},{txid:mine.id,index:0,script:user}]);ark.addOutput(batchWitnessOutput([1n]));
 const signing={status:'signing',arkTx:base64.encode(ark.toPSBT()),checkpoints:[base64.encode(head.toPSBT()),base64.encode(mine.toPSBT())],checkpoint:base64.encode(mine.toPSBT()),vin:1};
 let signedAt=0,polls=0;
 const api=(async(path:string)=>{
  if(path==='/spends')return {};
  if(path.endsWith('/sign')){signedAt=Date.now();return {};}
  polls++;return signedAt?{status:'included',txid:'t'}:Date.now()>=1_006_001?signing:{status:'pending'};
 }) as never;
 const pending=submitAll([{built:built([11n]),coin}],{api,prover,identity,poolScript:hex.encode(pool),step:()=>{},first:0});
 await setImmediate();
 for(let elapsed=250;elapsed<=15_000;elapsed+=250){t.mock.timers.tick(250);await setImmediate();}
 assert.equal((await pending).status,'included');assert.ok(polls<=6,String(polls));
 assert.ok(signedAt>=1_006_001&&signedAt<=1_011_001,String(signedAt));
});

test('a dropped member is the answer even when a sibling was included',async()=>{
 let n=0;
 const api=(async(path:string)=>path==='/spends'?{}:(n++===0?{status:'included',txid:'t'}:{status:'dropped',reason:'A group member was refused.'})) as never;
 const final=await submitAll([{built:built([11n],9n,2)},{built:built([21n],9n,2)}],{...deps(api),step:()=>{},first:0});
 assert.equal(final.status,'dropped');
 assert.equal(final.reason,'A group member was refused.');
});

test('auto-shield leaves pool payouts and in-flight coins alone, and names what it is shielding',()=>{
 const now=1_000_000,x='ee'.repeat(34),listed=new Set([x]);
 const coin=(n:string,value:number,hours:number,assets?:{assetId:string;amount:bigint}[])=>({txid:n.repeat(64).slice(0,64),vout:0,value,expiresAt:now+hours*3600_000,...(assets?{assets}:{})});
 const mine=coin('1',900,100),payout=coin('2',900,100),taken=coin('3',900,100);
 const plan=nextShieldPlan([mine,payout,taken],{skip:c=>c.txid===payout.txid,used:new Set([`${taken.txid}:0`]),listed,now,floorMs:25*3600_000});
 assert.deepEqual(plan,{kind:'btc',coins:[mine],amount:900});
 assert.equal(shieldTitle(plan!),'Shielding 900 sats');
 assert.equal(nextShieldPlan([payout],{skip:()=>true,used:new Set(),listed,now,floorMs:25*3600_000}),undefined);
 // `skip` is what the "Shield again" button turns off, so a pool payout can still be shielded on request.
 assert.ok(nextShieldPlan([payout],{skip:()=>false,used:new Set(),listed,now,floorMs:25*3600_000}));
 const asset=coin('4',330,100,[{assetId:x,amount:9n}]);
 assert.match(shieldTitle(nextShieldPlan([asset],{skip:()=>false,used:new Set(),listed,now,floorMs:25*3600_000})!),/^Shielding 9 units of asset ee/);
 assert.equal(shieldedSteps.shield.length,6);
});

test('renewal is offered only for coins the pool would refuse as near expiry',()=>{
 const now=1_000_000,floor=25*3600_000;
 const coin=(hours:number)=>({txid:'a'.repeat(64),vout:0,value:900,expiresAt:now+hours*3600_000});
 assert.equal(needsRenewal([coin(100)],now,floor),false);
 assert.equal(needsRenewal([coin(20)],now,floor),true);
 assert.equal(needsRenewal([coin(100),coin(20)],now,floor),true);
 assert.equal(needsRenewal([{txid:'a'.repeat(64),vout:0,value:900}],now,floor),false,'a coin with no expiry needs nothing');
 assert.equal(needsRenewal([],now,floor),false);
});

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const keys=(byte:string)=>deriveRollupKeys2(byte.repeat(32),'mutinynet');
const [aliceKeys,bobKeys]=[keys('11'),keys('22')];
const [aliceTo,bobTo]=[aliceKeys,bobKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));
async function fundedAccount(amounts:bigint[]):Promise<EpochAccount>{
 const pool=epochPool(hash,4),account=EpochAccount.owning(hash,aliceKeys,{epochLen:4});
 await account.apply(pool.land('spend',await Promise.all(amounts.map(amount=>pool.deposit(aliceTo,amount)))));
 return account;
}

// Review Focus 2. `EpochAccount.pay` reads the unspent set and resolves asynchronously, so without the
// reservation two concurrent actions choose the SAME note and the second spend is a certain double-spend.
test('two concurrent picks never choose the same note, because the reservation holds what it picked',async()=>{
 const account=await fundedAccount([400n,500n,600n]);
 const reservation=new NoteReservation();
 const payOnce=()=>reservation.pick(()=>account.pay(bobTo,300n,aliceTo,reservation.inFlight),
  chosen=>chosen.spends.map(s=>s.witness.slot.nullifiers[0]!));
 const [first,second]=await Promise.all([payOnce(),payOnce()]);
 const picked=[first,second].map(r=>String(r.spends[0]!.witness.slot.nullifiers[0]));
 assert.notEqual(picked[0],picked[1],'the second pick must see the first one reserved');
 assert.equal(reservation.inFlight.size,2);
 const naive=await Promise.all([account.pay(bobTo,300n,aliceTo,new Set()),account.pay(bobTo,300n,aliceTo,new Set())]);
 assert.equal(String(naive[0]!.spends[0]!.witness.slot.nullifiers[0]),String(naive[1]!.spends[0]!.witness.slot.nullifiers[0]),'unserialised selection picks the same note twice');
});

test('a rejected pick releases the queue and reserves nothing',async()=>{
 const reservation=new NoteReservation();
 await assert.rejects(reservation.pick(async()=>{throw new Error('no note covers this');},()=>[1n]),/no note covers/);
 assert.equal(reservation.inFlight.size,0);
 assert.deepEqual(await reservation.pick(async()=>[2n],chosen=>chosen),[2n],'the next pick still runs');
 assert.deepEqual([...reservation.inFlight],[2n]);
});

test('merge considers BTC first and then every listed asset, so one pass covers the wallet',()=>{
 const a='ee'.repeat(34),b='ff'.repeat(34);
 const fields=mergeAssetFields({[a]:'10',[b]:'4'});
 assert.equal(fields[0],0n,'BTC first');
 assert.equal(fields.length,3);
 assert.deepEqual(mergeAssetFields(undefined),[0n]);
});

test('a merge and a payment share one reservation, so neither can take the notes the other holds',async()=>{
 const account=await fundedAccount([400n,500n]);
 const reservation=new NoteReservation();
 const merged=await reservation.pick(()=>account.consolidate(aliceTo,0n,reservation.inFlight,1),
  chosen=>chosen?chosen.inputs.map(n=>n.nullifier):[]);
 assert.ok(merged,'two notes above a threshold of one');
 assert.equal(reservation.inFlight.size,2,'a merge holds both of its inputs');
 await assert.rejects(reservation.pick(()=>account.pay(bobTo,300n,aliceTo,reservation.inFlight),
  chosen=>chosen.spends.map(s=>s.witness.slot.nullifiers[0]!)),/No three notes/,'nothing is left for the payment');
 reservation.release(merged.inputs.map(n=>n.nullifier));
 assert.equal(reservation.inFlight.size,0);
 const after=await reservation.pick(()=>account.pay(bobTo,300n,aliceTo,reservation.inFlight),chosen=>chosen.spends.map(s=>s.witness.slot.nullifiers[0]!));
 assert.equal(after.spends.length,1,'and the notes are usable again once the merge lets go');
});

const owned=(amount:bigint,nullifier:bigint)=>({amount,nullifier});
test('a withdrawal needs one covering note, the BTC dust floor, and an asset carrier',()=>{
 const btc=[owned(500n,1n),owned(120n,2n)],units=[owned(40n,3n)];
 assert.equal(coversWithdrawal(btc,btc,400n,new Set(),false,330n),true);
 assert.equal(coversWithdrawal(btc,btc,600n,new Set(),false,330n),false);
 assert.equal(coversWithdrawal(btc,btc,400n,new Set([1n]),false,330n),false);
 assert.equal(coversWithdrawal(btc,btc,120n,new Set(),false,330n),false);
 assert.equal(coversWithdrawal(btc,btc,0n,new Set(),false,330n),false);
 assert.equal(coversWithdrawal(units,btc,40n,new Set(),true,330n),true);
 assert.equal(coversWithdrawal(units,[owned(200n,4n)],40n,new Set(),true,330n),false);
 assert.equal(coversWithdrawal(units,[owned(330n,4n)],40n,new Set(),true,330n),true);
 assert.equal(coversWithdrawal(units,btc,40n,new Set(),true,1000n),false);
 assert.equal(coversWithdrawal(units,btc,40n,new Set([1n]),true,330n),false);
 assert.equal(coversWithdrawal(units,btc,40n,new Set(),true,329n),false);
 assert.equal(coversWithdrawal([],btc,1n,new Set(),true,330n),false);
});

test('a private payment can reach the three largest notes, and no further',()=>{
 const notes=[{amount:100n},{amount:900n},{amount:500n},{amount:700n}];
 assert.equal(topThree(notes),2100n);
 assert.deepEqual(notes.map(n=>n.amount),[100n,900n,500n,700n]);
 assert.equal(topThree([{amount:100n}]),100n);
 assert.equal(topThree([]),0n);
});

test('a payout program is the Arkade address script without its taproot prefix',()=>{
 const address='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
 assert.deepEqual(programOf(address),hex.decode('e2d99617ad6f0911ce658123284c11e2dbf2ed7eaa3b7b5eb9804173c674016e'));
 assert.equal(hex.encode(ArkAddress.decode(address).pkScript),'5120e2d99617ad6f0911ce658123284c11e2dbf2ed7eaa3b7b5eb9804173c674016e');
 assert.throws(()=>programOf('not-an-address'));
});
