import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {installRollupKeys,ROLLUP_KEY_FILES,rollupKeyPath,rollupProgramsHash,verifyRollupKeys} from '../src/rollup/service.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

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

test('a pre-built key set is installed whole or not at all, so a broken mount can be fixed by mounting again',()=>{
 const from=mkdtempSync(join(tmpdir(),'rollup-bundle-')),keys=join(mkdtempSync(join(tmpdir(),'rollup-data-')),'keys'),files:Record<string,string>={};
 for(const name of ROLLUP_KEY_FILES.filter(n=>n!=='manifest.json')){writeFileSync(join(from,name),name);files[name]=sha(name);}
 writeFileSync(join(from,'manifest.json'),JSON.stringify({circuits:{all:{files}}}));
 rmSync(join(from,'join.zkey'));
 assert.throws(()=>installRollupKeys(from,keys));
 assert.equal(existsSync(keys),false,'nothing half-copied is left where the service looks');
 writeFileSync(join(from,'join.zkey'),'join.zkey');
 installRollupKeys(from,keys);
 assert.doesNotThrow(()=>verifyRollupKeys(keys));
});
