import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {DEFAULT_VM_BINARY} from '../src/rollup/leaves.ts';
import {openRollupService,rollupEpochLenOf} from '../src/rollup/service.ts';
import {emulatorKey,keySet,offline,ready,scratch,serverKey,sha,token} from './fixtures/epoch-service.ts';

const REFUSAL='This directory holds a classic (genesis-3) pool, which this build cannot open; run the build that created it.';

test('openRollupService cannot be called without an epoch length',async()=>{
 const directory=scratch('rollup-launch-unset-');
 // @ts-expect-error epochLen is required
 await assert.rejects(openRollupService({directory,circuits:directory,setupTool:directory,vmBinary:DEFAULT_VM_BINARY,endpoints:{}}),/epoch length/);
 assert.deepEqual(readdirSync(directory),[],'refused before it writes anything');
});

test('a directory holding a version-1 genesis is refused with a message naming the build',async()=>{
 const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-launch-classic-'),path=join(directory,'genesis.json');
 const head={txid:'55'.repeat(32),vout:0,value:1000,sourceTxHex:'abcd'},classic={version:1,token,txid:head.txid,serverKey,emulatorKey,archive:{version:1,head,reserves:{},batches:0}},{version:_,...unversioned}=classic;
 const attempt=async(genesis:object,epochLen:number|string=128)=>{
  writeFileSync(path,JSON.stringify(genesis));
  const service=await net.open(directory,keys,epochLen);
  try{await service.step();return [service.ready(),service.status().phase,service.status().message];}finally{service.close();}
 };
 assert.deepEqual(await attempt(classic),[false,'blocked',REFUSAL]);
 assert.deepEqual(await attempt(classic,'128'),[false,'blocked',REFUSAL]);
 assert.deepEqual(await attempt(unversioned),[false,'blocked',REFUSAL],'a genesis with no version is a classic one');
 assert.deepEqual(await attempt({...classic,version:3}),[false,'blocked','The rollup genesis has version 3, which this build cannot open; run the build that created it.']);
 assert.equal(existsSync(join(directory,'keys')),false,'the refusal comes before the keys are looked at');
 assert.equal(readFileSync(path,'utf8'),JSON.stringify({...classic,version:3}),'and leaves the genesis as it was');
});

test('a fresh directory with an epoch length writes a version-2 genesis and never a version-1',async()=>{
 for(const [epochLen,length] of [[128,128],['64',64]] as const){
  const net=offline(),keys=keySet('epoch'),directory=scratch('rollup-launch-fresh-');
  const first=await ready(net,directory,keys,epochLen),saved=JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8'));
  assert.deepEqual([saved.version,saved.epochLen],[2,length],String(epochLen));
  first.close();
  const again=await ready(net,directory,keys);
  assert.equal(again.status().pool!.epochLen,length,`reopened with the fixture's 128, written with ${epochLen}`);
  again.close();
  const same=await ready(net,directory,keys,epochLen);
  assert.equal(same.status().pool!.epochLen,length,`reopened with ${epochLen}`);
 }
});

test('rollupEpochLenOf accepts a number and a decimal string alike, and refuses both floors',()=>{
 for(const epochLen of [128,'128'])assert.equal(rollupEpochLenOf({epochLen}),128);
 for(const epochLen of [64,'64',2**20,String(2**20)])assert.equal(rollupEpochLenOf({epochLen}),Number(epochLen),String(epochLen));
 for(const epochLen of [63,'63',2**20+1,String(2**20+1),128.5,'128.5',NaN,'x','',0])assert.throws(()=>rollupEpochLenOf({epochLen}),/epoch length/,String(epochLen));
 for(const genesis of [{version:1},{}])assert.throws(()=>rollupEpochLenOf({genesis,epochLen:128}),/classic \(genesis-3\) pool, which this build cannot open/);
 assert.throws(()=>rollupEpochLenOf({genesis:{version:3},epochLen:128}),/version 3/);
 assert.throws(()=>rollupEpochLenOf({genesis:{version:2},epochLen:128}),/epoch length/);
 assert.equal(rollupEpochLenOf({genesis:{version:2,epochLen:64},epochLen:128}),64);
});

test('the genesis-4 manifest is byte for byte the one the live pool will journal as its artifacts hash',()=>{
 assert.equal(sha(readFileSync('rollup-keys/genesis-4.json')),'f37b081817d2f616366ba1798394ddd0516bfe24e102399989127c81e1862cad');
});

test('the service reads no epoch length from the environment',async()=>{
 process.env.SHIELDED_ROLLUP_EPOCH_LEN='64';
 try{
  const directory=scratch('rollup-launch-env-');await ready(offline(),directory,keySet('epoch'),128);
  assert.equal(JSON.parse(readFileSync(join(directory,'genesis.json'),'utf8')).epochLen,128);
 }finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
});

/** An epoch key set with a classic key file beside it, which the install must leave behind. */
const bundledKeys=()=>{const dir=keySet('epoch');writeFileSync(join(dir,'spend.zkey'),'spend.zkey');return dir;};

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
 assert.equal(rollupEpochLenOf({epochLen:given()}),128);
 assert.equal(rollupEpochLenOf({epochLen:given('64')}),64);
 assert.deepEqual([given(''),given('x')],['','x']);
 for(const value of ['','x'])assert.throws(()=>rollupEpochLenOf({epochLen:given(value)}),/epoch length/,`'${value}' must fail closed`);
});
