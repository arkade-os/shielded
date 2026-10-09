import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {ROLLUP_KEY_FILES,verifyRollupKeys} from '../src/rollup/service.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const fetchKeys=(manifest:string,base:string,out:string)=>promisify(execFile)(process.execPath,['tools/fetch-rollup-keys.mjs',manifest,base,out]);

test('published keys are installed only when each matches the manifest pinned in the repo',async(t)=>{
 const served=new Map<string,string>(),files:Record<string,string>={};
 for(const name of ROLLUP_KEY_FILES.filter(n=>n!=='manifest.json')){served.set('/'+name,name);files[name]=sha(name);}
 const server=createServer((req,res)=>{const body=served.get(req.url??'');res.writeHead(body===undefined?404:200).end(body);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,dir=mkdtempSync(join(tmpdir(),'rollup-fetch-')),manifest=join(dir,'pinned.json');
 writeFileSync(manifest,JSON.stringify({circuits:{all:{files}}}));
 const out=join(dir,'keys');
 await fetchKeys(manifest,base,out);
 assert.doesNotThrow(()=>verifyRollupKeys(out));
 assert.equal(readFileSync(join(out,'manifest.json'),'utf8'),readFileSync(manifest,'utf8'));
 served.set('/join.zkey','tampered');
 const again=join(dir,'again');
 await assert.rejects(fetchKeys(manifest,base,again),/join\.zkey does not match/);
 assert.equal(existsSync(join(again,'join.zkey')),false,'a file that fails its digest is not left behind');
});
