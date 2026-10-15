import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {NOTE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {checkpointOf} from '../packages/protocol/src/rollup/frontier.ts';
import {DeepTree} from '../packages/protocol/src/rollup/tree.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {freshAccount} from '../src/shielded/checkpoint.ts';
import type {PoolApi} from '../src/shielded/pool.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {loadAccount} from '../src/shielded/wallet.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet');
const leaf=(block:number,i:number)=>BigInt(block*32+i+1);

/** A pool whose batches each append two leaves. `landing` lands one more batch on the first status read. */
function pool(batches:number,o:{checkpoints?:boolean;wrong?:boolean;landing?:boolean}={}){
 const tree=new DeepTree(hash,NOTE_DEPTH),asked:string[]=[];
 let count=0,landed=!o.landing;
 const land=()=>{for(const i of [0,1])tree.set(count*32+i,leaf(count,i));count++;};
 while(count<batches)land();
 const batch=(block:number)=>({kind:'spend',slots:[{root:'0',nullifiers:['1'],commitments:[String(leaf(block,0)),String(leaf(block,1))],ctDigest:'0',groupId:'0',groupSize:0}]});
 const api=(async(path:string)=>{
  asked.push(path);
  if(path==='/status'){if(!landed){landed=true;land();}return {phase:'ready',message:'',pool:{batches:count,root:String(tree.root())}};}
  const page=/^\/batches\?from=(\d+)&limit=(\d+)$/.exec(path);
  if(page){const from=Number(page[1]),to=Math.min(count,from+Number(page[2]));return {total:count,batches:Array.from({length:Math.max(0,to-from)},(_,i)=>batch(from+i))};}
  const at=/^\/checkpoints\/(\d+)$/.exec(path);
  if(at&&o.checkpoints!==false){const c=checkpointOf(tree,Number(at[1]));return o.wrong?{...c,filled:c.filled.map(()=>'7')}:c;}
  throw Object.assign(new Error('Not found'),{status:404});
 }) as PoolApi;
 return {tree,api,asked};
}

test('a fresh account starts at the checkpoint before its birth and never reads the batches before it',async()=>{
 const {tree,api,asked}=pool(140),account=await freshAccount(hash,keys,130,api);
 assert.deepEqual([account.batchCount,account.latestRoot()],[140,tree.root()]);
 assert.deepEqual(asked,['/checkpoints/128','/batches?from=128&limit=50','/status']);
});

test('a batch landing between the catch-up and the status read gets another try',async()=>{
 const {tree,api,asked}=pool(140,{landing:true}),account=await freshAccount(hash,keys,130,api);
 assert.deepEqual([account.batchCount,account.latestRoot()],[141,tree.root()]);
 assert.equal(asked.filter(p=>p==='/status').length,2);
});

test('without a checkpoint, or with one the pool\'s root refutes, the account replays from genesis',async()=>{
 for(const o of [{checkpoints:false},{wrong:true}])assert.equal((await freshAccount(hash,keys,130,pool(140,o).api)).batchCount,0,JSON.stringify(o));
 const young=pool(140);
 assert.equal((await freshAccount(hash,keys,63,young.api)).batchCount,0);
 assert.deepEqual(young.asked,[],'no checkpoint comes before batch 64, so none is asked for');
});

test('a new wallet without a snapshot starts from the checkpoint; one with a snapshot resumes it',async()=>{
 const {api,asked}=pool(140),repository=new InMemoryShieldedNoteRepository();
 const fresh=await loadAccount(hash,keys,{repository,token:'g2',bornAt:130,api});
 assert.deepEqual([fresh.resumed,fresh.account.batchCount],[false,140]);
 await repository.saveAccount('g2',{v:1,token:'g2',account:fresh.account.snapshot(),sent:{},listings:[]});
 asked.length=0;
 const resumed=await loadAccount(hash,keys,{repository,token:'g2',bornAt:130,api});
 assert.deepEqual([resumed.resumed,resumed.account.batchCount,asked],[true,140,[]]);
});
