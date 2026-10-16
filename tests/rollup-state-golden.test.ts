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

// Pinned from the incremental state's own witnesses at the 7-public/96-byte layout; regenerate when that layout changes.
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
const GOLDEN=['2ddd881b4c32ba47634e3b9550b2aa3b3809dcb1cb3fc68a9a91d74f49c07044','7d3b3939b496435e0465f851f961d6d1c41ae391d3365fc86d9ba3a023aff71a','e5b71f84e0366641ec2e07e6555e3ca69b87abcffa5bb2c1671bdfa1d9495c0f'];
