import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {InMemoryShieldedNoteRepository} from '../src/shielded/repository.ts';
import {loadAccount} from '../src/shielded/wallet.ts';
import {epochLeafPool} from './fixtures/epoch-pool.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v)));
const keys=deriveRollupKeys2('11'.repeat(32),'mutinynet');

test('a new wallet without a snapshot starts from the checkpoint; one with a snapshot resumes it',async()=>{
 const {api,asked}=epochLeafPool(hash,256,140),repository=new InMemoryShieldedNoteRepository();let hooked=0;
 const fresh=await loadAccount(hash,keys,{repository,token:'g2',epochLen:256,bornAt:130,api,onBatch:()=>{hooked++;}});
 assert.deepEqual([fresh.resumed,fresh.account.batchCount,hooked,asked.includes('/checkpoints/0/128')],[false,140,12,true]);
 await repository.saveAccount('g2',{v:2,token:'g2',account:fresh.account.snapshot(),sent:{},listings:[]});
 asked.length=0;
 const resumed=await loadAccount(hash,keys,{repository,token:'g2',epochLen:256,bornAt:130,api});
 assert.deepEqual([resumed.resumed,resumed.account.batchCount,asked],[true,140,['/status','/batches?from=140&limit=50','/status']],'checked against the pool, with no checkpoint and no replay');
});
