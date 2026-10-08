import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
const root=resolve('.deps'),version='2.2.2';
const binaries={win32:['circom-windows-amd64.exe','e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1'],linux:['circom-linux-amd64','f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5']};
if(process.arch!=='x64'||!binaries[process.platform])throw new Error('Pinned circom supports Windows/Linux x64. Supply a separately verified compiler on other platforms.');
const [name,sha]=binaries[process.platform];
const compiler=join(root,'native-circom-'+version,name);
await mkdir(resolve(compiler,'..'),{recursive:true});
let cached=false;try{cached=createHash('sha256').update(await readFile(compiler)).digest('hex')===sha;}catch{}
if(!cached){
 const response=await fetch('https://github.com/iden3/circom/releases/download/v'+version+'/'+name,{signal:AbortSignal.timeout(180000)});if(!response.ok||!response.body)throw new Error('Pinned circom download failed: HTTP '+response.status);
 const temporary=compiler+'.partial-'+process.pid,hash=createHash('sha256');let size=0;
 const meter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>320*1024*1024)return callback(new Error('Circom download exceeds its limit.'));hash.update(chunk);callback(null,chunk);}});
 await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(temporary,{flags:'wx'}));
 if(hash.digest('hex')!==sha)throw new Error('Circom checksum mismatch; refusing to execute or use it.');
 await rename(temporary,compiler);
}
await chmod(compiler,0o755);
await writeFile(join(root,'native-circom-'+version,'compiler.json'),JSON.stringify({version,platform:process.platform,sha256:sha,file:name})+'\n');
console.log('Pinned circom '+version+' verified.');
