import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {asset} from '@arkade-os/sdk';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {installRollupKeys,openRollupService,ROLLUP_KEY_FILES,rollupEpochProgramsHash,rollupKeyFilesOf,rollupKeyPath,rollupPoolKindOf,rollupProgramsHash,rollupSpecOf,verifyRollupKeys,type RollupPoolKind} from '../src/rollup/service.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
// Shared-setup keys from the committed epoch fixture, built as tools/vm/rollup_leaves_test.go:109 builds them.
const {classicSpecFile,epochSpecFile}=(()=>{
 const {clientKey,batchKey}=JSON.parse(readFileSync('tools/vm/testdata/rollup-epoch-covenant-snarkjs.json','utf8')) as Record<'clientKey'|'batchKey',{vk_delta_2:unknown;IC:unknown[]}>;
 const dir=mkdtempSync(join(tmpdir(),'rollup-specs-')),wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 const keys:Record<string,unknown>={spend:clientKey,join:{...clientKey,vk_delta_2:batchKey.vk_delta_2},'batch-spend':wide,'batch-join':wide};
 mkdirSync(join(dir,'keys'));after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const [name,key] of Object.entries(keys))for(const prefix of ['','epoch-'])writeFileSync(join(dir,'keys',`${prefix}${name}.vkey.json`),JSON.stringify(key));
 writeFileSync(join(dir,'keys','epoch-batch-recover.vkey.json'),JSON.stringify(batchKey));
 const spec=(kind:RollupPoolKind)=>{const file=join(dir,`${kind}.json`);writeFileSync(file,JSON.stringify(rollupSpecOf(kind,token,'aa'.repeat(32))));return file;};
 return {classicSpecFile:spec('classic'),epochSpecFile:spec('epoch')};
})();

test('the proving allowlist names all four circuits, and nothing else is served',()=>{
 assert.deepEqual([...ROLLUP_KEY_FILES].sort(),['manifest.json',
  'spend.wasm','spend.zkey','spend.vkey.json','join.wasm','join.zkey','join.vkey.json',
  'batch-spend.wasm','batch-spend.zkey','batch-spend.vkey.json','batch-join.wasm','batch-join.zkey','batch-join.vkey.json'].sort());
 assert.equal(rollupKeyPath('/keys','join.zkey'),join('/keys','join.zkey'));
 for(const name of ['../secrets.json','join.r1cs','spend.wasm/..'])assert.equal(rollupKeyPath('/keys',name),undefined,name);
});

test('a key set is verified file by file, and one missing a circuit is refused',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rollup-keys-')),files:Record<string,string>={};
 for(const name of ROLLUP_KEY_FILES.filter(n=>n!=='manifest.json')){writeFileSync(join(dir,name),name);files[name]=sha(name);}
 const write=(circuits:Record<string,{files:Record<string,string>}>)=>writeFileSync(join(dir,'manifest.json'),JSON.stringify({circuits}));
 write({all:{files}});
 assert.doesNotThrow(()=>verifyRollupKeys(dir));
 const {['join.zkey']:_,...withoutJoin}=files;
 write({all:{files:withoutJoin}});
 assert.throws(()=>verifyRollupKeys(dir),/join\.zkey/);
 write({all:{files:{...files,'join.zkey':sha('other')}}});
 assert.throws(()=>verifyRollupKeys(dir),/join\.zkey does not match/);
});

test('the journal pin changes when any leaf changes, or when a byte moves between leaves',()=>{
 const leaves={batch:Uint8Array.of(1),batchJoin:Uint8Array.of(2),reserve:Uint8Array.of(3),renew:Uint8Array.of(4)},base=rollupProgramsHash(leaves);
 for(const name of ['batch','batchJoin','reserve','renew'] as const)assert.notEqual(rollupProgramsHash({...leaves,[name]:Uint8Array.of(9)}),base,name);
 assert.notEqual(rollupProgramsHash({...leaves,batch:Uint8Array.of(1,2),batchJoin:new Uint8Array()}),base);
});

const bundle=(tag='',kind:RollupPoolKind='classic')=>{
 const from=mkdtempSync(join(tmpdir(),'rollup-bundle-')),files:Record<string,string>={};
 for(const name of rollupKeyFilesOf(kind).filter(n=>n!=='manifest.json')){writeFileSync(join(from,name),name+tag);files[name]=sha(name+tag);}
 writeFileSync(join(from,'manifest.json'),JSON.stringify({circuits:{all:{files}}}));
 return from;
};

test('a pre-built key set is installed whole or not at all, so a broken mount can be fixed by mounting again',()=>{
 const from=bundle(),keys=join(mkdtempSync(join(tmpdir(),'rollup-data-')),'keys');
 rmSync(join(from,'join.zkey'));
 assert.throws(()=>installRollupKeys(from,keys));
 assert.equal(existsSync(keys),false,'nothing half-copied is left where the service looks');
 writeFileSync(join(from,'join.zkey'),'join.zkey');
 installRollupKeys(from,keys);
 assert.doesNotThrow(()=>verifyRollupKeys(keys));
});

test('an install replaces a leftover key directory that has no manifest, but never a key set that has one',()=>{
 const keys=join(mkdtempSync(join(tmpdir(),'rollup-data-')),'keys');
 mkdirSync(keys);writeFileSync(join(keys,'spend.zkey'),'stale');
 installRollupKeys(bundle(),keys);
 assert.doesNotThrow(()=>verifyRollupKeys(keys));
 assert.throws(()=>installRollupKeys(bundle('other'),keys));
 assert.equal(readFileSync(join(keys,'spend.zkey'),'utf8'),'spend.zkey');
});

test('the pool kind comes from the persisted genesis, and an unknown version is refused',()=>{
 assert.deepEqual(rollupPoolKindOf({genesis:{version:1}}),{kind:'classic'});
 assert.deepEqual(rollupPoolKindOf({genesis:{version:1},epochLenEnv:'128'}),{kind:'classic'});
 assert.deepEqual(rollupPoolKindOf({genesis:{version:2,epochLen:128}}),{kind:'epoch',epochLen:128});
 assert.deepEqual(rollupPoolKindOf({}),{kind:'classic'});
 assert.deepEqual(rollupPoolKindOf({epochLenEnv:'128'}),{kind:'epoch',epochLen:128});
 assert.throws(()=>rollupPoolKindOf({genesis:{version:3}}),/version 3/);
 assert.throws(()=>rollupPoolKindOf({genesis:{version:2}}),/epoch length/);
});

test('a genesis epoch length is at least 64 and at most 2**20',()=>{
 for(const bad of ['0','1','63',String(2**20+1),'128.5','x'])assert.throws(()=>rollupPoolKindOf({epochLenEnv:bad}),/epoch length/,bad);
 assert.deepEqual(rollupPoolKindOf({epochLenEnv:String(2**20)}),{kind:'epoch',epochLen:2**20});
});

test('each pool kind gets its own key files, and the classic list never moves',()=>{
 assert.deepEqual([...rollupKeyFilesOf('classic')],[...ROLLUP_KEY_FILES]);
 assert.ok(rollupKeyFilesOf('epoch').includes('epoch-batch-recover.zkey'));
 assert.equal(rollupKeyFilesOf('epoch').filter(n=>(ROLLUP_KEY_FILES as readonly string[]).includes(n)).join(),'manifest.json');
});

test('an epoch leaf set without the recover leaf is a hard error naming the stale VM',async()=>{
 await assert.rejects(loadRollupEpochLeaves(DEFAULT_VM_BINARY,classicSpecFile),/recover leaf|rebuild the covenant binary/);
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,epochSpecFile);
 assert.equal(leaves.batchRecover.length>0,true);
});

test('the epoch programs hash covers the recover leaf and is not the genesis-3 hash',async()=>{
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,epochSpecFile);
 assert.notEqual(rollupEpochProgramsHash(leaves),rollupProgramsHash(leaves));
 assert.equal(rollupEpochProgramsHash(leaves),'9a480211b80cd40998b6f59f14bf07d43eab0e3811c83a8f456cf1acf1dff34e');
 assert.notEqual(rollupEpochProgramsHash({...leaves,batchRecover:Uint8Array.of(0x52)}),rollupEpochProgramsHash(leaves));
});

/** One step() on a fresh data directory; an endpoint with a path fails the preflight before any request is sent. */
async function stepOnce(o:{genesis?:object;keys?:string;bundled?:string}){
 const directory=mkdtempSync(join(tmpdir(),'rollup-data-')),keys=join(directory,'keys');
 if(o.genesis)writeFileSync(join(directory,'genesis.json'),JSON.stringify(o.genesis));
 if(o.keys)installRollupKeys(o.keys,keys);
 const service=await openRollupService({directory,circuits:directory,setupTool:directory,vmBinary:DEFAULT_VM_BINARY,endpoints:{arkUrl:'http://127.0.0.1/offline'},log:()=>{},...(o.bundled?{bundled:o.bundled}:{})});
 try{await service.step();return {...service.status(),keys,hasKeys:existsSync(keys),keyFile:service.keyFile};}
 finally{service.close();rmSync(directory,{recursive:true,force:true});}
}

test('a classic genesis keeps the classic key list under SHIELDED_ROLLUP_EPOCH_LEN, and an unknown version is refused before the keys',async()=>{
 process.env.SHIELDED_ROLLUP_EPOCH_LEN='128';
 try{
  const live=await stepOnce({genesis:{version:1},keys:bundle()});
  assert.match(live.message,/preflight/);
  assert.deepEqual(Object.keys(live.proving??{}),['spend','join','batch','batchJoin']);
  assert.equal(live.keyFile('spend.zkey'),join(live.keys,'spend.zkey'));
  assert.equal(live.keyFile('epoch-spend.zkey'),undefined);
  assert.match((await stepOnce({genesis:{version:3}})).message,/version 3/);
 }finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
});

test('a fresh volume under SHIELDED_ROLLUP_EPOCH_LEN installs only an epoch key set, and stops before the network',async()=>{
 process.env.SHIELDED_ROLLUP_EPOCH_LEN='128';
 try{
  const classic=await stepOnce({bundled:bundle()});
  assert.match(classic.message,/epoch-spend\.wasm/);
  assert.equal(classic.hasKeys,false);
  const epoch=await stepOnce({bundled:bundle('','epoch')});
  assert.match(epoch.message,/cannot open an epoch pool/);
  assert.equal(epoch.proving?.spend.wasm,sha('epoch-spend.wasm'));
  assert.equal(epoch.keyFile('epoch-batch-recover.zkey'),join(epoch.keys,'epoch-batch-recover.zkey'));
  assert.equal(epoch.keyFile('spend.zkey'),undefined);
 }finally{delete process.env.SHIELDED_ROLLUP_EPOCH_LEN;}
});
