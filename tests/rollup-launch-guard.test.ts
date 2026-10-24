import assert from 'node:assert/strict';
import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {rollupPoolKindOf} from '../src/rollup/service.ts';
import {keySet,offline,POOL_KEYS,ready,scratch} from './fixtures/epoch-service.ts';

const CLASSIC_REFUSAL='This directory holds a classic pool; an epoch pool needs its own data directory.';

test('a service given an epoch length refuses a directory holding a classic genesis',async()=>{
 const net=offline(),keys=keySet('classic'),directory=scratch('rollup-launch-classic-'),path=join(directory,'genesis.json');
 (await ready(net,directory,keys)).close();
 const classic=readFileSync(path,'utf8'),{version:_,...unversioned}=JSON.parse(classic);
 const attempt=async(epochLen:number|string)=>{
  const service=await net.open(directory,keys,epochLen);
  try{await service.step();return [service.ready(),service.status().phase,service.status().message];}finally{service.close();}
 };
 const refused=[false,'blocked',CLASSIC_REFUSAL];
 assert.deepEqual(await attempt(128),refused);
 assert.deepEqual(await attempt('128'),refused);
 writeFileSync(path,JSON.stringify(unversioned));
 assert.deepEqual(await attempt(128),refused,'a genesis with no version is a classic one');
 rmSync(join(directory,'keys'),{recursive:true});
 assert.deepEqual(await attempt(128),refused,'the refusal comes before the keys are looked at');
 assert.equal(existsSync(join(directory,'keys')),false);
 assert.equal(readFileSync(path,'utf8'),JSON.stringify(unversioned));
});

test('a service given no epoch length still opens a classic genesis unchanged',async()=>{
 const net=offline(),keys=keySet('classic'),directory=scratch('rollup-launch-rollback-'),path=join(directory,'genesis.json');
 const first=await ready(net,directory,keys),saved=readFileSync(path,'utf8'),script=first.status().pool!.script;
 first.close();
 const again=await ready(net,directory,keys),status=again.status();
 assert.deepEqual([JSON.parse(saved).version,readFileSync(path,'utf8'),again.epochPool,status.pool!.script],[1,saved,false,script]);
 assert.deepEqual([Object.keys(status.pool!).sort(),Object.keys(status.proving!)],[POOL_KEYS,['spend','join','batch','batchJoin']]);
});

test('a fresh directory with an epoch length writes a version-2 genesis and never a version-1',async()=>{
 for(const [epochLen,length] of [[128,128],['64',64]] as const){
  const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-launch-fresh-');
  const first=await ready(net,directory,keys,epochLen),saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8'));
  assert.deepEqual([saved.version,saved.epochLen,first.epochPool],[2,length,true],String(epochLen));
  first.close();
  // The other direction needs no refusal: the version-2 genesis alone reopens an epoch pool, of its own length.
  const again=await ready(net,directory,keys);
  assert.deepEqual([again.epochPool,again.status().pool!.epochLen],[true,length],`reopened with no option, written with ${epochLen}`);
  again.close();
  const same=await ready(net,directory,keys,epochLen);
  assert.deepEqual([same.epochPool,same.status().pool!.epochLen],[true,length],`reopened with ${epochLen}`);
 }
});

test('rollupPoolKindOf accepts a number and a decimal string alike, and refuses both floors',()=>{
 for(const epochLen of [128,'128'])assert.deepEqual(rollupPoolKindOf({epochLen}),{kind:'epoch',epochLen:128});
 for(const epochLen of [64,'64',2**20,String(2**20)])assert.equal(rollupPoolKindOf({epochLen}).kind,'epoch',String(epochLen));
 for(const epochLen of [63,'63',2**20+1,String(2**20+1),128.5,'128.5',NaN,'x',''])assert.throws(()=>rollupPoolKindOf({epochLen}),/epoch length/,String(epochLen));
 assert.deepEqual(rollupPoolKindOf({genesis:{version:1},epochLen:128}),{kind:'classic'});
 assert.deepEqual(rollupPoolKindOf({genesis:{version:2,epochLen:64},epochLen:128}),{kind:'epoch',epochLen:64});
});

test('the service reads no epoch length from the environment',async()=>{
 process.env.SHIELDED_ROLLUP_EPOCH_LEN='128';
 try{
  const net=offline(),directory=scratch('rollup-launch-env-'),service=await ready(net,directory,keySet('classic'));
  assert.deepEqual([service.epochPool,JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')).version],[false,1]);
 }finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
});
