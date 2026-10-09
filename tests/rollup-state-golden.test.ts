import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {BATCH_SLOTS,BTC_ASSET,ROLLUP_DOMAIN} from '../packages/protocol/src/rollup/constants.ts';
import {clientWitness} from '../packages/protocol/src/rollup/client.ts';
import {ownerOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState,type BatchResult,type BatchSlot} from '../packages/protocol/src/rollup/state.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const owner=ownerOf(hash,ROLLUP_DOMAIN,7n,8n);
let counter=1000n;
const fresh=()=>++counter;
const slot=(state:RollupState,amount:bigint):BatchSlot=>clientWitness(hash,{domain:ROLLUP_DOMAIN,root:state.latestRoot(),asset:BTC_ASSET,inputs:[{amount:0n,ask:fresh(),nk:fresh(),rho:fresh(),index:0,path:Array(32).fill(0n)}],
 outputs:[{amount,owner,random:fresh()},{amount:0n,owner,random:fresh()}],deposit:amount,withdraw:0n,destination:0n,ctDigest:fresh(),groupId:0n,groupSize:0}).slot;
const digest=(r:Pick<BatchResult,'witness'|'publicSignals'|'binding'|'daRoot'>)=>createHash('sha256').update(JSON.stringify({w:r.witness,p:r.publicSignals,b:[...r.binding],d:r.daRoot},(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');

// Pinned from the Plan 1 reference model, so the incremental state must reproduce its witnesses exactly.
test('incremental state reproduces the reference witnesses',()=>{
 let state=RollupState.genesis(hash);
 const out:string[]=[];
 for(let batch=0;batch<3;batch++){
  const slots=Array.from({length:BATCH_SLOTS},(_,i)=>slot(state,BigInt(batch*100+i)));
  const result=state.apply('spend',slots);
  out.push(digest(result));
  state=(result as {next?:RollupState}).next??state;
 }
 assert.deepEqual(out,GOLDEN);
});
const GOLDEN=['ed6b93f609d343b77bf36a385b48a5f5e94d2032e10e392065ea0821d9dae903','0d65c4010f0b6a5892b8da54670b26c6ea53777c6671db29e09cc43155bfc220','e1e2cf502b28af81a534a9ce194f0e35d5af69e9089aeb7af3d8efaf3a7b2e2c'];
