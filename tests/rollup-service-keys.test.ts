import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {asset} from '@arkade-os/sdk';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import {EPOCH_KEY_FILES,installRollupKeys,openRollupService,rollupEpochProgramsHash,rollupKeyPath,rollupSpecOf,verifyRollupKeys} from '../src/rollup/service.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const token=asset.AssetId.create('cc'.repeat(32),0).toString();
// Shared-setup keys from the committed epoch fixture, built as tools/vm/rollup_leaves_test.go:109 builds them.
const {noRecoverSpecFile,epochSpecFile}=(()=>{
 const {clientKey,batchKey}=JSON.parse(readFileSync('tools/vm/testdata/rollup-epoch-covenant-snarkjs.json','utf8')) as Record<'clientKey'|'batchKey',{vk_delta_2:unknown;IC:unknown[]}>;
 const dir=mkdtempSync(join(tmpdir(),'rollup-specs-')),wide={...batchKey,nPublic:11,IC:[...batchKey.IC,...Array(12-batchKey.IC.length).fill(batchKey.IC.at(-1))]};
 const keys:Record<string,unknown>={spend:clientKey,join:{...clientKey,vk_delta_2:batchKey.vk_delta_2},'batch-spend':wide,'batch-join':wide};
 mkdirSync(join(dir,'keys'));after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const [name,key] of Object.entries(keys))writeFileSync(join(dir,'keys',`epoch-${name}.vkey.json`),JSON.stringify(key));
 writeFileSync(join(dir,'keys','epoch-batch-recover.vkey.json'),JSON.stringify(batchKey));
 const spec=rollupSpecOf(token,'aa'.repeat(32)),{batchRecoverKey:_,epoch:__,...noRecover}=spec;
 const file=(name:string,value:object)=>{const path=join(dir,name);writeFileSync(path,JSON.stringify(value));return path;};
 return {noRecoverSpecFile:file('no-recover.json',noRecover),epochSpecFile:file('epoch.json',spec)};
})();

test('the key allowlist is exactly the five epoch circuits plus the manifest, with no kind to choose',()=>{
 assert.deepEqual([...EPOCH_KEY_FILES].sort(),['manifest.json',...['epoch-spend','epoch-join','epoch-batch-spend','epoch-batch-join','epoch-batch-recover'].flatMap(c=>[`${c}.wasm`,`${c}.zkey`,`${c}.vkey.json`])].sort());
 assert.equal(rollupKeyPath('/keys','epoch-join.zkey'),join('/keys','epoch-join.zkey'));
 for(const name of ['join.zkey','spend.wasm','../secrets.json','epoch-join.r1cs','epoch-spend.wasm/..'])assert.equal(rollupKeyPath('/keys',name),undefined,name);
 // @ts-expect-error the allowlist takes no kind
 assert.equal(rollupKeyPath('/keys','join.zkey','classic'),undefined);
});

test('a key set is verified file by file, and one missing a circuit is refused',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rollup-keys-')),files:Record<string,string>={};
 for(const name of EPOCH_KEY_FILES.filter(n=>n!=='manifest.json')){writeFileSync(join(dir,name),name);files[name]=sha(name);}
 const write=(circuits:Record<string,{files:Record<string,string>}>)=>writeFileSync(join(dir,'manifest.json'),JSON.stringify({circuits}));
 write({all:{files}});
 assert.doesNotThrow(()=>verifyRollupKeys(dir));
 const {['epoch-join.zkey']:_,...withoutJoin}=files;
 write({all:{files:withoutJoin}});
 assert.throws(()=>verifyRollupKeys(dir),/epoch-join\.zkey/);
 write({all:{files:{...files,'epoch-join.zkey':sha('other')}}});
 assert.throws(()=>verifyRollupKeys(dir),/epoch-join\.zkey does not match/);
});

test('the journal pin changes when any leaf changes, or when a byte moves between leaves',()=>{
 const leaves={batch:Uint8Array.of(1),batchJoin:Uint8Array.of(2),reserve:Uint8Array.of(3),renew:Uint8Array.of(4),batchRecover:Uint8Array.of(5)},base=rollupEpochProgramsHash(leaves);
 for(const name of ['batch','batchJoin','reserve','renew','batchRecover'] as const)assert.notEqual(rollupEpochProgramsHash({...leaves,[name]:Uint8Array.of(9)}),base,name);
 assert.notEqual(rollupEpochProgramsHash({...leaves,batch:Uint8Array.of(1,2),batchJoin:new Uint8Array()}),base);
});

const bundle=(tag='')=>{
 const from=mkdtempSync(join(tmpdir(),'rollup-bundle-')),files:Record<string,string>={};
 for(const name of EPOCH_KEY_FILES.filter(n=>n!=='manifest.json')){writeFileSync(join(from,name),name+tag);files[name]=sha(name+tag);}
 writeFileSync(join(from,'manifest.json'),JSON.stringify({circuits:{all:{files}}}));
 return from;
};

test('a pre-built key set is installed whole or not at all, so a broken mount can be fixed by mounting again',()=>{
 const from=bundle(),keys=join(mkdtempSync(join(tmpdir(),'rollup-data-')),'keys');
 rmSync(join(from,'epoch-join.zkey'));
 assert.throws(()=>installRollupKeys(from,keys));
 assert.equal(existsSync(keys),false,'nothing half-copied is left where the service looks');
 writeFileSync(join(from,'epoch-join.zkey'),'epoch-join.zkey');
 installRollupKeys(from,keys);
 assert.doesNotThrow(()=>verifyRollupKeys(keys));
});

test('an install replaces a leftover key directory that has no manifest, but never a key set that has one',()=>{
 const keys=join(mkdtempSync(join(tmpdir(),'rollup-data-')),'keys');
 mkdirSync(keys);writeFileSync(join(keys,'epoch-spend.zkey'),'stale');
 installRollupKeys(bundle(),keys);
 assert.doesNotThrow(()=>verifyRollupKeys(keys));
 assert.throws(()=>installRollupKeys(bundle('other'),keys));
 assert.equal(readFileSync(join(keys,'epoch-spend.zkey'),'utf8'),'epoch-spend.zkey');
});

test('an epoch leaf set without the recover leaf is a hard error naming the stale VM',async()=>{
 await assert.rejects(loadRollupEpochLeaves(DEFAULT_VM_BINARY,noRecoverSpecFile),/recover leaf|rebuild the covenant binary/);
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,epochSpecFile);
 assert.equal(leaves.batchRecover.length>0,true);
});

test('the epoch programs hash covers the recover leaf',async()=>{
 const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,epochSpecFile);
 assert.equal(rollupEpochProgramsHash(leaves),'9a480211b80cd40998b6f59f14bf07d43eab0e3811c83a8f456cf1acf1dff34e');
 assert.notEqual(rollupEpochProgramsHash({...leaves,batchRecover:Uint8Array.of(0x52)}),rollupEpochProgramsHash(leaves));
});

/** One step() on a fresh data directory; an endpoint with a path fails the preflight before any request is sent. */
async function stepOnce(o:{bundled:string;epochLen:number|string}){
 const directory=mkdtempSync(join(tmpdir(),'rollup-data-')),keys=join(directory,'keys');
 const service=await openRollupService({directory,circuits:directory,setupTool:directory,vmBinary:DEFAULT_VM_BINARY,endpoints:{arkUrl:'http://127.0.0.1/offline'},log:()=>{},bundled:o.bundled,epochLen:o.epochLen});
 try{await service.step();return {...service.status(),keys,hasKeys:existsSync(keys),keyFile:service.keyFile};}
 finally{service.close();rmSync(directory,{recursive:true,force:true});}
}

test('a genesis epoch length is at least 64 and at most 2**20',async()=>{
 for(const bad of ['0','1','63',String(2**20+1),'128.5','x','',0,NaN]){
  const refused=await stepOnce({bundled:bundle(),epochLen:bad});
  assert.deepEqual([refused.phase,refused.hasKeys],['blocked',false],String(bad));
  assert.match(refused.message,/epoch length/,String(bad));
 }
 for(const good of ['64',String(2**20)])assert.match((await stepOnce({bundled:bundle(),epochLen:good})).message,/preflight/,good);
});

test('a fresh volume given an epoch length installs only an epoch key set, and stops before the network',async()=>{
 const epoch=await stepOnce({bundled:bundle(),epochLen:128});
 assert.match(epoch.message,/preflight/);
 assert.equal(epoch.proving?.spend.wasm,sha('epoch-spend.wasm'));
 assert.equal(epoch.keyFile('epoch-batch-recover.zkey'),join(epoch.keys,'epoch-batch-recover.zkey'));
 assert.equal(epoch.keyFile('spend.zkey'),undefined);
});
