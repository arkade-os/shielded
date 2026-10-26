import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFileSync,existsSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {rollupPoolKindOf} from '../src/rollup/service.ts';
import {keySet,offline,POOL_KEYS,ready,scratch,sha} from './fixtures/epoch-service.ts';

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

test('the genesis-4 manifest is byte for byte the one the live pool will journal as its artifacts hash',()=>{
 assert.equal(sha(readFileSync('rollup-keys/genesis-4.json')),'f37b081817d2f616366ba1798394ddd0516bfe24e102399989127c81e1862cad');
});

test('the service reads no epoch length from the environment',async()=>{
 process.env.SHIELDED_ROLLUP_EPOCH_LEN='128';
 try{
  const net=offline(),directory=scratch('rollup-launch-env-'),service=await ready(net,directory,keySet('classic'));
  assert.deepEqual([service.epochPool,JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')).version],[false,1]);
 }finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
});

/** Both kinds' keys in one bundle, so the kind the server picks is what decides the set it installs. */
const bundledKeys=()=>{
 const dir=scratch('rollup-launch-bundle-'),files:Record<string,string>={};
 for(const from of [keySet('classic'),keySet('epoch')]){
  for(const name of readdirSync(from).filter(n=>n!=='manifest.json'))copyFileSync(join(from,name),join(dir,name));
  Object.assign(files,JSON.parse(readFileSync(join(from,'manifest.json'),'utf8')).circuits.all.files);
 }
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({circuits:{all:{files}}}));
 return dir;
};

/** src/server.ts on a fresh data directory with no network, stopped once a pool directory has installed its bundled keys. */
async function runServer(){
 const data=scratch('rollup-launch-data-'),unreachable='http://127.0.0.1:1';
 const child=spawn(process.execPath,['--experimental-eventsource','--import','tsx','src/server.ts'],{stdio:['ignore','pipe','pipe'],
  env:{...process.env,SHIELDED_DATA_DIR:data,SHIELDED_ROLLUP_KEYS:bundledKeys(),SHIELDED_ROLLUP_EPOCH_LEN:undefined,SHIELDED_INDEXER_URL:undefined,SHIELDED_ARK_URL:unreachable,SHIELDED_EMULATOR_URL:unreachable,HOST:'127.0.0.1',PORT:'0'}});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
 const closed=new Promise(resolve=>child.once('close',resolve));
 try{
  for(let waited=0;!readdirSync(data).some(name=>existsSync(join(data,name,'keys','manifest.json')));waited+=100){
   assert.equal(child.exitCode,null,`the server exited early: ${output}`);
   assert.ok(waited<120_000,`the server installed no keys: ${output}`);
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }finally{child.kill();await closed;}
 return data;
}

test('the deployed server opens an epoch pool on a fresh directory and creates no rollup2',{timeout:180_000},async()=>{
 const data=await runServer(),keys=join(data,'rollup4','keys');
 assert.deepEqual(readdirSync(data),['rollup4']);
 assert.deepEqual([existsSync(join(keys,'epoch-spend.zkey')),existsSync(join(keys,'spend.zkey'))],[true,false],'the keys of an epoch pool, not a classic one');
});

test('an unset environment still yields epoch 128, and a set one overrides it',()=>{
 const matches=[...readFileSync('src/server.ts','utf8').matchAll(/\bepochLen:([^,}]+)/g)],expression=matches[0]?.[1];
 assert.ok(matches.length===1&&expression,'src/server.ts hands the service exactly one epoch length');
 const given=(value?:string)=>runInNewContext(expression,{process:{env:{SHIELDED_ROLLUP_EPOCH_LEN:value}}});
 assert.deepEqual(rollupPoolKindOf({epochLen:given()}),{kind:'epoch',epochLen:128});
 assert.deepEqual(rollupPoolKindOf({epochLen:given('64')}),{kind:'epoch',epochLen:64});
 for(const value of ['','x'])assert.notEqual(given(value),undefined,`'${value}' must not fall through to a classic pool`);
});
