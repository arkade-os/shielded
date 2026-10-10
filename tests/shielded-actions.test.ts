import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArkAddress,Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS} from '../packages/protocol/src/rollup/constants.ts';
import {buildRollupTransfer,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {submitAll} from '../src/shielded/submit.ts';

const built=(nullifiers:bigint[],groupId=0n,groupSize=0)=>({witness:{slot:{root:7n,nullifiers,commitments:[12n,13n],ctDigest:14n,groupId,groupSize},publicSignals:[1n,0n,0n,0n,0n],input:{}},ciphertext:Uint8Array.of(1),change:0n} as unknown as BuiltSpend);
const prover={prove:async(_b:BuiltSpend,circuit:'spend'|'join')=>({pi_a:[circuit],pi_b:[],pi_c:[]})};
const identity={sign:async(tx:Transaction)=>tx} as never;
const POOL_SCRIPT='51'.repeat(17);
const tx=(inputs:{txid:string;index:number;script:Uint8Array}[])=>{const t=new Transaction({allowUnknownOutputs:true});for(const i of inputs)t.addInput({txid:i.txid,index:i.index,witnessUtxo:{script:i.script,amount:1000n}});t.addOutput({script:hex.decode('0014'+'11'.repeat(20)),amount:1000n});return t;};
const deps=(api:never)=>({api,prover,identity,poolScript:POOL_SCRIPT});

test('a group is proved then submitted in the order its id commits to, and every member is awaited',async()=>{
 const submitted:string[]=[],steps:number[]=[];
 const api=(async(path:string,body?:{slot?:{nullifiers:string[]}})=>{
  if(path==='/spends'){submitted.push(body!.slot!.nullifiers[0]!);return {};}
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

test('only the member that owns a deposit coin signs, and a request for a member without one is refused',async()=>{
 const pool=hex.decode('5120'+'aa'.repeat(32)),user=hex.decode('0014'+'bb'.repeat(20)),coin={txid:'cc'.repeat(32),vout:1};
 const head=tx([{txid:'dd'.repeat(32),index:0,script:pool}]),mine=tx([{txid:coin.txid,index:coin.vout,script:user}]);
 const ark=tx([{txid:head.id,index:0,script:pool},{txid:mine.id,index:0,script:user}]);
 const signing={status:'signing',arkTx:base64.encode(ark.toPSBT()),checkpoints:[base64.encode(head.toPSBT()),base64.encode(mine.toPSBT())],checkpoint:base64.encode(mine.toPSBT()),vin:1};
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
});

test('a dropped member is the answer even when a sibling was included',async()=>{
 let n=0;
 const api=(async(path:string)=>path==='/spends'?{}:(n++===0?{status:'included',txid:'t'}:{status:'dropped',reason:'A group member was refused.'})) as never;
 const final=await submitAll([{built:built([11n],9n,2)},{built:built([21n],9n,2)}],{...deps(api),step:()=>{},first:0});
 assert.equal(final.status,'dropped');
 assert.equal(final.reason,'A group member was refused.');
});
