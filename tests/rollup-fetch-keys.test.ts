import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createServer,type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {promisify} from 'node:util';
import {EPOCH_KEY_FILES,verifyRollupKeys} from '../src/rollup/service.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const fetchKeys=(manifest:string,base:string,out:string)=>promisify(execFile)(process.execPath,['tools/fetch-rollup-keys.mjs',manifest,base,out]);

test('published keys are installed only when each matches the manifest pinned in the repo',async(t)=>{
 const served=new Map<string,string>(),files:Record<string,string>={};
 for(const name of EPOCH_KEY_FILES.filter(n=>n!=='manifest.json')){served.set('/'+name,name);files[name]=sha(name);}
 const server=createServer((req,res)=>{const body=served.get(req.url??'');res.writeHead(body===undefined?404:200).end(body);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,dir=mkdtempSync(join(tmpdir(),'rollup-fetch-')),manifest=join(dir,'pinned.json');
 writeFileSync(manifest,JSON.stringify({circuits:{all:{files}}}));
 const out=join(dir,'keys');
 await fetchKeys(manifest,base,out);
 assert.doesNotThrow(()=>verifyRollupKeys(out));
 assert.equal(readFileSync(join(out,'manifest.json'),'utf8'),readFileSync(manifest,'utf8'));
 served.set('/epoch-join.zkey','tampered');
 const again=join(dir,'again');
 await assert.rejects(fetchKeys(manifest,base,again),/epoch-join\.zkey does not match/);
 assert.equal(existsSync(join(again,'epoch-join.zkey')),false,'a file that fails its digest is not left behind');
});

const keyServer=async(t:TestContext,answer:(name:string,seen:number,res:ServerResponse)=>void)=>{
 const files:Record<string,string>={},hits=new Map<string,number>();
 for(const name of EPOCH_KEY_FILES.filter(n=>n!=='manifest.json'))files[name]=sha(name);
 const server=createServer((req,res)=>{
  const name=(req.url??'').slice(1),seen=(hits.get(name)??0)+1;hits.set(name,seen);
  if(name in files)answer(name,seen,res);else res.writeHead(404).end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const dir=mkdtempSync(join(tmpdir(),'rollup-fetch-')),manifest=join(dir,'pinned.json'),out=join(dir,'keys');
 writeFileSync(manifest,JSON.stringify({circuits:{all:{files}}}));
 return {hits,out,run:()=>fetchKeys(manifest,`http://127.0.0.1:${(server.address() as {port:number}).port}`,out)};
};
const whole=(name:string,res:ServerResponse)=>res.writeHead(200).end(name);
const cutShort=(name:string,res:ServerResponse)=>{res.writeHead(200,{'content-length':String(name.length)});res.write(name.slice(0,5));setTimeout(()=>res.socket?.destroy(),20);};

test('a download the host drops is fetched again',async(t)=>{
 const keys=await keyServer(t,(name,seen,res)=>name==='epoch-spend.vkey.json'&&seen===1?res.writeHead(504).end():whole(name,res));
 await keys.run();
 assert.doesNotThrow(()=>verifyRollupKeys(keys.out));
 assert.equal(keys.hits.get('epoch-spend.vkey.json'),2);
});

test('a download cut off mid-body starts over, so the retried file still matches its digest',async(t)=>{
 const keys=await keyServer(t,(name,seen,res)=>name==='epoch-spend.vkey.json'&&seen===1?cutShort(name,res):whole(name,res));
 await keys.run();
 assert.doesNotThrow(()=>verifyRollupKeys(keys.out));
 assert.equal(keys.hits.get('epoch-spend.vkey.json'),2);
});

test('a download that fails five times fails the fetch and leaves no partial file',async(t)=>{
 const keys=await keyServer(t,(name,_seen,res)=>name==='epoch-spend.vkey.json'?cutShort(name,res):whole(name,res));
 await assert.rejects(keys.run(),/terminated/);
 assert.equal(keys.hits.get('epoch-spend.vkey.json'),5);
 assert.deepEqual(readdirSync(keys.out).filter(file=>file.endsWith('.partial')),[]);
});
